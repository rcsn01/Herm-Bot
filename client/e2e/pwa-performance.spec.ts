import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Hermes', exact: true })).toBeVisible()
}

test.describe('on-demand screen loading', () => {
  // Ignore install-time precaching so this measures page module requests only.
  test.use({ serviceWorkers: 'block' })

  test('loads settings only when opened and keeps chat usable after returning', async ({ page }) => {
    const modules: string[] = []
    page.on('request', request => {
      if (request.url().includes('/assets/') && request.url().endsWith('.js')) modules.push(request.url())
    })
    await login(page)
    expect(modules.some(url => /\/(settings|capabilities|cron|group)-screen-/.test(url))).toBe(false)
    await page.getByRole('button', { name: 'Open settings' }).click()
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    expect(modules.some(url => /\/settings-screen-/.test(url))).toBe(true)
    await page.getByRole('button', { name: 'Back to bots' }).click()
    await page.getByRole('button', { name: 'Hermes', exact: true }).click()
    await page.getByLabel('Message Hermes').fill('Performance smoke test')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Fixture answer: Performance smoke test', { exact: true })).toBeVisible()
  })
})

test('serves precached split screens and fonts offline', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Service worker control is checked in Chromium.')
  await login(page)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible()
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys()
    const urls = await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))
    return urls.flat()
  })
  expect(cached.some(url => /\/settings-screen-/.test(url))).toBe(true)
  expect(cached.some(url => url.includes('jetbrains-mono-latin-wght-normal') && url.includes('.woff2'))).toBe(true)
  await context.setOffline(true)
  // A verified workspace stays navigable offline. Split assets must be local
  // too, so opening Appearance does not depend on another gateway request.
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: /Appearance/ }).click()
  await expect(page.getByRole('combobox')).toBeEnabled()
  await expect(page.locator('.mobile-shell')).not.toHaveAttribute('inert')
  const assets = cached.filter(url => /\/settings-screen-/.test(url) || url.includes('.woff2'))
  const offlineResponses = await page.evaluate(async urls => Promise.all(urls.map(async url => {
    const response = await fetch(url)
    return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength }
  })), assets)
  expect(offlineResponses.every(response => response.ok && response.bytes > 0)).toBe(true)
})
