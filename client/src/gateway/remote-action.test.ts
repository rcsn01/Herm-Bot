import { describe, expect, it } from 'vitest'

import { runRemoteAction } from './remote-action'
import { MemoryGateway } from '~/test/memory-gateway'

describe('runRemoteAction', () => {
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
})
