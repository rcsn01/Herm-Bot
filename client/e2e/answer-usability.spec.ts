import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('answer-user')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Hermes', exact: true }).click()
  await expect(page.getByText('Durable reply from saved-default', { exact: true })).toBeVisible()
}
async function control(page: Page, update: Record<string, unknown>) {
  await page.evaluate(async update => {
    const response = await fetch('/api/fixture-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) })
    if (!response.ok) throw new Error('Fixture control failed')
  }, update)
}
async function start(page: Page) {
  await control(page, { markdownStream: true })
  await page.getByLabel('Message Hermes').fill('Render the answer fixture')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.session-activity')).toContainText('Hermes is working')
  await expect(page.getByRole('status').filter({ hasText: 'Gateway accepted your message.' })).toBeVisible()
}
const answer = (page: Page) => page.getByRole('article', { name: 'Assistant answer' }).last()
async function delta(page: Page, text: string) { await control(page, { answerEvent: { type: 'delta', delta: text } }) }
async function captureClipboard(page: Page) {
  await page.evaluate(() => {
    Object.assign(window, { copiedTexts: [] as string[] })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedTexts: string[] }).copiedTexts.push(text) } } })
  })
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { copiedTexts: string[] }).copiedTexts)

const code = `  const text = "λ";\n\n  ${'veryLongIdentifier'.repeat(35)}\n`
const markdown = `## Answer\n\nA **formatted** answer with \`inline\` and [Docs](https://example.com).\n\n\`\`\`typescript\n${code}\`\`\`\n\n| ${Array.from({ length: 8 }, (_, i) => `Column ${i}`).join(' | ')} |\n| ${Array(8).fill('---').join(' | ')} |\n| ${Array(8).fill('Wide table value').join(' | ')} |\n\n<script>unsafe()</script>\n\n\`\`\`html\n<img onerror="literal">\n\`\`\``

test('copies exact answer and parsed code, including partial-stream snapshots', async ({ page }) => {
  await login(page)
  await captureClipboard(page)
  await start(page)
  await delta(page, 'Partial **answer**\n\n```ts\n  first')
  await answer(page).getByRole('button', { name: 'Copy answer so far' }).click()
  expect(await copied(page)).toEqual(['Partial **answer**\n\n```ts\n  first'])
  await delta(page, '\n  second\n```')
  await answer(page).getByRole('button', { name: 'Copy code', exact: true }).click()
  expect((await copied(page)).at(-1)).toBe('  first\n  second\n')
  await control(page, { answerEvent: { type: 'complete' } })
  await expect(answer(page).getByRole('button', { name: 'Copy answer', exact: true })).toBeVisible()
  await answer(page).getByRole('button', { name: 'Copy answer', exact: true }).click()
  expect((await copied(page)).at(-1)).toBe('Partial **answer**\n\n```ts\n  first\n  second\n```')
  await control(page, { rejectHandshake: true, closeSockets: true })
  await expect(page.getByLabel('Message Hermes')).toBeEnabled()
  await answer(page).getByRole('button', { name: 'Copy answer', exact: true }).click()
  expect((await copied(page)).at(-1)).toContain('Partial **answer**')
})

