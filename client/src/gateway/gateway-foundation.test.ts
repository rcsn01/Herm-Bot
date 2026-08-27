import { describe, expect, it } from 'vitest'

import { GatewayError, classifyGatewayError } from './gateway-error'
import { createEpochGuard, gatewayScopeKey } from './gateway-scope'
import { QueryClient } from '@tanstack/react-query'
import { MemoryGateway } from '~/test/memory-gateway'

describe('gateway foundation', () => {
  it('builds profile-isolated scope keys and guards epochs', () => {
    expect(gatewayScopeKey({ connectionKey: 'remote-a', profile: 'work' }, 'sessions', 3))
      .toEqual(['gateway', 'remote-a', 'work', 'sessions', 3])
    let epoch = 4
    const current = createEpochGuard(() => epoch)
    expect(current()).toBe(true)
    epoch += 1
    expect(current()).toBe(false)
  })

  it('classifies structured errors', () => {
    expect(classifyGatewayError({ message: 'Unauthorized', status: 401 })).toMatchObject({ kind: 'auth', retryable: false })
    expect(classifyGatewayError({ message: 'Missing', status: 404 })).toMatchObject({ kind: 'unsupported', retryable: false })
    expect(classifyGatewayError({ message: 'Invalid', status: 422 })).toMatchObject({ kind: 'validation', retryable: false })
    expect(classifyGatewayError(new Error('WebSocket disconnected'))).toMatchObject({ kind: 'network', retryable: true })
    expect(classifyGatewayError(new DOMException('stop', 'AbortError'))).toMatchObject({ kind: 'aborted', retryable: false })
    expect(classifyGatewayError(new GatewayError('known', { kind: 'conflict' })).kind).toBe('conflict')
  })

  it('deduplicates cache reads and supports the memory adapter', async () => {
    const cache = new QueryClient()
    let reads = 0
    const read = () => cache.fetchQuery({ queryFn: async () => ++reads, queryKey: ['gateway', 'a'] })
    expect(await Promise.all([read(), read()])).toEqual([1, 1])

    const gateway = new MemoryGateway().handle('session.list', () => ({ sessions: [1] }))
    expect(await gateway.rpc('session.list')).toEqual({ sessions: [1] })
    const events: string[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event.type))
    gateway.emit({ type: 'gateway.ready' })
    unsubscribe()
    gateway.emit({ type: 'error' })
    expect(events).toEqual(['gateway.ready'])
  })
})
