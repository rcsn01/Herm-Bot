import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInteraction } from '~/features/chat/chat-interaction'
import type { GatewayTransport } from '~/gateway/gateway-port'
import type { ChatState } from '~/lib/types'
import { SessionRuntime } from '~/gateway/session-runtime'
import { MINIMUM_CONTRACT } from '~/state/gateway-controller'
import { $chat, Conversation, emptyChatState as emptyState, reduceGatewayEvent } from '~/state/conversation'
import { transcriptCache } from '~/state/transcript-cache'
import { $preferences } from '~/state/store'
import { $draftOwner, lockDraftOwner } from '~/state/draft-owner'
import { MemoryGateway } from '~/test/memory-gateway'
import { createTranscript, updateTranscript } from '~/transcript/transcript'

const emptyChatState = (): ChatState => ({ ...emptyState(), availability: 'live' })
function saveCachedTranscript(profile: string | null, snapshot: { storedSessionId: string; entries: import('~/transcript/transcript').TranscriptEntry[] }) {
  transcriptCache.write({ owner: $draftOwner.get(), profile, storedSessionId: snapshot.storedSessionId }, { ...snapshot, title: '', source: null, startedAt: null, lastSyncedAt: 1 })
}
function loadCachedTranscript(profile: string | null) { return transcriptCache.latest($draftOwner.get(), profile) }

function subject(gateway: GatewayTransport) {
  const runtime = new SessionRuntime(gateway, { minimumContract: MINIMUM_CONTRACT, retryDelays: [0] })
  const conversation = new Conversation(runtime)
  return { conversation, dispose: () => runtime.dispose(), runtime }
}

beforeEach(() => {
  $chat.set(emptyChatState())
  $preferences.set({ authMode: 'token', profile: null, remoteURL: '', theme: 'system' })
  localStorage.clear()
})

