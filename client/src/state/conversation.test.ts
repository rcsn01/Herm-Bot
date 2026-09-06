import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayPort } from '~/gateway/gateway-port'
import type { ChatState } from '~/lib/types'
import { SessionRuntime, toTranscript } from '~/gateway/session-runtime'
import { MINIMUM_CONTRACT } from '~/state/gateway-controller'
import { $chat, Conversation, emptyChatState, reduceGatewayEvent } from '~/state/conversation'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

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
    expect(state.messages[0]).toMatchObject({ content: 'Hello', reasoning: 'Think', streaming: false })
    expect(state.tools[0]).toMatchObject({ detail: 'ok', status: 'complete' })
    expect(state.running).toBe(false)
  })

  it('preserves legacy and validated contract state when session events omit or corrupt the marker', () => {
    const legacy = { ...emptyChatState(), contractVersion: null, runtimeSessionId: 'legacy' }
    expect(reduceGatewayEvent(legacy, { type: 'session.info', session_id: 'legacy', payload: { running: true } }).contractVersion).toBeNull()

    const current = { ...emptyChatState(), contractVersion: 6, runtimeSessionId: 'current' }
    expect(reduceGatewayEvent(current, { type: 'session.info', session_id: 'current', payload: { desktop_contract: null } }).contractVersion).toBe(6)
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

describe('session identity and history mapping', () => {
  it('maps backend history without conflating message, runtime, and durable identities', () => {
    const messages = toTranscript([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', reasoning: 'briefly' }
    ] as never)
    expect(messages).toEqual([
      { content: 'hello', id: 'history-0', reasoning: undefined, role: 'user', streaming: false },
      { content: 'hi', id: 'history-1', reasoning: 'briefly', role: 'assistant', streaming: false }
    ])
  })

  it('projects internal timeline rows as compact activity instead of user messages', () => {
    const messages = toTranscript([
      { role: 'user', content: '[ASYNC DELEGATION COMPLETE — deleg_typed]\nagent result', display_kind: 'async_delegation_complete', display_metadata: { task_count: 1 }, row_id: 39 },
      { role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_legacy]\nA background fan-out of 3 subagent(s) you dispatched earlier has finished. All ran in parallel and waited on each other; their consolidated results are below.', row_id: 40 },
      { role: 'user', content: 'internal handoff', display_kind: 'hidden', row_id: 41 },
      { role: 'user', content: 'switch payload', display_kind: 'model_switch', row_id: 42 }
    ] as never)

    expect(messages).toEqual([
      { content: '1 background agent finished', displayKind: 'async_delegation_complete', id: 'history-row-39', reasoning: undefined, role: 'system', rowId: 39, streaming: false },
      { content: '3 background agents finished', displayKind: 'async_delegation_complete', id: 'history-row-40', reasoning: undefined, role: 'system', rowId: 40, streaming: false },
      { content: 'model changed', displayKind: 'model_switch', id: 'history-row-42', reasoning: undefined, role: 'system', rowId: 42, streaming: false }
    ])
  })

  it('hydrates the current gateway projection and keeps durable row identity separate', () => {
    const messages = toTranscript([
      { role: 'user', content: 'model-only', display_content: 'visible', row_id: 41, text: 'fallback' },
      { role: 'assistant', content: null, reasoning_content: 'carefully', text: 'answer' },
      { role: 'tool', content: null, context: 'terminal output', id: 43 },
      { role: 'assistant', content: { type: 'image' }, text: 'must not stringify malformed content' }
    ] as never)

    expect(messages).toEqual([
      { content: 'visible', id: 'history-row-41', reasoning: undefined, role: 'user', rowId: 41, streaming: false },
      { content: 'answer', id: 'history-1', reasoning: 'carefully', role: 'assistant', streaming: false },
      { content: 'terminal output', id: 'history-row-43', reasoning: undefined, role: 'tool', rowId: 43, streaming: false },
      { content: '', id: 'history-3', reasoning: undefined, role: 'assistant', streaming: false }
    ])
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
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const { conversation, dispose } = subject(gateway)

    await conversation.retryFrom(0, 41, 'edited hello')

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

    await expect(conversation.retryFrom(1, undefined as never, 'unsafe')).rejects.toThrow(/durable message row/i)
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
    expect($chat.get().messages.map(message => message.content)).toEqual(['recent question', 'recent answer'])

    await conversation.loadOlderMessages()

    expect($chat.get()).toMatchObject({ historyHasMore: false, historyLoadingOlder: false, historyNextOffset: 3 })
    expect($chat.get().messages.map(message => message.content)).toEqual(['older answer', 'recent question', 'recent answer'])
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

    expect($chat.get().messages.map(message => message.content)).toEqual(['live answer'])
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
      messages: [
        { content: 'older answer', id: 'history-row-80', role: 'assistant', rowId: 80, streaming: false },
        { content: 'recent answer', id: 'history-row-82', role: 'assistant', rowId: 82, streaming: false }
      ]
    })

    conversation.onGatewayEvent({ type: 'message.complete', session_id: 'runtime-1', payload: {} })

    await vi.waitFor(() => expect($chat.get().messages.map(message => message.content)).toEqual(['older answer', 'recent answer', 'final answer']))
    expect(fetches).toBe(1)
    expect($chat.get()).toMatchObject({ historyHasMore: false, historyNextOffset: 2, running: false })
    dispose()
  })
})