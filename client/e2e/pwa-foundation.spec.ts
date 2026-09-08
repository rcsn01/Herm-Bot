import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, path = '/') {
  await page.goto(path)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
}

async function fixtureCalls(page: Page) {
  return page.evaluate(async () => (await fetch('/api/fixture-calls')).json()) as Promise<{ calls: Array<Record<string, any>> }>
}

test('ships an installable manifest, icons, and a controlling service worker', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Service worker control is validated in Chromium; WebKit still runs the wire tests.')
  await page.goto('/')
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(manifestHref).toBeTruthy()
  const manifestResponse = await page.request.get(new URL(manifestHref!, page.url()).toString())
  expect(manifestResponse.ok()).toBeTruthy()
  const manifest = await manifestResponse.json()
  expect(manifest.name).toBe('Hermes Mobile')
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2)
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, page.url()).toString())
    expect(response.ok()).toBeTruthy()
    expect(response.headers()['content-type']).toBe('image/png')
  }

  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true))
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload()
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
})

test('password cookie authenticates a real WebSocket chat session', async ({ page, context }) => {
  await login(page)
  const cookies = await context.cookies()
  const sessionCookie = cookies.find(item => item.name === 'fixture_session')
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' })

  await page.getByLabel('Message Hermes').fill('hello over a real socket')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Fixture answer: hello over a real socket')).toBeVisible()

  const { calls } = await fixtureCalls(page)
  expect(calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'ws-connect', profile: 'default' }),
    expect.objectContaining({ kind: 'rpc', method: 'session.create', params: expect.objectContaining({ profile: 'default', source: 'mobile' }) }),
    expect.objectContaining({ kind: 'rpc', method: 'prompt.submit' })
  ]))
})

test('cold deep link switches profile, resumes, and reloads durable history', async ({ page }) => {
  await login(page, '/session/saved-work?profile=work')
  await expect(page.getByText('Durable reply from saved-work')).toBeVisible()

  let calls = (await fixtureCalls(page)).calls
  expect(calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'ws-connect', profile: 'work' }),
    expect.objectContaining({ kind: 'rpc', method: 'session.resume', params: expect.objectContaining({ profile: 'work', session_id: 'saved-work', source: 'mobile' }) })
  ]))

  await page.reload()
  await expect(page.getByText('Durable reply from saved-work')).toBeVisible()
  calls = (await fixtureCalls(page)).calls
  expect(calls.filter(call => call.kind === 'rpc' && call.method === 'session.resume' && call.params.session_id === 'saved-work').length).toBeGreaterThanOrEqual(2)
  expect(calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'http', path: '/api/sessions/saved-work/messages', query: expect.objectContaining({ include_compacted: 'true', order: 'latest' }) })
  ]))
})

test('offline shell works without caching private API responses', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright WebKit does not provide reliable service-worker offline control.')
  await login(page)
  const secret = await page.evaluate(async () => (await fetch('/api/private-fixture')).json())
  expect(secret).toEqual({ secret: 'cookie-private-response' })
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true))
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()

  const cached = await page.evaluate(async () => {
    const values: Array<{ text: string; url: string }> = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) values.push({ url: request.url, text: await (await cache.match(request))!.text() })
    }
    return values
  })
  expect(cached.some(item => item.url.includes('/api/private-fixture') || item.text.includes('cookie-private-response'))).toBe(false)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('status', { name: '' }).filter({ hasText: 'Offline. Reconnect to use your gateway.' })).toBeVisible()
  await page.goto('/session/saved-work?profile=work')
  await expect(page.getByText('Hermes Mobile')).toBeVisible()
  await expect(page.getByText('Offline. Reconnect to use your gateway.')).toBeVisible()
  const unavailable = await page.evaluate(async () => {
    const check = async (url: string) => { try { const response = await fetch(url); return { ok: response.ok, type: response.headers.get('content-type') } } catch { return { unavailable: true } } }
    return Promise.all([check('/api/private-fixture'), check('/auth/password-login')])
  })
  expect(unavailable).toEqual([{ unavailable: true }, { unavailable: true }])
})
