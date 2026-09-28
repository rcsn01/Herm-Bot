import { humanSessions, type SessionsApi } from '~/features/sessions/api'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { beginScopedTask, currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope, type ScopedTask } from '~/gateway/scope-guard'
import { queryClient } from '~/gateway/query-client'
import type { RuntimeSession, SessionRuntime } from '~/gateway/session-runtime'
import { $chat, type Conversation } from '~/state/conversation'
import { $preferences, $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'

/**
 * SessionSelection owns which session is live, including the selection epoch
 * and Scope-guarded publication. It also owns latest-session selection, the
 * live session list and paging, and the reconnect restore path. The
 * GatewayController owns transport lifecycle and connection phases.
 * Conversation owns session content and remains the only writer to `$chat`.
 */

/** What a selection published. `session: null` ⇒ warm-tap (nothing adopted;
 *  reconcile already ran inside when `freshen` was set). */
export interface SelectionOutcome {
  session: RuntimeSession | null
  resumed: boolean
}

export type SelectionRequest =
  | { kind: 'create' }                                // newSession
  | { kind: 'resume'; storedSessionId: string }       // sessions menu, deep links, cron run → session
  | { kind: 'branch' }                                // branch the open conversation
  | { kind: 'latest'; freshen: boolean }              // roster tap pick (openProfile)

export interface SessionSelection {
  /**
   * One user-initiated selection. Bumps the selection epoch at entry (after the
   * `branch` precondition check — a no-op branch must not retire in-flight work).
   * Publish order: source lookup → conversation.adopt → bookmark write → follow-up.
   * Resolves `undefined` when the epoch or captured Scope went stale, or when the
   * request is a no-op (branch without an open durable conversation): nothing is
   * adopted, nothing bookmarked, nothing thrown. Transport failures reject with the
   * classified GatewayError.
   * Follow-up policy per kind: create ⇒ best-effort list refresh (failure swallowed);
   * branch ⇒ awaited list refresh (failure rethrows); resume ⇒ awaited reconcileHistory
   * on the captured scope (failure rethrows); latest ⇒ see the implementation.
   */
  select(request: SelectionRequest): Promise<SelectionOutcome | undefined>

  /** Refresh the full current-profile list using the captured Scope. */
  refreshSessions(scope?: CurrentGatewayScope): Promise<void>

  /** Expand the cumulative page limit and re-fetch the full list. */
  loadMoreSessions(): Promise<void>

  /** Reset list state and its private page limit during Scope teardown. */
  resetSessionList(): void

  /** Rename a live session and refresh its roster after the route succeeds. */
  renameSession(storedSessionId: string, title: string): Promise<void>

  /** Archive a live session and refresh its roster after the route succeeds. */
  archiveSession(storedSessionId: string): Promise<void>

  /** Delete a live session, replacing it first when it is active. */
  deleteSession(storedSessionId: string): Promise<void>

  /**
   * Connect/reconnect restore. Resolves the restore target
   * (`$chat.storedSessionId ?? scope bookmark`), runs `open(target)`, then — only if
   * the captured Scope is current AND `isCurrent()` (the caller's reconnect-epoch
   * callback) — clears the bookmark when `resumed === false` and adopts the opened
   * session through the publish below (source lookup → adopt → bookmark write, so
   * the next cold start restores this session). Does NOT touch the selection
   * epoch: a restore that finishes after a user selection can publish over it.
   * Resolves `undefined` when stale.
   * Reconcile/refresh stay caller policy (paint happens between).
   */
  restore<TOpen extends { resumed: boolean; session: RuntimeSession }>(
    open: (storedSessionId: null | string) => Promise<TOpen>,
    isCurrent?: () => boolean
  ): Promise<{ opened: TOpen } | undefined>

  /** Retire every in-flight selection (dispose). Logout/switchProfile/configure keep
   *  scope-based guarding — their teardown changes the Scope itself. */
  invalidate(): void

  /** The sanctioned `$chat` reads outside the Conversation. */
  activeStoredSessionId(): null | string              // $chat.storedSessionId
  hasLiveSession(): boolean                           // Boolean($chat.runtimeSessionId)
}

function scopeSnapshot() {
  const preferences = $preferences.get()
  return { connectionKey: preferences.remoteURL, profile: preferences.profile }
}

function sessionBookmarkKey(scope: { connectionKey: string; profile: null | string } = scopeSnapshot()) {
  return `hermes.mobile.session:${encodeURIComponent(scope.connectionKey)}:${encodeURIComponent(scope.profile ?? 'default')}`
}

function readSessionBookmark(scope: { connectionKey: string; profile: null | string } = scopeSnapshot()) {
  return localStorage.getItem(sessionBookmarkKey(scope))
}

function clearSessionBookmark(scope: { connectionKey: string; profile: null | string } = scopeSnapshot()) {
  localStorage.removeItem(sessionBookmarkKey(scope))
}

const SESSION_LIST_PAGE_SIZE = 30

export function createSessionSelection(deps: {
  runtime: SessionRuntime
  conversation: Conversation
  sessionsApi: (scope: CurrentGatewayScope) => SessionsApi
}): SessionSelection {
  const { runtime, conversation, sessionsApi } = deps
  let selectionEpoch = 0
  let sessionListLimit = SESSION_LIST_PAGE_SIZE

  /** Install the session as the open conversation and remember it for reconnects. */
  function publish(session: RuntimeSession): void {
    const source = session.storedSessionId
      ? $sessions.get().find(candidate => candidate.id === session.storedSessionId)?.source
      : null
    conversation.adopt(session, typeof source === 'string' ? source : null)
    if (session.storedSessionId) localStorage.setItem(sessionBookmarkKey(), session.storedSessionId)
  }

  /** A publish requires the captured epoch to still be the newest user
   *  selection AND the captured Scope to still be foreground. */
  function stillCurrent(epoch: number, task: ScopedTask): boolean {
    return epoch === selectionEpoch && task.isCurrent()
  }

  async function refreshSessions(scope: CurrentGatewayScope = currentGatewayScope()): Promise<void> {
    const limit = sessionListLimit
    const response = await queryClient.fetchQuery({
      queryFn: ({ signal }) => sessionsApi(scope).list(limit, signal),
      queryKey: gatewayScopeKey(scope, 'sessions', 'list', limit),
      staleTime: 0
    })
    if (!isCurrentGatewayScope(scope)) return
    const sessions = response.sessions ?? []
    $sessions.set(sessions)
    $sessionsHasMore.set(sessions.length >= limit)
    const activeId = $chat.get().storedSessionId
    if (activeId) {
      const source = sessions.find(session => session.id === activeId)?.source
      conversation.setSessionSource(activeId, typeof source === 'string' ? source : null)
    }
  }

  async function loadMoreSessions(): Promise<void> {
    if ($sessionsLoadingMore.get() || !$sessionsHasMore.get()) return
    const scope = currentGatewayScope()
    const previousLimit = sessionListLimit
    sessionListLimit += SESSION_LIST_PAGE_SIZE
    $sessionsLoadingMore.set(true)
    try {
      await refreshSessions(scope)
    } catch (error) {
      if (isCurrentGatewayScope(scope)) sessionListLimit = previousLimit
      throw error
    } finally {
      if (isCurrentGatewayScope(scope)) $sessionsLoadingMore.set(false)
    }
  }

  function resetSessionList(): void {
    sessionListLimit = SESSION_LIST_PAGE_SIZE
    $sessions.set([])
    $sessionsHasMore.set(false)
    $sessionsLoadingMore.set(false)
  }

  async function renameSession(storedSessionId: string, title: string): Promise<void> {
    const scope = currentGatewayScope()
    await sessionsApi(scope).rename(storedSessionId, title)
    if (!isCurrentGatewayScope(scope)) return
    conversation.retitleActive(storedSessionId, title)
    await refreshSessions(scope)
  }

  async function archiveSession(storedSessionId: string): Promise<void> {
    const scope = currentGatewayScope()
    await sessionsApi(scope).archive(storedSessionId)
    if (isCurrentGatewayScope(scope)) await refreshSessions(scope)
  }

  async function deleteSession(storedSessionId: string): Promise<void> {
    const scope = currentGatewayScope()
    await sessionsApi(scope).remove(storedSessionId)
    if (!isCurrentGatewayScope(scope)) return
    if ($chat.get().storedSessionId === storedSessionId) await select({ kind: 'create' })
    if (isCurrentGatewayScope(scope)) await refreshSessions(scope)
  }

  async function select(request: SelectionRequest): Promise<SelectionOutcome | undefined> {
    const task = beginScopedTask()
    const scope = task.scope

    // A no-op branch must not retire in-flight work: the precondition runs
    // before the epoch bump.
    if (request.kind === 'branch') {
      const current = $chat.get()
      if (!current.runtimeSessionId || !current.storedSessionId) return undefined
      const epoch = ++selectionEpoch
      const session = await runtime.branchSession(current.runtimeSessionId)
      if (!stillCurrent(epoch, task)) return undefined
      publish(session)
      await refreshSessions(scope)
      return { session, resumed: false }
    }

    const epoch = ++selectionEpoch

    if (request.kind === 'create') {
      const session = await runtime.createSession(scope.profile)
      if (!stillCurrent(epoch, task)) return undefined
      publish(session)
      // Every other session mutation (branch/rename/archive/delete) refreshes
      // the list; a create must too — the roster tap picks the newest session
      // from this store, so a stale list sends the next tap into an older
      // conversation. Best-effort: the create already succeeded, and a failed
      // listing must not fail the new chat.
      try {
        await refreshSessions(scope)
      } catch {
        /* store stays stale; the next connect/tap re-lists */
      }
      return { session, resumed: false }
    }

    if (request.kind === 'resume') {
      const session = await runtime.resumeSession(scope.profile, request.storedSessionId)
      if (!stillCurrent(epoch, task)) return undefined
      publish(session)
      await conversation.reconcileHistory(scope)
      return { session, resumed: true }
    }

    // Roster tap: enter a profile's latest conversation. Resumes the newest
    // session from the refreshed list, and starts a fresh session when none
    // exists or the newest one is gone. A switch lets connect() resume the
    // profile's bookmarked session directly, so when that is already the
    // newest conversation no second resume happens.
    const sessions = humanSessions($sessions.get())
    const latest = sessions.reduce<null | (typeof sessions)[number]>((newest, session) =>
      !newest || session.started_at > newest.started_at ? session : newest, null)
    const active = $chat.get()
    if (latest && active.runtimeSessionId && latest.id === active.storedSessionId) {
      // Already inside the target conversation; a switch reconciled it in
      // passing, a warm tap only needs a freshen.
      if (request.freshen) await conversation.reconcileHistory(scope)
      return { session: null, resumed: false }
    }
    if (latest) {
      try {
        const session = await runtime.resumeSession(scope.profile, latest.id)
        if (!stillCurrent(epoch, task)) return undefined
        publish(session)
        await conversation.reconcileHistory(scope)
        return { session, resumed: true }
      } catch {
        // The stored conversation may no longer exist; start a fresh one
        // instead. Re-verify epoch + Scope first: with one epoch a newer
        // in-flight selection wins instead of being retired by the fallback.
        if (!stillCurrent(epoch, task)) return undefined
      }
    }
    const session = await runtime.createSession(scope.profile)
    if (!stillCurrent(epoch, task)) return undefined
    publish(session)
    try {
      await refreshSessions(scope)
    } catch {
      /* store stays stale; the next connect/tap re-lists */
    }
    return { session, resumed: false }
  }

  async function restore<TOpen extends { resumed: boolean; session: RuntimeSession }>(
    open: (storedSessionId: null | string) => Promise<TOpen>,
    isCurrent?: () => boolean
  ): Promise<{ opened: TOpen } | undefined> {
    const task = beginScopedTask()
    const scope = task.scope
    const storedSessionId = $chat.get().storedSessionId ?? readSessionBookmark(scope)
    const opened = await open(storedSessionId)
    if (!task.isCurrent() || isCurrent?.() === false) return undefined
    if (storedSessionId && !opened.resumed) clearSessionBookmark(scope)
    publish(opened.session)
    return { opened }
  }

  return {
    select,
    refreshSessions,
    loadMoreSessions,
    resetSessionList,
    renameSession,
    archiveSession,
    deleteSession,
    restore,
    invalidate: () => {
      selectionEpoch += 1
    },
    activeStoredSessionId: () => $chat.get().storedSessionId,
    hasLiveSession: () => Boolean($chat.get().runtimeSessionId)
  }
}