describe('session model metadata', () => {
  it('retains model and effort on adoption and replaces them on live updates', () => {
    const { conversation, dispose } = subject(new MemoryGateway())
    conversation.adopt({ contractVersion: null, info: { model: ' provider/first ', reasoning_effort: ' high ' }, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    expect($chat.get().info).toMatchObject({ model: 'provider/first', reasoningEffort: 'high' })
    $chat.set(reduceGatewayEvent($chat.get(), { type: 'session.info', session_id: 'runtime-1', payload: { model: 'provider/second', reasoning_effort: 'low' } }))
    expect($chat.get().info).toMatchObject({ model: 'provider/second', reasoningEffort: 'low' })
    dispose()
  })
})

describe('active session title', () => {
  it('retitles only a matching active session with conversation info', () => {
    const { conversation, dispose } = subject(new MemoryGateway())
    const info = { running: false, title: '', usage: null }
    $chat.set({ ...emptyChatState(), info, storedSessionId: 'stored-1' })

    conversation.retitleActive('stored-1', 'Renamed')
    expect($chat.get().info).toEqual({ ...info, title: 'Renamed' })

    const otherSession = { ...$chat.get(), storedSessionId: 'stored-2' }
    $chat.set(otherSession)
    conversation.retitleActive('stored-1', 'Ignored')
    expect($chat.get()).toBe(otherSession)

    const missingInfo = { ...emptyChatState(), storedSessionId: 'stored-1' }
    $chat.set(missingInfo)
    conversation.retitleActive('stored-1', 'Ignored')
    expect($chat.get()).toBe(missingInfo)
    dispose()
  })
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

  it.each(['clarify', 'approval', 'sudo', 'secret'] as const)('resolves the question for %s requests without persisting answers', kind => {
    const questionCases: Array<{ fields: Record<string, unknown>; question: string }> = [
      { fields: { question: 'question?', message: 'message?', command: 'command?' }, question: 'question?' },
      { fields: { question: null, message: 'message?', command: 'command?' }, question: 'message?' },
      { fields: { question: null, message: null, command: 'command?' }, question: 'command?' },
      { fields: { question: '', message: 'message?', command: 'command?' }, question: '' },
      { fields: { question: false, message: 'message?', command: 'command?' }, question: 'false' },
      { fields: { question: 0, message: 'message?', command: 'command?' }, question: '0' },
      { fields: { question: null, message: '', command: 'command?' }, question: '' },
      { fields: { question: null, message: false, command: 'command?' }, question: 'false' },
      { fields: { question: null, message: 0, command: 'command?' }, question: '0' },
      { fields: { question: null, message: null, command: '' }, question: '' },
      { fields: { question: null, message: null, command: false }, question: 'false' },
      { fields: { question: null, message: null, command: 0 }, question: '0' },
      { fields: { question: null, message: null, command: null }, question: '' },
      { fields: { question: null, message: '  unchanged whitespace  ' }, question: '  unchanged whitespace  ' },
      { fields: { question: 42 }, question: '42' },
      { fields: { question: false }, question: 'false' },
      { fields: { question: null, message: 42 }, question: '42' },
      { fields: { question: null, message: false }, question: 'false' },
      { fields: { question: null, message: null, command: 42 }, question: '42' },
      { fields: {}, question: '' }
    ]

    for (const { fields, question } of questionCases) {
      const state = reduceGatewayEvent(emptyChatState(), {
        type: `${kind}.request`, payload: { request_id: 'request-1', ...fields }
      })
      expect(state.pendingPrompt).toEqual({ kind, question, requestId: 'request-1' })
      expect(JSON.stringify(state)).not.toContain('answer')
    }
  })

  it.each([
    { name: 'current context rather than cumulative totals', payload: { title: 'Planning', running: true, usage: { context_used: 25, context_max: 100, total: 9999 } }, info: { title: 'Planning', running: true, usage: { used: 25, limit: 100 } }, running: true },
    { name: 'trimmed session model and effort', payload: { model: '  provider/model  ', reasoning_effort: ' high ' }, info: { title: '', running: false, model: 'provider/model', reasoningEffort: 'high', usage: null }, running: false },
    { name: 'empty model and effort', payload: { model: '  ', reasoning_effort: '' }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'malformed model and effort', payload: { model: { name: 'model' }, reasoning_effort: false }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'title preserves surrounding whitespace', payload: { title: '  Planning  ' }, info: { title: '  Planning  ', running: false, usage: null }, running: false },
    { name: 'cumulative aliases are not context', payload: { usage: { max_tokens: 100, total_tokens: 25 } }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'estimated context is identified', payload: { usage: { context_used: 25, context_max: 100, context_estimated: true } }, info: { title: '', running: false, usage: { used: 25, limit: 100, estimated: true } }, running: false },
    { name: 'null context does not fall back to totals', payload: { usage: { context_used: null, total: 25, context_max: 100 } }, info: { title: '', running: false, usage: { used: null, limit: 100 } }, running: false },
    { name: 'blank counts are unknown rather than zero', payload: { usage: { context_used: '', context_max: 100 } }, info: { title: '', running: false, usage: { used: null, limit: 100 } }, running: false },
    { name: 'boolean counts are unknown rather than zero', payload: { usage: { context_used: false, context_max: 100 } }, info: { title: '', running: false, usage: { used: null, limit: 100 } }, running: false },
    { name: 'reported zero occupancy is retained', payload: { usage: { context_used: 0, context_max: 100 } }, info: { title: '', running: false, usage: { used: 0, limit: 100 } }, running: false },
    { name: 'zero capacity is unknown', payload: { usage: { context_used: 25, context_max: 0 } }, info: { title: '', running: false, usage: { used: 25, limit: null } }, running: false },
    { name: 'negative and infinite counts are rejected', payload: { usage: { context_used: -1, context_max: Infinity } }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'fractional and unsafe counts are rejected', payload: { usage: { context_used: 1.5, context_max: Number.MAX_SAFE_INTEGER + 1 } }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'absent usage and title', payload: {}, info: { title: '', running: false, usage: null }, running: false },
    { name: 'null usage', payload: { usage: null }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'primitive usage', payload: { usage: 'legacy' }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'array usage', payload: { usage: [] }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'empty usage object', payload: { usage: {} }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'total only is not occupancy', payload: { usage: { total: 25 } }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'capacity only leaves occupancy unknown', payload: { usage: { context_max: 100 } }, info: { title: '', running: false, usage: { used: null, limit: 100 } }, running: false },
    { name: 'occupancy without capacity', payload: { usage: { context_used: 25 } }, info: { title: '', running: false, usage: { used: 25, limit: null } }, running: false },
    { name: 'numeric strings are validated', payload: { usage: { context_used: '25', context_max: '100' } }, info: { title: '', running: false, usage: { used: 25, limit: 100 } }, running: false },
    { name: 'garbage in both fields yields no usage', payload: { usage: { context_used: 'bad', context_max: 'bad' } }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'invalid occupancy beside valid capacity is unknown', payload: { usage: { context_used: 'bad', context_max: 100 } }, info: { title: '', running: false, usage: { used: null, limit: 100 } }, running: false },
    { name: 'invalid capacity beside valid occupancy is unknown', payload: { usage: { context_used: 25, context_max: 'bad' } }, info: { title: '', running: false, usage: { used: 25, limit: null } }, running: false },
    { name: 'non-string title', payload: { title: 42 }, info: { title: '', running: false, usage: null }, running: false },
    { name: 'truthy non-boolean running', payload: { running: 'yes' }, info: { title: '', running: true, usage: null }, running: true },
    { name: 'false running', payload: { running: false }, info: { title: '', running: false, usage: null }, running: false }
  ])('normalizes session.info: $name', ({ payload, info, running }) => {
    const state = reduceGatewayEvent({ ...emptyChatState(), runtimeSessionId: 'runtime-1' }, {
      type: 'session.info', session_id: 'runtime-1', payload
    })
    expect(state.info).toEqual(info)
    expect(state.running).toBe(running)
  })

  it('replaces the complete info snapshot when a later session.info omits fields', () => {
    const populated = reduceGatewayEvent({ ...emptyChatState(), runtimeSessionId: 'runtime-1' }, {
      type: 'session.info', session_id: 'runtime-1', payload: {
        title: 'Planning', running: true, model: 'provider/model', reasoning_effort: 'high', usage: { context_used: 25, context_max: 100 }
      }
    })

    const replaced = reduceGatewayEvent(populated, {
      type: 'session.info', session_id: 'runtime-1', payload: { running: false }
    })

    expect(replaced.info).toEqual({ title: '', running: false, usage: null })
    expect(replaced.running).toBe(false)
  })

  it('updates live context usage without erasing session metadata or running state', () => {
    const state = { ...emptyChatState(), runtimeSessionId: 'active', running: true,
      info: { title: 'Planning', running: true, model: 'provider/model', reasoningEffort: 'high', usage: null } }
    const updated = reduceGatewayEvent(state, { type: 'session.usage', session_id: 'active', payload: {
      usage: { total: 900000, context_used: 25000, context_max: 100000 }
    } })
    expect(updated.info).toEqual({ ...state.info, usage: { used: 25000, limit: 100000 } })
    expect(updated.running).toBe(true)
    expect(updated.lastResponseAt).toBeNull()
    expect(reduceGatewayEvent(updated, { type: 'session.usage', session_id: 'other', payload: { usage: {} } })).toBe(updated)
  })

  it('anchors the cache estimate only to successful observed completion, and consumes final usage', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456)
    const state = { ...emptyChatState(), runtimeSessionId: 'active' }
    const complete = reduceGatewayEvent(state, { type: 'message.complete', session_id: 'active', payload: {
      status: 'complete', usage: { total: 900000, context_used: 50, context_max: 100 }
    } })
    expect(complete.lastResponseAt).toBe(123456)
    expect(complete.info?.usage).toEqual({ used: 50, limit: 100 })
    for (const status of ['error', 'interrupted', 'unknown']) {
      expect(reduceGatewayEvent(state, { type: 'message.complete', session_id: 'active', payload: { status } }).lastResponseAt).toBeNull()
    }
    expect(reduceGatewayEvent(state, { type: 'message.complete', session_id: 'other', payload: {} })).toBe(state)
    expect(reduceGatewayEvent(complete, { type: 'message.start', session_id: 'active', payload: {} }).lastResponseAt).toBe(123456)
    expect(reduceGatewayEvent(complete, { type: 'message.complete', session_id: 'active', payload: { status: 'error' } }).lastResponseAt).toBe(123456)
  })

  it('retires the cache estimate when the session model changes', () => {
    const state = { ...emptyChatState(), runtimeSessionId: 'active', lastResponseAt: 123456,
      info: { title: '', running: false, model: 'first', usage: null } }
    const changed = reduceGatewayEvent(state, { type: 'session.info', session_id: 'active', payload: { model: 'second' } })
    expect(changed.lastResponseAt).toBeNull()
  })

  it('ignores events for another runtime session and unknown future events', () => {
    const state = { ...emptyChatState(), runtimeSessionId: 'active' }
    expect(reduceGatewayEvent(state, { type: 'message.delta', session_id: 'other', payload: { delta: 'leak' } })).toBe(state)
    expect(reduceGatewayEvent(state, { type: 'gateway.future-event', payload: { anything: true } })).toBe(state)
  })
})

