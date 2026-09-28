import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionsApi } from '~/features/sessions/api'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { queryClient } from '~/gateway/query-client'
import type { RuntimeSession, SessionRuntime } from '~/gateway/session-runtime'
import type { StoredSession } from '~/lib/types'
import { $chat, Conversation, emptyChatState } from '~/state/conversation'
import { createSessionSelection, type SessionSelection } from '~/state/session-selection'
import { $preferences, $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'

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

function makeStoredSession(id: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return { id, message_count: 1, preview: '', source: 'ios', started_at: 1, title: id, ...overrides }
}

interface RosterHarness {
  selection: SessionSelection & {
    refreshSessions(scope?: CurrentGatewayScope): Promise<void>
    loadMoreSessions(): Promise<void>
    resetSessionList(): void
  }
  runtime: {
    createSession: ReturnType<typeof vi.fn>
    resumeSession: ReturnType<typeof vi.fn>
    branchSession: ReturnType<typeof vi.fn>
  }
  conversation: {
    adopt: ReturnType<typeof vi.fn>
    reconcileHistory: ReturnType<typeof vi.fn>
    retitleActive: ReturnType<typeof vi.fn>
    setSessionSource: ReturnType<typeof vi.fn>
  }
  api: SessionsApi & { list: ReturnType<typeof vi.fn> }
  apiFactory: ReturnType<typeof vi.fn>
  factoryScopes: CurrentGatewayScope[]
}

function createRosterSelection(overrides: {
  api?: Partial<SessionsApi>
  runtime?: Record<string, unknown>
  conversation?: Record<string, unknown>
} = {}): RosterHarness {
  const runtime = {
    createSession: vi.fn(async () => makeSession('created-1')),
    resumeSession: vi.fn(async (_profile: null | string, storedSessionId: string) => makeSession(storedSessionId)),
    branchSession: vi.fn(async () => makeSession('branched-1')),
    ...overrides.runtime
  }
  const conversation = {
    adopt: vi.fn(),
    reconcileHistory: vi.fn(async () => undefined),
    retitleActive: vi.fn(),
    setSessionSource: vi.fn(),
    ...overrides.conversation
  }
  const api = {
    archive: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ sessions: [] })),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    ...overrides.api
  } as SessionsApi & { list: ReturnType<typeof vi.fn> }
  const factoryScopes: CurrentGatewayScope[] = []
  const apiFactory = vi.fn((scope: CurrentGatewayScope) => {
    factoryScopes.push(scope)
    return api
  })
  const selection = createSessionSelection({
    runtime: runtime as unknown as SessionRuntime,
    conversation: conversation as unknown as Conversation,
    sessionsApi: apiFactory
  })
  return { selection, runtime, conversation, api, apiFactory, factoryScopes } as RosterHarness
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
  api: SessionsApi
}

function createSelection(overrides: {
  runtime?: Record<string, unknown>
  conversation?: Record<string, unknown>
  api?: Partial<SessionsApi>
} = {}): SelectionHarness {
  const runtime = {
    createSession: vi.fn(async () => makeSession('created-1')),
    resumeSession: vi.fn(async (_profile: null | string, storedSessionId: string) => makeSession(storedSessionId)),
    branchSession: vi.fn(async () => makeSession('branched-1')),
    ...overrides.runtime
  }
  const conversation = {
    adopt: vi.fn(),
    reconcileHistory: vi.fn(async () => undefined),
    ...overrides.conversation
  }
  const api: SessionsApi = {
    archive: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ sessions: $sessions.get() })),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    ...overrides.api
  }
  const selection = createSessionSelection({
    runtime: runtime as unknown as SessionRuntime,
    conversation: conversation as unknown as Conversation,
    sessionsApi: () => api
  })
  return { selection, runtime, conversation, api } as SelectionHarness
}

beforeEach(() => {
  queryClient.clear()
  $chat.set(emptyChatState())
  $sessions.set([])
  $sessionsHasMore.set(false)
  $sessionsLoadingMore.set(false)
  $preferences.set({ authMode: 'token', profile: null, remoteURL: '', theme: 'system' })
  localStorage.clear()
})

