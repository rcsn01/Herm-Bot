import { humanSessions } from '~/features/sessions/api'
import { beginScopedTask, type CurrentGatewayScope, type ScopedTask } from '~/gateway/scope-guard'
import type { RuntimeSession, SessionRuntime } from '~/gateway/session-runtime'
import { $chat, type Conversation } from '~/state/conversation'
import { $preferences, $sessions } from '~/state/store'

/**
 * The Session selection is the deep module that owns *which session is live*
 * (see the repository's CONTEXT.md). It owns the selection epoch — the
 * request-epoch idiom over user-initiated selections (create / resume /
 * branch / latest) — the Scope-guarded publish of a selected session (source
 * lookup from `$sessions`, adoption through the Conversation, which stays
 * `$chat`'s sole writer, the session-bookmark write, and the per-verb
 * follow-up policy), the roster-tap `latest` pick, and the connect/reconnect
 * `restore` path. The GatewayController keeps transport lifecycle, connection
 * phases, and session-list paging; the Conversation owns session *content*.
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

  /**
   * Connect/reconnect restore. Resolves the restore target
   * (`$chat.storedSessionId ?? scope bookmark`), runs `open(target)`, then — only if
   * the captured Scope is current AND `isCurrent()` (the caller's reconnect-epoch
   * callback) — clears the bookmark when `resumed === false` and adopts the opened
   * session through the publish below (source lookup → adopt → bookmark write, so
   * the next cold start restores this session). Does NOT touch the selection
   * epoch: an automatic reconnect must never supersede an in-flight user
   * selection. Resolves `undefined` when stale.
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

export function createSessionSelection(deps: {
  runtime: SessionRuntime
  conversation: Conversation
  refreshSessions: (scope: CurrentGatewayScope) => Promise<void>
}): SessionSelection {
  const { runtime, conversation, refreshSessions } = deps
  let selectionEpoch = 0

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
    restore,
    invalidate: () => {
      selectionEpoch += 1
    },
    activeStoredSessionId: () => $chat.get().storedSessionId,
    hasLiveSession: () => Boolean($chat.get().runtimeSessionId)
  }
}