describe('prompt submission safety', () => {
  it.each(['send', 'queue', 'retry'] as const)('shows %s pending on the correct message until its acknowledgement', async mode => {
    $chat.set({ ...emptyChatState(), running: mode === 'queue', runtimeSessionId: 'runtime-1',
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ role: 'user', content: 'original', row_id: 41 }]) })
    let accept!: (value: unknown) => void
    const gateway = new MemoryGateway().handle('prompt.submit', () => new Promise(resolve => { accept = resolve }))
    const { conversation, dispose } = subject(gateway)
    try {
      const submission = mode === 'retry' ? conversation.retryFrom(41, 'new message') : conversation.send('new message')
      expect($chat.get().transcript.entries.at(-1)).toMatchObject({ content: 'new message', delivery: 'pending' })
      await vi.waitFor(() => expect(accept).toBeTypeOf('function'))
      accept({ status: mode === 'queue' ? 'queued' : 'streaming' })
      await submission
      expect($chat.get().transcript.entries.at(-1)).toMatchObject({ content: 'new message', delivery: 'accepted' })
      expect($chat.get().transcript.entries).toHaveLength(mode === 'retry' ? 1 : 2)
    } finally { dispose() }
  })

  it.each([
    { error: new Error('Network disconnected'), delivery: 'uncertain' },
    { error: new Error('Submission rejected'), delivery: 'failed' }
  ])('marks a failed submission $delivery without confirming another message', async ({ error, delivery }) => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1',
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ role: 'user', content: 'earlier', row_id: 1 }]) })
    const { conversation, dispose } = subject(new MemoryGateway().handle('prompt.submit', () => { throw error }))
    try {
      await expect(conversation.send('new message')).rejects.toThrow(error.message)
      expect($chat.get().transcript.entries.at(-1)).toMatchObject({ content: 'new message', delivery })
      expect($chat.get().transcript.entries[0]).not.toHaveProperty('delivery')
    } finally { dispose() }
  })

  it('retires pending delivery on interruption and ignores an acknowledgement after switching conversations', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    let accept!: (value: unknown) => void
    const { conversation, dispose } = subject(new MemoryGateway().handle('prompt.submit', () => new Promise(resolve => { accept = resolve })))
    try {
      const submission = conversation.send('old conversation')
      await vi.waitFor(() => expect(accept).toBeTypeOf('function'))
      conversation.suspend()
      expect($chat.get().transcript.entries.at(-1)).toMatchObject({ delivery: 'uncertain' })
      const other = { ...emptyChatState(), runtimeSessionId: 'runtime-2' }
      $chat.set(other)
      accept({ status: 'streaming' })
      await submission
      expect($chat.get()).toBe(other)
    } finally { dispose() }
  })

  describe.each(['send', 'queue', 'retry'] as const)('%s acknowledgement', mode => {
    it.each([
      { label: 'streaming', acknowledgement: { status: 'streaming' }, expected: 'accepted' },
      { label: 'queued', acknowledgement: { status: 'queued' }, expected: 'accepted' },
      { label: 'steered', acknowledgement: { status: 'steered' }, expected: 'accepted' },
      { label: 'redirected', acknowledgement: { status: 'redirected' }, expected: 'accepted' },
      { label: 'isolated streaming', acknowledgement: { status: 'streaming', turn_isolation: true }, expected: 'accepted' },
      { label: 'legacy explicit acceptance', acknowledgement: { accepted: true }, expected: 'accepted' },
      { label: 'empty', acknowledgement: {}, expected: 'uncertain' },
      { label: 'missing', acknowledgement: undefined, expected: 'uncertain' },
      { label: 'null', acknowledgement: null, expected: 'uncertain' },
      { label: 'array', acknowledgement: [{ status: 'streaming' }], expected: 'uncertain' },
      { label: 'bare string', acknowledgement: 'streaming', expected: 'uncertain' },
      { label: 'unknown status', acknowledgement: { status: 'ok' }, expected: 'uncertain' },
      { label: 'rejected status', acknowledgement: { status: 'rejected' }, expected: 'uncertain' },
      { label: 'malformed status', acknowledgement: { status: true }, expected: 'uncertain' },
      { label: 'false acceptance', acknowledgement: { accepted: false }, expected: 'uncertain' },
      { label: 'string acceptance', acknowledgement: { accepted: 'true' }, expected: 'uncertain' }
    ])('classifies $label without inferring execution', async ({ acknowledgement, expected }) => {
      $chat.set({ ...emptyChatState(), running: mode === 'queue', runtimeSessionId: 'runtime-1',
        transcript: createTranscript({ source: null, storedSessionId: null }, [{ role: 'user', content: 'original', row_id: 41 }]) })
      const gateway = new MemoryGateway().handle('prompt.submit', () => acknowledgement)
      const { conversation, dispose } = subject(gateway)
      try {
        const submission = mode === 'retry' ? conversation.retryFrom(41, 'Ping') : conversation.send('Ping')
        await expect(submission).resolves.toEqual({ status: expected, mode })
        expect($chat.get().transcript.entries.at(-1)).toMatchObject({ content: 'Ping', delivery: expected })
      } finally { dispose() }
    })
  })

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

  it('retains queue dispatch identity across turn completion and guards direct duplicate submissions', async () => {
    $chat.set({ ...emptyChatState(), running: true, runtimeSessionId: 'runtime-1' })
    let accept!: (value: unknown) => void
    const gateway = new MemoryGateway().handle('prompt.submit', () => new Promise(resolve => { accept = resolve }))
    const { conversation, dispose } = subject(gateway)
    const first = conversation.send('next task')
    await expect(conversation.send('duplicate')).rejects.toThrow('already pending')
    $chat.set({ ...$chat.get(), running: false })
    accept({ accepted: true })
    await expect(first).resolves.toEqual({ status: 'accepted', mode: 'queue' })
    expect(gateway.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    dispose()
  })

  it('guards repeated interrupt calls without inventing completion or blocking Queue', async () => {
    $chat.set({ ...emptyChatState(), running: true, runtimeSessionId: 'runtime-1' })
    let finish!: (value: unknown) => void
    const gateway = new MemoryGateway().handle('session.interrupt', () => new Promise(resolve => { finish = resolve })).handle('prompt.submit', () => ({ accepted: true }))
    const { conversation, dispose } = subject(gateway)
    const first = conversation.interrupt()
    await conversation.interrupt()
    await expect(conversation.send('queued separately')).resolves.toEqual({ status: 'accepted', mode: 'queue' })
    expect(gateway.calls.filter(call => call.method === 'session.interrupt')).toHaveLength(1)
    finish({})
    await first
    expect($chat.get().running).toBe(true)
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
      attach: vi.fn(), completeSlash: vi.fn(), retryFrom: conversation.retryFrom.bind(conversation), send: vi.fn()
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
    const pendingPrompt = { kind: 'approval' as const, question: '', requestId: 'request-1' }
    $chat.set({ ...emptyChatState(), pendingPrompt, runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('approval.respond', () => {
      throw new Error('Network disconnected')
    })
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.respond('yes')).rejects.toMatchObject({ kind: 'network' })

    expect($chat.get().pendingPrompt).toEqual(pendingPrompt)
    dispose()
  })

  it('sends every prompt response with only its kind-specific wire field', async () => {
    const cases = [
      { kind: 'clarify', method: 'clarify.respond', field: 'answer', value: 'text answer' },
      { kind: 'approval', method: 'approval.respond', field: 'choice', value: 'allow' },
      { kind: 'sudo', method: 'sudo.respond', field: 'password', value: 'secret password' },
      { kind: 'secret', method: 'secret.respond', field: 'value', value: 'secret value' }
    ] as const

    for (const { kind, method, field, value } of cases) {
      const gateway = new MemoryGateway().handle(method, () => ({}))
      const { conversation, dispose } = subject(gateway)
      $chat.set({
        ...emptyChatState(),
        pendingPrompt: { kind, question: 'question', requestId: `request-${kind}` },
        runtimeSessionId: 'runtime-1'
      })

      await conversation.respond(kind === 'approval' ? 'unused' : value, kind === 'approval' ? value : undefined)

      expect(gateway.calls).toEqual([{
        kind: 'rpc',
        method,
        value: {
          request_id: `request-${kind}`,
          session_id: 'runtime-1',
          [field]: value
        }
      }])
      expect($chat.get().pendingPrompt).toBeNull()
      dispose()
    }
  })

  it('does not clear a replacement prompt when an earlier response resolves', async () => {
    $chat.set({
      ...emptyChatState(),
      pendingPrompt: { kind: 'clarify', question: 'First question', requestId: 'request-1' },
      runtimeSessionId: 'runtime-1'
    })
    let release!: () => void
    const gateway = new MemoryGateway().handle('clarify.respond', () => new Promise<void>(resolve => { release = resolve }))
    const { conversation, dispose } = subject(gateway)

    const responding = conversation.respond('answer')
    const replacement = { kind: 'secret' as const, question: 'Second question', requestId: 'request-2' }
    $chat.set({ ...$chat.get(), pendingPrompt: replacement })
    release()
    await responding

    expect($chat.get().pendingPrompt).toBe(replacement)
    dispose()
  })

  it('does not clear a pending prompt when its response resolves in a different Scope', async () => {
    const pendingPrompt = { kind: 'clarify' as const, question: 'Question', requestId: 'request-1' }
    $chat.set({ ...emptyChatState(), pendingPrompt, runtimeSessionId: 'runtime-1' })
    let release!: () => void
    const gateway = new MemoryGateway().handle('clarify.respond', () => new Promise<void>(resolve => { release = resolve }))
    const { conversation, dispose } = subject(gateway)

    const responding = conversation.respond('answer')
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    release()
    await responding

    expect($chat.get().pendingPrompt).toBe(pendingPrompt)
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

  it('does not dispatch a prompt after authentication changes during pre-send feedback', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({ accepted: true }))
    const { conversation, dispose } = subject(gateway)
    const sending = conversation.send('private draft')
    lockDraftOwner()
    await expect(sending).rejects.toMatchObject({ kind: 'validation' })
    expect(gateway.calls.some(call => call.method === 'prompt.submit')).toBe(false)
    dispose()
  })

  it('reports prompt failure without mutating the destination after scope changed', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    let release!: () => void
    const submitted = new Promise<void>(resolve => { release = resolve })
    const gateway = new MemoryGateway().handle('prompt.submit', () => submitted.then(() => {
      throw new Error('gateway exploded')
    }))
    const { conversation, dispose } = subject(gateway)

    const sending = conversation.send('hello')
    await vi.waitFor(() => expect(gateway.calls.some(call => call.method === 'prompt.submit')).toBe(true))
    const stale = $chat.get()
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    release()
    await expect(sending).rejects.toThrow('gateway exploded')

    expect($chat.get()).toBe(stale)
    dispose()
  })
})

