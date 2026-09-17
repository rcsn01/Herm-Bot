import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getConfigValue } from '~/features/models/helpers'
import type { HermesConfigRecord } from '~/lib/types'
import { $preferences } from '~/state/store'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { useConfigAutosave } from './use-config-autosave'

const originalPreferences = $preferences.get()
const queryKey: QueryKey = ['gateway', 'https://gateway.example', 'work', 'settings', 'config']
const keyFor = (remoteURL: string, profile: string) => [...gatewayScopeKey({ connectionKey: remoteURL, profile }, 'settings'), 'config']

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useConfigAutosave', () => {
  it('updates a loaded config immediately and saves one nested field after 450 ms', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' }, timezone: 'UTC' }
    client.setQueryData(queryKey, initial)
    const savePartial = vi.fn(async () => ({ ok: true }))
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), {
      wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))

    expect(hook.result.current.valueFor('display.personality')).toBe('concise')
    expect(getConfigValue(client.getQueryData(queryKey), 'display.personality')).toBe('concise')
    expect(savePartial).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(449) })
    expect(savePartial).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(savePartial).toHaveBeenCalledTimes(1)
    expect(savePartial).toHaveBeenCalledWith({ display: { personality: 'concise' } }, expect.any(AbortSignal))
    expect(hook.result.current.valueFor('display.personality')).toBe('concise')
  })

  it('collapses repeated pre-debounce edits to the newest value', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const savePartial = vi.fn(async () => ({ ok: true }))
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), {
      wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    act(() => hook.result.current.change('display.personality', 'compact'))
    await act(async () => { await vi.advanceTimersByTimeAsync(449) })
    expect(savePartial).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(savePartial).toHaveBeenCalledTimes(1)
    expect(savePartial).toHaveBeenCalledWith({ display: { personality: 'compact' } }, expect.any(AbortSignal))
  })

  it('debounces fields independently and serializes ready writes', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' }, timezone: 'UTC' }
    client.setQueryData(queryKey, initial)
    const first = deferred<{ ok: boolean }>()
    const second = deferred<{ ok: boolean }>()
    const savePartial = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), {
      wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    act(() => hook.result.current.change('timezone', 'America/New_York'))
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    expect(savePartial).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(savePartial).toHaveBeenCalledTimes(1)

    await act(async () => first.resolve({ ok: true }))
    expect(savePartial).toHaveBeenCalledTimes(2)
    expect(savePartial.mock.calls.map(call => call[0])).toEqual([
      { display: { personality: 'concise' } },
      { timezone: 'America/New_York' }
    ])
    await act(async () => second.resolve({ ok: true }))
  })

  it('rolls back only the latest failed field and preserves another optimistic draft', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' }, timezone: 'UTC' }
    client.setQueryData(queryKey, initial)
    const first = deferred<{ ok: boolean }>()
    const second = deferred<{ ok: boolean }>()
    const savePartial = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => {
      hook.result.current.change('display.personality', 'concise')
      hook.result.current.change('timezone', 'America/New_York')
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    await act(async () => first.reject(new Error('save rejected')))

    expect(hook.result.current.error).toBe('save rejected')
    expect(getConfigValue(client.getQueryData(queryKey), 'display.personality')).toBe('default')
    expect(hook.result.current.valueFor('timezone')).toBe('America/New_York')
    await act(async () => second.resolve({ ok: true }))
  })

  it('restores the last confirmed same-field value when the next write fails', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const first = deferred<{ ok: boolean }>()
    const second = deferred<{ ok: boolean }>()
    const savePartial = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    act(() => hook.result.current.change('display.personality', 'compact'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    expect(savePartial).toHaveBeenCalledTimes(1)
    await act(async () => first.resolve({ ok: true }))
    expect(savePartial).toHaveBeenCalledTimes(2)
    await act(async () => second.reject(new Error('rejected')))

    expect(getConfigValue(client.getQueryData(queryKey), 'display.personality')).toBe('concise')
    expect(hook.result.current.valueFor('display.personality')).toBe('concise')
  })

  it('does not let an older failure replace a newer same-field draft or error', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const first = deferred<{ ok: boolean }>()
    const second = deferred<{ ok: boolean }>()
    const savePartial = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    act(() => hook.result.current.change('display.personality', 'compact'))
    await act(async () => first.reject(new Error('stale rejection')))

    expect(hook.result.current.valueFor('display.personality')).toBe('compact')
    expect(hook.result.current.error).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    await act(async () => second.resolve({ ok: true }))
  })

  it('treats ok false as a classified save failure', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const savePartial = vi.fn(async () => ({ ok: false }))
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })

    expect(hook.result.current.error).toBe('The gateway rejected this setting.')
    expect(hook.result.current.valueFor('display.personality')).toBe('default')
  })

  it('does not roll back over a background cache replacement', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const response = deferred<{ ok: boolean }>()
    const savePartial = vi.fn(() => response.promise)
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    client.setQueryData(queryKey, { display: { personality: 'external' } })
    await act(async () => response.reject(new Error('offline')))

    expect(getConfigValue(client.getQueryData(queryKey), 'display.personality')).toBe('external')
    expect(hook.result.current.valueFor('display.personality')).toBe('external')
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('defers success invalidation until every field is idle', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' }, timezone: 'UTC' }
    client.setQueryData(queryKey, initial)
    const first = deferred<{ ok: boolean }>()
    const second = deferred<{ ok: boolean }>()
    const savePartial = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    act(() => hook.result.current.change('timezone', 'America/New_York'))
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await act(async () => first.resolve({ ok: true }))
    expect(invalidate).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => second.resolve({ ok: true }))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('cancels and restores a debounced edit when the category changes', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const savePartial = vi.fn(async () => ({ ok: true }))
    const hook = renderHook(({ category }) => useConfigAutosave({ category, config: initial, queryKey, settings: { savePartial } }), {
      initialProps: { category: 'chat' }, wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))
    hook.rerender({ category: 'safety' })
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })

    expect(savePartial).not.toHaveBeenCalled()
    expect(getConfigValue(client.getQueryData(queryKey), 'display.personality')).toBe('default')
    expect(hook.result.current.valueFor('display.personality')).toBe('default')
  })

  it('aborts an active category write and suppresses its late result', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const response = deferred<{ ok: boolean }>()
    let signal: AbortSignal | undefined
    const savePartial = vi.fn((_config: HermesConfigRecord, nextSignal?: AbortSignal) => { signal = nextSignal; return response.promise })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const hook = renderHook(({ category }) => useConfigAutosave({ category, config: initial, queryKey, settings: { savePartial } }), {
      initialProps: { category: 'chat' }, wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    hook.rerender({ category: 'safety' })

    expect(signal?.aborted).toBe(true)
    expect(invalidate).toHaveBeenCalledWith({ queryKey, refetchType: 'none' })
    await act(async () => response.resolve({ ok: true }))
    expect(getConfigValue(client.getQueryData(queryKey), 'display.personality')).toBe('default')
    expect(hook.result.current.error).toBeNull()
  })

  it('restores the old cache and prevents a debounced write after a Scope change', async () => {
    vi.useFakeTimers()
    const oldURL = 'https://gateway.example'
    const newURL = 'https://other.example'
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: oldURL })
    const client = createClient()
    const oldKey = keyFor(oldURL, 'work')
    const newKey = keyFor(newURL, 'work')
    const oldConfig: HermesConfigRecord = { display: { personality: 'default' } }
    const newConfig: HermesConfigRecord = { display: { personality: 'other' } }
    client.setQueryData(oldKey, oldConfig)
    client.setQueryData(newKey, newConfig)
    const savePartial = vi.fn(async () => ({ ok: true }))
    const hook = renderHook(({ config, key }) => useConfigAutosave({ category: 'chat', config, queryKey: key, settings: { savePartial } }), {
      initialProps: { config: oldConfig, key: oldKey }, wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))
    act(() => $preferences.set({ ...$preferences.get(), remoteURL: newURL }))
    hook.rerender({ config: newConfig, key: newKey })
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })

    expect(savePartial).not.toHaveBeenCalled()
    expect(getConfigValue(client.getQueryData(oldKey), 'display.personality')).toBe('default')
    expect(getConfigValue(client.getQueryData(newKey), 'display.personality')).toBe('other')
  })

  it('aborts an active write and invalidates the captured key after a Profile change', async () => {
    vi.useFakeTimers()
    const url = 'https://gateway.example'
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: url })
    const client = createClient()
    const oldKey = keyFor(url, 'work')
    const newKey = keyFor(url, 'other')
    const oldConfig: HermesConfigRecord = { display: { personality: 'default' } }
    const newConfig: HermesConfigRecord = { display: { personality: 'other' } }
    client.setQueryData(oldKey, oldConfig)
    client.setQueryData(newKey, newConfig)
    const response = deferred<{ ok: boolean }>()
    let signal: AbortSignal | undefined
    const savePartial = vi.fn((_config: HermesConfigRecord, nextSignal?: AbortSignal) => { signal = nextSignal; return response.promise })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const hook = renderHook(({ config, key }) => useConfigAutosave({ category: 'chat', config, queryKey: key, settings: { savePartial } }), {
      initialProps: { config: oldConfig, key: oldKey }, wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    act(() => $preferences.set({ ...$preferences.get(), profile: 'other' }))
    hook.rerender({ config: newConfig, key: newKey })

    expect(signal?.aborted).toBe(true)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: oldKey, refetchType: 'none' })
    await act(async () => response.reject(new Error('late failure')))
    expect(hook.result.current.error).toBeNull()
    expect(getConfigValue(client.getQueryData(oldKey), 'display.personality')).toBe('default')
    expect(getConfigValue(client.getQueryData(newKey), 'display.personality')).toBe('other')
  })

  it('rejects old work after switching away and back to the same Scope', async () => {
    vi.useFakeTimers()
    const url = 'https://gateway.example'
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: url })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const savePartial = vi.fn(async () => ({ ok: true }))
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => hook.result.current.change('display.personality', 'concise'))
    act(() => {
      $preferences.set({ ...$preferences.get(), profile: 'other' })
      $preferences.set({ ...$preferences.get(), profile: 'work' })
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })

    expect(savePartial).not.toHaveBeenCalled()
    expect(getConfigValue(client.getQueryData(queryKey), 'display.personality')).toBe('default')
    expect(hook.result.current.valueFor('display.personality')).toBe('default')
  })

  it('cleans up timers and active requests on unmount without state updates', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const initial: HermesConfigRecord = { display: { personality: 'default' } }
    client.setQueryData(queryKey, initial)
    const response = deferred<{ ok: boolean }>()
    let signal: AbortSignal | undefined
    const savePartial = vi.fn((_config: HermesConfigRecord, nextSignal?: AbortSignal) => { signal = nextSignal; return response.promise })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })

    act(() => hook.result.current.change('display.personality', 'concise'))
    hook.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    expect(savePartial).not.toHaveBeenCalled()

    const activeHook = renderHook(() => useConfigAutosave({ category: 'chat', config: initial, queryKey, settings: { savePartial } }), { wrapper: wrapperFor(client) })
    act(() => activeHook.result.current.change('display.personality', 'compact'))
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    activeHook.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => response.reject(new Error('late rejection')))
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('keeps an early draft without seeding an incomplete config query', async () => {
    vi.useFakeTimers()
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const client = createClient()
    const savePartial = vi.fn(async () => ({ ok: true }))
    const hook = renderHook(() => useConfigAutosave({ category: 'chat', config: undefined, queryKey, settings: { savePartial } }), {
      wrapper: wrapperFor(client)
    })

    act(() => hook.result.current.change('display.personality', 'concise'))

    expect(hook.result.current.valueFor('display.personality')).toBe('concise')
    expect(client.getQueryData(queryKey)).toBeUndefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    expect(savePartial).toHaveBeenCalledWith({ display: { personality: 'concise' } }, expect.any(AbortSignal))
    expect(client.getQueryData(queryKey)).toBeUndefined()
  })
})
