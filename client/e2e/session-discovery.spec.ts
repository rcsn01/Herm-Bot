import { expect, test, type Page } from '@playwright/test'

async function control(page: Page, update: Record<string, unknown>) {
  await page.evaluate(async update => {
    const response = await fetch('/api/fixture-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) })
    if (!response.ok) throw new Error('Fixture control failed')
  }, update)
}
async function calls(page: Page) {
  return page.evaluate(async () => (await (await fetch('/api/fixture-calls')).json()).calls as Array<{ kind: string; method: string; params?: { limit?: number; profile?: string; session_id?: string }; path?: string; query?: { profile?: string }; body?: unknown }>)
}
async function login(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('discovery-user')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Hermes', exact: true }).click()
  await expect(page.getByText('Durable reply from saved-default', { exact: true })).toBeVisible()
  await control(page, { discovery: true })
}
const menu = (page: Page) => page.getByRole('main', { name: 'Sessions menu' })
async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(menu(page).getByText(/matches in .* loaded conversations/)).toBeVisible()
}
async function archive(page: Page) {
  const originalURL = page.url()
  await openMenu(page)
  await menu(page).getByRole('textbox', { name: 'Search loaded titles' }).fill('archive lookup')
  await menu(page).getByRole('button', { name: 'Archived chats', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Archived chats', exact: true })).toBeVisible()
  await expect(page).toHaveURL(originalURL)
}
const resumeCalls = async (page: Page) => (await calls(page)).filter(call => call.method === 'session.resume' && call.params?.session_id === 'archived-default')

test('finds an older title with explicit expansion, contains previews and opens the exact conversation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 470 })
  await login(page)
  await openMenu(page)
  const search = menu(page).getByRole('textbox', { name: 'Search loaded titles' })
  await search.fill('needle')
  await expect(menu(page).getByText('No matching loaded titles. Load more sessions to look further.')).toBeVisible()
  const before = (await calls(page)).filter(call => call.method === 'session.list').length
  await page.waitForTimeout(300)
  expect((await calls(page)).filter(call => call.method === 'session.list')).toHaveLength(before)
  await menu(page).getByRole('button', { name: 'Load more sessions' }).click()
  await expect(menu(page).getByRole('button', { name: /^Older needle notes/ })).toBeVisible()
  await expect(search).toHaveValue('needle')
  await expect(menu(page).getByRole('button', { name: 'Load more sessions' })).toBeFocused()
  expect((await calls(page)).filter(call => call.method === 'session.list').at(-1)?.params).toMatchObject({ limit: 60, profile: 'default' })
  await search.fill('')
  await menu(page).getByRole('heading', { name: 'Today', exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('grouped-sessions-phone.png') })
  await search.fill('needle')
  await menu(page).getByRole('button', { name: /^Older needle notes/ }).click()
  await expect(page.getByText('Durable reply from discovery-default-55', { exact: true })).toBeVisible()
  expect((await calls(page)).filter(call => call.path?.endsWith('/messages') && call.path.includes('discovery-default-'))).toHaveLength(1)
})

test('long titles and previews stay bounded in both themes and keyboard delete preserves the menu', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 600 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await openMenu(page)
  await menu(page).getByRole('button', { name: 'Delete Conversation 0', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(menu(page)).toBeVisible()
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document.documentElement.classList.toggle('light', theme === 'light')
      document.documentElement.dataset.theme = theme
      document.documentElement.style.fontSize = '24px'
    }, theme)
    const foreground = await page.evaluate(() => getComputedStyle(document.body).color)
    await expect.poll(() => menu(page).locator('.session-quick-delete').first().evaluate(node => getComputedStyle(node).color)).toBe(foreground)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await menu(page).locator('.navigation-session-list').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    const mainBox = await menu(page).locator('.session-main').first().boundingBox()
    const deleteBox = await menu(page).locator('.session-quick-delete').first().boundingBox()
    expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(deleteBox!.x + 1)
    expect(deleteBox!.width).toBe(44)
    expect(deleteBox!.height).toBe(44)
    await page.screenshot({ path: testInfo.outputPath(`session-large-text-${theme}.png`) })
  }
})

test('archive entry returns to the menu, searches only loaded titles, and restore-only does not open', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 })
  await login(page)
  await archive(page)
  await expect(page.getByText(/up to 100 chats, not a verified complete archive/)).toBeVisible()
  await page.getByRole('textbox', { name: 'Search loaded archived titles' }).fill('Literal archived preview')
  await expect(page.getByText('No matching loaded archived titles.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search loaded archived titles' }).fill('')
  await expect(page.getByText('<script>Literal archived preview</script>', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('archive-phone.png') })
  await page.getByRole('button', { name: 'Back', exact: true }).last().click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('textbox')).toHaveValue('archive lookup')
  await menu(page).getByRole('button', { name: 'Archived chats', exact: true }).click()
  await page.getByRole('button', { name: 'Restore Archived default notes', exact: true }).click()
  await expect(page.getByText('Restored.', { exact: true })).toBeVisible()
  expect(await resumeCalls(page)).toHaveLength(0)
  expect((await calls(page)).find(call => call.method === 'PATCH' && call.path === '/api/sessions/archived-default')).toMatchObject({ query: { profile: 'default' }, body: { archived: false } })
})