describe('session roster list', () => {
  it('refreshes the full raw page with its scoped key and projects the active source', async () => {
    const rows = [
      makeStoredSession('active', { source: '' }),
      makeStoredSession('cron-row', { source: 'cron' }),
      ...Array.from({ length: 28 }, (_, index) => makeStoredSession(`row-${index}`))
    ]
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-active', storedSessionId: 'active' })
    const { selection, api, apiFactory, factoryScopes, conversation } = createRosterSelection({
      api: { list: vi.fn(async () => ({ sessions: rows })) }
    })
    const scope = currentGatewayScope()

    await selection.refreshSessions()

    expect(api.list).toHaveBeenCalledOnce()
    expect(api.list.mock.calls[0]?.[0]).toBe(30)
    expect(api.list.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(apiFactory).toHaveBeenCalledWith(scope)
    expect(factoryScopes).toEqual([scope])
    expect(queryClient.getQueryData(gatewayScopeKey(scope, 'sessions', 'list', 30))).toEqual({ sessions: rows })
    expect($sessions.get()).toEqual(rows)
    expect($sessionsHasMore.get()).toBe(true)
    expect(conversation.setSessionSource).toHaveBeenCalledWith('active', '')
  })

  it('projects the active id that exists when the list request finishes', async () => {
    let release!: (value: { sessions: StoredSession[] }) => void
    const list = new Promise<{ sessions: StoredSession[] }>(resolve => { release = resolve })
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-first', storedSessionId: 'first' })
    const { selection, conversation } = createRosterSelection({ api: { list: vi.fn(() => list) } })

    const pending = selection.refreshSessions()
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-later', storedSessionId: 'later' })
    release({ sessions: [makeStoredSession('later', { source: 'cron' })] })
    await pending

    expect(conversation.setSessionSource).toHaveBeenCalledOnce()
    expect(conversation.setSessionSource).toHaveBeenCalledWith('later', 'cron')
  })

  it('clears provenance when the active row or its source is missing, but leaves it alone without an active id', async () => {
    const missing = createRosterSelection({ api: { list: vi.fn(async () => ({ sessions: [] })) } })
    $chat.set({ ...emptyChatState(), storedSessionId: 'missing' })
    await missing.selection.refreshSessions()
    expect(missing.conversation.setSessionSource).toHaveBeenCalledWith('missing', null)

    const malformed = createRosterSelection({ api: {
      list: vi.fn(async () => ({ sessions: [makeStoredSession('active', { source: 7 as unknown as string })] }))
    } })
    $chat.set({ ...emptyChatState(), storedSessionId: 'active' })
    await malformed.selection.refreshSessions()
    expect(malformed.conversation.setSessionSource).toHaveBeenCalledWith('active', null)

    const noActive = createRosterSelection({ api: { list: vi.fn(async () => ({ sessions: [makeStoredSession('row')] })) } })
    $chat.set(emptyChatState())
    await noActive.selection.refreshSessions()
    expect(noActive.conversation.setSessionSource).not.toHaveBeenCalled()
  })

  it('discards a successful result after the captured Scope goes away and back', async () => {
    let release!: (value: { sessions: StoredSession[] }) => void
    const list = new Promise<{ sessions: StoredSession[] }>(resolve => { release = resolve })
    const { selection, conversation } = createRosterSelection({ api: { list: vi.fn(() => list) } })
    const previous = [makeStoredSession('previous')]
    $sessions.set(previous)
    $sessionsHasMore.set(true)

    const pending = selection.refreshSessions()
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    $preferences.set({ ...$preferences.get(), profile: null })
    release({ sessions: [makeStoredSession('stale')] })
    await pending

    expect($sessions.get()).toBe(previous)
    expect($sessionsHasMore.get()).toBe(true)
    expect(conversation.setSessionSource).not.toHaveBeenCalled()
  })

  it('propagates a stale list rejection without changing published state', async () => {
    let reject!: (reason: Error) => void
    const list = new Promise<{ sessions: StoredSession[] }>((_resolve, rejectList) => { reject = rejectList })
    const { selection, conversation } = createRosterSelection({ api: { list: vi.fn(() => list) } })
    const previous = [makeStoredSession('previous')]
    $sessions.set(previous)
    $sessionsHasMore.set(true)

    const pending = selection.refreshSessions()
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    reject(new Error('list failed'))

    await expect(pending).rejects.toThrow('list failed')
    expect($sessions.get()).toBe(previous)
    expect($sessionsHasMore.get()).toBe(true)
    expect(conversation.setSessionSource).not.toHaveBeenCalled()
  })

  it('re-fetches cumulative pages and replaces the full list response', async () => {
    const first = Array.from({ length: 30 }, (_, index) => makeStoredSession(`row-${index}`))
    const expanded = [...first, ...Array.from({ length: 15 }, (_, index) => makeStoredSession(`new-${index}`))]
    const list = vi.fn()
      .mockResolvedValueOnce({ sessions: first })
      .mockResolvedValueOnce({ sessions: expanded })
    const { selection, api } = createRosterSelection({ api: { list } })

    await selection.refreshSessions()
    await selection.loadMoreSessions()

    expect(api.list.mock.calls.map(([limit]) => limit)).toEqual([30, 60])
    expect($sessions.get()).toEqual(expanded)
    expect($sessions.get()).toHaveLength(45)
    expect($sessionsHasMore.get()).toBe(false)
  })

  it('ignores load-more while busy or when there is no more data', async () => {
    let release!: (value: { sessions: StoredSession[] }) => void
    const list = vi.fn(() => new Promise<{ sessions: StoredSession[] }>(resolve => { release = resolve }))
    const { selection, api } = createRosterSelection({ api: { list } })
    $sessionsHasMore.set(true)

    const pending = selection.loadMoreSessions()
    expect($sessionsLoadingMore.get()).toBe(true)
    await selection.loadMoreSessions()
    expect(api.list).toHaveBeenCalledOnce()
    release({ sessions: [] })
    await pending
    expect($sessionsLoadingMore.get()).toBe(false)

    $sessionsHasMore.set(false)
    await selection.loadMoreSessions()
    expect(api.list).toHaveBeenCalledOnce()
  })

  it('rolls a failed page expansion back and resets the next refresh to page 30', async () => {
    const oldRows = [makeStoredSession('old')]
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValue({ sessions: oldRows })
    const { selection, api } = createRosterSelection({ api: { list } })
    $sessions.set(oldRows)
    $sessionsHasMore.set(true)

    await expect(selection.loadMoreSessions()).rejects.toThrow('list failed')
    expect($sessions.get()).toBe(oldRows)
    expect($sessionsHasMore.get()).toBe(true)
    expect($sessionsLoadingMore.get()).toBe(false)
    await selection.refreshSessions()
    expect(api.list.mock.calls.map(([limit]) => limit)).toEqual([60, 30])
  })

  it('resets list state and the private page limit', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => makeStoredSession(`row-${index}`))
    const list = vi.fn()
      .mockResolvedValueOnce({ sessions: rows })
      .mockResolvedValueOnce({ sessions: rows })
      .mockResolvedValueOnce({ sessions: [] })
    const { selection, api } = createRosterSelection({ api: { list } })
    await selection.refreshSessions()
    await selection.loadMoreSessions()
    expect(api.list.mock.calls.map(([limit]) => limit)).toEqual([30, 60])

    selection.resetSessionList()
    expect($sessions.get()).toEqual([])
    expect($sessionsHasMore.get()).toBe(false)
    expect($sessionsLoadingMore.get()).toBe(false)
    await selection.refreshSessions()
    expect(api.list.mock.calls.map(([limit]) => limit)).toEqual([30, 60, 30])
  })
})

