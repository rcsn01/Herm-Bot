import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CurrentGatewayScope } from '~/gateway/scope-guard'
import type { RuntimeSession, SessionRuntime } from '~/gateway/session-runtime'
import type { Conversation } from '~/state/conversation'
import { $chat, emptyChatState } from '~/state/conversation'
import { createSessionSelection, type SessionSelection } from '~/state/session-selection'
import { $preferences, $sessions } from '~/state/store'

const BOOKMARK_KEY = 'hermes.mobile.session::default'

function makeSession(storedSessionId: null | string): RuntimeSession {
  return {
    contractVersion: 6,
    info: {},
    rows: [],
    runtimeSessionId: `runtime-${storedSessionId ?? 'fresh'}`,
    storedSessionId
  }
}

function makeStoredSession(id: string, overrides: Partial<RuntimeSession> = {}) {
  return { id, message_count: 1, preview: '', source: 'ios', started_at: 1, title: id, ...overrides }
}

interface SelectionHarness {
  selection: SessionSelection
  runtime: {
    createSession: ReturnType<typeof vi.fn>
    resumeSession: ReturnType<typeof vi.fn>
    branchSession: ReturnType<typeof vi.fn>
  }
  conversation: {
    adopt: ReturnType<typeof vi.fn>
    reconcileHistory: ReturnType<typeof vi.fn>
  }
  refreshSessions: ReturnType<typeof vi.fn>
}

function createSelection(overrides: {
  runtime?: Record<string, unknown>
  refreshSessions?: (scope: CurrentGatewayScope) => Promise<void>
} = {}): SelectionHarness {
  const runtime = {
    createSession: vi.fn(async () => makeSession('created-1')),
    resumeSession: vi.fn(async (_profile: null | string, storedSessionId: string) => makeSession(storedSessionId)),
    branchSession: vi.fn(async () => makeSession('branched-1')),
    ...overrides.runtime
  }
  const conversation = {
    adopt: vi.fn(),
    reconcileHistory: vi.fn(async () => undefined)
  }
  const refreshSessions = overrides.refreshSessions ?? vi.fn(async () => undefined)
  const selection = createSessionSelection({
    runtime: runtime as unknown as SessionRuntime,
    conversation: conversation as unknown as Conversation,
    refreshSessions: refreshSessions as (scope: CurrentGatewayScope) => Promise<void>
  })
  return { selection, runtime, conversation, refreshSessions } as SelectionHarness
}

beforeEach(() => {
  $chat.set(emptyChatState())
  $sessions.set([])
  $preferences.set({ authMode: 'token', profile: null, remoteURL: '', theme: 'system' })
  localStorage.clear()
})

