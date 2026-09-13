import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, path = '/') {
  await page.goto(path)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  if (path === '/') {
    // The main screen is the agent roster; opening the default bot enters its latest conversation.
    await page.getByRole('button', { name: 'Hermes' }).click()
  }
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
  if (path === '/') {
    // The newest session on the fixture is Bot Mode plumbing ('Group: r-crew');
    // opening Hermes must land on the human conversation instead. The fixture
    // echoes the requested session id as the resumed title.
    await expect(page.locator('.header-bot-button small')).toHaveText('saved-default')
  }
}

async function fixtureCalls(page: Page) {
  return page.evaluate(async () => (await fetch('/api/fixture-calls')).json()) as Promise<{ calls: Array<Record<string, any>> }>
}

async function touchDrag(page: Page, start: { x: number; y: number }, end: { x: number; y: number }, steps = 4, onMove?: () => Promise<void>) {
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: start.x, y: start.y }] })
  for (let step = 1; step <= steps; step += 1) {
    const fraction = step / steps
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ id: 1, x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction }]
    })
    await onMove?.()
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
}

async function waitForSwipeIdle(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).evaluate(element => element.getAttribute('data-swipe-phase'))).toBe('idle')
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

test('keeps the bottom status row clear of screen corners until the keyboard opens', async ({ page }) => {
  await login(page)
  const metadata = page.locator('.composer-meta')
  await page.getByLabel('Message Hermes').blur()

  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingLeft)).toBe('18px')
  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingRight)).toBe('18px')

  await page.getByLabel('Message Hermes').focus()
  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingLeft)).toBe('5px')
  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingRight)).toBe('5px')
})

test('keeps the latest message at the same distance from a keyboard-shifted composer while following', async ({ page }) => {
  await login(page)
  await page.getByLabel('Message Hermes').fill('measure the following gap')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Fixture answer: measure the following gap')).toBeVisible()

  const gap = () => page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>('.composer-wrap')!
    const messages = document.querySelectorAll<HTMLElement>('.message')
    return composer.getBoundingClientRect().top - messages[messages.length - 1]!.getBoundingClientRect().bottom
  })
  const afterLayout = () => page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  await page.evaluate(() => {
    const spacer = document.createElement('div')
    spacer.style.height = '900px'
    document.querySelector('.transcript')!.prepend(spacer)
    window.dispatchEvent(new Event('resize'))
  })
  await afterLayout()
  const closedGap = await gap()

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.composer-wrap')!.style.transform = 'translateY(-180px)'
    window.dispatchEvent(new Event('resize'))
  })
  await afterLayout()

  expect(await gap()).toBeCloseTo(closedGap, 0)
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
    expect.objectContaining({ kind: 'rpc', method: 'session.resume', params: expect.objectContaining({ profile: 'default', session_id: 'saved-default', source: 'mobile' }) }),
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

test('desktop group chats list on the main screen and open with sending', async ({ page }) => {
  await login(page)

  await page.getByRole('button', { name: 'Back to bots' }).click()
  const row = page.getByRole('button', { name: /Research crew/ })
  await expect(row).toBeVisible()
  const rowText = await row.textContent()
  expect(rowText).toContain('2 bots')
  expect(rowText).toContain('Codex: Two candidates so far')

  // The stacked member faces must sit inside the avatar box — a face drawn at
  // the roster size would overflow its chip (blank icon in a real browser).
  const faceBox = await page.locator('.group-faces .group-face .bot-face').first().boundingBox()
  expect(faceBox).toBeTruthy()
  expect(faceBox!.width).toBeLessThanOrEqual(33)
  expect(faceBox!.height).toBeLessThanOrEqual(33)

  const initialURL = page.url()
  await row.click()
  await expect(page).toHaveURL(initialURL)
  await expect(page.getByText('Two candidates so far', { exact: true })).toBeVisible()

  // Sending runs the desktop round engine locally: the user bubble lands
  // immediately, member turns fire against the gateway in the background.
  await page.getByLabel('Message Research crew').fill('hello crew')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('hello crew')).toBeVisible()

  // The top bar owns the exit, and back lands on the roster.
  await page.getByRole('button', { name: 'Back to bots' }).click()
  await expect(row).toBeVisible()
})

