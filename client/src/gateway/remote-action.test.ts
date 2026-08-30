import { describe, expect, it, vi } from 'vitest'

import { assertRemoteActionStart, remoteActionName, runRemoteAction, type RemoteActionState } from './remote-action'
import { MemoryGateway } from '~/test/memory-gateway'

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

  it('stops when the gateway scope changes', async () => {
    const gateway = new MemoryGateway()
    let epoch = 1
    await expect(runRemoteAction({
      gateway,
      getScopeEpoch: () => epoch,
      intervalMs: 0,
      start: async () => {
        epoch += 1
        return { status: 'pending' }
      },
      poll: async () => ({ status: 'complete' })
    })).rejects.toMatchObject({ name: 'AbortError' })
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
