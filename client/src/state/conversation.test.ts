import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInteraction } from '~/features/chat/chat-interaction'
import type { GatewayPort } from '~/gateway/gateway-port'
import type { ChatState } from '~/lib/types'
import { SessionRuntime } from '~/gateway/session-runtime'
import { MINIMUM_CONTRACT } from '~/state/gateway-controller'
import { $chat, Conversation, emptyChatState, reduceGatewayEvent } from '~/state/conversation'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'
import { createTranscript, updateTranscript } from '~/transcript/transcript'

function subject(gateway: GatewayPort) {
  const runtime = new SessionRuntime(gateway, { minimumContract: MINIMUM_CONTRACT, retryDelays: [0] })
  const conversation = new Conversation(runtime)
  return { conversation, dispose: () => runtime.dispose(), runtime }
}

beforeEach(() => {
  $chat.set(emptyChatState())
  $preferences.set({ authMode: 'token', profile: null, remoteURL: '', theme: 'system' })
  localStorage.clear()
})

describe('reduceGatewayEvent', () => {
  it('reduces streaming text, reasoning, tools, completion, and context info', () => {
    let state: ChatState = { ...emptyChatState(), runtimeSessionId: 'runtime-1' }
    state = reduceGatewayEvent(state, { type: 'session.info', session_id: 'runtime-1', payload: { desktop_contract: 3, stored_session_id: 'durable-1', running: true } })
    state = reduceGatewayEvent(state, { type: 'message.delta', session_id: 'runtime-1', payload: { delta: 'Hello' } })
    state = reduceGatewayEvent(state, { type: 'reasoning.delta', session_id: 'runtime-1', payload: { delta: 'Think' } })
    state = reduceGatewayEvent(state, { type: 'tool.start', session_id: 'runtime-1', payload: { id: 'tool-1', name: 'terminal' } })
    state = reduceGatewayEvent(state, { type: 'tool.complete', session_id: 'runtime-1', payload: { id: 'tool-1', name: 'terminal', output: 'ok' } })
    state = reduceGatewayEvent(state, { type: 'message.complete', session_id: 'runtime-1', payload: {} })

    expect(state.contractVersion).toBe(3)
    expect(state.storedSessionId).toBe('durable-1')
    expect(state.transcript.entries[0]).toMatchObject({ content: 'Hello', reasoning: 'Think', streaming: false })
    expect(state.tools[0]).toMatchObject({ detail: 'ok', status: 'complete' })
    expect(state.running).toBe(false)
  })

  it('preserves legacy and validated contract state when session events omit or corrupt the marker', () => {
    const legacy = { ...emptyChatState(), contractVersion: null, runtimeSessionId: 'legacy' }
    expect(reduceGatewayEvent(legacy, { type: 'session.info', session_id: 'legacy', payload: { running: true } }).contractVersion).toBeNull()

    const current = { ...emptyChatState(), contractVersion: 6, runtimeSessionId: 'current' }
    expect(reduceGatewayEvent(current, { type: 'session.info', session_id: 'current', payload: { desktop_contract: null } }).contractVersion).toBe(6)
  })

  it('preserves provenance for the same durable id and clears it when session info changes the id', () => {
    const transcript = createTranscript({ source: 'cron', storedSessionId: 'stored-1' })
    const state = { ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1', transcript }

    const same = reduceGatewayEvent(state, {
      type: 'session.info', session_id: 'runtime-1', payload: { stored_session_id: 'stored-1' }
    })
    expect(same.transcript.context).toEqual({ source: 'cron', storedSessionId: 'stored-1' })

    const changed = reduceGatewayEvent(same, {
      type: 'session.info', session_id: 'runtime-1', payload: { stored_session_id: 'stored-2' }
    })
    expect(changed.transcript.context).toEqual({ source: null, storedSessionId: 'stored-2' })
  })

  it.each(['clarify', 'approval', 'sudo', 'secret'] as const)('maps %s requests without persisting answers', kind => {
    const state = reduceGatewayEvent(emptyChatState(), { type: `${kind}.request`, payload: { request_id: 'request-1', question: 'value?' } })
    expect(state.pendingPrompt).toMatchObject({ kind, requestId: 'request-1' })
    expect(JSON.stringify(state)).not.toContain('answer')
  })

  it('ignores events for another runtime session and unknown future events', () => {
    const state = { ...emptyChatState(), runtimeSessionId: 'active' }
    expect(reduceGatewayEvent(state, { type: 'message.delta', session_id: 'other', payload: { delta: 'leak' } })).toBe(state)
    expect(reduceGatewayEvent(state, { type: 'gateway.future-event', payload: { anything: true } })).toBe(state)
  })
})

describe('prompt submission safety', () => {
  it('submits ordinary prompts without truncation parameters', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const { conversation, dispose } = subject(gateway)

    await conversation.send('  hello  ')

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: { session_id: 'runtime-1', text: 'hello' } })
    dispose()
  })

  it('queues active-turn prompts at the gateway instead of client memory', async () => {
    $chat.set({ ...emptyChatState(), running: true, runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const { conversation, dispose } = subject(gateway)

    await conversation.send('next task')

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: {
      queued: true,
      session_id: 'runtime-1',
      text: 'next task'
    } })
    dispose()
  })

  it('confirms a durable first-turn rewind by both ordinal and row id', async () => {
    $chat.set({
      ...emptyChatState(),
      runtimeSessionId: 'runtime-1',
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ role: 'user', content: 'hello', row_id: 41 }])
    })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const { conversation, dispose } = subject(gateway)

    await conversation.retryFrom(41, 'edited hello')

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: {
      confirm_empty_truncate: true,
      confirm_truncate: true,
      session_id: 'runtime-1',
      text: 'edited hello',
      truncate_before_row_id: 41,
      truncate_before_user_ordinal: 0
    } })
    dispose()
  })

  it('resolves the current ordinal by row id after older history prepends', async () => {
    let transcript = createTranscript({ source: null, storedSessionId: 'stored-1' }, [
      { role: 'user', content: 'recent', row_id: 41 }
    ])
    transcript = updateTranscript(transcript, {
      kind: 'prepend-history', fallbackOffset: 80,
      rows: [{ role: 'user', content: 'older', row_id: 40 }]
    })
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1', transcript })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const { conversation, dispose } = subject(gateway)

    await conversation.retryFrom(41, 'edited recent')

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: {
      confirm_truncate: true,
      session_id: 'runtime-1',
      text: 'edited recent',
      truncate_before_row_id: 41,
      truncate_before_user_ordinal: 1
    } })
    dispose()
  })

  it('uses the fresh ordinal through an open edit draft after history prepends', async () => {
    let transcript = createTranscript({ source: null, storedSessionId: 'stored-1' }, [
      { role: 'user', content: 'recent', row_id: 41 }
    ])
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1', transcript })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const { conversation, dispose } = subject(gateway)
    const interaction = new ChatInteraction({
      attach: vi.fn(), request: vi.fn(), retryFrom: conversation.retryFrom.bind(conversation), send: vi.fn()
    }, { request: vi.fn(), upload: vi.fn() })
    interaction.beginEdit({ content: 'recent', rowId: 41 })
    interaction.updateDraft('edited recent')

    transcript = updateTranscript($chat.get().transcript, {
      kind: 'prepend-history', fallbackOffset: 80,
      rows: [{ role: 'user', content: 'older', row_id: 40 }]
    })
    $chat.set({ ...$chat.get(), transcript })
    await interaction.submit()

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: expect.objectContaining({
      truncate_before_row_id: 41,
      truncate_before_user_ordinal: 1
    }) })
    interaction.dispose()
    dispose()
  })

  it('leaves chat retryable when prompt submission fails', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 })
    })
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.send('hello')).rejects.toMatchObject({ kind: 'auth' })

    expect($chat.get()).toMatchObject({ error: 'Unauthorized', running: false, runtimeSessionId: 'runtime-1' })
    dispose()
  })

  it('keeps a pending response when delivery fails', async () => {
    const pendingPrompt = { kind: 'approval' as const, payload: {}, requestId: 'request-1' }
    $chat.set({ ...emptyChatState(), pendingPrompt, runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('approval.respond', () => {
      throw new Error('Network disconnected')
    })
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.respond('yes')).rejects.toMatchObject({ kind: 'network' })

    expect($chat.get().pendingPrompt).toEqual(pendingPrompt)
    dispose()
  })

  it('refuses to rewind without a durable row id', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.retryFrom(undefined as never, 'unsafe')).rejects.toThrow(/durable message row/i)
    expect(gateway.calls).not.toContainEqual(expect.objectContaining({ method: 'prompt.submit' }))
    dispose()
  })

  it('discards prompt failures that resolve after the gateway scope changed', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    let release!: () => void
    const submitted = new Promise<void>(resolve => { release = resolve })
    const gateway = new MemoryGateway().handle('prompt.submit', () => submitted.then(() => {
      throw new Error('gateway exploded')
    }))
    const { conversation, dispose } = subject(gateway)

    const sending = conversation.send('hello')
    const stale = $chat.get()
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    release()
    await sending

    expect($chat.get()).toBe(stale)
    dispose()
  })
})

