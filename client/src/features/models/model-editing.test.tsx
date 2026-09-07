import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: () => null,
  Input: () => null
}))

import {
  useAuxiliaryModelEditing,
  useMainModelEditing,
  useModelConfigEditing
} from '~/features/models/model-editing'
import { getConfigValue } from '~/features/models/helpers'
import { GatewayProvider } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import type { HermesConfigRecord, ModelOptionProvider } from '~/lib/types'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

interface Deferred<T> {
  promise: Promise<T>
  reject(reason?: unknown): void
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const originalPreferences = $preferences.get()

function createClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Infinity }
    }
  })
}

function wrapperFor(client: QueryClient, gateway: MemoryGateway) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <GatewayProvider gateway={gateway}>{children}</GatewayProvider>
      </QueryClientProvider>
    )
  }
}

function configKey(connectionKey = 'https://gateway.example', profile = 'work') {
  return [...gatewayScopeKey({ connectionKey, profile }, 'models'), 'config']
}

const requestBodies = (gateway: MemoryGateway, path: string) => gateway.calls
  .filter(call => call.kind === 'request' && (call.value as { path: string }).path === path)
  .map(call => (call.value as { body?: Record<string, unknown> }).body)

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  $preferences.set(originalPreferences)
})

describe('useMainModelEditing', () => {
  it('retries the exact assignment after confirmation and publishes stale auxiliary tasks', async () => {
    let attempts = 0
    const gateway = new MemoryGateway().handle('/api/model/set?profile=work', value => {
      attempts += 1
      const body = (value as { body: Record<string, unknown> }).body
      return attempts === 1
        ? { confirm_message: 'Costs more', confirm_required: true, ok: false }
        : { ok: true, stale_aux: [{ model: 'old', provider: 'other', task: 'vision' }], ...body }
    })
    const client = createClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const hook = renderHook(() => useMainModelEditing(), { wrapper: wrapperFor(client, gateway) })

    act(() => hook.result.current.apply({ base_url: 'http://local/v1', model: 'large', provider: 'custom' }))
    await waitFor(() => expect(hook.result.current.pendingConfirmation?.message).toBe('Costs more'))
    act(() => hook.result.current.confirm())
    await waitFor(() => expect(hook.result.current.staleAuxiliary).toHaveLength(1))

    expect(requestBodies(gateway, '/api/model/set?profile=work')).toEqual([
      { base_url: 'http://local/v1', model: 'large', provider: 'custom', scope: 'main' },
      { base_url: 'http://local/v1', confirm_expensive_model: true, model: 'large', provider: 'custom', scope: 'main' }
    ])
    expect(invalidate).toHaveBeenCalled()
  })

  it('fails closed when the acknowledged request still requires confirmation', async () => {
    const gateway = new MemoryGateway().handle('/api/model/set?profile=work', () => ({
      confirm_message: 'Still blocked', confirm_required: true, ok: false
    }))
    const hook = renderHook(() => useMainModelEditing(), { wrapper: wrapperFor(createClient(), gateway) })

    act(() => hook.result.current.apply({ model: 'large', provider: 'openrouter' }))
    await waitFor(() => expect(hook.result.current.pendingConfirmation).not.toBeNull())
    act(() => hook.result.current.confirm())
    await waitFor(() => expect(hook.result.current.error).toBe('Still blocked'))
    expect(hook.result.current.pendingConfirmation).toBeNull()
  })

  it('suppresses an old response after switching away and back', async () => {
    const pending = deferred<{ ok: boolean; stale_aux: [] }>()
    const gateway = new MemoryGateway().handle('/api/model/set?profile=work', () => pending.promise)
    const client = createClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const hook = renderHook(() => useMainModelEditing(), { wrapper: wrapperFor(client, gateway) })

    act(() => hook.result.current.apply({ model: 'next', provider: 'nous' }))
    act(() => { $preferences.set({ ...$preferences.get(), profile: 'other' }) })
    await waitFor(() => expect(hook.result.current.applying).toBe(false))
    act(() => { $preferences.set({ ...$preferences.get(), profile: 'work' }) })
    await act(async () => pending.resolve({ ok: true, stale_aux: [] }))

    expect(hook.result.current.applying).toBe(false)
    expect(hook.result.current.staleAuxiliaryVersion).toBe(0)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('clears only the stale report targeted by a reset', async () => {
    const gateway = new MemoryGateway().handle('/api/model/set?profile=work', value => {
      const body = (value as { body: Record<string, unknown> }).body
      return { ok: true, stale_aux: [{ model: String(body.model), provider: 'other', task: 'vision' }] }
    })
    const hook = renderHook(() => useMainModelEditing(), { wrapper: wrapperFor(createClient(), gateway) })

    act(() => hook.result.current.apply({ model: 'a', provider: 'nous' }))
    await waitFor(() => expect(hook.result.current.staleAuxiliaryVersion).toBe(1))
    const oldVersion = hook.result.current.staleAuxiliaryVersion
    act(() => hook.result.current.apply({ model: 'b', provider: 'nous' }))
    await waitFor(() => expect(hook.result.current.staleAuxiliaryVersion).toBe(2))
    act(() => hook.result.current.clearStaleAuxiliary(oldVersion))
    expect(hook.result.current.staleAuxiliary[0]?.model).toBe('b')
  })
})

describe('useAuxiliaryModelEditing', () => {
  const providers: ModelOptionProvider[] = [
    { api_url: 'http://local/v1', models: ['local'], name: 'Custom', slug: 'custom' }
  ]

  it('adds the auxiliary protocol fields and supports reset-all', async () => {
    const gateway = new MemoryGateway().handle('/api/model/set?profile=work', () => ({ ok: true }))
    const hook = renderHook(() => useAuxiliaryModelEditing(providers), { wrapper: wrapperFor(createClient(), gateway) })

    await act(async () => {
      expect(await hook.result.current.assign({ model: 'local', provider: 'custom', task: 'vision' })).toBe(true)
      expect(await hook.result.current.resetAll({ model: 'main', provider: 'nous' })).toBe(true)
    })

    expect(requestBodies(gateway, '/api/model/set?profile=work')).toEqual([
      { base_url: 'http://local/v1', model: 'local', provider: 'custom', scope: 'auxiliary', task: 'vision' },
      { model: 'main', provider: 'nous', scope: 'auxiliary', task: '__reset__' }
    ])
  })

  it('returns false and suppresses effects for a stale completion', async () => {
    const pending = deferred<{ ok: boolean }>()
    const gateway = new MemoryGateway().handle('/api/model/set?profile=work', () => pending.promise)
    const client = createClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const hook = renderHook(() => useAuxiliaryModelEditing(providers), { wrapper: wrapperFor(client, gateway) })
    let outcome!: Promise<boolean>

    act(() => { outcome = hook.result.current.assign({ model: 'local', provider: 'custom', task: 'vision' }) })
    act(() => { $preferences.set({ ...$preferences.get(), profile: 'other' }) })
    await act(async () => pending.resolve({ ok: true }))

    expect(await outcome).toBe(false)
    expect(hook.result.current.error).toBeNull()
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('useModelConfigEditing', () => {
  const initial: HermesConfigRecord = {
    agent: { reasoning_effort: 'medium', service_tier: 'normal' },
    model_context_length: 32000
  }

  function setup(handler: (value: unknown) => unknown | Promise<unknown>) {
    const gateway = new MemoryGateway().handle('/api/config?profile=work', handler)
    const client = createClient()
    client.setQueryData(configKey(), initial)
    const hook = renderHook(() => useModelConfigEditing(initial), { wrapper: wrapperFor(client, gateway) })
    return { client, gateway, hook }
  }

  it('optimistically writes immediate fields with partial payloads', async () => {
    const { client, gateway, hook } = setup(() => ({ ok: true }))

    act(() => {
      hook.result.current.setReasoningEffort('high')
      hook.result.current.setFastTier(true)
    })
    await waitFor(() => expect(requestBodies(gateway, '/api/config?profile=work')).toHaveLength(2))

    expect(requestBodies(gateway, '/api/config?profile=work')).toEqual([
      { config: { agent: { reasoning_effort: 'high' } } },
      { config: { agent: { service_tier: 'fast' } } }
    ])
    expect(getConfigValue(client.getQueryData(configKey()), 'agent.reasoning_effort')).toBe('high')
    expect(getConfigValue(client.getQueryData(configKey()), 'agent.service_tier')).toBe('fast')
  })

  it('debounces context and fallback writes independently', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { gateway, hook } = setup(() => ({ ok: true }))

    act(() => {
      hook.result.current.setContextLength(64000)
      hook.result.current.setContextLength(128000)
      hook.result.current.setFallbacks([{ model: 'm', provider: 'p' }])
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(549) })
    expect(requestBodies(gateway, '/api/config?profile=work')).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await waitFor(() => expect(requestBodies(gateway, '/api/config?profile=work')).toHaveLength(2))

    expect(requestBodies(gateway, '/api/config?profile=work')).toEqual(expect.arrayContaining([
      { config: { model_context_length: 128000 } },
      { config: { fallback_providers: [{ model: 'm', provider: 'p' }] } }
    ]))
  })

  it('rolls back only the failed field and preserves a newer unrelated edit', async () => {
    const reasoning = deferred<unknown>()
    const { client, hook } = setup(value => {
      const config = (value as { body: { config: HermesConfigRecord } }).body.config
      return getConfigValue(config, 'agent.reasoning_effort') ? reasoning.promise : { ok: true }
    })

    act(() => hook.result.current.setReasoningEffort('high'))
    await waitFor(() => expect(getConfigValue(client.getQueryData(configKey()), 'agent.reasoning_effort')).toBe('high'))
    act(() => hook.result.current.setFastTier(true))
    await act(async () => reasoning.reject(new Error('offline')))
    await waitFor(() => expect(hook.result.current.error).not.toBeNull())

    const cached = client.getQueryData(configKey())
    expect(getConfigValue(cached, 'agent.reasoning_effort')).toBe('medium')
    expect(getConfigValue(cached, 'agent.service_tier')).toBe('fast')
  })

  it('serializes same-field writes and restores the last confirmed value', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let calls = 0
    const { client, gateway, hook } = setup(() => (++calls === 1 ? first.promise : second.promise))

    act(() => hook.result.current.setReasoningEffort('high'))
    await waitFor(() => expect(requestBodies(gateway, '/api/config?profile=work')).toHaveLength(1))
    act(() => hook.result.current.setReasoningEffort('ultra'))
    expect(requestBodies(gateway, '/api/config?profile=work')).toHaveLength(1)

    await act(async () => first.resolve({ ok: true }))
    await waitFor(() => expect(requestBodies(gateway, '/api/config?profile=work')).toHaveLength(2))
    await act(async () => second.reject(new Error('rejected')))
    await waitFor(() => expect(hook.result.current.error).not.toBeNull())

    expect(getConfigValue(client.getQueryData(configKey()), 'agent.reasoning_effort')).toBe('high')
  })
})
