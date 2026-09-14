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

test('the scratch automation editor uses mobile-safe dropdowns and popup pickers', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Automations' }).click()
  await page.getByRole('button', { name: 'New automations' }).click()
  await page.getByRole('dialog', { name: 'New automation' }).getByRole('button', { name: 'Create from scratch' }).click()

  const workspaceHeader = page.locator('.foreground-layer.active > .bot-workspace-header')
  await expect(workspaceHeader.locator('.header-bot-button small')).toHaveText('New job')
  await expect(page.getByRole('button', { exact: true, name: 'Back' })).toHaveCount(1)
  await expect(page.getByRole('heading', { exact: true, name: 'New job' })).toHaveCount(0)

  const scheduleType = page.getByRole('combobox', { name: 'Schedule type' })
  await expect(scheduleType).toBeVisible()
  expect(await scheduleType.locator('option').allTextContents()).toEqual([
    'Repeating interval', 'Natural language', 'Cron expression', 'One time'
  ])
  expect(await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))).toEqual({ client: 390, scroll: 390 })

  await page.getByRole('button', { name: /^Skills/ }).click()
  const skills = page.getByRole('dialog', { name: 'Choose skills' })
  await expect(skills.getByRole('searchbox')).toBeVisible()
  await skills.getByRole('searchbox').fill('Research')
  await skills.getByRole('checkbox', { name: /Research/ }).check()
  await skills.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: /^Skills/ })).toContainText('research')

  await page.getByRole('button', { name: /^Delivery/ }).click()
  const delivery = page.getByRole('dialog', { name: 'Delivery targets' })
  await delivery.getByRole('checkbox', { name: /Telegram/ }).check()
  await delivery.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: /^Provider/ }).click()
  const providers = page.getByRole('dialog', { name: 'Choose provider' })
  await providers.getByRole('radio', { name: 'Fixture AI' }).check()
  await providers.getByRole('button', { name: 'Done' }).click()
  await page.locator('.cron-picker-field').filter({ hasText: /^Model/ }).click()
  const models = page.getByRole('dialog', { name: 'Choose model' })
  await models.getByRole('radio', { name: 'fixture/deep' }).check()
  await models.getByRole('button', { name: 'Done' }).click()

  await page.getByPlaceholder('Morning briefing').fill('Research briefing')
  await page.getByPlaceholder('Ask Hermes to…').fill('Research the selected topic and summarize it.')
  await page.getByRole('button', { name: 'Create job' }).click()
  await expect(workspaceHeader.locator('.header-bot-button small')).toHaveText('Job details')

  const calls = await page.evaluate(async () => (await fetch('/api/fixture-calls')).json())
  const create = calls.calls.find((call: { kind: string; method: string; path: string }) => call.kind === 'http' && call.method === 'POST' && call.path === '/api/cron/jobs')
  expect(create.body).toMatchObject({ deliver: 'local,telegram', model: 'fixture/deep', provider: 'fixture', skills: ['research'] })
})
