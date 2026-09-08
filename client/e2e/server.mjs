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
const stateFor = id => {
  if (!clients.has(id)) clients.set(id, { calls: [], messages: new Map() })
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
    if (url.pathname === '/api/status') return json(res, 200, {
      auth_required: true, auth_providers: ['password'], desktop_contract: 6,
      profiles: [{ name: 'default', is_default: true }, { name: 'work' }]
    })
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
      if (url.pathname === '/api/private-fixture') return json(res, 200, { secret: 'cookie-private-response' })
      if (url.pathname === '/api/fixture-calls') return json(res, 200, { calls: state.calls })
      return json(res, 404, { detail: 'Fixture API route not found' })
    }

    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!relative || url.pathname.startsWith('/session/')) relative = 'index.html'
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
    if (request.method === 'session.create' || request.method === 'session.resume') {
      currentStored = stored
      result = { session_id: runtime, stored_session_id: stored, info: { desktop_contract: 6, model: 'fixture/test-model', title: stored } }
    } else if (request.method === 'session.history') {
      result = { messages: state.messages.get(stored) ?? initialMessages(stored) }
    } else if (request.method === 'session.list') {
      result = { sessions: [{ id: `saved-${params.profile || profile}`, title: `Saved ${params.profile || profile}`, preview: 'Fixture transcript', source: 'mobile', started_at: 1_700_000_000, message_count: 2 }] }
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
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    if (request.method === 'prompt.submit') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: params.session_id, payload: { delta: `Fixture answer: ${params.text}` } } }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: params.session_id, payload: {} } }))
    }
  })
})

server.listen(5176, '127.0.0.1', () => console.log(`mobile browser fixture listening on ${origin}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
