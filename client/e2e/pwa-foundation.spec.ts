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
    await expect(page.locator('.foreground-layer.active > .app-header .header-bot-button small')).toHaveText('saved-default')
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

test('animates a real roster pull with one haptic tick without opening the dragged row', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Real touch injection uses CDP; WebKit gets the shared feedback test below.')
  await login(page)
  await page.getByRole('button', { name: 'Back to bots' }).click()
  const indicator = page.locator('.pull-refresh')
  await page.evaluate(() => {
    ;(window as any).refreshTicks = []
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern: number[]) => { (window as any).refreshTicks.push(pattern); return true } })
  })
  const before = (await fixtureCalls(page)).calls.filter(call => call.method === 'session.list').length
  const row = page.getByRole('button', { name: 'Hermes', exact: true })
  const box = (await row.boundingBox())!
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  let move = 0
  await touchDrag(page, start, { x: start.x, y: start.y + 140 }, 4, async () => {
    move += 1
    await expect(indicator).toHaveAttribute('data-phase', move < 3 ? 'pulling' : 'armed')
    await expect(indicator).toBeVisible()
    const track = (await indicator.locator('.pull-refresh-track').boundingBox())!
    const ring = (await indicator.locator('.pull-refresh-ring').boundingBox())!
    expect(ring.x + ring.width / 2).toBeCloseTo(track.x + track.width / 2, 0)
    expect(ring.y + ring.height / 2).toBeCloseTo(track.y + track.height / 2, 0)
    if (move === 3) await page.screenshot({ path: testInfo.outputPath('refresh-armed.png') })
  })
  await expect(indicator).toHaveAttribute('data-phase', 'refreshing')
  await expect(indicator).toContainText('Refreshing')
  await page.screenshot({ path: testInfo.outputPath('refresh-spinning.png') })
  await expect.poll(async () => (await fixtureCalls(page)).calls.filter(call => call.method === 'session.list').length).toBeGreaterThan(before)
  await expect(indicator).toHaveAttribute('data-phase', 'idle')
  await expect(row).toBeVisible()
  expect(await page.evaluate(() => (window as any).refreshTicks)).toEqual([[20]])
})

test('shows shared pull feedback on a workspace screen and respects reduced motion', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Main model' })).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const indicator = page.locator('.pull-refresh')
  const dispatchTouch = async (type: string, y: number) => {
    await page.locator('.foreground-layer.active .view-container').evaluate((scroller, { type, y }) => {
      scroller.scrollTop = 0
      const event = new Event(type, { bubbles: true, cancelable: true })
      const touch = { identifier: 1, clientX: 180, clientY: y }
      Object.defineProperties(event, { touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [touch] }, changedTouches: { value: [touch] } })
      scroller.dispatchEvent(event)
    }, { type, y })
  }
  await dispatchTouch('touchstart', 100)
  await dispatchTouch('touchmove', 145)
  await expect(indicator).toHaveAttribute('data-phase', 'pulling')
  await expect(indicator).toContainText('Pull to refresh')
  await dispatchTouch('touchcancel', 145)
  await expect(indicator).toHaveAttribute('data-phase', 'idle')
  await dispatchTouch('touchstart', 100)
  await dispatchTouch('touchmove', 210)
  await expect(indicator).toHaveAttribute('data-phase', 'armed')
  await expect(indicator).toContainText('Release to refresh')
  await dispatchTouch('touchend', 210)
  await expect(indicator).toHaveAttribute('data-phase', 'refreshing')
  expect(await indicator.locator('.pull-refresh-ring').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
  await expect(indicator).toHaveAttribute('data-phase', 'idle')
  await expect(page.getByRole('heading', { name: 'Main model' })).toBeVisible()
})

test('uses the active profile character in a new chat without gateway version text', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'New session' }).click()

  const emptyChat = page.locator('.foreground-layer.active .empty-chat:visible').first()
  await expect(emptyChat.getByRole('heading', { name: 'What can Hermes do for you?' })).toBeVisible()
  await expect(emptyChat.locator('.bot-face')).toBeVisible()
  await expect(emptyChat).not.toContainText('This conversation runs on')
  await expect(emptyChat).not.toContainText('0.20.5')
})