test('restore and open resumes an archived ID absent from the initial live page', async ({ page }) => {
  await login(page)
  await page.getByLabel('Message Hermes').fill('Keep this draft on the original conversation')
  await archive(page)
  await page.getByRole('button', { name: 'Restore and open Archived default notes' }).click()
  await expect(page.getByText('Durable reply from archived-default', { exact: true })).toBeVisible()
  expect(await resumeCalls(page)).toHaveLength(1)
  await expect(page.getByLabel('Message Hermes')).toHaveValue('')
})

test('restore and resume failures have separate recovery without repeating a successful mutation', async ({ page }) => {
  await login(page)
  await archive(page)
  await control(page, { failRestore: true, failResumeSession: 'archived-default' })
  await page.getByRole('button', { name: 'Restore and open Archived default notes' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Restore failed' })).toBeVisible()
  expect(await resumeCalls(page)).toHaveLength(0)
  await control(page, { failRestore: false })
  await page.getByRole('button', { name: 'Restore and open Archived default notes' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Restored, but could not open.' })).toBeVisible()
  await control(page, { failResumeSession: null })
  await page.getByRole('button', { name: 'Open restored chat' }).click()
  await expect(page.getByText('Durable reply from archived-default', { exact: true })).toBeVisible()
  expect((await calls(page)).filter(call => call.method === 'PATCH' && call.path === '/api/sessions/archived-default')).toHaveLength(2)
})

test('leaving the archive retires a pending restore-and-open without undoing the remote restore', async ({ page }) => {
  await login(page)
  await archive(page)
  await control(page, { delayRestore: true })
  await page.getByRole('button', { name: 'Restore and open Archived default notes' }).click()
  await expect(page.getByText('Updating chat…')).toBeVisible()
  await expect.poll(async () => (await calls(page)).filter(call => call.method === 'PATCH' && call.path === '/api/sessions/archived-default').length).toBe(1)
  await page.getByRole('button', { name: 'Back', exact: true }).last().click()
  await expect(menu(page)).toBeVisible()
  await control(page, { delayRestore: false })
  await expect.poll(async () => (await calls(page)).filter(call => call.method === 'restore.complete').length).toBe(1)
  await menu(page).getByRole('button', { name: 'Archived chats', exact: true }).click()
  await expect(page.getByText('No archived chats in this response.')).toBeVisible()
  expect(await resumeCalls(page)).toHaveLength(0)
})

test('offline archive entry explains its limits without starting a remote request', async ({ page }) => {
  await login(page)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.getByText('Device offline. You can read saved conversations and prepare drafts.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(menu(page).getByText(/Searches titles saved on this device/)).toBeVisible()
  const before = (await calls(page)).filter(call => call.path === '/api/sessions').length
  await menu(page).getByRole('button', { name: 'Archived chats', exact: true }).click()
  await expect(page.getByText(/Archived chats are not saved on this device/)).toBeVisible()
  await expect(page.getByText('Loading archived chats…')).toHaveCount(0)
  expect((await calls(page)).filter(call => call.path === '/api/sessions')).toHaveLength(before)
  await page.getByRole('button', { name: 'Back', exact: true }).last().click()
  await expect(menu(page)).toBeVisible()
})

test('archive route errors are not reported as empty results and can be retried', async ({ page }) => {
  await login(page)
  await control(page, { failArchiveList: true })
  await archive(page)
  await expect(page.getByRole('button', { name: 'Retry archived chats' })).toBeVisible()
  await expect(page.getByText('No archived chats in this response.')).toHaveCount(0)
  await control(page, { failArchiveList: false })
  await page.getByRole('button', { name: 'Retry archived chats' }).click()
  await expect(page.getByText('Archived default notes', { exact: true })).toBeVisible()
})

test('search expansion failure retains the query and permits a manual retry', async ({ page }) => {
  await login(page)
  await openMenu(page)
  await menu(page).getByRole('textbox').fill('needle')
  await control(page, { failSessionList: true })
  await menu(page).getByRole('button', { name: 'Load more sessions' }).click()
  await expect(menu(page).getByRole('alert')).toContainText('Fixture list failed')
  const failedCount = (await calls(page)).filter(call => call.method === 'session.list').length
  await page.waitForTimeout(300)
  expect((await calls(page)).filter(call => call.method === 'session.list')).toHaveLength(failedCount)
  await control(page, { failSessionList: false })
  await menu(page).getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(menu(page).getByRole('button', { name: /^Older needle notes/ })).toBeVisible()
  await expect(menu(page).getByRole('textbox')).toHaveValue('needle')
})