test('clipboard denial offers exact manual selection and drops fallback on profile change', async ({ page }, testInfo) => {
  await login(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied') } } }))
  await answer(page).getByRole('button', { name: 'Copy answer', exact: true }).click()
  const fallback = answer(page).getByRole('textbox')
  await expect(fallback).toHaveValue('Durable reply from saved-default')
  await answer(page).getByRole('button', { name: 'Select text', exact: true }).click()
  await expect(fallback).toBeFocused()
  expect(await fallback.evaluate((node: HTMLTextAreaElement) => node.selectionEnd - node.selectionStart)).toBe('Durable reply from saved-default'.length)
  await page.screenshot({ path: testInfo.outputPath('copy-fallback.png') })
  await page.getByRole('button', { name: 'Back to bots' }).click()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await expect(page.getByText('Durable reply from saved-work', { exact: true })).toBeVisible()
  await expect(page.locator('.copy-fallback')).toHaveCount(0)
  await expect(page.locator('.copy-feedback').filter({ hasText: 'Could not copy' })).toHaveCount(0)
})

test('late pending clipboard result does not appear in a different profile', async ({ page }) => {
  await login(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(resolve => Object.assign(window, { resolveCopy: resolve })) } }))
  await answer(page).getByRole('button', { name: 'Copy answer', exact: true }).click()
  await expect(answer(page).getByRole('button', { name: 'Copy answer', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to bots' }).click()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await expect(page.getByText('Durable reply from saved-work', { exact: true })).toBeVisible()
  await page.evaluate(() => (window as unknown as { resolveCopy(): void }).resolveCopy())
  await expect(page.locator('.copy-feedback').filter({ hasText: 'Copied' })).toHaveCount(0)
})

test('code and semantic tables scroll internally at phone widths with keyboard access', async ({ page }, testInfo) => {
  await login(page)
  await captureClipboard(page)
  await start(page)
  await delta(page, markdown)
  await control(page, { answerEvent: { type: 'complete' } })
  await expect(answer(page).getByRole('table')).toBeVisible()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    for (const region of [answer(page).getByRole('region', { name: 'typescript code block' }), answer(page).getByRole('region', { name: 'Scrollable table' })]) {
      expect(await region.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
      await region.scrollIntoViewIfNeeded()
      await region.focus()
      await expect(region).toBeFocused()
      await region.press('ArrowRight')
      await expect.poll(() => region.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
    }
  }
  for (const region of await answer(page).getByRole('region').all()) await region.evaluate(node => { node.scrollLeft = 0 })
  // Apply the same token classes as Appearance settings; changing OS media alone
  // does not reapply an already-resolved app theme.
  await page.evaluate(() => {
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
    document.documentElement.dataset.theme = 'dark'
  })
  const foreground = await page.evaluate(() => getComputedStyle(document.body).color)
  await expect.poll(() => answer(page).getByRole('button', { name: 'Copy answer', exact: true }).evaluate(node => getComputedStyle(node).color)).toBe(foreground)
  const darkCodeColor = await answer(page).locator('pre').first().evaluate(node => getComputedStyle(node).backgroundColor)
  await page.screenshot({ path: testInfo.outputPath('markdown-phone-dark.png') })
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
    document.documentElement.dataset.theme = 'light'
  })
  expect(await answer(page).locator('pre').first().evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(darkCodeColor)
  await page.screenshot({ path: testInfo.outputPath('markdown-phone-light.png') })
  await answer(page).getByRole('button', { name: 'Copy code', exact: true }).first().click()
  expect((await copied(page)).at(-1)).toBe(code)
  await expect(answer(page).getByRole('link', { name: 'Docs' })).toHaveAttribute('rel', 'noreferrer noopener')
  await expect(answer(page).locator('script')).toHaveCount(0)
  await expect(answer(page).getByRole('table').locator('th')).toHaveCount(8)
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('streaming has no transcript live region and errors are not announced as completion', async ({ page }) => {
  await login(page)
  await start(page)
  await delta(page, 'First chunk')
  await expect(page.locator('.transcript')).not.toHaveAttribute('aria-live')
  await expect(answer(page)).not.toHaveAttribute('aria-busy')
  await expect(page.locator('.session-activity')).toHaveAttribute('aria-atomic', 'true')
  await delta(page, ' second chunk')
  await expect(answer(page)).toContainText('First chunk second chunk')
  await expect(page.locator('.session-activity')).toHaveText('Hermes is working')
  expect(await answer(page).evaluate(node => node.closest('[aria-live]') === null)).toBe(true)
  await control(page, { answerEvent: { type: 'error' } })
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture stream failed' })).toBeVisible()
  await expect(page.getByText('Answer completed', { exact: true })).toHaveCount(0)
})

test('real secure-browser clipboard receives answer and code text', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebKit does not expose Playwright clipboard read/write permissions; covered with controlled writes separately.')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await login(page)
  await start(page)
  await delta(page, '**Real clipboard**\n\n```sh\n  echo λ\n```')
  const copy = answer(page).getByRole('button', { name: 'Copy answer so far' })
  await copy.focus()
  await copy.press('Space')
  await expect(answer(page).getByRole('status').filter({ hasText: 'Copied.' })).toHaveCount(1)
  await expect(copy).toBeFocused()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('**Real clipboard**\n\n```sh\n  echo λ\n```')
  await answer(page).getByRole('button', { name: 'Copy code' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('  echo λ\n')
})