test('keeps session model and effort left of status on narrow screens with context usage', async ({ page }, testInfo) => {
  await login(page, '/session/footer-fixture')
  const model = page.getByRole('group', { name: 'Session model and effort' })
  const status = page.locator('.session-activity')
  await expect(model).toContainText('fixture/a-very-long-model-name-that-must-not-hide-the-status')
  await expect(page.locator('.composer-model-effort')).toHaveText('high')
  await expect(status).toHaveText('Ready')
  await expect(page.locator('.context-usage')).toContainText('25,000 / 100,000')

  const checkLayout = async () => {
    const modelBox = (await model.boundingBox())!
    const statusBox = (await status.boundingBox())!
    expect(modelBox.width).toBeGreaterThan(0)
    expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(statusBox.x)
    expect(Math.abs(modelBox.y - statusBox.y)).toBeLessThan(2)
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.locator('.composer-model-effort')).toBeVisible()
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.getByLabel('Message Hermes').blur()
    await checkLayout()
    await page.getByLabel('Message Hermes').focus()
    await checkLayout()
  }
  await page.screenshot({ path: testInfo.outputPath('footer-ready.png') })
  await page.getByLabel('Message Hermes').fill('hold footer activity')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(status).toHaveText('Hermes is working')
  await checkLayout()
  await expect(page.locator('.composer-model-effort')).toHaveText('high')
  await page.screenshot({ path: testInfo.outputPath('footer-working.png') })
})

test('keeps model and status clear of rounded screen corners with and without composer focus', async ({ page }) => {
  await login(page)
  const metadata = page.locator('.composer-meta')
  await page.getByLabel('Message Hermes').blur()

  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingLeft)).toBe('18px')
  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingRight)).toBe('18px')

  await page.getByLabel('Message Hermes').focus()
  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingLeft)).toBe('5px')
  await expect.poll(() => metadata.evaluate(element => getComputedStyle(element).paddingRight)).toBe('5px')
  for (const focused of [false, true]) {
    if (focused) await page.getByLabel('Message Hermes').focus()
    else await page.getByLabel('Message Hermes').blur()
    await expect.poll(() => page.locator('.composer-model').evaluate(element => getComputedStyle(element).paddingLeft)).toBe('8px')
    await expect.poll(() => page.locator('.session-activity').evaluate(element => getComputedStyle(element).paddingRight)).toBe('8px')
  }
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

test('keeps the composer inside a keyboard-reduced and panned visual viewport', async ({ page }) => {
  await login(page)
  const composer = page.getByLabel('Message Hermes')
  await expect(composer).toHaveAttribute('spellcheck', 'true')
  await expect(composer).toHaveAttribute('autocorrect', 'on')
  await expect(composer).toHaveAttribute('autocomplete', 'off')
  // Match the standalone full-height fallback without requiring installation.
  await page.addStyleTag({ content: '.mobile-shell { height: 100vh; }' })
  await composer.focus()

  // Desktop engines have no iOS keyboard. Keep the layout viewport full-size
  // while changing the visible region, as a Home Screen keyboard does.
  const setViewport = async (height: number, offsetTop: number, event: 'resize' | 'scroll') => {
    await page.evaluate(({ height, offsetTop, event }) => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop }
      })
      window.visualViewport!.dispatchEvent(new Event(event))
    }, { height, offsetTop, event })
  }
  const bounds = () => page.locator('.composer-wrap').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { bottom: rect.bottom, top: rect.top }
  })

  await setViewport(430, 0, 'resize')
  await expect.poll(async () => (await bounds()).bottom).toBeLessThanOrEqual(431)
  await expect.poll(async () => (await bounds()).top).toBeGreaterThanOrEqual(0)
  await composer.fill('Typing above the keyboard')

  await setViewport(430, 45, 'scroll')
  await expect.poll(async () => (await bounds()).bottom).toBeCloseTo(475, 0)
  await expect.poll(async () => (await bounds()).top).toBeGreaterThanOrEqual(45)

  await setViewport(360, 0, 'resize')
  await expect.poll(async () => (await bounds()).bottom).toBeLessThanOrEqual(361)

  await setViewport(844, 0, 'resize')
  await composer.blur()
  await expect.poll(async () => (await bounds()).bottom).toBeCloseTo(844, 0)
  await expect(composer).toHaveValue('Typing above the keyboard')
})