describe('live session mutations', () => {
  it('renames through the captured adapter before the list refresh', async () => {
    const events: string[] = []
    const { selection, api, factoryScopes, conversation } = createRosterSelection({
      api: {
        list: vi.fn(async () => { events.push('list'); return { sessions: [] } }),
        rename: vi.fn(async () => { events.push('rename') })
      },
      conversation: { retitleActive: vi.fn(() => { events.push('retitle') }) }
    })
    const scope = currentGatewayScope()

    await selection.renameSession('stored-1', 'Renamed')

    expect(events).toEqual(['rename', 'retitle', 'list'])
    expect(api.rename).toHaveBeenCalledWith('stored-1', 'Renamed')
    expect(factoryScopes).toEqual([scope, scope])
    expect(conversation.retitleActive).toHaveBeenCalledWith('stored-1', 'Renamed')
  })

  it('retitles only the matching active session when Conversation info exists', async () => {
    const actualConversation = new Conversation({} as SessionRuntime)
    const events: string[] = []
    const { selection } = createRosterSelection({
      conversation: {
        retitleActive: (id: string, title: string) => {
          events.push('retitle')
          actualConversation.retitleActive(id, title)
        }
      },
      api: {
        list: vi.fn(async () => { events.push('list'); return { sessions: [] } }),
        rename: vi.fn(async () => { events.push('rename') })
      }
    })
    $chat.set({ ...emptyChatState(), storedSessionId: 'active', info: { running: false, title: 'Before', usage: null } })

    await selection.renameSession('active', 'Renamed')
    expect($chat.get().info?.title).toBe('Renamed')
    expect(events).toEqual(['rename', 'retitle', 'list'])

    const other = { ...$chat.get(), storedSessionId: 'other' }
    $chat.set(other)
    await selection.renameSession('active', 'Ignored')
    expect($chat.get()).toBe(other)

    const withoutInfo = { ...emptyChatState(), storedSessionId: 'active' }
    $chat.set(withoutInfo)
    await selection.renameSession('active', 'Ignored')
    expect($chat.get()).toBe(withoutInfo)
  })

  it('keeps a successful rename when its list refresh fails', async () => {
    const events: string[] = []
    const { selection, api, conversation } = createRosterSelection({
      api: {
        list: vi.fn(async () => { throw new Error('list failed') }),
        rename: vi.fn(async () => { events.push('rename') })
      },
      conversation: { retitleActive: vi.fn(() => { events.push('retitle') }) }
    })

    await expect(selection.renameSession('stored-1', 'Renamed')).rejects.toThrow('list failed')

    expect(events).toEqual(['rename', 'retitle'])
    expect(conversation.retitleActive).toHaveBeenCalledOnce()
  })

  it('archives without changing Conversation state and awaits the list refresh', async () => {
    const events: string[] = []
    const { selection, api } = createRosterSelection({
      api: {
        archive: vi.fn(async () => { events.push('archive') }),
        list: vi.fn(async () => { events.push('list'); return { sessions: [] } })
      }
    })
    const before = $chat.get()

    await selection.archiveSession('stored-1')

    expect(events).toEqual(['archive', 'list'])
    expect($chat.get()).toBe(before)
    await expect(createRosterSelection({ api: {
      archive: vi.fn(async () => undefined),
      list: vi.fn(async () => { throw new Error('list failed') })
    } }).selection.archiveSession('stored-1')).rejects.toThrow('list failed')
  })

  it('refreshes an inactive deletion once without creating a replacement', async () => {
    const events: string[] = []
    const { selection, api, runtime } = createRosterSelection({
      api: {
        remove: vi.fn(async () => { events.push('remove') }),
        list: vi.fn(async () => { events.push('list'); return { sessions: [] } })
      }
    })

    await selection.deleteSession('inactive')

    expect(events).toEqual(['remove', 'list'])
    expect(api.remove).toHaveBeenCalledWith('inactive')
    expect(runtime.createSession).not.toHaveBeenCalled()
  })

  it('does not replace a session that became inactive before removal resolved', async () => {
    let releaseRemove!: () => void
    const removeGate = new Promise<void>(resolve => { releaseRemove = resolve })
    const { selection, runtime, api } = createRosterSelection({ api: {
      remove: vi.fn(() => removeGate)
    } })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })

    const deleting = selection.deleteSession('stored-1')
    $chat.set({ ...emptyChatState(), storedSessionId: 'other' })
    releaseRemove()
    await deleting

    expect(runtime.createSession).not.toHaveBeenCalled()
    expect(api.list).toHaveBeenCalledOnce()
  })

  it('waits for the replacement create refresh before the separate final delete refresh', async () => {
    let releaseFirst!: (value: { sessions: StoredSession[] }) => void
    const events: string[] = []
    const list = vi.fn()
      .mockImplementationOnce(() => { events.push('create-list'); return new Promise<{ sessions: StoredSession[] }>(resolve => { releaseFirst = resolve }) })
      .mockImplementationOnce(async () => { events.push('delete-list'); return { sessions: [] } })
    const { selection } = createRosterSelection({
      api: { list },
      runtime: { createSession: vi.fn(async () => makeSession('replacement')) }
    })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })

    let settled = false
    const deleting = selection.deleteSession('stored-1').then(() => { settled = true })
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    expect(events).toEqual(['create-list'])
    expect(settled).toBe(false)

    releaseFirst({ sessions: [] })
    await deleting
    expect(events).toEqual(['create-list', 'delete-list'])
  })

  it('keeps the delete route effect when final refresh fails', async () => {
    const remove = vi.fn(async () => undefined)
    const { selection, api } = createRosterSelection({ api: {
      remove,
      list: vi.fn(async () => { throw new Error('list failed') })
    } })

    await expect(selection.deleteSession('inactive')).rejects.toThrow('list failed')
    expect(remove).toHaveBeenCalledOnce()
  })

  it('swallows a replacement create refresh failure and still awaits final delete refresh', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('create refresh failed'))
      .mockResolvedValueOnce({ sessions: [] })
    const { selection, api } = createRosterSelection({ api: { list } })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })

    await selection.deleteSession('stored-1')

    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('does not run the final delete refresh when replacement creation fails', async () => {
    const { selection, api } = createRosterSelection({
      api: { list: vi.fn(async () => ({ sessions: [] })) },
      runtime: { createSession: vi.fn(async () => { throw new Error('create failed') }) }
    })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })

    await expect(selection.deleteSession('stored-1')).rejects.toThrow('create failed')
    expect(api.list).not.toHaveBeenCalled()
  })

  it('checks the active stored id after removal before selecting a replacement', async () => {
    let release!: () => void
    const removeGate = new Promise<void>(resolve => { release = resolve })
    const events: string[] = []
    const { selection, api, runtime } = createRosterSelection({
      api: {
        remove: vi.fn(async () => { events.push('remove'); await removeGate }),
        list: vi.fn(async () => { events.push('list'); return { sessions: [] } })
      },
      runtime: { createSession: vi.fn(async () => { events.push('create'); return makeSession('replacement') }) }
    })

    const deleting = selection.deleteSession('stored-1')
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })
    release()
    await deleting

    expect(api.remove).toHaveBeenCalledWith('stored-1')
    expect(runtime.createSession).toHaveBeenCalledOnce()
    expect(events).toEqual(['remove', 'create', 'list', 'list'])
  })

  it('still refreshes after a newer selection supersedes active-delete replacement creation', async () => {
    let releaseReplacement!: (session: RuntimeSession) => void
    const replacement = new Promise<RuntimeSession>(resolve => { releaseReplacement = resolve })
    const createSession = vi.fn()
      .mockImplementationOnce(() => replacement)
      .mockResolvedValueOnce(makeSession('newer'))
    const { selection, runtime, api, conversation } = createRosterSelection({ runtime: { createSession } })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })

    const deleting = selection.deleteSession('stored-1')
    await vi.waitFor(() => expect(runtime.createSession).toHaveBeenCalledOnce())
    await selection.select({ kind: 'create' })
    releaseReplacement(makeSession('stale-replacement'))
    await deleting

    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(conversation.adopt.mock.calls[0]?.[0].storedSessionId).toBe('newer')
    expect(api.list).toHaveBeenCalledTimes(2) // newer create plus delete follow-up
  })

  it('skips stale active-delete replacement and final refresh after Scope changes', async () => {
    let releaseReplacement!: (session: RuntimeSession) => void
    const replacement = new Promise<RuntimeSession>(resolve => { releaseReplacement = resolve })
    const { selection, runtime, api, conversation } = createRosterSelection({
      runtime: { createSession: vi.fn(() => replacement) }
    })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })

    const deleting = selection.deleteSession('stored-1')
    await vi.waitFor(() => expect(runtime.createSession).toHaveBeenCalledOnce())
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    releaseReplacement(makeSession('stale-replacement'))
    await deleting

    expect(conversation.adopt).not.toHaveBeenCalled()
    expect(api.list).not.toHaveBeenCalled()
  })

  it.each(['rename', 'archive', 'delete'] as const)('%s route rejection propagates without follow-up', async action => {
    const failure = new Error('write failed')
    const { selection, api, conversation, runtime } = createRosterSelection({ api: {
      rename: vi.fn(async () => { throw failure }),
      archive: vi.fn(async () => { throw failure }),
      remove: vi.fn(async () => { throw failure })
    } })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })
    const mutation = action === 'rename'
      ? selection.renameSession('stored-1', 'Title')
      : action === 'archive'
        ? selection.archiveSession('stored-1')
        : selection.deleteSession('stored-1')

    await expect(mutation).rejects.toBe(failure)
    expect(api.list).not.toHaveBeenCalled()
    expect(conversation.retitleActive).not.toHaveBeenCalled()
    expect(runtime.createSession).not.toHaveBeenCalled()
  })

  it.each(['rename', 'archive', 'delete'] as const)('%s successful route skips follow-up after a Scope round trip', async action => {
    let release!: () => void
    const route = new Promise<void>(resolve => { release = resolve })
    const { selection, api, conversation, runtime } = createRosterSelection({ api: {
      rename: vi.fn(() => route),
      archive: vi.fn(() => route),
      remove: vi.fn(() => route)
    } })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })
    const mutation = action === 'rename'
      ? selection.renameSession('stored-1', 'Title')
      : action === 'archive'
        ? selection.archiveSession('stored-1')
        : selection.deleteSession('stored-1')
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    $preferences.set({ ...$preferences.get(), profile: null })
    release()

    await expect(mutation).resolves.toBeUndefined()
    expect(api.list).not.toHaveBeenCalled()
    expect(conversation.retitleActive).not.toHaveBeenCalled()
    expect(runtime.createSession).not.toHaveBeenCalled()
  })

  it.each(['rename', 'archive', 'delete'] as const)('%s route rejection stays visible after Scope changes', async action => {
    let reject!: (reason: Error) => void
    const route = new Promise<void>((_resolve, rejectRoute) => { reject = rejectRoute })
    const { selection, api } = createRosterSelection({ api: {
      rename: vi.fn(() => route),
      archive: vi.fn(() => route),
      remove: vi.fn(() => route)
    } })
    const mutation = action === 'rename'
      ? selection.renameSession('stored-1', 'Title')
      : action === 'archive'
        ? selection.archiveSession('stored-1')
        : selection.deleteSession('stored-1')
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    reject(new Error('write failed'))

    await expect(mutation).rejects.toThrow('write failed')
    expect(api.list).not.toHaveBeenCalled()
  })
})