describe('attachments', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stubCompletedRead = () => {
    vi.stubGlobal('FileReader', class {
      error = null
      onerror: (() => void) | null = null
      onload: (() => void) | null = null
      result: string | null = null

      readAsDataURL() {
        this.result = 'data:text/plain;base64,eHg='
        queueMicrotask(() => this.onload?.())
      }
    })
  }

  it('routes images to image.attach_bytes and other files to file.attach with the active session', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    stubCompletedRead()
    const gateway = new MemoryGateway()
      .handle('image.attach_bytes', () => ({ ref_text: '@file:pic.png' }))
      .handle('file.attach', () => ({ ref_text: '@file:doc.txt' }))
    const { conversation, dispose } = subject(gateway)

    expect(await conversation.attach(new File(['x'], 'pic.png', { type: 'image/png' }))).toBe('@file:pic.png')
    expect(await conversation.attach(new File(['x'], 'doc.txt'))).toBe('@file:doc.txt')
    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'image.attach_bytes', value: { data_url: 'data:text/plain;base64,eHg=', name: 'pic.png', session_id: 'runtime-1' } })
    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'file.attach', value: { data_url: 'data:text/plain;base64,eHg=', name: 'doc.txt', path: 'doc.txt', session_id: 'runtime-1' } })
    dispose()
  })

  it('does not invent ready references for empty or missing attachment acknowledgements', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    stubCompletedRead()
    const gateway = new MemoryGateway()
      .handle('file.attach', () => ({}))
      .handle('image.attach_bytes', () => ({ ref_text: '' }))
    const { conversation, dispose } = subject(gateway)

    expect(await conversation.attach(new File(['x'], 'doc.txt'))).toBeUndefined()
    expect(await conversation.attach(new File(['x'], 'pic.png', { type: 'image/png' }))).toBeUndefined()
    dispose()
  })

  it('resolves undefined for a falsy response', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    stubCompletedRead()
    const gateway = new MemoryGateway().handle('file.attach', () => null)
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.attach(new File(['x'], 'doc.txt'))).resolves.toBeUndefined()
    dispose()
  })

  it('rejects image and file uploads over their size caps before any RPC', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)
    const image = new File(['x'], 'pic.png', { type: 'image/png' })
    Object.defineProperty(image, 'size', { value: 20 * 1_024 * 1_024 + 1 })
    const doc = new File(['x'], 'doc.txt')
    Object.defineProperty(doc, 'size', { value: 50 * 1_024 * 1_024 + 1 })

    await expect(conversation.attach(image)).rejects.toThrow('This attachment exceeds the 20 MB mobile upload limit.')
    await expect(conversation.attach(doc)).rejects.toThrow('This attachment exceeds the 50 MB mobile upload limit.')
    expect(gateway.calls).toEqual([])
    dispose()
  })

  it('returns undefined without an RPC when the gateway scope goes stale mid-read', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    let releaseReader!: () => void
    vi.stubGlobal('FileReader', class {
      error = null
      onerror: (() => void) | null = null
      onload: (() => void) | null = null
      result: string | null = null

      readAsDataURL() {
        this.result = 'data:text/plain;base64,eHg='
        releaseReader = () => this.onload?.()
      }
    })
    const gateway = new MemoryGateway().handle('file.attach', () => ({ ref_text: '@file:doc.txt' }))
    const { conversation, dispose } = subject(gateway)

    const attaching = conversation.attach(new File(['x'], 'doc.txt'))
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    releaseReader()
    await expect(attaching).resolves.toBeUndefined()
    expect(gateway.calls).toEqual([])
    dispose()
  })
})

