import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayError } from './gateway-error'
import { useOAuthFlow, type OAuthFlowAdapter, type OAuthFlowSnapshot } from './oauth-flow'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

const originalPreferences = $preferences.get()

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

function adapter(options: {
  poll?: OAuthFlowAdapter['poll']
  polling?: OAuthFlowAdapter['polling']
  start: OAuthFlowAdapter['start']
}): OAuthFlowAdapter {
  return {
    gateway: new MemoryGateway(),
    poll: options.poll ?? (async () => ({ phase: 'approved' })),
    polling: { intervalMs: 0, maxIntervalMs: 0, maxAttempts: 60, ...options.polling },
    start: options.start
  }
}

function snapshot(phase: OAuthFlowSnapshot['phase'], extra: Partial<OAuthFlowSnapshot> = {}): OAuthFlowSnapshot {
  return { phase, ...extra }
}

describe('useOAuthFlow', () => {
  it('publishes a waiting start and a terminal approval', async () => {
    const poll = vi.fn(async () => snapshot('approved', { flowId: 'flow-1' }))
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => hook.result.current.start(adapter({
      poll,
      start: async () => snapshot('waiting', { flowId: 'flow-1' })
    })))

    await waitFor(() => expect(hook.result.current.snapshot?.phase).toBe('approved'))
    expect(hook.result.current.busy).toBe(false)
    expect(poll).toHaveBeenCalledOnce()
    expect(hook.result.current.error).toBeNull()
  })

  it('opens the authorization URL once and supports explicit reopening', async () => {
    const opened = vi.fn(async () => undefined)
    const polling = deferred<OAuthFlowSnapshot>()
    const hook = renderHook(() => useOAuthFlow({ openExternal: opened }))

    act(() => hook.result.current.start(adapter({
      poll: async () => polling.promise,
      start: async () => snapshot('waiting', { authorizationURL: 'https://auth.example/authorize', flowId: 'flow-1' })
    })))

    await waitFor(() => expect(opened).toHaveBeenCalledWith('https://auth.example/authorize'))
    expect(opened).toHaveBeenCalledOnce()
    await act(async () => { await hook.result.current.openAuthorization() })
    expect(opened).toHaveBeenCalledTimes(2)

    await act(async () => { polling.resolve(snapshot('approved', { flowId: 'flow-1' })) })
    await waitFor(() => expect(hook.result.current.busy).toBe(false))
  })

  it('keeps polling when automatic URL opening fails and allows a retry', async () => {
    const opened = vi.fn(async () => undefined)
    opened.mockRejectedValueOnce(new Error('Popup blocked'))
    const polling = deferred<OAuthFlowSnapshot>()
    const hook = renderHook(() => useOAuthFlow({ openExternal: opened }))

    act(() => hook.result.current.start(adapter({
      start: async () => snapshot('waiting', { authorizationURL: 'https://auth.example/authorize' }),
      poll: async () => polling.promise
    })))

    await waitFor(() => expect(hook.result.current.error?.message).toBe('Popup blocked'))
    await act(async () => { await hook.result.current.openAuthorization() })
    expect(hook.result.current.error).toBeNull()
    expect(opened).toHaveBeenCalledTimes(2)

    await act(async () => { polling.resolve(snapshot('approved')); await Promise.resolve() })
    await waitFor(() => expect(hook.result.current.busy).toBe(false))
  })

  it('suppresses an opener failure after the flow is stopped', async () => {
    const opened = deferred<void>()
    const hook = renderHook(() => useOAuthFlow({ openExternal: () => opened.promise }))

    act(() => hook.result.current.start(adapter({
      start: async () => snapshot('waiting', { authorizationURL: 'https://auth.example/authorize' }),
      poll: async () => snapshot('approved')
    })))
    await waitFor(() => expect(hook.result.current.snapshot?.phase).toBe('approved'))

    act(() => hook.result.current.stop())
    await act(async () => { opened.reject(new Error('Popup closed')); await Promise.resolve() })
    expect(hook.result.current.error).toBeNull()
    expect(hook.result.current.snapshot).toBeNull()
  })

  it('does not poll after a terminal start', async () => {
    const poll = vi.fn(async () => snapshot('approved'))
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => hook.result.current.start(adapter({
      poll,
      start: async () => snapshot('denied', { message: 'Denied by provider.' })
    })))

    await waitFor(() => expect(hook.result.current.snapshot?.phase).toBe('denied'))
    expect(poll).not.toHaveBeenCalled()
    expect(hook.result.current.snapshot?.message).toBe('Denied by provider.')
  })

  it('maps poll exhaustion to a non-retryable OAuth timeout', async () => {
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => hook.result.current.start(adapter({
      polling: { maxAttempts: 2 },
      poll: async () => snapshot('waiting'),
      start: async () => snapshot('waiting')
    })))

    await waitFor(() => expect(hook.result.current.error?.code).toBe('OAUTH_TIMEOUT'))
    expect(hook.result.current.error).toBeInstanceOf(GatewayError)
    expect(hook.result.current.error?.retryable).toBe(false)
    expect(hook.result.current.snapshot).toMatchObject({ phase: 'error', message: expect.stringContaining('timed out') })
    expect(hook.result.current.busy).toBe(false)
  })

  it('stops a deferred poll without publishing its late result', async () => {
    const polling = deferred<OAuthFlowSnapshot>()
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => hook.result.current.start(adapter({
      poll: async () => polling.promise,
      start: async () => snapshot('waiting')
    })))
    await waitFor(() => expect(hook.result.current.busy).toBe(true))
    act(() => hook.result.current.stop())
    await act(async () => { polling.resolve(snapshot('approved')); await Promise.resolve() })

    expect(hook.result.current.busy).toBe(false)
    expect(hook.result.current.snapshot).toBeNull()
    expect(hook.result.current.error).toBeNull()
  })

  it('aborts an active poll on unmount without publishing a late result', async () => {
    const polling = deferred<OAuthFlowSnapshot>()
    let pollSignal!: AbortSignal
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => hook.result.current.start(adapter({
      poll: async (_current, signal) => {
        pollSignal = signal
        return polling.promise
      },
      start: async () => snapshot('waiting')
    })))
    await waitFor(() => expect(pollSignal).toBeDefined())
    hook.unmount()
    expect(pollSignal.aborted).toBe(true)

    await act(async () => {
      polling.resolve(snapshot('approved'))
      await Promise.resolve()
    })
  })

  it('suppresses a late result after a Scope change', async () => {
    const polling = deferred<OAuthFlowSnapshot>()
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => hook.result.current.start(adapter({
      poll: async () => polling.promise,
      start: async () => snapshot('waiting')
    })))
    await waitFor(() => expect(hook.result.current.busy).toBe(true))

    act(() => $preferences.set({ ...$preferences.get(), remoteURL: 'https://other-gateway.example' }))
    await act(async () => { polling.resolve(snapshot('approved')); await Promise.resolve() })
    await waitFor(() => expect(hook.result.current.snapshot).toBeNull())
    expect(hook.result.current.error).toBeNull()
  })

  it('rejects a second same-tick start while the first run is active', async () => {
    const firstStart = vi.fn(async () => snapshot('waiting'))
    const secondStart = vi.fn(async () => snapshot('approved'))
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => {
      hook.result.current.start(adapter({ start: firstStart, poll: async () => snapshot('waiting') }))
      hook.result.current.start(adapter({ start: secondStart }))
    })

    await waitFor(() => expect(firstStart).toHaveBeenCalledOnce())
    expect(secondStart).not.toHaveBeenCalled()
    act(() => hook.result.current.stop())
  })

  it('allows a fresh start after a terminal run', async () => {
    const first = adapter({ start: async () => snapshot('approved') })
    const secondStart = vi.fn(async () => snapshot('approved', { flowId: 'new-flow' }))
    const hook = renderHook(() => useOAuthFlow({}))

    act(() => hook.result.current.start(first))
    await waitFor(() => expect(hook.result.current.snapshot?.phase).toBe('approved'))
    act(() => hook.result.current.start(adapter({ start: secondStart })))

    await waitFor(() => expect(hook.result.current.snapshot?.flowId).toBe('new-flow'))
    expect(secondStart).toHaveBeenCalledOnce()
  })
})
