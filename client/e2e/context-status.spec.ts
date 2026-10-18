import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/session/footer-fixture')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
}

async function control(page: Page, update: Record<string, unknown>) {
  await page.evaluate(async update => {
    const response = await fetch('/api/fixture-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) })
    if (!response.ok) throw new Error('Fixture control rejected')
  }, update)
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message Hermes').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('uses live context occupancy and anchors the estimate only to observed completion', async ({ page }) => {
  await login(page)
  const context = page.locator('.context-usage')
  const cache = context.locator('.context-cache-estimate')
  const progress = context.getByRole('progressbar', { name: 'Context used' })
  await expect(context).toContainText('Context 25%')
  await expect(context).toContainText('25,000 / 100,000')
  await expect(progress).toHaveAttribute('value', '25000')
  await expect(progress).toHaveAttribute('max', '100000')
  await expect(cache).toHaveText('Est. cache: unknown')

  await control(page, { contextUsage: { context_used: 40000, context_max: 100000, context_estimated: true, total: 1500000 } })
  await expect(context).toContainText('Context ~40%')
  await expect(context).toContainText('~40,000 / 100,000')
  await expect(cache).toHaveText('Est. cache: unknown')
  await control(page, { contextUsage: { total: 1500000 } })
  await expect(context).toContainText('Usage unavailable')
  await expect(progress).toHaveCount(0)
  await control(page, { contextUsage: { context_used: 25000, context_max: 0 } })
  await expect(context).toContainText('25,000 tokens · limit unknown')
  await expect(progress).toHaveCount(0)
  await control(page, { contextUsage: { context_used: 0, context_max: 100000 } })
  await expect(context).toContainText('Context 0%')
  await expect(progress).toHaveAttribute('value', '0')

  await control(page, { markdownStream: true })
  await send(page, 'Observe a completed response')
  await expect(page.locator('.session-activity')).toHaveText('Hermes is working')
  await expect(cache).toHaveText('Est. cache: unknown')
  await control(page, { answerEvent: { type: 'delta', delta: 'A completed fixture response.' } })
  await control(page, { answerEvent: { type: 'complete', usage: { context_used: 65000, context_max: 100000, total: 2000000 } } })
  await expect(context).toContainText('Context 65%')
  await expect(cache).toHaveText(/^Est\. cache: (60:00|59:59) left$/)
  await expect(cache).toHaveText(/^Est\. cache: 59:5\d left$/)
  await control(page, { contextUsage: { context_used: 90000, context_max: 100000, total: 3000000 } })
  await page.getByLabel('Message Hermes').fill('Unsent draft does not refresh the estimate')
  await expect(context).toContainText('Context 90%')
  await expect(cache).toHaveText(/^Est\. cache: 59:5\d left$/)

  // In-memory navigation resets to the roster on reload. Load the exact chat again.
  await page.goto('/session/footer-fixture')
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
  await expect(cache).toHaveText('Est. cache: unknown')
  await control(page, { markdownStream: false })
  await send(page, 'A fresh observed response after reload')
  await expect(cache).toHaveText(/^Est\. cache: (60:00|59:59) left$/)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message Hermes')).toHaveValue('')
  await expect(cache).toHaveText('Est. cache: unknown')
})

test('keeps context and the cache estimate readable on narrow light and dark screens', async ({ page }, testInfo) => {
  await login(page)
  await send(page, 'Show the cache estimate')
  await expect(page.locator('.context-cache-estimate')).toHaveText(/^Est\. cache: .* left$/)
  for (const [width, theme] of [[390, 'light'], [320, 'dark']] as const) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(theme => {
      document.documentElement.classList.remove(theme === 'dark' ? 'light' : 'dark')
      document.documentElement.classList.add(theme)
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
    }, theme)
    await page.getByLabel('Message Hermes').blur()
    await expect(page.locator('.context-usage')).toBeInViewport()
    await expect(page.locator('.context-cache-estimate')).toBeInViewport()
    await expect(page.getByRole('progressbar', { name: 'Context used' })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`context-${theme}-${width}.png`) })
  }
})