describe('session selection', () => {
  it('create publishes: adopt with the list source, bookmark write, best-effort refresh', async () => {
    $sessions.set([{ id: 'created-1', message_count: 0, preview: '', source: 'ios', started_at: 1, title: 'Created' }])
    const refreshSessions = vi.fn(async () => {
      throw new Error('list unavailable')
    })
    const { selection, runtime, conversation } = createSelection({ refreshSessions })

    const outcome = await selection.select({ kind: 'create' })

    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'created-1' }), resumed: false })
    expect(runtime.createSession).toHaveBeenCalledTimes(1)
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(conversation.adopt.mock.calls[0][1]).toBe('ios')
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('created-1')
    expect(refreshSessions).toHaveBeenCalledTimes(1) // best-effort: the rejection was swallowed
  })

  it('resume publishes: reconcile awaited on the captured scope; no list refresh', async () => {
    $sessions.set([{ id: 'stored-2', message_count: 2, preview: '', source: 'desktop', started_at: 2, title: 'Stored' }])
    const { selection, conversation, refreshSessions } = createSelection()

    const outcome = await selection.select({ kind: 'resume', storedSessionId: 'stored-2' })

    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'stored-2' }), resumed: true })
    expect(conversation.adopt).toHaveBeenCalledWith(expect.objectContaining({ storedSessionId: 'stored-2' }), 'desktop')
    expect(conversation.reconcileHistory).toHaveBeenCalledTimes(1)
    expect(conversation.reconcileHistory).toHaveBeenCalledWith(expect.objectContaining({ profile: null }))
    expect(refreshSessions).not.toHaveBeenCalled()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('stored-2')
  })

  it('branch publishes: awaited refresh rethrows; a no-op branch resolves undefined without bumping the epoch', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-stored', storedSessionId: 'stored-1' })
    const failing = createSelection({ refreshSessions: async () => { throw new Error('list down') } })
    await expect(failing.selection.select({ kind: 'branch' })).rejects.toThrow('list down')
    expect(failing.conversation.adopt).toHaveBeenCalledTimes(1) // published before the refresh threw

    // A no-op branch must not retire in-flight work: a concurrent select still
    // publishes. No open durable conversation (runtime id missing) makes the
    // branch a no-op.
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })
    let release!: (value: RuntimeSession) => void
    const gate = new Promise<RuntimeSession>(resolve => { release = resolve })
    const gated = createSelection({ runtime: { createSession: vi.fn(() => gate) } })
    const pending = gated.selection.select({ kind: 'create' })
    await expect(gated.selection.select({ kind: 'branch' })).resolves.toBeUndefined()
    release(makeSession('late'))
    expect(await pending).toEqual({ session: expect.objectContaining({ storedSessionId: 'late' }), resumed: false })
    expect(gated.conversation.adopt).toHaveBeenCalledTimes(1)
  })

  it('latest newest-pick skips cron rows and resumes the newest human session', async () => {
    $sessions.set([
      { id: 'cron-newest', message_count: 9, preview: '', source: 'cron', started_at: 400, title: 'Nightly digest' },
      { id: 'human-newest', message_count: 2, preview: '', source: 'ios', started_at: 300, title: 'Human' }
    ])
    const { selection, runtime } = createSelection()

    const outcome = await selection.select({ kind: 'latest', freshen: true })

    expect(runtime.resumeSession).toHaveBeenCalledWith(null, 'human-newest')
    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'human-newest' }), resumed: true })
  })

  it('latest warm-tap with freshen refreshes without a resume RPC', async () => {
    $sessions.set([{ id: 'current', message_count: 1, preview: '', source: 'ios', started_at: 5, title: 'Current' }])
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'current' })
    const { selection, runtime, conversation } = createSelection()

    const outcome = await selection.select({ kind: 'latest', freshen: true })

    expect(outcome).toEqual({ session: null, resumed: false })
    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(runtime.createSession).not.toHaveBeenCalled()
    expect(conversation.reconcileHistory).toHaveBeenCalledTimes(1)
  })

  it('latest warm-tap without freshen neither resumes nor reconciles', async () => {
    $sessions.set([{ id: 'current', message_count: 1, preview: '', source: 'ios', started_at: 5, title: 'Current' }])
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'current' })
    const { selection, runtime, conversation } = createSelection()

    const outcome = await selection.select({ kind: 'latest', freshen: false })

    expect(outcome).toEqual({ session: null, resumed: false })
    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(conversation.reconcileHistory).not.toHaveBeenCalled()
  })

  it('latest resume-failure falls back to a create; create failure propagates; a newer select wins the race', async () => {
    $sessions.set([{ id: 'newest', message_count: 1, preview: '', source: 'ios', started_at: 300, title: 'Newest' }])

    // The fallback publishes the created session.
    const fallback = createSelection({
      runtime: {
        resumeSession: vi.fn(async () => { throw new Error('conversation gone') }),
        createSession: vi.fn(async () => makeSession('fallback'))
      }
    })
    expect(await fallback.selection.select({ kind: 'latest', freshen: true }))
      .toEqual({ session: expect.objectContaining({ storedSessionId: 'fallback' }), resumed: false })

    // The create's failure propagates.
    const failing = createSelection({
      runtime: {
        resumeSession: vi.fn(async () => { throw new Error('conversation gone') }),
        createSession: vi.fn(async () => { throw new Error('create failed') })
      }
    })
    await expect(failing.selection.select({ kind: 'latest', freshen: true })).rejects.toThrow('create failed')

    // A newer select started during the failed resume retires the fallback:
    // the re-check before the create keeps the newer selection winning.
    let failResume!: (error: unknown) => void
    const resumeGate = new Promise<never>((_resolve, reject) => { failResume = reject })
    const racing = createSelection({
      runtime: {
        // The stale pick resumes the roster's 'newest' and hangs; the newer
        // resume selects 'newer' directly and succeeds.
        resumeSession: vi.fn((_profile: null | string, storedSessionId: string) =>
          storedSessionId === 'newest'
            ? resumeGate
            : Promise.resolve(makeSession(storedSessionId))),
        createSession: vi.fn(async () => makeSession('fallback'))
      }
    })
    const stale = racing.selection.select({ kind: 'latest', freshen: false })
    await racing.selection.select({ kind: 'resume', storedSessionId: 'newer' })
    failResume(new Error('conversation gone'))
    await expect(stale).resolves.toBeUndefined()
    expect(racing.runtime.createSession).not.toHaveBeenCalled()
  })

  it('two concurrent selects: the first to resolve after the second started publishes nothing', async () => {
    let releaseFirst!: (value: RuntimeSession) => void
    const firstGate = new Promise<RuntimeSession>(resolve => { releaseFirst = resolve })
    const createSession = vi.fn()
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValueOnce(makeSession('second'))
    const { selection, conversation } = createSelection({ runtime: { createSession } })

    const first = selection.select({ kind: 'create' })
    await selection.select({ kind: 'create' })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)

    releaseFirst(makeSession('late'))
    await expect(first).resolves.toBeUndefined()
    expect(conversation.adopt).toHaveBeenCalledTimes(1) // the slower selection published nothing
  })

  it('a Scope change between the RPC and the publish discards the selection', async () => {
    let release!: (value: RuntimeSession) => void
    const gate = new Promise<RuntimeSession>(resolve => { release = resolve })
    const { selection, conversation } = createSelection({ runtime: { createSession: vi.fn(() => gate) } })

    const pending = selection.select({ kind: 'create' })
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    release(makeSession('late'))

    await expect(pending).resolves.toBeUndefined()
    expect(conversation.adopt).not.toHaveBeenCalled()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBeNull()
  })

  it('restore resolves the target: $chat wins over the bookmark; the bookmark fills an empty $chat', async () => {
    const open = vi.fn(async (storedSessionId: null | string) => ({
      resumed: storedSessionId !== null,
      session: makeSession(storedSessionId)
    }))
    const { selection } = createSelection()

    $chat.set({ ...emptyChatState(), storedSessionId: 'chat-id' })
    await selection.restore(open)
    expect(open).toHaveBeenCalledWith('chat-id')

    $chat.set(emptyChatState())
    localStorage.setItem(BOOKMARK_KEY, 'bookmark-id')
    await selection.restore(open)
    expect(open).toHaveBeenLastCalledWith('bookmark-id')
  })

  it('restore clears the bookmark when the open lands fresh; a non-current guard publishes nothing', async () => {
    const open = vi.fn(async () => ({ resumed: false, session: makeSession(null) }))
    const { selection, conversation } = createSelection()
    localStorage.setItem(BOOKMARK_KEY, 'bookmark-id')

    await selection.restore(open)

    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBeNull()

    const blocked = await selection.restore(open, () => false)
    expect(blocked).toBeUndefined()
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
  })

  it('restore does not bump the selection epoch: an in-flight select still publishes', async () => {
    let release!: (value: RuntimeSession) => void
    const gate = new Promise<RuntimeSession>(resolve => { release = resolve })
    const { selection, conversation } = createSelection({ runtime: { createSession: vi.fn(() => gate) } })
    const pending = selection.select({ kind: 'create' })

    const restored = await selection.restore(async () => ({ resumed: true, session: makeSession('restored') }))
    expect(restored).toBeDefined()
    expect(conversation.adopt).toHaveBeenCalledTimes(1)

    release(makeSession('late'))
    expect(await pending).toEqual({ session: expect.objectContaining({ storedSessionId: 'late' }), resumed: false })
    expect(conversation.adopt).toHaveBeenCalledTimes(2)
  })

  it('invalidate retires an in-flight select', async () => {
    let release!: (value: RuntimeSession) => void
    const gate = new Promise<RuntimeSession>(resolve => { release = resolve })
    const { selection, conversation } = createSelection({ runtime: { createSession: vi.fn(() => gate) } })
    const pending = selection.select({ kind: 'create' })

    selection.invalidate()
    release(makeSession('late'))

    await expect(pending).resolves.toBeUndefined()
    expect(conversation.adopt).not.toHaveBeenCalled()
  })

  it('activeStoredSessionId and hasLiveSession read through $chat', () => {
    const { selection } = createSelection()
    expect(selection.activeStoredSessionId()).toBeNull()
    expect(selection.hasLiveSession()).toBe(false)

    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    expect(selection.activeStoredSessionId()).toBe('stored-1')
    expect(selection.hasLiveSession()).toBe(true)
  })
})