describe('session selection', () => {
  it('create publishes: adopt with the list source, bookmark write, best-effort refresh', async () => {
    $sessions.set([{ id: 'created-1', message_count: 0, preview: '', source: 'ios', started_at: 1, title: 'Created' }])
    const list = vi.fn(async () => {
      throw new Error('list unavailable')
    })
    const { selection, runtime, conversation, api } = createSelection({ api: { list } })

    const outcome = await selection.select({ kind: 'create' })

    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'created-1' }), resumed: false })
    expect(runtime.createSession).toHaveBeenCalledTimes(1)
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(conversation.adopt.mock.calls[0][1]).toBe('ios')
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('created-1')
    expect(api.list).toHaveBeenCalledTimes(1) // best-effort: the rejection was swallowed
  })

  it('resume publishes: reconcile awaited on the captured scope; no list refresh', async () => {
    $sessions.set([{ id: 'stored-2', message_count: 2, preview: '', source: 'desktop', started_at: 2, title: 'Stored' }])
    const { selection, conversation, api } = createSelection()

    const outcome = await selection.select({ kind: 'resume', storedSessionId: 'stored-2' })

    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'stored-2' }), resumed: true })
    expect(conversation.adopt).toHaveBeenCalledWith(expect.objectContaining({ storedSessionId: 'stored-2' }), 'desktop')
    expect(conversation.reconcileHistory).toHaveBeenCalledTimes(1)
    expect(conversation.reconcileHistory).toHaveBeenCalledWith(expect.objectContaining({ profile: null }))
    expect(api.list).not.toHaveBeenCalled()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('stored-2')
  })

  it('branch publishes: awaited refresh rethrows; a no-op branch resolves undefined without bumping the epoch', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-stored', storedSessionId: 'stored-1' })
    const failing = createSelection({ api: { list: vi.fn(async () => { throw new Error('list down') }) } })
    await expect(failing.selection.select({ kind: 'branch' })).rejects.toThrow('list down')
    expect(failing.conversation.adopt).toHaveBeenCalledTimes(1) // published before the refresh threw
    expect(failing.api.list).toHaveBeenCalledOnce()

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

  it('latest newest-pick filters automation and plumbing rows and keeps the first human on a timestamp tie', async () => {
    $sessions.set([
      { id: 'cron-newest', message_count: 9, preview: '', source: 'cron', started_at: 500, title: 'Nightly digest' },
      { id: 'tool-run', message_count: 2, preview: '', source: 'tool', started_at: 490, title: 'Sub-agent' },
      { id: 'worker', message_count: 2, preview: '', source: 'kanban', started_at: 480, title: 'Worker' },
      { id: 'bot-chat', message_count: 1, preview: '', source: 'ios', started_at: 470, title: 'Bot Chat' },
      { id: 'group-session', message_count: 1, preview: '', source: 'ios', started_at: 460, title: 'Group: room' },
      { id: 'human-first', message_count: 2, preview: '', source: 'custom', started_at: 300, title: 'Human first' },
      { id: 'human-tie', message_count: 1, preview: '', source: 'ios', started_at: 300, title: 'Human tie' }
    ])
    const { selection, runtime } = createSelection()

    const outcome = await selection.select({ kind: 'latest', freshen: true })

    expect(runtime.resumeSession).toHaveBeenCalledWith(null, 'human-first')
    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'human-first' }), resumed: true })
  })

  it('creates from only the loaded page when every visible session is non-human', async () => {
    $sessions.set([
      makeStoredSession('cron', { source: 'cron', started_at: 500 }),
      makeStoredSession('bot', { title: 'Bot Chat', started_at: 400 })
    ])
    $sessionsHasMore.set(true)
    const events: string[] = []
    const { selection, runtime, api } = createSelection({
      runtime: { createSession: vi.fn(async () => { events.push('create'); return makeSession('fresh') }) },
      api: { list: vi.fn(async limit => { events.push(`list:${limit}`); return { sessions: [] } }) }
    })

    const outcome = await selection.select({ kind: 'latest', freshen: true })

    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'fresh' }), resumed: false })
    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(events).toEqual(['create', 'list:30'])
    expect(api.list).toHaveBeenCalledOnce()
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

  it('refreshes a created session into the next latest pick', async () => {
    const rows = [
      makeStoredSession('older', { started_at: 100 }),
      makeStoredSession('created', { started_at: 500 })
    ]
    const { selection, runtime, api } = createSelection({
      runtime: { createSession: vi.fn(async () => makeSession('created')) },
      api: { list: vi.fn(async () => ({ sessions: rows })) }
    })

    await selection.select({ kind: 'create' })
    expect($sessions.get()).toEqual(rows)
    const outcome = await selection.select({ kind: 'latest', freshen: true })

    expect(runtime.resumeSession).toHaveBeenCalledWith(null, 'created')
    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'created' }), resumed: true })
    expect(api.list).toHaveBeenCalledOnce()
  })

  it('lets a warm no-freshen tap supersede an in-flight create without publishing', async () => {
    $sessions.set([makeStoredSession('current')])
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-current', storedSessionId: 'current' })
    let release!: (session: RuntimeSession) => void
    const gate = new Promise<RuntimeSession>(resolve => { release = resolve })
    const { selection, runtime, conversation, api } = createSelection({ runtime: { createSession: vi.fn(() => gate) } })

    const pending = selection.select({ kind: 'create' })
    const warm = await selection.select({ kind: 'latest', freshen: false })
    release(makeSession('late'))

    expect(warm).toEqual({ session: null, resumed: false })
    await expect(pending).resolves.toBeUndefined()
    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(conversation.adopt).not.toHaveBeenCalled()
    expect(api.list).not.toHaveBeenCalled()
  })

  it.each(['resume', 'publish', 'reconcile'] as const)('latest %s failure falls back to a fresh session', async failure => {
    $sessions.set([makeStoredSession('newest', { started_at: 300 })])
    const runtime = {
      resumeSession: vi.fn(async () => {
        if (failure === 'resume') throw new Error('resume failed')
        return makeSession('newest')
      }),
      createSession: vi.fn(async () => makeSession('fallback'))
    }
    const conversation = {
      adopt: vi.fn((session: RuntimeSession) => {
        if (failure === 'publish' && session.storedSessionId === 'newest') throw new Error('publish failed')
      }),
      reconcileHistory: vi.fn(async () => {
        if (failure === 'reconcile') throw new Error('reconcile failed')
      })
    }
    const { selection } = createSelection({ runtime, conversation })

    const outcome = await selection.select({ kind: 'latest', freshen: true })

    expect(runtime.resumeSession).toHaveBeenCalledWith(null, 'newest')
    expect(runtime.createSession).toHaveBeenCalledOnce()
    expect(outcome).toEqual({ session: expect.objectContaining({ storedSessionId: 'fallback' }), resumed: false })
  })

  it('latest warm-tap propagates freshen failure without creating a replacement', async () => {
    $sessions.set([makeStoredSession('current')])
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-current', storedSessionId: 'current' })
    const { selection, runtime } = createSelection({
      runtime: { createSession: vi.fn(async () => makeSession('unwanted')) },
      conversation: { reconcileHistory: vi.fn(async () => { throw new Error('history failed') }) }
    })

    await expect(selection.select({ kind: 'latest', freshen: true })).rejects.toThrow('history failed')
    expect(runtime.createSession).not.toHaveBeenCalled()
  })

  it('does not fall back from a latest resume rejection after its Scope goes stale', async () => {
    $sessions.set([makeStoredSession('newest')])
    let rejectResume!: (error: Error) => void
    const resume = new Promise<RuntimeSession>((_resolve, reject) => { rejectResume = reject })
    const { selection, runtime } = createSelection({
      runtime: {
        resumeSession: vi.fn(() => resume),
        createSession: vi.fn(async () => makeSession('fallback'))
      }
    })

    const pending = selection.select({ kind: 'latest', freshen: false })
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    rejectResume(new Error('session gone'))

    await expect(pending).resolves.toBeUndefined()
    expect(runtime.createSession).not.toHaveBeenCalled()
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
    await expect(selection.restore(open)).resolves.toMatchObject({ kind: 'published' })
    expect(open).toHaveBeenCalledWith('chat-id')

    $chat.set(emptyChatState())
    localStorage.setItem(BOOKMARK_KEY, 'bookmark-id')
    await expect(selection.restore(open)).resolves.toMatchObject({ kind: 'published' })
    expect(open).toHaveBeenLastCalledWith('bookmark-id')
  })

  it('preserves null and empty-string restore targets and bookmark cleanup behavior', async () => {
    const open = vi.fn(async (storedSessionId: null | string) => ({
      resumed: Boolean(storedSessionId),
      session: makeSession(storedSessionId || null)
    }))
    const { selection } = createSelection()

    await expect(selection.restore(open)).resolves.toMatchObject({ kind: 'published' })
    expect(open).toHaveBeenLastCalledWith(null)

    localStorage.setItem(BOOKMARK_KEY, '')
    await expect(selection.restore(open)).resolves.toMatchObject({ kind: 'published' })
    expect(open).toHaveBeenLastCalledWith('')
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('')
  })

  it('replaces an old bookmark after a fresh restore opens a new durable session', async () => {
    localStorage.setItem(BOOKMARK_KEY, 'old-session')
    const { selection } = createSelection()
    const opened = { resumed: false, session: makeSession('new-session') }

    await expect(selection.restore(async () => opened)).resolves.toEqual({ kind: 'published', opened })
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('new-session')
  })

  it('does not publish a fresh restore after a user selection has published', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection()
    localStorage.setItem(BOOKMARK_KEY, 'old-session')

    const restoring = selection.restore(() => openGate)
    const selected = await selection.select({ kind: 'create' })
    expect(selected).toEqual({ session: expect.objectContaining({ storedSessionId: 'created-1' }), resumed: false })

    const opened = { resumed: false, session: makeSession(null) }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'superseded', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(conversation.adopt).toHaveBeenCalledWith(expect.objectContaining({ storedSessionId: 'created-1' }), null)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('created-1')
  })

  it.each([
    ['branch', 'branched-1'],
    ['create', 'created-1'],
    ['resume', 'direct-session'],
    ['latest-resume', 'latest-session'],
    ['latest-create fallback', 'created-1']
  ] as const)('a %s publication supersedes a pending restore', async (kind, userSessionId) => {
    if (kind === 'branch') {
      $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-active', storedSessionId: 'active-session' })
    }
    if (kind === 'latest-resume' || kind === 'latest-create fallback') {
      $sessions.set([makeStoredSession('latest-session', { started_at: 20 })])
    }

    const runtimeOverrides: Record<string, unknown> = {}
    if (kind === 'latest-create fallback') {
      runtimeOverrides.resumeSession = vi.fn(async () => { throw new Error('session no longer exists') })
    }
    const { selection, runtime, conversation } = createSelection({
      runtime: runtimeOverrides,
      conversation: { setSessionSource: vi.fn() }
    })
    localStorage.setItem(BOOKMARK_KEY, 'old-session')

    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const expectedTarget = kind === 'branch' ? 'active-session' : 'old-session'
    const restoring = selection.restore(storedSessionId => {
      expect(storedSessionId).toBe(expectedTarget)
      return openGate
    })

    let selected
    switch (kind) {
      case 'branch':
        selected = await selection.select({ kind: 'branch' })
        break
      case 'create':
        selected = await selection.select({ kind: 'create' })
        break
      case 'resume':
        selected = await selection.select({ kind: 'resume', storedSessionId: userSessionId })
        break
      case 'latest-resume':
        selected = await selection.select({ kind: 'latest', freshen: false })
        break
      case 'latest-create fallback':
        selected = await selection.select({ kind: 'latest', freshen: false })
        expect(runtime.resumeSession).toHaveBeenCalledWith(null, 'latest-session')
        break
    }

    expect(selected).toMatchObject({ session: expect.objectContaining({ storedSessionId: userSessionId }) })
    const opened = { resumed: false, session: makeSession(null) }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'superseded', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(conversation.adopt.mock.calls[0]?.[0]).toMatchObject({ storedSessionId: userSessionId })
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe(userSessionId)
  })

  it('a selection without a durable id still supersedes restore before bookmark cleanup', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection({ runtime: { createSession: vi.fn(async () => makeSession(null)) } })
    localStorage.setItem(BOOKMARK_KEY, 'old-session')

    const restoring = selection.restore(() => openGate)
    await expect(selection.select({ kind: 'create' })).resolves.toMatchObject({
      session: expect.objectContaining({ storedSessionId: null })
    })
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('old-session')

    const opened = { resumed: false, session: makeSession(null) }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'superseded', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('old-session')
  })

  it('does not overwrite a new bookmark when the superseded restore resumed an older id', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection()
    localStorage.setItem(BOOKMARK_KEY, 'old-session')

    const restoring = selection.restore(() => openGate)
    await selection.select({ kind: 'create' })
    const opened = { resumed: true, session: makeSession('old-session') }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'superseded', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('created-1')
  })

  it('a selection rejected before adoption leaves restore eligible to publish', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection({
      runtime: { createSession: vi.fn(async () => { throw new Error('create failed') }) }
    })
    localStorage.setItem(BOOKMARK_KEY, 'old-session')
    const restoring = selection.restore(() => openGate)

    await expect(selection.select({ kind: 'create' })).rejects.toThrow('create failed')
    const opened = { resumed: false, session: makeSession(null) }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'published', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(conversation.adopt).toHaveBeenCalledWith(opened.session, null)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBeNull()
  })

  it('a selection remains published when its history follow-up rejects', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    let rejectFollowUp!: (error: Error) => void
    const followUpGate = new Promise<void>((_resolve, reject) => { rejectFollowUp = reject })
    const { selection, conversation } = createSelection({ conversation: { reconcileHistory: vi.fn(() => followUpGate) } })
    localStorage.setItem(BOOKMARK_KEY, 'old-session')

    const restoring = selection.restore(() => openGate)
    const selecting = selection.select({ kind: 'resume', storedSessionId: 'user-session' })
    await vi.waitFor(() => expect(conversation.adopt).toHaveBeenCalledOnce())
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('user-session')

    rejectFollowUp(new Error('history failed'))
    await expect(selecting).rejects.toThrow('history failed')

    const opened = { resumed: true, session: makeSession('old-session') }
    releaseOpen(opened)
    await expect(restoring).resolves.toEqual({ kind: 'superseded', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('user-session')
  })

  it('records publication before a bookmark write that throws', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection()
    localStorage.setItem(BOOKMARK_KEY, 'old-session')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('storage unavailable') })

    const restoring = selection.restore(() => openGate)
    await expect(selection.select({ kind: 'create' })).rejects.toThrow('storage unavailable')
    expect(conversation.adopt).toHaveBeenCalledOnce()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('old-session')

    const opened = { resumed: false, session: makeSession('restore-session') }
    releaseOpen(opened)
    await expect(restoring).resolves.toEqual({ kind: 'superseded', opened })
    expect(conversation.adopt).toHaveBeenCalledOnce()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('old-session')
  })

  it.each([
    ['runtime id', { runtimeSessionId: null, storedSessionId: 'old-session' }],
    ['stored id', { runtimeSessionId: 'runtime-active', storedSessionId: null }]
  ] as const)('a no-op branch with no %s does not supersede restore', async (_missing, chat) => {
    $chat.set({ ...emptyChatState(), ...chat })
    localStorage.setItem(BOOKMARK_KEY, 'old-session')
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection()
    const restoring = selection.restore(() => openGate)

    await expect(selection.select({ kind: 'branch' })).resolves.toBeUndefined()
    const opened = { resumed: true, session: makeSession('old-session') }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'published', opened })
    expect(conversation.adopt).toHaveBeenCalledOnce()
  })

  it('a warm latest tap does not supersede restore', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-active', storedSessionId: 'same-session' })
    $sessions.set([makeStoredSession('same-session', { started_at: 10 })])
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection()
    const restoring = selection.restore(() => openGate)

    await expect(selection.select({ kind: 'latest', freshen: false })).resolves.toMatchObject({ session: null })
    expect(conversation.adopt).not.toHaveBeenCalled()

    const opened = { resumed: true, session: makeSession('same-session') }
    releaseOpen(opened)
    await expect(restoring).resolves.toEqual({ kind: 'published', opened })
    expect(conversation.adopt).toHaveBeenCalledOnce()
  })

  it('a Scope-stale restore has no effects after a user selection publishes', async () => {
    localStorage.setItem(BOOKMARK_KEY, 'old-session')
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const { selection, conversation } = createSelection()
    const restoring = selection.restore(() => openGate)

    await selection.select({ kind: 'create' })
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    const opened = { resumed: false, session: makeSession(null) }
    releaseOpen(opened)

    await expect(restoring).resolves.toBeUndefined()
    expect(conversation.adopt).toHaveBeenCalledOnce()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('created-1')
  })

  it('an open rejection remains an error after a user selection publishes', async () => {
    let rejectOpen!: (error: Error) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>((_resolve, reject) => { rejectOpen = reject })
    const { selection, conversation } = createSelection()
    const restoring = selection.restore(() => openGate)

    await selection.select({ kind: 'create' })
    rejectOpen(new Error('restore failed'))

    await expect(restoring).rejects.toThrow('restore failed')
    expect(conversation.adopt).toHaveBeenCalledOnce()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('created-1')
  })

  it('an adoption that throws does not mark the selection as published', async () => {
    localStorage.setItem(BOOKMARK_KEY, 'old-session')
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    const adopt = vi.fn().mockImplementationOnce(() => { throw new Error('adopt failed') })
    const { selection, conversation } = createSelection({ conversation: { adopt } })
    const restoring = selection.restore(() => openGate)

    await expect(selection.select({ kind: 'create' })).rejects.toThrow('adopt failed')
    const opened = { resumed: false, session: makeSession(null) }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'published', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBeNull()
  })

  it('restore clears the bookmark when the open lands fresh; a non-current guard publishes nothing', async () => {
    const open = vi.fn(async () => ({ resumed: false, session: makeSession(null) }))
    const { selection, conversation } = createSelection()
    localStorage.setItem(BOOKMARK_KEY, 'bookmark-id')

    await expect(selection.restore(open)).resolves.toMatchObject({ kind: 'published' })

    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBeNull()

    localStorage.setItem(BOOKMARK_KEY, 'guarded-target')
    const blocked = await selection.restore(open, () => false)
    expect(blocked).toBeUndefined()
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('guarded-target')
  })

  it('a pending selection does not suppress restore when restore resolves first', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    let releaseCreate!: (session: RuntimeSession) => void
    const createGate = new Promise<RuntimeSession>(resolve => { releaseCreate = resolve })
    const { selection, conversation } = createSelection({ runtime: { createSession: vi.fn(() => createGate) } })
    localStorage.setItem(BOOKMARK_KEY, 'old-session')

    const restoring = selection.restore(() => openGate)
    const selecting = selection.select({ kind: 'create' })
    const opened = { resumed: false, session: makeSession('restored-session') }
    releaseOpen(opened)

    await expect(restoring).resolves.toEqual({ kind: 'published', opened })
    expect(conversation.adopt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('restored-session')

    releaseCreate(makeSession('user-session'))
    await expect(selecting).resolves.toMatchObject({ session: expect.objectContaining({ storedSessionId: 'user-session' }) })
    expect(conversation.adopt).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('user-session')
  })

  it('a selection that started before restore can still supersede it by publishing first', async () => {
    let releaseOpen!: (opened: { resumed: boolean; session: RuntimeSession }) => void
    const openGate = new Promise<{ resumed: boolean; session: RuntimeSession }>(resolve => { releaseOpen = resolve })
    let releaseCreate!: (session: RuntimeSession) => void
    const createGate = new Promise<RuntimeSession>(resolve => { releaseCreate = resolve })
    const { selection, conversation } = createSelection({ runtime: { createSession: vi.fn(() => createGate) } })
    localStorage.setItem(BOOKMARK_KEY, 'old-session')

    const selecting = selection.select({ kind: 'create' })
    const restoring = selection.restore(() => openGate)
    releaseCreate(makeSession('user-session'))
    await expect(selecting).resolves.toMatchObject({ session: expect.objectContaining({ storedSessionId: 'user-session' }) })

    const opened = { resumed: false, session: makeSession(null) }
    releaseOpen(opened)
    await expect(restoring).resolves.toEqual({ kind: 'superseded', opened })
    expect(conversation.adopt).toHaveBeenCalledOnce()
    expect(localStorage.getItem(BOOKMARK_KEY)).toBe('user-session')
  })

  it('restore does not bump the selection epoch: an in-flight select still publishes', async () => {
    let release!: (value: RuntimeSession) => void
    const gate = new Promise<RuntimeSession>(resolve => { release = resolve })
    const { selection, conversation } = createSelection({ runtime: { createSession: vi.fn(() => gate) } })
    const pending = selection.select({ kind: 'create' })

    const restored = await selection.restore(async () => ({ resumed: true, session: makeSession('restored') }))
    expect(restored).toMatchObject({ kind: 'published' })
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