test('screens stay in one document URL while navigation remains in memory', async ({ page }) => {
  await login(page)
  const initialURL = page.url()
  await expect(page.getByLabel('Message Hermes')).toBeVisible()

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Capabilities' }).click()
  await expect(page.getByText('Capabilities')).toBeVisible()
  await expect(page).toHaveURL(initialURL)

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Open bot chat' }).click()
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
  await expect(page).toHaveURL(initialURL)
})

test('drawer touch motion moves only the panel and commits after the visual endpoint', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const backdrop = page.getByTestId('side-navigation-backdrop')
  const panel = page.locator('.side-drawer-panel')
  await expect(backdrop).toHaveClass(/open/)
  await expect.poll(() => backdrop.evaluate(element => element.style.getPropertyValue('--swipe-progress'))).toBe('0')
  await expect(page.locator('.screen-stack')).toHaveCSS('pointer-events', 'none')

  const box = await panel.boundingBox()
  expect(box).toBeTruthy()
  // Start at the viewport edge, outside the panel, to cover the full-screen
  // backdrop path that must not wake the foreground gesture.
  const start = { x: 0, y: box!.y + 180 }
  const partial = { x: start.x + box!.width * .2, y: start.y + 4 }
  const foreground = page.locator('.foreground-layer.active')
  const mainTransform = await foreground.evaluate(element => getComputedStyle(element).transform)
  await touchDrag(page, start, partial, 2, async () => {
    await page.waitForTimeout(180)
    await expect.poll(() => backdrop.evaluate(element => Number(element.style.getPropertyValue('--swipe-progress')))).toBeGreaterThan(0)
    expect(await foreground.evaluate(element => getComputedStyle(element).transform)).toBe(mainTransform)
  })
  await waitForSwipeIdle(page, '[data-testid="side-navigation-backdrop"]')
  await expect.poll(() => backdrop.evaluate(element => Number(element.style.getPropertyValue('--swipe-progress')))).toBe(0)

  const reopenedBox = await panel.boundingBox()
  expect(reopenedBox).toBeTruthy()
  const commitStart = { x: 10, y: reopenedBox!.y + 180 }
  await touchDrag(page, commitStart, { x: commitStart.x + reopenedBox!.width * .75, y: commitStart.y + 2 })
  await expect(backdrop).not.toHaveClass(/open/)
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
})

test('right-edge touch opening moves only the drawer over the session', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await login(page)
  const backdrop = page.getByTestId('side-navigation-backdrop')
  const foreground = page.locator('.foreground-layer.active')
  await expect(backdrop).not.toHaveClass(/open/)
  const mainTransform = await foreground.evaluate(element => getComputedStyle(element).transform)

  await touchDrag(page, { x: 388, y: 220 }, { x: 240, y: 224 }, 2, async () => {
    expect(await foreground.evaluate(element => getComputedStyle(element).transform)).toBe(mainTransform)
  })
  await waitForSwipeIdle(page, '[data-testid="side-navigation-backdrop"]')
  await expect(backdrop).toHaveClass(/open/)
  await expect(foreground).toHaveCSS('transform', mainTransform)
})

