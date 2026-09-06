import { describe, expect, it, vi } from 'vitest'

import { createGatewayApi } from './gateway-api'
import { assertRemoteActionStart, remoteActionName, runGatewayAction, runRemoteAction, type GatewayActionState, type RemoteActionState } from './remote-action'
import { MemoryGateway } from '~/test/memory-gateway'

const requestPaths = (gateway: MemoryGateway): string[] =>
  gateway.calls.flatMap(call => (call.kind === 'request' ? [(call.value as { path: string }).path] : []))

describe('runRemoteAction', () => {
  it('rejects an explicit action-start refusal before polling', () => {
    expect(() => assertRemoteActionStart({ error: 'Install refused.', ok: false })).toThrow('Install refused.')
  })

  it('allows synchronous action starts without a poll handle', () => {
    expect(remoteActionName({ background: false, ok: true })).toBe('')
  })

  it('requires a poll handle for asynchronous action starts', () => {
    expect(() => remoteActionName({ background: true, ok: true })).toThrow(/poll handle/i)
  })

  it('bounds polling and recovers from temporary network errors', async () => {
    const gateway = new MemoryGateway()
    let polls = 0
    const result = await runRemoteAction({
      gateway,
      intervalMs: 0,
      maxAttempts: 4,
      start: async () => ({ status: 'pending' }),
      poll: async () => {
        polls += 1
        if (polls === 1) throw new Error('WebSocket disconnected')
        return { result: 42, status: 'complete' }
      }
    })
    expect(result.result).toBe(42)
    expect(polls).toBe(2)
  })

  it('allows start and completion while the scope predicate stays true', async () => {
    const gateway = new MemoryGateway()
    const result = await runRemoteAction({
      gateway,
      intervalMs: 0,
      isCurrentScope: () => true,
      start: async () => ({ status: 'pending' }),
      poll: async () => ({ result: 7, status: 'complete' })
    })
    expect(result.result).toBe(7)
  })

  it('rejects before another poll once the scope predicate turns false', async () => {
    const gateway = new MemoryGateway()
    let current = true
    await expect(runRemoteAction({
      gateway,
      intervalMs: 0,
      isCurrentScope: () => current,
      start: async () => {
        current = false
        return { status: 'pending' }
      },
      poll: async () => ({ status: 'complete' })
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects before start when the scope predicate is already false', async () => {
    const gateway = new MemoryGateway()
    let started = false
    await expect(runRemoteAction({
      gateway,
      intervalMs: 0,
      isCurrentScope: () => false,
      start: async () => {
        started = true
        return { status: 'pending' }
      },
      poll: async () => ({ status: 'complete' })
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toBe(false)
  })

  it('honors cancellation', async () => {
    const gateway = new MemoryGateway()
    const controller = new AbortController()
    controller.abort()
    await expect(runRemoteAction({
      gateway,
      signal: controller.signal,
      start: async () => ({ status: 'pending' }),
      poll: async () => ({ status: 'complete' })
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels after a start callback that resolves late', async () => {
    const gateway = new MemoryGateway()
    const controller = new AbortController()
    let finish!: (state: RemoteActionState<unknown>) => void
    const action = runRemoteAction<unknown>({
      gateway,
      intervalMs: 0,
      signal: controller.signal,
      start: () => new Promise<RemoteActionState<unknown>>(resolve => { finish = resolve }),
      poll: async () => ({ status: 'complete' })
    })
    controller.abort()
    finish({ status: 'pending' })
    await expect(action).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels while a poll is still resolving', async () => {
    const gateway = new MemoryGateway()
    const controller = new AbortController()
    let pollStarted!: () => void
    let finishPoll!: (state: RemoteActionState<number>) => void
    const started = new Promise<void>(resolve => { pollStarted = resolve })
    const action = runRemoteAction<number>({
      gateway,
      intervalMs: 0,
      signal: controller.signal,
      start: async () => ({ status: 'pending' }),
      poll: () => {
        pollStarted()
        return new Promise<RemoteActionState<number>>(resolve => { finishPoll = resolve })
      }
    })
    await started
    controller.abort()
    finishPoll({ result: 1, status: 'complete' })
    await expect(action).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('stops after the configured poll bound', async () => {
    const gateway = new MemoryGateway()
    let polls = 0
    await expect(runRemoteAction({
      gateway,
      intervalMs: 0,
      maxAttempts: 3,
      start: async () => ({ status: 'pending' }),
      poll: async () => { polls += 1; return { status: 'pending' } }
    })).rejects.toThrow('timed out after 3 polls')
    expect(polls).toBe(3)
  })

  it('does not leave a timer behind when cancelled during backoff', async () => {
    vi.useFakeTimers()
    try {
      const gateway = new MemoryGateway()
      const controller = new AbortController()
      const action = runRemoteAction({
        gateway,
        intervalMs: 10_000,
        signal: controller.signal,
        start: async () => ({ status: 'pending' }),
        poll: async () => ({ status: 'complete' })
      })
      await Promise.resolve()
      controller.abort()
      await expect(action).rejects.toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runGatewayAction', () => {
  it('runs an async action to completion over the unscoped status route', async () => {
    const gateway = new MemoryGateway()
    const api = createGatewayApi(gateway, 'work')
    let polls = 0
    gateway
      .handle('/api/skills/hub/install?profile=work', () => ({ action: 'install-1', background: true, ok: true }))
      .handle('/api/actions/install-1/status', () => {
        polls += 1
        return polls === 1 ? { exit_code: null, running: true } : { exit_code: 0, running: false }
      })
    const state: GatewayActionState = await runGatewayAction(api, {
      intervalMs: 0,
      start: signal => api.request('/api/skills/hub/install', { method: 'POST', signal })
    })
    expect(state.status).toBe('complete')
    expect(state.result?.exit_code).toBe(0)
    expect(requestPaths(gateway).filter(path => path.startsWith('/api/actions')))
      .toEqual(['/api/actions/install-1/status', '/api/actions/install-1/status'])
  })

  it('resolves a synchronous start without polling the status route', async () => {
    const gateway = new MemoryGateway()
    const api = createGatewayApi(gateway, 'work')
    gateway.handle('/api/skills/hub/install?profile=work', () => ({ background: false, ok: true }))
    const state = await runGatewayAction(api, {
      intervalMs: 0,
      start: signal => api.request('/api/skills/hub/install', { method: 'POST', signal })
    })
    expect(state.status).toBe('complete')
    expect(requestPaths(gateway).some(path => path.startsWith('/api/actions'))).toBe(false)
  })

  it('rejects with ACTION_FAILED when the action exits nonzero', async () => {
    const gateway = new MemoryGateway()
    const api = createGatewayApi(gateway, 'work')
    gateway
      .handle('/api/skills/hub/install?profile=work', () => ({ action: 'install-1', background: true, ok: true }))
      .handle('/api/actions/install-1/status', () => ({ exit_code: 1, running: false }))
    const failure = runGatewayAction(api, {
      intervalMs: 0,
      start: signal => api.request('/api/skills/hub/install', { method: 'POST', signal })
    })
    await expect(failure).rejects.toMatchObject({ code: 'ACTION_FAILED', kind: 'server' })
    await expect(failure).rejects.toThrow(/exit code 1/)
  })

  it('preserves a refused start response message', async () => {
    const gateway = new MemoryGateway()
    const api = createGatewayApi(gateway, 'work')
    gateway.handle('/api/skills/hub/install?profile=work', () => ({ error: 'Install refused.', ok: false }))
    await expect(runGatewayAction(api, {
      intervalMs: 0,
      start: signal => api.request('/api/skills/hub/install', { method: 'POST', signal })
    })).rejects.toThrow('Install refused.')
  })

  it('rejects an asynchronous start that returns no poll handle', async () => {
    const gateway = new MemoryGateway()
    const api = createGatewayApi(gateway, 'work')
    gateway.handle('/api/skills/hub/install?profile=work', () => ({ background: true, ok: true }))
    await expect(runGatewayAction(api, {
      intervalMs: 0,
      start: signal => api.request('/api/skills/hub/install', { method: 'POST', signal })
    })).rejects.toThrow(/poll handle/i)
  })

  it('aborts polling once the starting scope is no longer current', async () => {
    const gateway = new MemoryGateway()
    const api = createGatewayApi(gateway, 'work')
    let current = true
    gateway
      .handle('/api/skills/hub/install?profile=work', () => ({ action: 'install-1', background: true, ok: true }))
      .handle('/api/actions/install-1/status', () => {
        current = false
        return { exit_code: null, running: true }
      })
    await expect(runGatewayAction(api, {
      intervalMs: 0,
      isCurrentScope: () => current,
      start: signal => api.request('/api/skills/hub/install', { method: 'POST', signal })
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
