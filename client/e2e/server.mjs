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
  { name: 'work' }
]
const stateFor = id => {
  if (!clients.has(id)) clients.set(id, { assets: new Map(), calls: [], messages: new Map(), profiles: initialProfiles() })
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
const initialMessages = id => [
  { row_id: 1, role: 'user', content: `Question saved in ${id}` },
  { row_id: 2, role: 'assistant', content: `Durable reply from ${id}` }
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin)
  try {
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
      stateFor(id).calls.push({ kind: 'http', method: req.method, path: url.pathname, body: credentials })
      return json(res, 200, { ok: true }, { 'set-cookie': `fixture_session=${id}; Path=/; HttpOnly; SameSite=Lax` })
    }
    const id = cookie(req)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      if (!id) return json(res, 401, { detail: 'Authentication required' })
      const state = stateFor(id)
      state.calls.push({ kind: 'http', method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
      if (url.pathname === '/api/auth/me') return json(res, 200, { user_id: 'fixture-user', provider: 'password', org_id: 'fixture', expires_at: 4_102_444_800 })
      if (url.pathname === '/api/auth/ws-ticket' && req.method === 'POST') {
        const ticket = `ticket-${++sequence}`
        tickets.set(ticket, { id, used: false })
        return json(res, 200, { ticket })
      }
      const match = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
      if (match && req.method === 'GET') {
        const stored = decodeURIComponent(match[1])
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
      const content = await fs.readFile(target)
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
  ticket.used = true
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req, id, url.searchParams.get('profile') || 'default'))
})

sockets.on('connection', (ws, _req, id, profile) => {
  const state = stateFor(id)
  let currentStored = `created-${profile}`
  state.calls.push({ kind: 'ws-connect', profile })
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))
  ws.on('message', raw => {
    const request = JSON.parse(raw.toString())
    const params = request.params || {}
    state.calls.push({ kind: 'rpc', method: request.method, params, profile })
    const stored = params.session_id || `created-${profile}`
    const runtime = `runtime-${profile}-${stored}`
    let result
    let rpcError
    if (request.method === 'session.create' || request.method === 'session.resume') {
      currentStored = stored
      result = { session_id: runtime, stored_session_id: stored, info: { desktop_contract: 6, model: 'fixture/test-model', title: stored } }
    } else if (request.method === 'session.history') {
      result = { messages: state.messages.get(stored) ?? initialMessages(stored) }
    } else if (request.method === 'session.list') {
      // The 'Group: ' row is newer on purpose: opening a bot must skip the
      // desktop's group-plumbing sessions and land on the human conversation.
      result = { sessions: [
        { id: `saved-${params.profile || profile}`, title: `Saved ${params.profile || profile}`, preview: 'Fixture transcript', source: 'mobile', started_at: 1_700_000_000, message_count: 2 },
        { id: 'plumb-group', title: 'Group: r-crew', preview: '[Group chat: "Research crew"]', source: 'ios', started_at: 1_700_000_500, message_count: 9 }
      ] }
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
      result = { providers: [{ authenticated: true, models: ['fixture/fast', 'fixture/deep'], name: 'Fixture AI', slug: 'fixture' }, { authenticated: true, models: ['local/test'], name: 'Local', slug: 'local' }] }
    } else if (request.method === 'profiles.configure') {
      const profile = state.profiles.find(candidate => candidate.name === params.name)
      if (!profile) rpcError = { code: -32602, message: 'Profile not found' }
      else {
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
    else if (request.method === 'prompt.submit') {
      const messages = state.messages.get(currentStored) ?? []
      messages.push({ row_id: messages.length + 1, role: 'user', content: params.text })
      messages.push({ row_id: messages.length + 1, role: 'assistant', content: `Fixture answer: ${params.text}` })
      state.messages.set(currentStored, messages)
      result = { accepted: true }
    } else result = {}
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(rpcError ? { error: rpcError } : { result }) }))
    if (request.method === 'prompt.submit') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: params.session_id, payload: { delta: `Fixture answer: ${params.text}` } } }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: params.session_id, payload: {} } }))
    }
  })
})

server.listen(5176, '127.0.0.1', () => console.log(`mobile browser fixture listening on ${origin}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