describe('slash completion', () => {
  it('scopes completions to the current session and ignores malformed rows', async () => {
    const gateway = new MemoryGateway().handle('complete.slash', () => ({ items: [null, { text: 3 }, { text: 'status', meta: 7 }], replace_from: -1 }))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.completeSlash('/st')).resolves.toEqual({ items: [{ text: 'status' }], replaceFrom: undefined })
    expect(gateway.calls[0].value).toEqual({ text: '/st', session_id: 'runtime-1' })
    dispose()
  })

  it('lists and filters session model options with provider identity and the current model', async () => {
    const gateway = new MemoryGateway().handle('model.options', () => ({ model: 'demo', provider: 'test', providers: [
      { name: 'Test', slug: 'test', models: ['demo', 'other', '--global', 'bad --provider evil', null] },
      { name: 'Other provider', slug: 'other', models: ['demo'] },
      { slug: 'locked', authenticated: false, models: ['demo'] },
      { slug: 'paid', models: ['demo'], unavailable_models: ['demo'] }
    ] }))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const choices = await conversation.completeSlash('/model')
    expect(choices.replaceFrom).toBe(6)
    expect(choices.items).toHaveLength(3)
    expect(choices.items[0]).toMatchObject({ text: ' demo --provider test --session', display: 'demo', meta: 'Test · Current', kind: 'model' })
    const filtered = await conversation.completeSlash('/model other')
    expect(filtered.items.map(item => item.text)).toEqual(['other --provider test --session', 'demo --provider other --session'])
    expect(filtered.replaceFrom).toBe(7)
    expect(gateway.calls[0].value).toEqual({ session_id: 'runtime-1', explicit_only: true })
    expect(gateway.calls).toHaveLength(1) // Filtering reuses the same inventory request.
    dispose()
  })

  it('discards completions after switching conversations in the same profile', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gateway = new MemoryGateway().handle('complete.slash', () => gate.then(() => ({ items: [{ text: 'status' }] })))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const completing = conversation.completeSlash('/')
    $chat.set({ ...$chat.get(), runtimeSessionId: 'runtime-2' })
    release()
    await expect(completing).rejects.toMatchObject({ name: 'AbortError' })
    dispose()
  })

  it('resolves the suggestion payload and sends the draft as text', async () => {
    const gateway = new MemoryGateway().handle('complete.slash', () => ({ items: [{ text: '/research' }], replace_from: 2 }))
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.completeSlash('/re')).resolves.toEqual({ items: [{ text: '/research' }], replaceFrom: 2 })
    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'complete.slash', value: { text: '/re', profile: 'default' } })
    dispose()
  })

  it('defaults a missing suggestion list and a non-numeric replace_from', async () => {
    const gateway = new MemoryGateway().handle('complete.slash', () => ({ items: null, replace_from: 'x' }))
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.completeSlash('/re')).resolves.toEqual({ items: [], replaceFrom: undefined })
    dispose()
  })

  it('rejects with an abort error when the gateway scope changed mid-RPC', async () => {
    let release!: () => void
    const submitted = new Promise<void>(resolve => { release = resolve })
    const gateway = new MemoryGateway().handle('complete.slash', () => submitted.then(() => ({})))
    const { conversation, dispose } = subject(gateway)

    const pending = conversation.completeSlash('/re')
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    release()
    await expect(pending).rejects.toMatchObject({ message: 'Gateway scope or conversation changed.', name: 'AbortError' })
    dispose()
  })
})

