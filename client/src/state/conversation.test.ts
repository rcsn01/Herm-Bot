import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInteraction } from '~/features/chat/chat-interaction'
import type { GatewayPort } from '~/gateway/gateway-port'
import type { ChatState } from '~/lib/types'
import { SessionRuntime } from '~/gateway/session-runtime'
import { MINIMUM_CONTRACT } from '~/state/gateway-controller'
import { $chat, Conversation, emptyChatState, reduceGatewayEvent } from '~/state/conversation'
import { loadCachedTranscript, saveCachedTranscript } from '~/state/transcript-cache'
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
    conversation.adopt({ contractVersion: null, info: null, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })

    await expect(conversation.loadOlderMessages()).rejects.toMatchObject({ kind: 'server', message: 'history unavailable' })
    expect($chat.get().historyLoadingOlder).toBe(false)
    dispose()
  })

  it('returns false and clears the busy flag when Scope or runtime abort makes a load stale', async () => {
    const path = '/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=80&order=latest&profile=default'
    let resolvePage!: (value: unknown) => void
    const gateway = new MemoryGateway().handle(path, () => new Promise(resolve => { resolvePage = resolve }))
    const { conversation, dispose } = subject(gateway)
    conversation.adopt({ contractVersion: null, info: null, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })

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
    const sessionA = { contractVersion: null, info: null, rows: [{ content: 'latest A', role: 'assistant' as const, row_id: 82 }], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' }
    conversation.adopt(sessionA)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
    const oldSameIds = conversation.loadOlderMessages()

    conversation.adopt(sessionA)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
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
    const sessionB = { contractVersion: null, info: null, rows: [{ content: 'latest B', role: 'assistant' as const, row_id: 92 }], runtimeSessionId: 'runtime-2', storedSessionId: 'stored-2' }
    conversation.adopt(sessionB)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
    const oldA = conversation.loadOlderMessages()
    conversation.adopt(sessionA)
    rejectOld(new Error('old A failure'))
    await expect(oldA).resolves.toBe(false)
    expect($chat.get()).toMatchObject({ historyLoadingOlder: false, runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    let resolveReset!: (value: unknown) => void
    gateway.handle(path, () => new Promise(resolve => { resolveReset = resolve }))
    conversation.adopt(sessionA)
    $chat.set({ ...$chat.get(), historyHasMore: true, historyNextOffset: 80 })
    const resetLoad = conversation.loadOlderMessages()
    conversation.reset()
    resolveReset({ messages: [{ content: 'reset stale', role: 'assistant', row_id: 90 }], pagination: { limit: 80, offset: 80, returned: 1 } })
    await expect(resetLoad).resolves.toBe(false)
    expect($chat.get()).toEqual(emptyChatState())
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

    conversation.adopt({ contractVersion: null, info: null, rows: [], runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    expect($chat.get().transcript.entries.map(entry => entry.content)).toEqual(['Cached line'])
    dispose()
  })

  it('prefers the session rows over the cache and ignores other sessions', () => {
    saveCachedTranscript(null, { entries: [cachedEntry], storedSessionId: 'stored-9' })
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)

    conversation.adopt({
      contractVersion: null,
      info: null,
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

  it('persists the transcript when a turn completes', () => {
    const gateway = new MemoryGateway()
    const { conversation, dispose } = subject(gateway)
    conversation.adopt({
      contractVersion: null,
      info: null,
      rows: [{ content: 'done answer', role: 'assistant', row_id: 7 }],
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1'
    })

    conversation.onGatewayEvent({ type: 'message.complete', session_id: 'runtime-1', payload: {} })

    expect(loadCachedTranscript(null)).toMatchObject({ storedSessionId: 'stored-1' })
    expect(loadCachedTranscript(null)?.entries.map(entry => entry.content)).toContain('done answer')
    dispose()
  })
})
