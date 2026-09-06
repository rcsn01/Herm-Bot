import { describe, expect, it } from 'vitest'

import { createGatewayApi, type GatewayApi } from './gateway-api'
import { GatewayError } from './gateway-error'
import { MemoryGateway } from '~/test/memory-gateway'

describe('GatewayApi binding', () => {
  it('appends exactly one profile param and merges caller params before it', async () => {
    const gateway = new MemoryGateway().handle('/api/config?profile=default', () => ({ ok: true }))

    const api = createGatewayApi(gateway, null)
    await api.request('/api/config')

    const namedGateway = new MemoryGateway().handle('/api/config?profile=work', () => ({ ok: true }))
    const named = createGatewayApi(namedGateway, 'work')
    await named.request('/api/config')

    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/config?profile=default' })
    expect(namedGateway.calls.at(-1)?.value).toMatchObject({ path: '/api/config?profile=work' })
  })

  it('preserves existing path params and drops undefined extras, profile last', async () => {
    const gateway = new MemoryGateway().handle('/api/sessions?archived=only&limit=100&order=recent&profile=work', () => ({ sessions: [] }))
    const api = createGatewayApi(gateway, 'work')

    await api.request('/api/sessions?archived=only&limit=100&order=recent', { params: { limit: 100, missing: undefined } })

    expect(gateway.calls.at(-1)?.value).toMatchObject({
      path: '/api/sessions?archived=only&limit=100&order=recent&profile=work'
    })
    const url = new URL((gateway.calls.at(-1)?.value as { path: string }).path, 'http://hermes.mobile')
    expect(url.searchParams.getAll('profile')).toEqual(['work'])
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('never appends profile on the unscoped tier', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/status', () => ({ gateway_running: true }))
      .handle('/api/actions/reload/status?verbose=1', () => ({ running: false }))
    const api = createGatewayApi(gateway, 'work')

    await api.unscoped('/api/status')
    await api.unscoped('/api/actions/reload/status', { params: { verbose: 1 } })

    expect(gateway.calls.map(call => (call.value as { path: string }).path)).toEqual([
      '/api/status',
      '/api/actions/reload/status?verbose=1'
    ])
  })

  it('gates defaultOnly before any I/O for a named profile', () => {
    const gateway = new MemoryGateway()
    const api = createGatewayApi(gateway, 'work')

    expect(() => api.defaultOnly('Process-wide route.', '/api/cron/blueprints')).toThrow(GatewayError)
    expect(() => api.defaultOnly('Process-wide route.', '/api/cron/blueprints')).toThrow(/Process-wide route\./)

    const error = (() => {
      try {
        api.defaultOnly('Process-wide route.', '/api/cron/blueprints')
      } catch (caught) {
        return caught as GatewayError
      }
      throw new Error('expected a throw')
    })()
    expect(error.code).toBe('PROFILE_SCOPE_UNSUPPORTED')
    expect(error.kind).toBe('unsupported')
    expect(error.retryable).toBe(false)
    expect(gateway.calls).toHaveLength(0)
  })

  it('lets defaultOnly pass through like unscoped on the default profile', async () => {
    const gateway = new MemoryGateway().handle('/api/cron/blueprints', () => ({ blueprints: [] }))
    const api = createGatewayApi(gateway, null)

    await expect(api.defaultOnly('Process-wide route.', '/api/cron/blueprints')).resolves.toEqual({ blueprints: [] })
    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/cron/blueprints' })
  })

  it('unwraps .body on every tier', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/scoped?profile=work', () => ({ scoped: true }))
      .handle('/api/raw', () => ({ raw: true }))
    const api = createGatewayApi(gateway, 'work')

    await expect(api.request('/api/scoped')).resolves.toEqual({ scoped: true })
    await expect(api.unscoped('/api/raw')).resolves.toEqual({ raw: true })
  })

  it('passes signal, timeoutMs, method, and body through verbatim', async () => {
    const gateway = new MemoryGateway().handle('/api/config?profile=work', () => ({ ok: true }))
    const api = createGatewayApi(gateway, 'work')
    const controller = new AbortController()

    await api.request('/api/config', { body: { config: {} }, method: 'PUT', signal: controller.signal, timeoutMs: 60_000 })

    expect(gateway.calls.at(-1)?.value).toMatchObject({
      body: { config: {} },
      method: 'PUT',
      path: '/api/config?profile=work',
      timeoutMs: 60_000
    })
    expect((gateway.calls.at(-1)?.value as { signal?: AbortSignal }).signal).toBe(controller.signal)
  })

  it('delegates rpc untouched and unscoped', async () => {
    const gateway = new MemoryGateway().handle('billing.state', params => ({ ok: true, params }))
    const api = createGatewayApi(gateway, 'work')

    await expect(api.rpc('billing.state', { tier: 'starter' }, { timeoutMs: 1_000 })).resolves.toEqual({
      ok: true,
      params: { tier: 'starter' }
    })

    expect(gateway.calls.filter(call => call.kind === 'rpc')).toEqual([
      { kind: 'rpc', method: 'billing.state', value: { tier: 'starter' } }
    ])
  })

  it('binds inertly and exposes the wire key and default predicate', () => {
    const gateway = new MemoryGateway()
    const api: GatewayApi = createGatewayApi(gateway, null)

    expect(gateway.calls).toHaveLength(0)
    expect(api.profileKey).toBe('default')
    expect(api.isDefaultProfile).toBe(true)
    expect(createGatewayApi(gateway, 'work').profileKey).toBe('work')
    expect(createGatewayApi(gateway, 'work').isDefaultProfile).toBe(false)
    expect(createGatewayApi(gateway, 'default').isDefaultProfile).toBe(true)
    expect(gateway.calls).toHaveLength(0)
  })
})