test('locks PWA page scale without blocking typing or single-touch scrolling', async ({ page }) => {
  await login(page)
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /user-scalable=no/)
  await expect(page.locator('html')).toHaveAttribute('data-page-zoom', 'locked')
  const composer = page.getByLabel('Message Hermes')
  await expect.poll(() => composer.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
  await composer.fill('Typing without page zoom')
  await expect(composer).toHaveValue('Typing without page zoom')
  const gestures = await page.evaluate(() => {
    const dispatch = (type: string, touches?: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      if (touches !== undefined) Object.defineProperty(event, 'touches', { value: Array(touches).fill({}) })
      document.querySelector('textarea')!.dispatchEvent(event)
      return event.defaultPrevented
    }
    return {
      pinch: dispatch('gesturestart'),
      doubleTap: dispatch('dblclick'),
      multiTouch: dispatch('touchmove', 2),
      singleTouch: dispatch('touchmove', 1),
      touchAction: getComputedStyle(document.documentElement).touchAction
    }
  })
  expect(gestures).toEqual({ pinch: true, doubleTap: true, multiTouch: true, singleTouch: false, touchAction: 'pan-x pan-y' })
})

test('compacts long agent activity into keyboard-accessible cards with independent output expansion', async ({ page, browserName }) => {
  await login(page, '/session/activity-fixture?profile=default')
  await expect(page.getByText('Follow-up answer', { exact: true })).toBeVisible()
  const cards = page.locator('.foreground-layer.active .agent-activity-card')
  await expect(cards).toHaveCount(2)
  const first = cards.first()
  await expect(first.locator(':scope > summary')).toContainText('13 reasoning blocks · 12 tool outputs')
  await expect(first).not.toHaveAttribute('open', '')
  await expect(first.getByText('Reasoning step 1', { exact: true })).not.toBeVisible()
  await expect(page.getByText('Activity fixture final answer', { exact: true })).toBeAttached()
  await expect(page.locator('.foreground-layer.active article.message')).toHaveCount(4)

  await first.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `/tmp/herm-bot-activity-collapsed-${browserName}.png` })
  await first.locator(':scope > summary').focus()
  await page.keyboard.press('Enter')
  await expect(first).toHaveAttribute('open', '')
  const rows = first.locator('.agent-activity-step')
  await expect(rows).toHaveCount(25)
  await rows.nth(0).locator('summary').click()
  await expect(first.getByText('Reasoning step 1', { exact: true })).toBeVisible()
  await expect(rows.nth(2)).not.toHaveAttribute('open', '')
  await rows.nth(1).locator('summary').click()
  await expect(rows.nth(1).locator('pre')).toBeVisible()
  expect(await rows.nth(1).locator('pre').evaluate(element => element.clientHeight)).toBeLessThanOrEqual(240)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await rows.nth(0).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `/tmp/herm-bot-activity-expanded-${browserName}.png` })

  await first.locator(':scope > summary').click()
  await expect(first).not.toHaveAttribute('open', '')
  await page.getByLabel('Message Hermes').fill('A new normal message')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Fixture answer: A new normal message', { exact: true })).toBeVisible()
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

test('a valid browser session supersedes a stale saved access token', async ({ page }) => {
  await login(page)
  const before = await fixtureCalls(page)
  await page.evaluate(() => {
    localStorage.setItem('hermes.remoteURL', window.location.origin)
    sessionStorage.setItem('hermes.token', 'stale-browser-token')
  })

  await page.reload()
  await expect(page.getByRole('region', { name: 'Bots' }).getByRole('button', { name: 'Hermes' })).toBeVisible()

  const after = await fixtureCalls(page)
  const reconnect = after.calls.slice(before.calls.length)
  expect(reconnect).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'http', path: '/api/auth/me' }),
    expect.objectContaining({ kind: 'http', path: '/api/auth/ws-ticket' }),
    expect.objectContaining({ kind: 'ws-connect' })
  ]))
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('hermes.token'))).toBeNull()
})

test('cold session deep links switch profile and normalize the URL', async ({ page }) => {
  await login(page, '/session/saved-work?profile=work')
  await expect(page.getByText('Durable reply from saved-work')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  const calls = (await fixtureCalls(page)).calls
  expect(calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'ws-connect', profile: 'work' }),
    expect.objectContaining({ kind: 'rpc', method: 'session.resume', params: expect.objectContaining({ profile: 'work', session_id: 'saved-work', source: 'mobile' }) })
  ]))

  // Reloading no longer replays the session URL: in-memory navigation resets
  // to the roster while the browser URL remains the root.
  await page.reload()
  await expect(page.getByRole('searchbox', { name: 'Search bots' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
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

  await row.click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Two candidates so far', { exact: true })).toBeVisible()

  // Sending runs the desktop round engine locally: the user bubble lands
  // immediately, member turns fire against the gateway in the background.
  await page.getByLabel('Message Research crew').fill('hello crew')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('hello crew')).toBeVisible()

  // The top bar owns the exit, and in-app back lands on the roster.
  await page.getByRole('button', { name: 'Back to bots' }).click()
  await expect(row).toBeVisible()
})

