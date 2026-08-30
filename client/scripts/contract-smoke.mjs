#!/usr/bin/env node

const minimumContract = 6
const rawGateway = process.env.HERMES_MOBILE_SMOKE_GATEWAY
const token = process.env.HERMES_MOBILE_SMOKE_TOKEN
const profile = process.env.HERMES_MOBILE_SMOKE_PROFILE || 'default'
if (!rawGateway || !token) {
  console.error('Set HERMES_MOBILE_SMOKE_GATEWAY and HERMES_MOBILE_SMOKE_TOKEN for a dedicated test gateway.')
  process.exit(2)
}

const gateway = new URL(rawGateway)
if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password) throw new Error('The smoke gateway must be a credential-free HTTP(S) URL.')

const api = new URL(`${gateway.pathname.replace(/\/$/, '')}/api/status`, gateway.origin)
const statusResponse = await fetch(api, { headers: { 'X-Hermes-Session-Token': token } })
if (!statusResponse.ok) throw new Error(`/api/status returned HTTP ${statusResponse.status}`)
const status = await statusResponse.json()
console.log(`status ok: Hermes ${status.version ?? 'unknown'}`)

const ws = new URL(`${gateway.pathname.replace(/\/$/, '')}/api/ws`, gateway.origin)
ws.protocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:'
ws.searchParams.set('token', token)

const socket = new WebSocket(ws)
const timeout = setTimeout(() => socket.close(4_000, 'smoke timeout'), 20_000)
let requestId = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const frame = JSON.parse(String(event.data))
  if (frame.id && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id)
    pending.delete(frame.id)
    frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result)
  }
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('WebSocket connection failed.')), { once: true })
})

const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = `smoke-${++requestId}`
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
})

const profiles = await rpc('profiles.list')
const sessions = await rpc('session.list', { limit: 1, profile })
const storedSessionId = sessions?.sessions?.[0]?.id
if (!storedSessionId) throw new Error('The dedicated smoke profile needs one existing session for read-only contract negotiation.')
const resumed = await rpc('session.resume', { profile, session_id: storedSessionId, source: 'ios-smoke' })
const contract = Number(resumed?.info?.desktop_contract)
if (!Number.isFinite(contract) || contract < minimumContract) throw new Error(`Gateway contract ${contract || 'unknown'} is below required contract ${minimumContract}.`)
const commands = await rpc('commands.catalog', { query: '' })
console.log(`contract ${contract} read-only RPC ok for profile ${profile}`, {
  commands: Array.isArray(commands?.items) ? commands.items.length : 'available',
  profiles: Array.isArray(profiles?.profiles) ? profiles.profiles.length : 'available',
  sessions: Array.isArray(sessions?.sessions) ? sessions.sessions.length : 'available'
})
clearTimeout(timeout)
socket.close(1_000, 'smoke complete')
