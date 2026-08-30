import { describe, expect, it } from 'vitest'

import { GatewayError } from '~/gateway/gateway-error'
import { SessionRuntime } from '~/gateway/session-runtime'
import { MemoryGateway } from '~/test/memory-gateway'

describe('session runtime', () => {
  it('restores a bookmarked session through the gateway interface', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', params => ({
        info: { desktop_contract: 6, stored_session_id: (params as { session_id: string }).session_id },
        messages: [{ content: 'welcome back', role: 'assistant' }],
        session_id: 'runtime-1'
      }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

    const result = await runtime.open({ profile: 'work', storedSessionId: 'stored-1' })

    expect(result).toMatchObject({ resumed: true, session: { runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' } })
    expect(gateway.calls).toEqual([
      { kind: 'close', value: null },
      { kind: 'connect', value: { profile: 'work' } },
      { kind: 'rpc', method: 'session.resume', value: { profile: 'work', session_id: 'stored-1', source: 'ios' } }
    ])
  })

  it('does not replace an unsupported bookmarked session with a new session', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({ info: { desktop_contract: 5 }, session_id: 'runtime-old' }))
      .handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-new' }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

    await expect(runtime.open({ profile: null, storedSessionId: 'stored-old' })).rejects.toMatchObject({
      code: 'MOBILE_CONTRACT_UNSUPPORTED',
      kind: 'unsupported'
    })
    expect(gateway.calls).not.toContainEqual(expect.objectContaining({ method: 'session.create' }))
  })

  it('does not treat an unsupported resume method as a missing bookmark', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => { throw Object.assign(new Error('Method not found'), { code: -32_601 }) })
      .handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-new' }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

    await expect(runtime.open({ profile: null, storedSessionId: 'stored-1' })).rejects.toMatchObject({ kind: 'unsupported' })
    expect(gateway.calls).not.toContainEqual(expect.objectContaining({ method: 'session.create' }))
  })

  it('creates a session only when a bookmark is confirmed missing', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => { throw Object.assign(new Error('session not found'), { status: 404 }) })
      .handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-new' }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

    const result = await runtime.open({ profile: null, storedSessionId: 'missing' })

    expect(result).toMatchObject({ resumed: false, session: { runtimeSessionId: 'runtime-new' } })
    expect(gateway.calls.filter(call => call.kind === 'rpc').map(call => call.value)).toEqual([
      { profile: 'default', session_id: 'missing', source: 'ios' },
      { profile: 'default', source: 'ios' }
    ])
  })

  it('does not treat a generic 404 or server message as a missing bookmark', async () => {
    for (const error of [
      Object.assign(new Error('Not Found'), { status: 404 }),
      new Error('session store not found')
    ]) {
      const gateway = new MemoryGateway()
        .handle('session.resume', () => { throw error })
        .handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-new' }))
      const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

      await expect(runtime.open({ profile: null, storedSessionId: 'stored-1' })).rejects.toBeInstanceOf(GatewayError)
      expect(gateway.calls).not.toContainEqual(expect.objectContaining({ method: 'session.create' }))
    }
  })

  it('creates a session when the gateway confirms a missing bookmark without an HTTP status', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => { throw new Error('session not found') })
      .handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-new' }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

    const result = await runtime.open({ profile: null, storedSessionId: 'stale-bookmark' })

    expect(result).toMatchObject({ resumed: false, session: { runtimeSessionId: 'runtime-new' } })
    expect(gateway.calls).toContainEqual(expect.objectContaining({ method: 'session.create' }))
  })

  it('does not replace a bookmark after a network failure', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => { throw new Error('Network disconnected') })
      .handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-new' }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

    await expect(runtime.open({ profile: null, storedSessionId: 'stored-1' })).rejects.toMatchObject({ kind: 'network' })
    expect(gateway.calls).not.toContainEqual(expect.objectContaining({ method: 'session.create' }))
  })

  it('does not retry a permanent reconnect failure', async () => {
    const gateway = new MemoryGateway().handle('session.create', () => {
      throw Object.assign(new Error('Invalid'), { status: 422 })
    })
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [0, 0, 0] })

    await expect(runtime.reopen({ profile: null, storedSessionId: null })).rejects.toMatchObject({ kind: 'validation' })
    expect(gateway.calls.filter(call => call.kind === 'connect')).toHaveLength(1)
  })

  it('normalizes RPC failures at the adapter seam', async () => {
    const gateway = new MemoryGateway().handle('prompt.submit', () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 })
    })
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })

    await expect(runtime.rpc('prompt.submit')).rejects.toMatchObject({ kind: 'auth', retryable: false } satisfies Partial<GatewayError>)
  })

  it('prevents a stale connection preparation from replacing a newer scope', async () => {
    let finishPreparation: (() => void) | undefined
    const gateway = new MemoryGateway().handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-new' }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })
    const stale = runtime.open(
      { profile: 'old', storedSessionId: null },
      () => new Promise<void>(resolve => { finishPreparation = resolve })
    )

    const current = runtime.open({ profile: 'new', storedSessionId: null }, async () => undefined)
    await current
    finishPreparation?.()

    await expect(stale).rejects.toMatchObject({ kind: 'aborted' })
    expect(gateway.calls.filter(call => call.kind === 'connect')).toEqual([
      { kind: 'connect', value: { profile: 'new' } }
    ])
  })

  it('aborts feature requests that cross the runtime seam when scope changes', async () => {
    let observedSignal: AbortSignal | undefined
    const transport = new MemoryGateway()
      .handle('/api/cron/jobs', (_request, options) => {
        observedSignal = options?.signal
        return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }))
      })
    const runtime = new SessionRuntime(transport, { minimumContract: 6, retryDelays: [] })
    const stale = runtime.request({ path: '/api/cron/jobs' })

    runtime.close()

    expect(observedSignal?.aborted).toBe(true)
    await expect(stale).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('aborts in-flight work before opening a new scope', async () => {
    let observedSignal: AbortSignal | undefined
    const gateway = new MemoryGateway()
      .handle('slow', (_params, options) => {
        observedSignal = options?.signal
        return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }))
      })
      .handle('session.create', () => ({ info: { desktop_contract: 6 }, session_id: 'runtime-2' }))
    const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [] })
    const stale = runtime.rpc('slow')

    await runtime.open({ profile: null, storedSessionId: null })

    expect(observedSignal?.aborted).toBe(true)
    await expect(stale).rejects.toMatchObject({ kind: 'aborted' } satisfies Partial<GatewayError>)
  })
})