test('runs the deterministic MCP OAuth flow through the browser adapter', async ({ page }) => {
  await page.addInitScript(() => {
    const opened: string[] = []
    Object.defineProperty(window, '__oauthOpened', { configurable: true, value: opened })
    window.open = ((url?: string | URL) => {
      opened.push(String(url))
      return null
    }) as typeof window.open
  })
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
  await page.getByRole('button', { name: /^MCP Servers/ }).click()
  await page.getByRole('button', { name: 'Authenticate fixture-oauth' }).click()

  await expect(page.getByText('Authorize the server in your browser, then return to Hermes.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as Window & { __oauthOpened?: string[] }).__oauthOpened ?? [])).toContain('https://auth.example/mcp')
  await expect(page.getByText('Authentication complete.')).toBeVisible({ timeout: 10_000 })

  const { calls } = await fixtureCalls(page)
  const start = calls.find(call => call.method === 'POST' && call.path === '/api/mcp/servers/fixture-oauth/auth')
  expect(start?.query).toEqual({ profile: 'default' })
  const polls = calls.filter(call => call.method === 'GET' && call.path === '/api/mcp/oauth/flows/fixture-mcp-flow')
  expect(polls.length).toBeGreaterThanOrEqual(2)
  expect(polls.every(call => Object.keys(call.query || {}).length === 0)).toBe(true)
})

test('runtime screen and navigation routes stay out of the browser URL', async ({ page }) => {
  await login(page)
  const rootURL = page.url()

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page).toHaveURL(rootURL)
  await expect(page.getByTestId('sessions-menu')).toHaveClass(/open/)

  await page.getByRole('button', { name: 'Capabilities' }).click()
  await expect(page).toHaveURL(rootURL)
  await expect(page.getByRole('heading', { name: 'Capabilities' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Skills/ })).toBeVisible()

  await page.getByRole('navigation', { name: 'Bot workspace' }).getByRole('button', { name: 'Automations' }).click()
  await expect(page).toHaveURL(rootURL)
  const automationList = page.locator('.cron-job-list')
  await expect(page.getByRole('heading', { name: 'Cron jobs' })).toHaveCount(0)
  const newAutomation = automationList.locator(':scope > :first-child')
  await expect(newAutomation).toHaveAccessibleName('New automations')
  await expect(page.getByRole('button', { name: 'Refresh cron jobs' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Blueprints' })).toHaveCount(0)
  await expect(page.getByText('Showing cached jobs. Pull to refresh.')).toHaveCount(0)
  await newAutomation.click()
  const createDialog = page.getByRole('dialog', { name: 'New automation' })
  await expect(createDialog.getByRole('button', { name: 'Use a blueprint' })).toBeVisible()
  await expect(createDialog.getByRole('button', { name: 'Create from scratch' })).toBeVisible()
  await createDialog.getByRole('button', { name: 'Cancel' }).click()
})

test('workspace tabs share a stable header without redundant menu buttons', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()

  const menuNavigation = page.getByTestId('sessions-menu').getByRole('navigation', { name: 'Bot workspace' })
  await expect(menuNavigation.locator('.bot-workspace-tab span')).toHaveCount(4)
  await expect(menuNavigation.locator('.bot-workspace-tab span').first()).toBeHidden()

  const sessionsList = page.getByRole('region', { name: 'Sessions' })
  await expect(page.getByText('Recent sessions')).toHaveCount(0)
  const newSessionRow = sessionsList.locator(':scope > :first-child')
  await expect(newSessionRow).toHaveAccessibleName('New session')
  const newSessionBackground = await newSessionRow.evaluate(element => getComputedStyle(element).backgroundColor)
  const newSessionHeight = await newSessionRow.evaluate(element => element.getBoundingClientRect().height)
  const sessionBackground = await sessionsList.locator('.session-main').first().evaluate(element => getComputedStyle(element).backgroundColor)
  expect(newSessionBackground).toBe(sessionBackground)

  const sessionHeader = page.getByTestId('sessions-menu').locator('.bot-workspace-header')
  await expect(sessionHeader).toBeVisible()
  const sessionTopPadding = await page.locator('.sessions-menu-body').evaluate(element => getComputedStyle(element).paddingTop)
  const sessionIdentity = await sessionHeader.locator('.header-bot-button').boundingBox()
  expect(sessionIdentity).toBeTruthy()

  await page.getByRole('button', { name: 'Automations' }).click()
  const foregroundNavigation = page.locator('.foreground-layer.active').getByRole('navigation', { name: 'Bot workspace' })
  await expect(foregroundNavigation.locator('.bot-workspace-tab span').first()).toBeHidden()
  for (const destination of [
    { button: 'Automations', subtitle: 'Automations' },
    { button: 'Capabilities', subtitle: 'Capabilities' },
    { button: 'Models', subtitle: 'Models' }
  ]) {
    if (destination.button !== 'Automations') {
      await page.getByRole('navigation', { name: 'Bot workspace' }).getByRole('button', { name: destination.button }).click()
    }
    const header = page.locator('.foreground-layer.active > .bot-workspace-header')
    await expect(header.locator('.header-bot-button small')).toHaveText(destination.subtitle)
    if (destination.button === 'Automations') {
      const newAutomation = page.locator('.foreground-layer.active .cron-new-automation')
      await expect(newAutomation).toBeVisible()
      const newAutomationHeight = await newAutomation.evaluate(element => element.getBoundingClientRect().height)
      expect(newAutomationHeight).toBe(newSessionHeight)
    }
    await expect(header.getByRole('button', { name: 'Open navigation' })).toHaveCount(0)
    const contentTopPadding = await page.locator('.foreground-layer.active .page-screen').evaluate(element => getComputedStyle(element).paddingTop)
    expect(contentTopPadding).toBe(sessionTopPadding)
    const identity = await header.locator('.header-bot-button').boundingBox()
    expect(identity?.x).toBe(sessionIdentity?.x)
    expect(identity?.width).toBe(sessionIdentity?.width)
  }

  await page.getByRole('navigation', { name: 'Bot workspace' }).getByRole('button', { name: 'Automations' }).click()
  await page.getByRole('button', { name: 'New automations' }).click()
  await page.getByRole('dialog', { name: 'New automation' }).getByRole('button', { name: 'Create from scratch' }).click()
  const workspaceHeader = page.locator('.foreground-layer.active > .bot-workspace-header')
  await expect(workspaceHeader.locator('.header-bot-button small')).toHaveText('New job')
  await expect(page.getByRole('heading', { name: 'New job' })).toHaveCount(0)
  await expect(page.getByRole('button', { exact: true, name: 'Back' })).toHaveCount(1)
  const nestedPageTopPadding = await page.locator('.foreground-layer.active .page-screen').evaluate(element => getComputedStyle(element).paddingTop)
  expect(nestedPageTopPadding).toBe(sessionTopPadding)

  await page.getByRole('button', { exact: true, name: 'Back' }).click()
  await page.getByRole('navigation', { name: 'Bot workspace' }).getByRole('button', { name: 'Capabilities' }).click()
  await page.getByRole('button', { name: /^Skills/ }).click()
  await expect(workspaceHeader.locator('.header-bot-button small')).toHaveText('Skills')
  await expect(page.getByRole('heading', { exact: true, name: 'Skills' })).toHaveCount(0)
  await expect(page.getByRole('button', { exact: true, name: 'Back' })).toHaveCount(1)

  await page.getByRole('button', { exact: true, name: 'Back' }).click()
  await page.getByRole('button', { name: /^MCP/ }).click()
  await page.getByRole('button', { exact: true, name: 'Add' }).click()
  await expect(workspaceHeader.locator('.header-bot-button small')).toHaveText('Add server')
  await expect(page.getByRole('heading', { exact: true, name: 'Add server' })).toHaveCount(0)
  await expect(page.getByRole('button', { exact: true, name: 'Back' })).toHaveCount(1)
  await page.getByRole('button', { exact: true, name: 'Back' }).click()
  await expect(workspaceHeader.locator('.header-bot-button small')).toHaveText('MCP')
  await expect(page.getByRole('button', { exact: true, name: 'Add' })).toBeVisible()
})

test('bot configuration destinations return to the sessions menu', async ({ page }) => {
  await login(page)
  const rootURL = page.url()

  for (const destination of [
    { button: 'Models', marker: 'Main model', markerRole: 'heading' as const },
    { button: 'Capabilities', marker: /^Skills/, markerRole: 'button' as const },
    { button: 'Automations', marker: 'New automations', markerRole: 'button' as const }
  ]) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByRole('button', { name: destination.button, exact: true }).click()
    await expect(page).toHaveURL(rootURL)
    await expect(page.getByRole(destination.markerRole, { name: destination.marker })).toBeVisible()
    if (destination.button === 'Models') {
      await expect(page.getByRole('heading', { exact: true, name: 'Models' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Refresh models' })).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Back to menu' }).click()
    await expect(page.getByTestId('sessions-menu')).toHaveClass(/open/)
    await expect(page.getByRole('navigation', { name: 'Bot workspace' })).toBeVisible()
    await page.getByRole('button', { exact: true, name: 'Back' }).click()
    await expect(page.getByLabel('Message Hermes')).toBeVisible()
  }
})

test('reloading resets the in-memory navigation page to the startup screen', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByTestId('sessions-menu')).toHaveClass(/open/)
  await expect(page).toHaveURL(/\/$/)

  await page.reload()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('searchbox', { name: 'Search bots' })).toBeVisible()
  await expect(page.getByTestId('sessions-menu')).toHaveCount(0)
})

test('navigation-page back button dismisses in memory without changing the URL', async ({ page }) => {
  await login(page)
  const previousURL = page.url()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page).toHaveURL(previousURL)

  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(previousURL)
  await expect(page.getByTestId('sessions-menu')).not.toHaveClass(/open/)
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
})

