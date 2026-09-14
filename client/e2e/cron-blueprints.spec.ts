import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Hermes' }).click()
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
}

test('cron blueprints render and edit cleanly on a mobile viewport', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Automations' }).click()
  await page.getByRole('button', { name: 'Blueprints' }).click()

  await expect(page.getByRole('heading', { name: 'Blueprints' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(1)
  const blueprint = page.getByRole('button', { name: /Daily calendar briefing/ })
  const clipping = await blueprint.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }))
  expect(clipping.scrollHeight).toBeLessThanOrEqual(clipping.clientHeight)
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390)

  await blueprint.click()
  await expect(page.getByRole('heading', { name: 'Daily calendar briefing' })).toBeVisible()
  await expect(blueprint).toHaveCount(0)
  await expect(page.getByLabel('Delivery time')).toHaveAttribute('type', 'time')
  await expect(page.getByLabel('Delivery time')).toHaveValue('09:00')
  await expect(page.getByRole('checkbox', { name: 'Mon' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Fri' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Sat' })).not.toBeChecked()
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) await page.getByRole('checkbox', { name: day }).uncheck()
  await page.getByRole('button', { name: 'Create job' }).click()
  await expect(page.getByRole('alert')).toHaveText('Weekdays is required.')

  await page.getByRole('button', { name: 'All blueprints' }).click()
  await expect(page.getByRole('heading', { name: 'Blueprints' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Daily calendar briefing/ })).toBeVisible()
})