test('single-chat touch dismissal moves the foreground over a fixed roster', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await login(page)
  const foreground = page.locator('.foreground-layer.active')
  const roster = page.locator('.roster-layer')
  const box = await foreground.boundingBox()
  expect(box).toBeTruthy()
  expect(await foreground.locator('.app-header').count()).toBe(1)
  expect(await foreground.locator('.composer-wrap').count()).toBe(1)
  const rosterTransform = await roster.evaluate(element => getComputedStyle(element).transform)

  await touchDrag(page, { x: box!.x + 30, y: box!.y + 220 }, { x: box!.x + box!.width * .45, y: box!.y + 224 }, 2, async () => {
    await expect.poll(() => foreground.evaluate(element => Number(element.style.getPropertyValue('--swipe-progress')))).toBeGreaterThan(0)
    expect(await roster.evaluate(element => getComputedStyle(element).transform)).toBe(rosterTransform)
  })
  await waitForSwipeIdle(page, '.foreground-layer')
  await expect(page.locator('.foreground-layer.active')).toHaveCount(0)
  await expect(page.locator('.roster-layer')).toBeVisible()
})

test('group touch dismissal uses the same right-only foreground motion', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await login(page)
  await page.getByRole('button', { name: 'Back to bots' }).click()
  const group = page.getByRole('button', { name: /Research crew/ })
  await group.click()
  await expect(page.getByText('Two candidates so far', { exact: true })).toBeVisible()
  const foreground = page.locator('.foreground-layer.active')
  const box = await foreground.boundingBox()
  expect(box).toBeTruthy()
  const url = page.url()

  await touchDrag(page, { x: box!.x + box!.width - 30, y: box!.y + 220 }, { x: box!.x + box!.width * .45, y: box!.y + 224 }, 2)
  await waitForSwipeIdle(page, '.foreground-layer')
  await expect(page).toHaveURL(url)
  await expect(page.getByText('Two candidates so far', { exact: true })).toBeVisible()

  await touchDrag(page, { x: box!.x + 30, y: box!.y + 220 }, { x: box!.x + box!.width * .55, y: box!.y + 224 }, 2)
  await expect(page.locator('.foreground-layer.active')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Research crew/ })).toBeVisible()
})

test('session-row touch motion reveals and conceals without dismissing the drawer', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await waitForSwipeIdle(page, '[data-testid="side-navigation-backdrop"]')
  const row = page.locator('.session-row').filter({ hasText: 'Saved default' })
  await expect(row).toBeVisible()
  const main = row.locator('.session-main')
  const box = await main.boundingBox()
  expect(box).toBeTruthy()
  await touchDrag(page, { x: box!.x + box!.width - 30, y: box!.y + 20 }, { x: box!.x + 30, y: box!.y + 22 })
  await expect(row.locator('.session-delete-action button')).toHaveAttribute('aria-hidden', 'false')
  await touchDrag(page, { x: box!.x + 30, y: box!.y + 20 }, { x: box!.x + box!.width - 30, y: box!.y + 22 })
  await expect(row.locator('.session-delete-action button')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByTestId('side-navigation-backdrop')).toHaveClass(/open/)
})

test('reduced motion still reaches drawer endpoints immediately', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const backdrop = page.getByTestId('side-navigation-backdrop')
  await expect.poll(() => backdrop.evaluate(element => element.style.getPropertyValue('--swipe-progress'))).toBe('0')
  const panel = page.locator('.side-drawer-panel')
  const box = await panel.boundingBox()
  expect(box).toBeTruthy()
  await touchDrag(page, { x: 10, y: box!.y + 160 }, { x: 10 + box!.width * .75, y: box!.y + 162 })
  await expect(backdrop).not.toHaveClass(/open/)
})

test('reloading returns to the launch screen because navigation is not persisted in history', async ({ page }) => {
  await login(page)
  const initialURL = page.url()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Cron Jobs' }).click()
  await expect(page.getByText('Cron Jobs')).toBeVisible()
  await expect(page).toHaveURL(initialURL)

  await page.reload()
  await expect(page).toHaveURL(initialURL)
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible()
})

test('a direct launch URL still selects its initial screen', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.getByText('Profile defaults, mobile preferences, and gateway administration.')).toBeVisible()
  await expect(page).toHaveURL(/\/settings$/)
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