describe('incremental session loading', () => {
  it('loads a bounded latest transcript page and prepends older pages', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'stored-1' },
        session_id: 'runtime-1'
      }))
      .handle('/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [
          { content: 'recent question', role: 'user', row_id: 81 },
          { content: 'recent answer', role: 'assistant', row_id: 82 }
        ],
        pagination: { limit: 2, offset: 0, returned: 2 }
      }))
      .handle('/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=2&order=latest&profile=default', () => ({
        messages: [{ content: 'older answer', role: 'assistant', row_id: 80 }],
        pagination: { limit: 2, offset: 2, returned: 1 }
      }))
    const { conversation, dispose, runtime } = subject(gateway)

    conversation.adopt(await runtime.resumeSession(null, 'stored-1'))
    await conversation.reconcileHistory()

    expect($chat.get()).toMatchObject({ historyHasMore: true, historyNextOffset: 2 })
    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['recent question', 'recent answer'])

    await conversation.loadOlderMessages()

    expect($chat.get()).toMatchObject({ historyHasMore: false, historyLoadingOlder: false, historyNextOffset: 3 })
    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['older answer', 'recent question', 'recent answer'])
    dispose()
  })

  it('does not reconcile history for another session completion', async () => {
    $chat.set({
      ...emptyChatState(),
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1',
      transcript: createTranscript({ source: null, storedSessionId: 'stored-1' })
    })
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)

    conversation.onGatewayEvent({ type: 'message.complete', session_id: 'runtime-other', payload: {} })
    await Promise.resolve()

    expect(gateway.calls).toEqual([])
    dispose()
  })

  it('falls back to live history when a resumed session is not yet available through REST', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'stored-1' },
        session_id: 'runtime-1'
      }))
      .handle('/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => {
        throw Object.assign(new Error('Session not found'), { status: 404 })
      })
      .handle('session.history', () => ({ messages: [{ content: 'live answer', role: 'assistant' }] }))
    const { conversation, dispose, runtime } = subject(gateway)

    conversation.adopt(await runtime.resumeSession(null, 'stored-1'))
    await conversation.reconcileHistory()

    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['live answer'])
    dispose()
  })

  it('reconciles once when the live session completes a message and grafts the refetched page', async () => {
    let fetches = 0
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'stored-1' },
        session_id: 'runtime-1'
      }))
      .handle('/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => {
        fetches += 1
        return {
          messages: [
            { content: 'recent answer', role: 'assistant', row_id: 82 },
            { content: 'final answer', role: 'assistant', row_id: 83 }
          ],
          pagination: { limit: 80, offset: 0, returned: 2 }
        }
      })
    const { conversation, dispose, runtime } = subject(gateway)

    conversation.adopt(await runtime.resumeSession(null, 'stored-1'))
    $chat.set({
      ...$chat.get(),
      historyBackfilled: true,
      transcript: createTranscript({ source: null, storedSessionId: 'stored-1' }, [
        { content: 'older answer', role: 'assistant', row_id: 80 },
        { content: 'recent answer', role: 'assistant', row_id: 82 }
      ])
    })

    conversation.onGatewayEvent({ type: 'message.complete', session_id: 'runtime-1', payload: {} })

    await vi.waitFor(() => expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['older answer', 'recent answer', 'final answer']))
    expect(fetches).toBe(1)
    expect($chat.get()).toMatchObject({ historyHasMore: false, historyNextOffset: 2, running: false })
    dispose()
  })
})