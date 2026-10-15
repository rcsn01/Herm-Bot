import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const origin = 'http://127.0.0.1:5176'
const clients = new Map()
const tickets = new Map()
let sequence = 0

const mime = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.webmanifest', 'application/manifest+json; charset=utf-8']
])
const cookie = req => /(?:^|;\s*)fixture_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]
const initialProfiles = () => [
  {
    name: 'default', is_default: true,
    ui_meta: {
      'hermes-bots': { custom: true, shape: 'blobatar:12:organic', title: 'Hermes' },
      'hermes-bots-groups': {
        version: 3, updatedAt: 1_700_000_000_000,
        rooms: { 'id:r-crew': {
          name: 'Research crew', roomId: 'r-crew', revision: 3,
          members: [{ name: 'codex' }, { name: 'scout' }],
          log: [
            { at: 1_700_000_000_000, from: { kind: 'user', name: 'You' }, text: 'Find the specs' },
            { at: 1_700_000_060_000, from: { kind: 'member', name: 'Codex' }, text: 'Two candidates so far' }
          ]
        } }, deleted: {}
      }
    }
  },
  {
    name: 'work',
    ui_meta: { 'hermes-bots': { custom: true, image: 'data:image/png;base64,T0xE', imageKind: 'photo', shape: 'circle' } }
  }
]
const stateFor = id => {
  if (!clients.has(id)) clients.set(id, {
    assets: new Map(),
    calls: [],
    config: { display: { personality: 'default' } },
    messages: new Map(),
    archives: new Map(),
    restoredSessions: new Map(),
    deletedSessions: new Set(),
    sockets: new Set(),
    controls: {},
    histories: [],
    deferred: [],
    mcpOAuth: null,
    profiles: initialProfiles()
  })
  return clients.get(id)
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}
const body = req => new Promise((resolve, reject) => {
  let value = ''
  req.on('data', chunk => { value += chunk; if (value.length > 100_000) reject(new Error('body too large')) })
  req.on('end', () => { try { resolve(value ? JSON.parse(value) : {}) } catch (error) { reject(error) } })
  req.on('error', reject)
})
const waitForControl = (state, control) => state.controls[control] ? new Promise(resolve => state.deferred.push({ control, resolve })) : Promise.resolve()
// Eight seconds of PCM silence, decoded by real browser media elements.
const speechFixture = () => {
  const buffer = Buffer.alloc(44 + 8000 * 8)
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(8000, 28); buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40); buffer.fill(128, 44)
  return `data:audio/wav;base64,${buffer.toString('base64')}`
}
const initialMessages = id => id.startsWith('created-') ? [] : id === 'activity-fixture' ? [
  { row_id: 1, role: 'user', content: 'Inspect the project' },
  ...Array.from({ length: 12 }, (_, index) => [
    { row_id: 2 + index * 2, role: 'assistant', content: '', reasoning: `Reasoning step ${index + 1}` },
    { row_id: 3 + index * 2, role: 'tool', content: `Output step ${index + 1}\n${'Detailed fixture output. '.repeat(150)}` }
  ]).flat(),
  { row_id: 26, role: 'assistant', content: 'Activity fixture final answer', reasoning: 'Final validation' },
  { row_id: 27, role: 'user', content: 'Run another check' },
  { row_id: 28, role: 'assistant', content: '', reasoning: 'Follow-up reasoning' },
  { row_id: 29, role: 'tool', content: 'Another output' },
  { row_id: 30, role: 'assistant', content: 'Follow-up answer' }
] : [
  { row_id: 1, role: 'user', content: `Question saved in ${id}` },
  { row_id: 2, role: 'assistant', content: `Durable reply from ${id}` }
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin)
  try {
    const fixtureId = cookie(req)
    // Controls and recording stay reachable even when gateway routes fail.
    if (url.pathname === '/api/fixture-control' && req.method === 'POST') {
      if (!fixtureId) return json(res, 401, { detail: 'Authentication required' })
      const state = stateFor(fixtureId)
      const update = await body(req)
      if (update.reset === true) state.controls = {}
      for (const key of ['rejectHandshake', 'serverFailure', 'authExpired', 'delayHistory', 'delayAttachments', 'delaySubmission', 'delayInterrupt', 'delayTranscription', 'delaySpeech', 'holdTurn', 'rejectInterrupt', 'markdownStream', 'discovery', 'failSessionList', 'failRestore', 'failArchiveList', 'delayRestore', 'delaySessionList', 'pushFailure', 'pushExpired', 'pushUnknown', 'delayPushTest']) {
        if (typeof update[key] === 'boolean') state.controls[key] = update[key]
      }
      if (typeof update.missingSession === 'string' || update.missingSession === null) state.controls.missingSession = update.missingSession
      if (typeof update.failResumeSession === 'string' || update.failResumeSession === null) state.controls.failResumeSession = update.failResumeSession
      if (typeof update.longHistorySession === 'string' && update.longHistorySession.length <= 256) {
        const stored = update.longHistorySession
        state.messages.set(stored, [...initialMessages(stored), ...Array.from({ length: 30 }, (_, i) => ({ row_id: i + 3, role: i % 2 ? 'assistant' : 'user', content: `Saved history ${i + 1}. ${'Readable fixture paragraph. '.repeat(40)}` }))])
      }
      if (['delta', 'complete', 'error'].includes(update.answerEvent?.type)) {
        for (const ws of state.sockets) {
          if (!ws.fixtureAnswer || ws.readyState !== 1) continue
          const type = update.answerEvent.type
          const delta = typeof update.answerEvent.delta === 'string' ? update.answerEvent.delta : ''
          if (type === 'delta') ws.fixtureAnswer.content += delta
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {
            type: type === 'delta' ? 'message.delta' : type === 'complete' ? 'message.complete' : 'error',
            session_id: ws.fixtureRuntime,
            payload: type === 'delta' ? { delta } : type === 'error' ? { message: 'Fixture stream failed' } : {}
          } }))
          if (type !== 'delta') ws.fixtureAnswer = null
        }
      }
      if (update.closeSockets === true) for (const ws of state.sockets) ws.close(1012, 'fixture interruption')
      if (!state.controls.delayHistory) for (const release of state.histories.splice(0)) release()
      state.deferred = state.deferred.filter(waiter => { if (state.controls[waiter.control]) return true; waiter.resolve(); return false })
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/fixture-calls' && fixtureId) return json(res, 200, { calls: stateFor(fixtureId).calls })
    const controls = fixtureId ? stateFor(fixtureId).controls : {}
    if ((url.pathname.startsWith('/api/') || url.pathname === '/auth/logout') && controls.authExpired) return json(res, 401, { detail: 'Fixture session expired' })
    if ((url.pathname.startsWith('/api/') || url.pathname === '/auth/logout') && controls.serverFailure) return json(res, 503, { detail: 'Fixture gateway unavailable' })
    if (url.pathname === '/api/status') {
      const current = cookie(req)
      const profiles = current
        ? stateFor(current).profiles.map(profile => ({ is_default: profile.is_default === true, name: profile.name }))
        : [{ name: 'default', is_default: true }, { name: 'work' }]
      return json(res, 200, { auth_required: true, auth_providers: ['password'], desktop_contract: 6, profiles })
    }
    if (url.pathname === '/api/auth/providers') return json(res, 200, { providers: [
      { name: 'password', display_name: 'Test account', supports_password: true }
    ] })
    if (url.pathname === '/auth/password-login' && req.method === 'POST') {
      const credentials = await body(req)
      if (credentials.provider !== 'password' || credentials.password !== 'fixture-password') {
        return json(res, 401, { detail: 'Invalid fixture credentials' })
      }
      const id = `browser-${++sequence}`
      stateFor(id).userId = credentials.username
      stateFor(id).calls.push({ kind: 'http', method: req.method, path: url.pathname, body: credentials })
      return json(res, 200, { ok: true }, { 'set-cookie': `fixture_session=${id}; Path=/; HttpOnly; SameSite=Lax` })
    }
    const id = cookie(req)
    if (url.pathname.startsWith('/push/v1/')) {
      if (!id || controls.authExpired) return json(res, 401, { error: 'sign_in_required' })
      const state = stateFor(id)
      const call = { kind: 'http', method: req.method, path: url.pathname }
      state.calls.push(call)
      if (controls.pushFailure) return json(res, 503, { error: 'relay_unavailable' })
      if (url.pathname.endsWith('/public-key')) return json(res, 200, { version: 2, publicKey: Buffer.from([4, ...Array(64).fill(0)]).toString('base64url') })
      const value = await body(req)
      call.body = value
      if (url.pathname.endsWith('/status')) return json(res, 200, { version: 2, owner: 'a'.repeat(64), registered: Boolean(state.pushBinding && value.endpoint), binding: value.endpoint ? state.pushBinding ?? null : null })
      if (url.pathname.endsWith('/subscriptions')) {
        const removed = state.pushBinding === value.binding ? 1 : 0
        state.pushBinding = req.method === 'PUT' ? 'fixture-binding' : null
        return json(res, 200, { ok: true, binding: state.pushBinding, removed })
      }
      if (url.pathname.endsWith('/test')) {
        await waitForControl(state, 'delayPushTest')
        return json(res, 200, { outcome: controls.pushExpired ? 'expired' : controls.pushUnknown ? 'unknown' : 'accepted', retryAfter: 30 })
      }
      return json(res, 404, { error: 'not_found' })
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      if (!id) return json(res, 401, { detail: 'Authentication required' })
      const state = stateFor(id)
      state.calls.push({ kind: 'http', method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
      if (url.pathname === '/auth/logout') return json(res, 200, { ok: true }, { 'set-cookie': 'fixture_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' })
      if (url.pathname === '/api/fixture-update') { state.swVersion = (state.swVersion ?? 0) + 1; return json(res, 200, { ok: true }) }
      if (url.pathname === '/api/audio/transcribe') {
        await waitForControl(state, 'delayTranscription')
        return json(res, 200, { transcript: 'Fixture spoken words' })
      }
      if (url.pathname === '/api/audio/speak') {
        await waitForControl(state, 'delaySpeech')
        return json(res, 200, { data_url: speechFixture() })
      }
      if (url.pathname === '/api/auth/me') return json(res, 200, { user_id: state.userId ?? 'fixture-user', provider: 'password', org_id: '', expires_at: 4_102_444_800 })
      if (url.pathname === '/api/auth/ws-ticket' && req.method === 'POST') {
        const ticket = `ticket-${++sequence}`
        tickets.set(ticket, { id, used: false })
        return json(res, 200, { ticket })
      }
      if (url.pathname === '/api/sessions' && url.searchParams.get('archived') === 'only') {
        if (state.controls.failArchiveList) return json(res, 404, { detail: 'Archive route unavailable' })
        const profile = url.searchParams.get('profile') || 'default'
        if (!state.archives.has(profile)) state.archives.set(profile, [{ id: `archived-${profile}`, title: `Archived ${profile} notes`, preview: '<script>Literal archived preview</script>', message_count: 8 }])
        return json(res, 200, { sessions: state.archives.get(profile).slice(0, Number(url.searchParams.get('limit') || 100)) })
      }
      const sessionItem = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
      if (sessionItem && ['PATCH', 'DELETE'].includes(req.method)) {
        const profile = url.searchParams.get('profile') || 'default'
        const stored = decodeURIComponent(sessionItem[1])
        const recorded = state.calls.at(-1)
        const payload = req.method === 'PATCH' ? await body(req) : null
        recorded.body = payload
        if (payload?.archived === false) {
          await waitForControl(state, 'delayRestore')
          if (state.controls.failRestore) return json(res, 503, { detail: 'Restore failed' })
          const restored = state.archives.get(profile)?.find(row => row.id === stored)
          if (restored) state.restoredSessions.set(`${profile}:${stored}`, { ...restored, source: 'mobile', started_at: 1_500_000_000 })
          state.archives.set(profile, (state.archives.get(profile) || []).filter(row => row.id !== stored))
          state.calls.push({ kind: 'fixture', method: 'restore.complete', profile })
        }
        if (req.method === 'DELETE') {
          state.deletedSessions.add(`${profile}:${stored}`)
          state.archives.set(profile, (state.archives.get(profile) || []).filter(row => row.id !== stored))
        }
        return json(res, 200, { ok: true })
      }
      const match = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
      if (match && req.method === 'GET') {
        const stored = decodeURIComponent(match[1])
        if (state.controls.delayHistory) await new Promise(resolve => state.histories.push(resolve))
        if (state.controls.missingSession === stored) return json(res, 404, { detail: 'Session not found' })
        const messages = state.messages.get(stored) ?? initialMessages(stored)
        return json(res, 200, { messages, pagination: { offset: Number(url.searchParams.get('offset') || 0), limit: 80, returned: messages.length } })
      }
      if (url.pathname === '/api/cron/jobs' && req.method === 'GET') return json(res, 200, [{
        enabled: true, id: 'fixture-context-job', name: 'Daily notes', prompt: 'Summarize today.',
        schedule: { display: 'Every day at 5:00 PM', expr: 'every day 5pm', kind: 'natural' }
      }])
      if (url.pathname === '/api/cron/jobs' && req.method === 'POST') {
        const payload = await body(req)
        state.calls.at(-1).body = payload
        state.cronJob = { ...payload, enabled: true, id: 'created-fixture-job' }
        return json(res, 200, state.cronJob)
      }
      if (url.pathname === '/api/cron/jobs/created-fixture-job' && req.method === 'GET' && state.cronJob) return json(res, 200, state.cronJob)
      if (url.pathname === '/api/cron/jobs/created-fixture-job/runs' && req.method === 'GET') return json(res, 200, { runs: [] })
      if (url.pathname === '/api/cron/delivery-targets' && req.method === 'GET') return json(res, 200, { targets: [
        { home_env_var: null, home_target_set: true, id: 'local', name: 'Local storage' },
        { home_env_var: 'TELEGRAM_HOME', home_target_set: true, id: 'telegram', name: 'Telegram' }
      ] })
      if (url.pathname === '/api/skills' && req.method === 'GET') return json(res, 200, [
        ['browser', 'Browse websites'], ['calendar', 'Read calendars'], ['email', 'Read and send email'], ['files', 'Work with files'],
        ['research', 'Research a topic'], ['terminal', 'Run terminal commands'], ['weather', 'Check forecasts']
      ].map(([name, description]) => ({ category: 'fixture', description, enabled: true, name })))
      if (url.pathname === '/api/tools/toolsets' && req.method === 'GET') return json(res, 200, [
        { configured: true, description: 'Search the web', enabled: true, label: 'Web search', name: 'web_search', tools: [] },
        { configured: true, description: 'Use a browser', enabled: true, label: 'Browser', name: 'browser', tools: [] }
      ])
      if (url.pathname === '/api/config/schema' && req.method === 'GET') return json(res, 200, { fields: {
        'display.personality': { description: 'Personality', type: 'string' }
      } })
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, state.config)
      if (url.pathname === '/api/config' && req.method === 'PUT') {
        const payload = await body(req)
        state.calls.at(-1).body = payload
        const patch = payload?.config && typeof payload.config === 'object' ? payload.config : {}
        const display = patch.display && typeof patch.display === 'object' ? patch.display : undefined
        state.config = {
          ...state.config,
          ...patch,
          ...(display ? { display: { ...state.config.display, ...display } } : {})
        }
        return json(res, 200, { ok: true })
      }
      if (url.pathname === '/api/model/options' && req.method === 'GET') return json(res, 200, { providers: [
        { authenticated: true, models: ['fixture/fast', 'fixture/deep'], name: 'Fixture AI', slug: 'fixture' },
        { authenticated: true, models: ['local/test'], name: 'Local', slug: 'local' }
      ] })
      if (url.pathname === '/api/cron/blueprints' && req.method === 'GET') return json(res, 200, { blueprints: [
        {
          appUrl: 'https://example.test/calendar', category: 'Productivity', command: 'calendar-digest',
          description: 'Summarize upcoming calendar events and prepare a daily briefing.',
          fields: [
            { default: '09:00', help: 'Local delivery time.', label: 'Delivery time', name: 'time', optional: false, options: [], type: 'time' },
            { default: 'mon,tue,wed,thu,fri', help: 'Days when this automation should run.', label: 'Weekdays', name: 'weekdays', optional: false, options: [], type: 'weekdays' },
            { default: 'concise', help: 'Controls the amount of detail.', label: 'Style', name: 'style', optional: false, options: ['concise', 'detailed'], type: 'enum' },
            { default: '', help: 'Extra instructions for the briefing.', label: 'Instructions', name: 'instructions', optional: true, options: [], type: 'text' }
          ],
          key: 'calendar-digest', tags: ['calendar', 'daily'], title: 'Daily calendar briefing'
        }
      ] })
      if (url.pathname === '/api/mcp/servers' && req.method === 'GET') return json(res, 200, { servers: [
        { args: [], auth: 'oauth', command: null, enabled: true, name: 'fixture-oauth', tools: [], transport: 'streamable_http', url: 'https://mcp.example' }
      ] })
      const mcpAuthMatch = /^\/api\/mcp\/servers\/([^/]+)\/auth$/.exec(url.pathname)
      if (mcpAuthMatch && req.method === 'POST') {
        state.mcpOAuth = { flowId: 'fixture-mcp-flow', polls: 0, cancelled: false, serverName: decodeURIComponent(mcpAuthMatch[1]) }
        return json(res, 200, { authorization_url: 'https://auth.example/mcp', error: null, flow_id: state.mcpOAuth.flowId, server_name: state.mcpOAuth.serverName, status: 'authorization_required' })
      }
      const mcpFlowMatch = /^\/api\/mcp\/oauth\/flows\/([^/]+)$/.exec(url.pathname)
      if (mcpFlowMatch && state.mcpOAuth?.flowId === decodeURIComponent(mcpFlowMatch[1])) {
        if (req.method === 'DELETE') {
          state.mcpOAuth.cancelled = true
          return json(res, 200, { ok: true, status: 'cancelled' })
        }
        state.mcpOAuth.polls += 1
        return json(res, 200, {
          authorization_url: 'https://auth.example/mcp',
          error: null,
          flow_id: state.mcpOAuth.flowId,
          server_name: state.mcpOAuth.serverName,
          status: state.mcpOAuth.polls >= 2 ? 'approved' : 'authorization_required'
        })
      }
      if (url.pathname === '/api/private-fixture') return json(res, 200, { secret: 'cookie-private-response' })
      if (url.pathname === '/api/fixture-calls') return json(res, 200, { calls: state.calls })
      return json(res, 404, { detail: 'Fixture API route not found' })
    }

    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    // App-shell paths: session deep links plus known startup screen paths
    // served offline by the service worker policy (see src/pwa/policy.ts).
    if (!relative || url.pathname === '/' || /^\/(?:session|bot|group|sessions|capabilities|cron|settings|navigation)(?:\/|$)/.test(url.pathname)) relative = 'index.html'
    const target = path.resolve(root, relative)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return json(res, 404, { detail: 'Not found' })
    try {
      let content = await fs.readFile(target)
      if (relative === 'sw.js') content = Buffer.concat([content, Buffer.from(`\n// fixture update ${cookie(req) ? stateFor(cookie(req)).swVersion ?? 0 : 0}\n`)])
      res.writeHead(200, { 'content-type': mime.get(path.extname(target)) || 'application/octet-stream' })
      res.end(content)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
    }
  } catch (error) {
    json(res, 500, { detail: error instanceof Error ? error.message : 'fixture failure' })
  }
})

const sockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, origin)
  const id = cookie(req)
  const ticket = tickets.get(url.searchParams.get('ticket'))
  if (url.pathname !== '/api/ws' || req.headers.origin !== origin || !id || !ticket || ticket.id !== id || ticket.used) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return
  }
  const state = stateFor(id)
  state.calls.push({ kind: 'ws-handshake', profile: url.searchParams.get('profile') || 'default' })
  if (state.controls.rejectHandshake || state.controls.serverFailure || state.controls.authExpired) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return
  }
  ticket.used = true
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req, id, url.searchParams.get('profile') || 'default'))
})

sockets.on('connection', (ws, _req, id, profile) => {
  const state = stateFor(id)
  state.sockets.add(ws)
  ws.on('close', () => state.sockets.delete(ws))
  let currentStored = `created-${profile}`
  state.calls.push({ kind: 'ws-connect', profile })
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))
  ws.on('message', async raw => {
    const request = JSON.parse(raw.toString())
    const params = request.params || {}
    state.calls.push({ kind: 'rpc', method: request.method, params, profile })
    const gate = ({ 'file.attach': 'delayAttachments', 'image.attach_bytes': 'delayAttachments', 'prompt.submit': 'delaySubmission', 'session.interrupt': 'delayInterrupt' })[request.method]
    if (gate) await waitForControl(state, gate)
    if (ws.readyState !== 1) return
    const stored = params.session_id || `created-${profile}`
    const runtime = `runtime-${profile}-${stored}`
    let result
    let rpcError
    if (request.method === 'session.resume' && state.controls.failResumeSession === stored) {
      rpcError = { code: 'FIXTURE_RESUME_FAILED', message: 'Fixture resume failed' }
    } else if (request.method === 'session.resume' && state.controls.missingSession === stored) {
      rpcError = { code: 'SESSION_NOT_FOUND', message: 'Session not found' }
    } else if (request.method === 'session.create' || request.method === 'session.resume') {
      currentStored = stored
      ws.fixtureRuntime = runtime
      ws.fixtureAnswer = null
      result = { session_id: runtime, stored_session_id: stored, info: { desktop_contract: 6, model: stored === 'footer-fixture' ? 'fixture/a-very-long-model-name-that-must-not-hide-the-status' : 'fixture/test-model', reasoning_effort: 'high', title: stored, ...(stored === 'footer-fixture' ? { usage: { total: 25000, context_limit: 100000 } } : {}) } }
    } else if (request.method === 'session.history') {
      result = { messages: state.messages.get(stored) ?? initialMessages(stored) }
    } else if (request.method === 'session.list') {
      await waitForControl(state, 'delaySessionList')
      if (state.controls.failSessionList) rpcError = { code: 'FIXTURE_LIST_FAILED', message: 'Fixture list failed' }
      // The 'Group: ' row is newer on purpose: opening a bot must skip the
      // desktop's group-plumbing sessions and land on the human conversation.
      result = { sessions: [
        { id: `saved-${params.profile || profile}`, title: `Saved ${params.profile || profile}`, preview: 'Fixture transcript', source: 'mobile', started_at: 1_700_000_000, message_count: 2 },
        { id: 'plumb-group', title: 'Group: r-crew', preview: '[Group chat: "Research crew"]', source: 'ios', started_at: 1_700_000_500, message_count: 9 }
      ] }
      if (state.controls.discovery) {
        const currentProfile = params.profile || profile
        const rows = Array.from({ length: 70 }, (_, index) => ({ id: `discovery-${currentProfile}-${index}`, title: index === 55 ? 'Older needle notes' : index === 1 ? 'LongUnbrokenTitle'.repeat(20) : `Conversation ${index}`, preview: index === 0 ? 'LongUnbrokenPreview'.repeat(40) : `Preview ${index}`, source: index % 10 === 9 ? 'cron' : 'mobile', started_at: Math.floor(Date.now() / 1000) - index * 86400, message_count: index + 1 }))
        const restored = [...state.restoredSessions.entries()].filter(([key]) => key.startsWith(`${currentProfile}:`)).map(([, row]) => row)
        result = { sessions: [...rows, ...result.sessions, ...restored].filter(row => !state.deletedSessions.has(`${currentProfile}:${row.id}`)).slice(0, Number(params.limit || 30)) }
      }
    } else if (request.method === 'profiles.list') {
      result = { profiles: state.profiles }
    } else if (request.method === 'profiles.create') {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!/^[a-z0-9_-]{1,63}$/.test(name)) {
        rpcError = { code: -32602, message: 'Invalid profile name' }
      } else if (state.profiles.some(profile => profile.name === name)) {
        rpcError = { code: -32602, message: 'Profile already exists' }
      } else {
        const source = typeof params.clone_from === 'string' ? state.profiles.find(profile => profile.name === params.clone_from) : undefined
        const created = params.clone_all && source
          ? structuredClone(source)
          : { name }
        created.name = name
        created.is_default = false
        if (typeof params.description === 'string') created.description = params.description
        if (typeof params.model === 'string') created.model = { default: params.model, provider: params.provider || '' }
        if (typeof params.soul === 'string') created.soul = params.soul
        state.profiles.push(created)
        result = { name, ok: true, path: `/profiles/${name}` }
      }
    } else if (request.method === 'profiles.describe') {
      const profile = state.profiles.find(candidate => candidate.name === params.name)
      if (!profile) rpcError = { code: -32602, message: 'Profile not found' }
      else result = {
        description: profile.description || '',
        mcp_servers: profile.mcp_servers || [{ description: 'Fixture MCP server', enabled: true, name: 'fixture-mcp', transport: 'stdio' }],
        model: profile.model || { default: '', provider: '' },
        name: profile.name,
        skills: profile.skills || [{ description: 'Browse websites', enabled: true, name: 'browser' }, { description: 'Read calendars', enabled: true, name: 'calendar' }],
        soul: profile.soul || '',
        toolsets: profile.toolsets || [{ description: 'Search the web', enabled: true, name: 'web_search' }, { description: 'Use a browser', enabled: true, name: 'browser' }]
      }
    } else if (request.method === 'mcp.catalog') {
      result = { servers: [{ description: 'Fixture MCP server', name: 'fixture-mcp', transport: 'stdio' }, { description: 'Catalog-only server', name: 'catalog-mcp', transport: 'http' }] }
    } else if (request.method === 'model.options') {
      result = { providers: [{ authenticated: true, models: ['fixture/fast', 'fixture/deep', 'fixture/expensive'], name: 'Fixture AI', slug: 'fixture' }, { authenticated: true, models: ['local/test'], name: 'Local', slug: 'local' }] }
    } else if (request.method === 'profiles.configure') {
      const profile = state.profiles.find(candidate => candidate.name === params.name)
      const appearanceTitle = params.ui_meta?.['hermes-bots']?.title
      if (!profile) rpcError = { code: -32602, message: 'Profile not found' }
      else if (params.model === 'fixture/expensive' && params.confirm_expensive_model !== true) {
        result = { confirm_message: 'This fixture model is expensive.', confirm_required: true, ok: false }
      } else if (appearanceTitle === 'Reject appearance') {
        result = { applied: { ui_meta: false }, ok: true }
      } else {
        if (typeof params.description === 'string') profile.description = params.description
        if (typeof params.soul === 'string') profile.soul = params.soul
        if (Array.isArray(params.disabled_skills)) profile.disabled_skills = params.disabled_skills
        if (Array.isArray(params.enabled_toolsets)) profile.enabled_toolsets = params.enabled_toolsets
        if (Array.isArray(params.enabled_mcp_servers)) profile.enabled_mcp_servers = params.enabled_mcp_servers
        if (params.model !== undefined) profile.model = { default: params.model, provider: params.provider || '' }
        if (params.ui_meta) profile.ui_meta = { ...(profile.ui_meta || {}), ...params.ui_meta }
        result = { applied: Object.fromEntries(Object.keys(params).filter(key => key !== 'name').map(key => [key, true])), ok: true }
      }
    } else if (request.method === 'profiles.get_asset') {
      const data = state.assets.get(params.name)
      result = data ? { asset: 'avatar', data, found: true, mime: 'image/png', size: data.length } : { asset: 'avatar', found: false }
    } else if (request.method === 'profiles.set_asset') {
      if (params.clear) state.assets.delete(params.name)
      else if (typeof params.data === 'string') state.assets.set(params.name, params.data)
      const profile = state.profiles.find(candidate => candidate.name === params.name)
      if (profile) profile.has_avatar = !params.clear
      result = { asset: 'avatar', found: !params.clear, ok: true }
    } else if (request.method === 'image.generate') {
      result = { image_data: 'data:image/png;base64,AA==', success: true }
    } else if (request.method === 'cli.exec') {
      const argv = Array.isArray(params.argv) ? params.argv : []
      if (argv[0] === 'profile' && argv[1] === 'delete' && typeof argv[2] === 'string') {
        state.profiles = state.profiles.filter(profile => profile.name !== argv[2])
        state.assets.delete(argv[2])
      }
      result = { code: 0, ok: true }
    } else if (request.method === 'commands.catalog') result = { commands: [] }
    else if (request.method === 'model.info') result = { model: 'fixture/test-model' }
    else if (request.method === 'session.events.since') result = { events: [] }
    else if (request.method === 'session.interrupt') {
      if (state.controls.rejectInterrupt) rpcError = { code: -32602, message: 'Fixture stop rejected' }
      else result = {}
    }
    else if (request.method === 'file.attach' || request.method === 'image.attach_bytes') {
      if (params.name === 'rejected.txt') rpcError = { code: -32602, message: 'Fixture file rejected' }
      else result = params.name === 'unconfirmed.txt' ? {} : { ref_text: `@file:${params.name}` }
    }
    else if (request.method === 'prompt.submit') {
      if (params.text === 'draft delayed failure') {
        setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Fixture submission rejected' } })), 800)
        return
      }
      const messages = state.messages.get(currentStored) ?? (state.controls.markdownStream ? initialMessages(currentStored) : [])
      messages.push({ row_id: messages.length + 1, role: 'user', content: params.text })
      const answer = { row_id: messages.length + 1, role: 'assistant', content: state.controls.markdownStream ? '' : `Fixture answer: ${params.text}` }
      messages.push(answer)
      if (state.controls.markdownStream) ws.fixtureAnswer = answer
      state.messages.set(currentStored, messages)
      result = params.text === 'draft uncertain response' ? {} : { accepted: true }
    } else result = {}
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(rpcError ? { error: rpcError } : { result }) }))
    if (request.method === 'prompt.submit' && state.controls.markdownStream) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', session_id: params.session_id, payload: {} } }))
    } else if (request.method === 'prompt.submit') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: params.session_id, payload: { delta: `Fixture answer: ${params.text}` } } }))
      if (!state.controls.holdTurn && !(currentStored === 'footer-fixture' && params.text === 'hold footer activity')) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: params.session_id, payload: {} } }))
      }
    }
  })
})

server.listen(5176, '127.0.0.1', () => console.log(`mobile browser fixture listening on ${origin}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
