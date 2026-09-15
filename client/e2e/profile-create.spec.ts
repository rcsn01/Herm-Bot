import { expect, test, type Page } from '@playwright/test'

async function loginToRoster(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Bots' }).getByRole('button', { name: 'Hermes' })).toBeVisible()
}

test('creates a profile from the roster header and refreshes the roster', async ({ page }) => {
  await loginToRoster(page)

  await page.getByRole('button', { name: 'Create profile' }).click()
  await page.getByRole('dialog', { name: 'Create new' }).getByRole('button', { name: 'New bot' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create profile' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Profile name' }).fill('research')
  await dialog.getByRole('button', { name: 'Create profile' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Bots' }).getByRole('button', { exact: true, name: 'Research' })).toBeVisible()

  const calls = await page.evaluate(async () => (await fetch('/api/fixture-calls')).json()) as { calls: Array<Record<string, any>> }
  expect(calls.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'rpc', method: 'profiles.create', params: { name: 'research' } })
  ]))
})

test('creates a customized profile without switching the active bot', async ({ page }) => {
  await loginToRoster(page)

  await page.getByRole('button', { name: 'Create profile' }).click()
  await page.getByRole('dialog', { name: 'Create new' }).getByRole('button', { name: 'New bot' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create profile' })
  await dialog.getByRole('textbox', { name: 'Profile name' }).fill('research')
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Research')
  await dialog.getByRole('textbox', { name: 'Description' }).fill('A research profile')
  await dialog.getByRole('button', { name: 'Advanced profile settings' }).click()
  await dialog.getByRole('textbox', { name: 'SOUL.md' }).fill('Be concise.')
  await dialog.getByRole('button', { name: 'Create profile' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Bots' }).getByRole('button', { exact: true, name: 'Research' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible()
  const calls = await page.evaluate(async () => (await fetch('/api/fixture-calls')).json()) as { calls: Array<Record<string, any>> }
  expect(calls.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'rpc', method: 'profiles.create', params: { description: 'A research profile', name: 'research', share_auth: true, soul: 'Be concise.' } }),
    expect.objectContaining({ kind: 'rpc', method: 'profiles.configure', params: expect.objectContaining({ name: 'research', ui_meta: expect.any(Object) }) })
  ]))
  expect(calls.calls.some(call => call.kind === 'ws-connect' && call.profile === 'research')).toBe(false)
})

test('creates a group chat from selected bots', async ({ page }) => {
  await loginToRoster(page)

  await page.getByRole('button', { name: 'Create profile' }).click()
  await page.getByRole('dialog', { name: 'Create new' }).getByRole('button', { name: 'New group chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'New group chat' })
  await expect(dialog.getByRole('checkbox', { name: 'Hermes' })).toBeVisible()
  await dialog.getByRole('checkbox', { name: 'Hermes' }).check()
  await dialog.getByRole('checkbox', { name: 'Work' }).check()
  await dialog.getByRole('textbox', { name: 'Group name' }).fill('Research team')
  await dialog.getByRole('button', { name: 'Create group chat (2)' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Group chat Research team' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Research team' })).toBeVisible()
})

test('edits a profile and saves advanced capability settings', async ({ page }) => {
  await loginToRoster(page)

  await page.getByRole('button', { name: 'Profile menu' }).nth(1).click()
  const actions = page.getByRole('dialog', { name: 'Work' })
  await actions.getByRole('button', { name: 'Edit profile' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit profile' })
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Operator')
  await dialog.getByRole('button', { name: 'Advanced profile settings' }).click()
  await dialog.getByRole('combobox', { name: 'Profile provider' }).selectOption('fixture')
  await dialog.getByRole('combobox', { name: 'Profile model' }).selectOption('fixture/deep')
  const skills = dialog.locator('fieldset').filter({ hasText: 'Skills (' })
  await skills.locator('input[type="checkbox"]').first().uncheck()
  const toolsets = dialog.locator('fieldset').filter({ hasText: 'Toolsets (' })
  await toolsets.locator('input[type="checkbox"]').first().uncheck()
  await dialog.locator('section[aria-label="MCP servers"] input[type="checkbox"]').first().uncheck()
  await dialog.getByRole('textbox', { name: 'SOUL.md' }).fill('Use short answers.')
  await dialog.getByRole('button', { name: 'Save changes' }).click()

  await expect(dialog).toHaveCount(0)
  const calls = await page.evaluate(async () => (await fetch('/api/fixture-calls')).json()) as { calls: Array<Record<string, any>> }
  expect(calls.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'rpc', method: 'profiles.describe', params: { name: 'work' } }),
    expect.objectContaining({ kind: 'rpc', method: 'profiles.configure', params: expect.objectContaining({ disabled_skills: ['browser'], enabled_mcp_servers: [], enabled_toolsets: ['browser'], model: 'fixture/deep', name: 'work', provider: 'fixture', soul: 'Use short answers.' }) }),
    expect.objectContaining({ kind: 'rpc', method: 'profiles.configure', params: expect.objectContaining({ name: 'work', ui_meta: expect.any(Object) }) })
  ]))
})

test('duplicates and deletes a non-default profile from the profile menu', async ({ page }) => {
  await loginToRoster(page)

  await page.getByRole('button', { name: 'Profile menu' }).nth(1).click()
  let actions = page.getByRole('dialog', { name: 'Work' })
  await actions.getByRole('button', { name: 'Duplicate profile' }).click()
  const duplicate = page.getByRole('dialog', { name: 'Duplicate profile' })
  await expect(duplicate.getByRole('textbox', { name: 'Profile name' })).toHaveValue('work-2')
  await duplicate.getByRole('button', { name: 'Duplicate profile' }).click()
  await expect(duplicate).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Bots' }).getByRole('button', { exact: true, name: 'Work 2' })).toBeVisible()

  await page.getByRole('button', { name: 'Profile menu' }).nth(1).click()
  actions = page.getByRole('dialog', { name: 'Work' })
  await actions.getByRole('button', { name: 'Delete profile' }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete profile?' })
  await confirmation.getByRole('button', { name: 'Delete profile' }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Bots' }).getByRole('button', { exact: true, name: 'Work' })).toHaveCount(0)

  const calls = await page.evaluate(async () => (await fetch('/api/fixture-calls')).json()) as { calls: Array<Record<string, any>> }
  expect(calls.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'rpc', method: 'profiles.create', params: expect.objectContaining({ clone_all: true, clone_from: 'work', name: 'work-2' }) }),
    expect.objectContaining({ kind: 'rpc', method: 'cli.exec', params: { argv: ['profile', 'delete', 'work', '--yes'] } })
  ]))
})