describe('slash execution', () => {
  it('follows alias directives with their arguments and bounds recursive aliases', async () => {
    const gateway = new MemoryGateway().handle('commands.catalog', () => ({})).handle('slash.exec', value => {
      const command = (value as { command: string }).command
      return command === 'fast demo' ? { type: 'alias', target: 'model' } : command === 'model demo' ? { type: 'plugin', output: 'Plugin complete.' } : { type: 'alias', target: 'loop' }
    })
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.send('/fast demo')).resolves.toMatchObject({ mode: 'command', output: 'Plugin complete.' })
    await expect(conversation.send('/loop')).rejects.toThrow('recursive')
    expect(gateway.calls.some(call => call.method === 'prompt.submit')).toBe(false)
    dispose()
  })

  it('returns prefill directives as editable draft text without starting a model turn', async () => {
    const gateway = new MemoryGateway().handle('commands.catalog', () => ({}))
      .handle('slash.exec', () => ({ type: 'prefill', message: 'Previous prompt', notice: 'Turn undone.' }))
      .handle('session.history', () => ({ messages: [] }))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.send('/undo')).resolves.toMatchObject({ status: 'accepted', mode: 'command', prefill: 'Previous prompt', output: 'Turn undone.' })
    expect(gateway.calls.map(call => call.method)).toEqual(['commands.catalog', 'slash.exec', 'session.history'])
    dispose()
  })

  it('executes a command without appending a user prompt or starting a model turn', async () => {
    const gateway = new MemoryGateway().handle('commands.catalog', () => ({})).handle('slash.exec', () => ({ output: 'Model changed.' }))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.send('/model demo --provider test --session')).resolves.toEqual({ status: 'accepted', mode: 'command', output: 'Model changed.' })
    expect(gateway.calls.map(call => call.method)).toEqual(['commands.catalog', 'slash.exec'])
    expect(gateway.calls[1].value).toEqual({ session_id: 'runtime-1', command: 'model demo --provider test --session' })
    expect($chat.get().running).toBe(false)
    expect($chat.get().transcript.entries).toEqual([])
    dispose()
  })

  it('dispatches a skill only for an explicit legacy redirect, then submits its expanded prompt', async () => {
    const gateway = new MemoryGateway().handle('commands.catalog', () => ({}))
      .handle('slash.exec', () => { throw { code: 4018, message: 'skill command: use command.dispatch for /research' } })
      .handle('command.dispatch', () => ({ type: 'send', message: 'Research this topic', display: '/research topic', notice: 'Research skill loaded.' }))
      .handle('prompt.submit', () => ({ accepted: true }))
      .handle('session.history', () => ({ messages: [{ role: 'user', content: 'Research this topic', row_id: 1 }] }))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.send('/research topic')).resolves.toMatchObject({ status: 'accepted', mode: 'send', output: 'Research skill loaded.' })
    expect($chat.get().transcript.entries[0]).toMatchObject({ author: 'user', content: '/research topic' })
    await conversation.reconcileHistory()
    expect($chat.get().transcript.entries[0]).toMatchObject({ author: 'user', content: '/research topic', rowId: 1 })
    expect(gateway.calls.find(call => call.method === 'command.dispatch')?.value).toEqual({ session_id: 'runtime-1', name: 'research', arg: 'topic' })
    expect(gateway.calls.find(call => call.method === 'prompt.submit')?.value).toMatchObject({ text: 'Research this topic' })
    dispose()
  })

  it('does not retry a failed execution through another endpoint or prompt submission', async () => {
    const gateway = new MemoryGateway().handle('commands.catalog', () => ({})).handle('slash.exec', () => { throw new Error('worker failed') })
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.send('/status')).rejects.toThrow('worker failed')
    expect(gateway.calls.map(call => call.method)).toEqual(['commands.catalog', 'slash.exec'])
    dispose()
  })

  it('rejects terminal-only and conversation-switching commands without execution', async () => {
    const gateway = new MemoryGateway().handle('commands.catalog', () => ({ commands: { '/clear': { desktop: 'terminal' } } }))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.send('/clear')).rejects.toThrow('terminal')
    await expect(conversation.send('/new')).rejects.toThrow('conversation menu')
    expect(gateway.calls.map(call => call.method)).toEqual(['commands.catalog'])
    dispose()
  })

  it('does not execute after the conversation changes during catalog lookup', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gateway = new MemoryGateway().handle('commands.catalog', () => gate.then(() => ({})))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const sending = conversation.send('/status')
    $chat.set({ ...$chat.get(), runtimeSessionId: 'runtime-2' })
    release()
    await expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    expect(gateway.calls).toHaveLength(1)
    dispose()
  })

  it('does not report a guarded model switch as successfully applied', async () => {
    const gateway = new MemoryGateway().handle('commands.catalog', () => ({})).handle('slash.exec', () => ({ confirm_required: true, output: 'Not applied' }))
    const { conversation, dispose } = subject(gateway)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.send('/model costly')).rejects.toThrow('requires confirmation')
    expect($chat.get().running).toBe(false)
    dispose()
  })
})