test('navigation-page edge swipe dismisses with in-memory back', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const navigationPage = page.getByTestId('sessions-menu')
  await expect(navigationPage).toHaveClass(/open/)
  const box = await navigationPage.boundingBox()
  expect(box).toBeTruthy()

  await touchDrag(page, { x: box!.x + 3, y: box!.y + 240 }, { x: box!.x + box!.width * .6, y: box!.y + 244 }, 2)
  await waitForSwipeIdle(page, '[data-testid="sessions-menu"]')
  await expect(navigationPage).not.toHaveClass(/open/)
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
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

test('session-row touch motion reveals and conceals without dismissing the navigation page', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Pointer touch animation coverage uses Chromium CDP input.')
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByTestId('sessions-menu')).toHaveClass(/open/)
  const row = page.locator('.session-row').filter({ hasText: 'Saved default' })
  await expect(row).toBeVisible()
  const main = row.locator('.session-main')
  const box = await main.boundingBox()
  expect(box).toBeTruthy()
  await touchDrag(page, { x: box!.x + box!.width - 30, y: box!.y + 20 }, { x: box!.x + 30, y: box!.y + 22 })
  await expect(row.locator('.session-delete-action button')).toHaveAttribute('aria-hidden', 'false')
  await touchDrag(page, { x: box!.x + 30, y: box!.y + 20 }, { x: box!.x + box!.width - 30, y: box!.y + 22 })
  await expect(row.locator('.session-delete-action button')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByTestId('sessions-menu')).toHaveClass(/open/)
})

test('reloading resets a runtime screen to the startup route', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Automations' }).click()
  await expect(page.getByRole('button', { name: 'New automations' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  await page.reload()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('searchbox', { name: 'Search bots' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Cron jobs' })).toHaveCount(0)
})

test('autosaves a Chat setting through the profile-scoped config adapter', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Back to bots' }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: /^Chat/ }).click()

  const personality = page.getByLabel('Personality')
  await expect(personality).toHaveValue('default')
  await personality.fill('concise')
  await expect(personality).toHaveValue('concise')

  await expect.poll(async () => {
    const calls = (await fixtureCalls(page)).calls
    return calls.filter(call => call.kind === 'http' && call.method === 'PUT' && call.path === '/api/config')
  }).toEqual([
    expect.objectContaining({
      body: { config: { display: { personality: 'concise' } } },
      query: { profile: 'default' }
    })
  ])

  await page.reload()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: /^Chat/ }).click()
  await expect(page.getByLabel('Personality')).toHaveValue('concise')
})

test('a screen URL is consumed as a cold-start input', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.getByText('Profile defaults, mobile preferences, and gateway administration.')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
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