describe('session adoption', () => {
  it('preserves an observed cache anchor only for reconnection to the same conversation and model', () => {
    const { conversation, dispose } = subject(new MemoryGateway())
    const session = { contractVersion: null, info: { model: 'provider/model' }, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' }
    try {
      conversation.adopt(session)
      $chat.set({ ...$chat.get(), lastResponseAt: 123456 })
      conversation.suspend()
      conversation.adopt({ ...session, runtimeSessionId: 'runtime-2' })
      expect($chat.get().lastResponseAt).toBe(123456)
      conversation.adopt({ ...session, storedSessionId: 'stored-2' })
      expect($chat.get().lastResponseAt).toBeNull()
      $chat.set({ ...$chat.get(), lastResponseAt: 123456 })
      conversation.adopt({ ...session, storedSessionId: 'stored-2', info: { model: 'other' } })
      expect($chat.get().lastResponseAt).toBeNull()
      conversation.reset()
      expect($chat.get().lastResponseAt).toBeNull()
    } finally { dispose() }
  })

  it('installs raw info from the runtime and starts idle until history reconciliation', async () => {
    const rawInfo = {
      desktop_contract: MINIMUM_CONTRACT,
      title: 'Adopted session',
      running: true,
      usage: { context_max: 100, context_used: 25 }
    }
    const gateway = new MemoryGateway().handle('session.create', () => ({
      info: rawInfo,
      session_id: 'runtime-1',
      stored_session_id: 'stored-1'
    }))
    const { conversation, dispose, runtime } = subject(gateway)
    const session = await runtime.createSession(null)

    conversation.adopt(session)

    expect($chat.get().info).toEqual({ title: 'Adopted session', running: true, usage: { used: 25, limit: 100 } })
    expect($chat.get().running).toBe(false)
    dispose()
  })

  it('accepts an empty raw info object', async () => {
    const gateway = new MemoryGateway().handle('session.create', () => ({ info: {}, session_id: 'runtime-1' }))
    const { conversation, dispose, runtime } = subject(gateway)

    conversation.adopt(await runtime.createSession(null))

    expect($chat.get().info).toEqual({ title: '', running: false, usage: null })
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

    await expect(conversation.loadOlderMessages()).resolves.toBe(true)

    expect($chat.get()).toMatchObject({ historyHasMore: false, historyLoadingOlder: false, historyNextOffset: 3 })
    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['older answer', 'recent question', 'recent answer'])
    dispose()
  })

  it('returns false for guarded older-history preconditions', async () => {
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)

    await expect(conversation.loadOlderMessages()).resolves.toBe(false)
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    await expect(conversation.loadOlderMessages()).resolves.toBe(false)
    $chat.set({ ...$chat.get(), storedSessionId: 'stored-1' })
    await expect(conversation.loadOlderMessages()).resolves.toBe(false)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyLoadingOlder: true })
    await expect(conversation.loadOlderMessages()).resolves.toBe(false)
    expect(gateway.calls).toEqual([])
    dispose()
  })

  it('rethrows current non-aborted failures after clearing the busy flag', async () => {
    const path = '/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=80&order=latest&profile=default'
    const gateway = new MemoryGateway().handle(path, () => {
      throw Object.assign(new Error('history unavailable'), { status: 503 })
    })
    const { conversation, dispose } = subject(gateway)
    conversation.adopt({ contractVersion: null, info: {}, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    $chat.set({ ...$chat.get(), availability: 'live', historyHasMore: true, historyNextOffset: 80 })

    await expect(conversation.loadOlderMessages()).rejects.toMatchObject({ kind: 'server', message: 'history unavailable' })
    expect($chat.get().historyLoadingOlder).toBe(false)
    dispose()
  })

  it('returns false and clears the busy flag when Scope or runtime abort makes a load stale', async () => {
    const path = '/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=80&order=latest&profile=default'
    let resolvePage!: (value: unknown) => void
    const gateway = new MemoryGateway().handle(path, () => new Promise(resolve => { resolvePage = resolve }))
    const { conversation, dispose } = subject(gateway)
    conversation.adopt({ contractVersion: null, info: {}, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    $chat.set({ ...$chat.get(), availability: 'live', historyHasMore: true, historyNextOffset: 80 })

    const staleScope = conversation.loadOlderMessages()
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    resolvePage({ messages: [{ content: 'stale', role: 'assistant', row_id: 81 }], pagination: { limit: 80, offset: 80, returned: 1 } })
    await expect(staleScope).resolves.toBe(false)
    expect($chat.get()).toMatchObject({ historyLoadingOlder: false, historyNextOffset: 80 })
    expect($chat.get().transcript.entries).toHaveLength(0)

    $preferences.set({ ...$preferences.get(), profile: null })
    gateway.handle(path, () => { throw new DOMException('runtime closed', 'AbortError') })
    $chat.set({ ...$chat.get(), historyHasMore: true })
    await expect(conversation.loadOlderMessages()).resolves.toBe(false)
    expect($chat.get().historyLoadingOlder).toBe(false)
    dispose()
  })

  it('keeps replacement request ownership across same-id reconnects and A-to-B-to-A sessions', async () => {
    const path = '/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=80&order=latest&profile=default'
    const releases: Array<(value: unknown) => void> = []
    const gateway = new MemoryGateway().handle(path, () => new Promise(resolve => { releases.push(resolve) }))
    const { conversation, dispose } = subject(gateway)
    const sessionA = { contractVersion: null, info: {}, rows: [{ content: 'latest A', role: 'assistant' as const, row_id: 82 }], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' }
    conversation.adopt(sessionA)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
    $chat.set({ ...$chat.get(), availability: 'live' })
    const oldSameIds = conversation.loadOlderMessages()

    conversation.adopt(sessionA)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
    $chat.set({ ...$chat.get(), availability: 'live' })
    const replacement = conversation.loadOlderMessages()
    expect(releases).toHaveLength(2)
    releases[0]!({ messages: [{ content: 'old page', role: 'assistant', row_id: 81 }], pagination: { limit: 80, offset: 80, returned: 1 } })
    await expect(oldSameIds).resolves.toBe(false)
    expect($chat.get().historyLoadingOlder).toBe(true)
    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['latest A'])
    releases[1]!({ messages: [{ content: 'replacement page', role: 'assistant', row_id: 80 }], pagination: { limit: 80, offset: 80, returned: 1 } })
    await expect(replacement).resolves.toBe(true)
    expect($chat.get()).toMatchObject({ historyLoadingOlder: false, historyNextOffset: 81 })
    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['replacement page', 'latest A'])

    let rejectOld!: (error: unknown) => void
    const rejectPath = '/api/sessions/stored-2/messages?include_compacted=true&limit=80&offset=80&order=latest&profile=default'
    gateway.handle(rejectPath, () => new Promise((_resolve, reject) => { rejectOld = reject }))
    const sessionB = { contractVersion: null, info: {}, rows: [{ content: 'latest B', role: 'assistant' as const, row_id: 92 }], runtimeSessionId: 'runtime-2', storedSessionId: 'stored-2' }
    conversation.adopt(sessionB)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
    $chat.set({ ...$chat.get(), availability: 'live' })
    const oldA = conversation.loadOlderMessages()
    conversation.adopt(sessionA)
    rejectOld(new Error('old A failure'))
    await expect(oldA).resolves.toBe(false)
    expect($chat.get()).toMatchObject({ historyLoadingOlder: false, runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    let resolveReset!: (value: unknown) => void
    gateway.handle(path, () => new Promise(resolve => { resolveReset = resolve }))
    conversation.adopt(sessionA)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
    $chat.set({ ...$chat.get(), availability: 'live' })
    const resetLoad = conversation.loadOlderMessages()
    conversation.reset()
    resolveReset({ messages: [{ content: 'reset stale', role: 'assistant', row_id: 90 }], pagination: { limit: 80, offset: 80, returned: 1 } })
    await expect(resetLoad).resolves.toBe(false)
    expect($chat.get()).toEqual(emptyState())
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
      availability: 'live',
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
describe('local transcript cache', () => {
  const cachedEntry = {
    author: 'user' as const,
    content: 'Cached line',
    id: 'cached-1',
    kind: 'message' as const,
    streaming: false
  }

  it('seeds the transcript from the cache when the adopted session is the cached one', () => {
    saveCachedTranscript(null, { entries: [cachedEntry], storedSessionId: 'stored-1' })
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)

    conversation.adopt({ contractVersion: null, info: {}, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['Cached line'])
    dispose()
  })

  it('prefers the session rows over the cache and ignores other sessions', () => {
    saveCachedTranscript(null, { entries: [cachedEntry], storedSessionId: 'stored-9' })
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)

    conversation.adopt({
      contractVersion: null,
      info: {},
      rows: [{ content: 'live row', role: 'user', row_id: 1 }],
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1'
    })

    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['live row'])
    dispose()
  })

  it('replaces the seeded cache with the authoritative page on reconcile', async () => {
    saveCachedTranscript(null, { entries: [{ ...cachedEntry, content: 'Stale line' }], storedSessionId: 'stored-1' })
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({ row_id: 1, session_id: 'runtime-1', stored_session_id: 'stored-1' }))
      .handle('/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ content: 'fresh answer', role: 'assistant', row_id: 1 }],
        pagination: { limit: 80, offset: 0, returned: 1 }
      }))
    const { conversation, dispose, runtime } = subject(gateway)

    conversation.adopt(await runtime.resumeSession(null, 'stored-1'))
    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['Stale line'])
    await conversation.reconcileHistory()

    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['fresh answer'])
    dispose()
  })

  it('does not cache an optimistic edit preserved before an authoritative history anchor', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({ session_id: 'runtime-1', stored_session_id: 'stored-1' }))
      .handle('/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ content: 'fresh answer', role: 'assistant', row_id: 2 }], pagination: { limit: 80, offset: 0, returned: 1 }
      }))
    const { conversation, dispose, runtime } = subject(gateway)
    try {
      conversation.adopt(await runtime.resumeSession(null, 'stored-1'))
      const transcript = createTranscript({ source: null, storedSessionId: 'stored-1' }, [
        { content: 'original', role: 'user', row_id: 1 }, { content: 'old answer', role: 'assistant', row_id: 2 }
      ])
      $chat.set({ ...$chat.get(), availability: 'live', historyBackfilled: true, transcript: updateTranscript(transcript, {
        kind: 'local-user', id: 'edit-1', content: 'pending edit', replaceId: 'history-row-1'
      }) })
      await conversation.reconcileHistory()
      expect($chat.get().transcript.entries[0]).toMatchObject({ content: 'pending edit', delivery: 'pending' })
      expect(loadCachedTranscript(null)?.entries.map(entry => entry.content)).toEqual(['fresh answer'])
    } finally { dispose() }
  })

  it('does not persist unconfirmed events when a turn completes', () => {
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)
    conversation.adopt({
      contractVersion: null,
      info: {},
      rows: [{ content: 'done answer', role: 'assistant', row_id: 7 }],
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1'
    })

    conversation.onGatewayEvent({ type: 'message.complete', session_id: 'runtime-1', payload: {} })

    expect(loadCachedTranscript(null)).toBeNull()
    dispose()
  })
})
