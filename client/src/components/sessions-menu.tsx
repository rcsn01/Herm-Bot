import { useStore } from '@nanostores/react'
import { IconArchive, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { useSwipeMotion } from '~/gestures/use-swipe-motion'

import { Button, Input } from '~/compat/primitives'
import { BotWorkspaceHeader } from '~/components/bot-workspace-header'
import { BotWorkspaceNavigation } from '~/components/bot-workspace-navigation'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { displayNameFor } from '~/features/agents/agent-labels'
import { humanSessions } from '~/features/sessions/api'
import { buildSessionList, sessionCount, sessionDate, sessionPreview, sessionTitle, type DiscoverySession } from '~/features/sessions/session-discovery'
import { useDiscoveryIdentity } from '~/features/sessions/use-discovery-identity'
import type { MobileTab } from '~/navigation/routes'
import { workspaceMenuIntent, type WorkspaceMenuIntent } from '~/navigation/workspace-navigation'
import { useScopedTask } from '~/gateway/scope-guard'
import { $chat } from '~/state/conversation'
import { $sessionSelecting } from '~/state/store'
import type { SelectionOutcome } from '~/state/session-selection'
import type { GatewayController } from '~/state/gateway-controller'
import { transcriptCache } from '~/state/transcript-cache'
import { $draftOwner } from '~/state/draft-owner'
import { $gatewayReady, $preferences } from '~/state/store'
import { $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'

interface SessionsMenuProps {
  controller: GatewayController
  onDismissRequest(intent?: WorkspaceMenuIntent): void
  open: boolean
}

const EDGE_BACK_WIDTH_PX = 28
const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
const NAVIGATION_CONTROLS = 'button, input, textarea, select, [contenteditable="true"], .session-row'

interface SessionRowProps {
  active: boolean
  remoteReady: boolean
  savedAt?: number
  savedPersistently?: boolean
  onDelete(title: string): void
  onReveal(id: string | null): void
  onOpen(id: string, active: boolean): void
  pending: boolean
  revealed: boolean
  session: DiscoverySession
}

function SessionRow({ remoteReady, savedAt, savedPersistently, active, onDelete, onOpen, onReveal, pending, revealed, session }: SessionRowProps) {
  const date = sessionDate(session.started_at)
  const title = sessionTitle(session)
  const preview = remoteReady ? sessionPreview(session.preview) : ''
  const count = remoteReady ? sessionCount(session.message_count) : null
  const motion = useSwipeMotion({
    canStart: (target, event) => {
      if (event && event.clientX <= EDGE_BACK_WIDTH_PX) return false
      if (!(target instanceof HTMLElement)) return true
      if (target.closest('.session-delete-action, .session-quick-delete')) return false
      return true
    },
    direction: 'left',
    enabled: remoteReady && !pending,
    // The visible 44px action already occupies part of the 104px delete rail.
    extentPx: () => 60,
    initialProgress: revealed ? 1 : 0,
    onCommit: endpoint => onReveal(endpoint === 1 ? session.id : null),
    restingEndpoint: revealed ? 1 : 0
  })

  useEffect(() => {
    motion.setProgress(revealed ? 1 : 0)
  }, [motion.setProgress, revealed])

  return (
    <article
      className={`session-row ${revealed ? 'delete-revealed' : ''} ${active ? 'active-session' : ''}`}
      key={session.id}
      ref={motion.ref}
      {...motion.bind}
    >
      <div className="session-delete-action">
        <Button
          aria-hidden={!revealed}
          aria-label={`Delete ${title}`}
          disabled={!remoteReady || pending}
          onClick={() => {
            if (!revealed) return
            onReveal(null)
            onDelete(title)
          }}
          tabIndex={revealed ? 0 : -1}
          variant="destructive"
        >
          <IconTrash size={18} /> Delete
        </Button>
      </div>
      <button
        aria-current={active ? 'page' : undefined}
        className="session-main"
        data-session-id={session.id}
        disabled={pending}
        onClick={() => {
          if (revealed) return onReveal(null)
          onOpen(session.id, active)
        }}
      >
        <strong>{title}</strong>
        {date ? <time dateTime={date.toISOString()}>Started {date.toLocaleDateString()}</time> : <small>Date unavailable</small>}
        {preview && <span className="session-preview">{preview}</span>}
        {count !== null && <small className="session-count">{count} {count === 1 ? 'message' : 'messages'}</small>}
        {savedAt !== undefined && <small>{savedPersistently ? 'Saved on this device' : 'Available until this app closes'} · {new Date(savedAt).toLocaleString()}</small>}
      </button>
      <Button aria-hidden={revealed} aria-label={`Delete ${title}`} className="session-quick-delete" disabled={!remoteReady || pending} tabIndex={revealed ? -1 : 0} onClick={() => onDelete(title)} size="icon" variant="ghost"><IconTrash aria-hidden="true" size={16} /></Button>
    </article>
  )
}

export function SessionsMenu(props: SessionsMenuProps) {
  const identity = useDiscoveryIdentity()
  return <SessionsMenuContent key={identity} {...props} />
}

function SessionsMenuContent({ controller, onDismissRequest, open }: SessionsMenuProps) {
  const chat = useStore($chat)
  const preferences = useStore($preferences)
  const remoteSessions = useStore($sessions)
  const ready = useStore($gatewayReady)
  const owner = useStore($draftOwner)
  useStore(transcriptCache.$version)
  const cached = transcriptCache.list(owner, preferences.profile)
  const savedTimes = new Map(cached.map(item => [item.storedSessionId, item.lastSyncedAt]))
  const sessions: DiscoverySession[] = owner.locked ? [] : ready ? remoteSessions : cached.map(item => ({ id: item.storedSessionId, title: item.title, message_count: null, preview: '', source: item.source ?? '', started_at: item.startedAt === null ? null : item.startedAt / 1000 }))
  const sessionsHaveMore = useStore($sessionsHasMore)
  const sessionsLoadingMore = useStore($sessionsLoadingMore)
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [refreshing, setRefreshing] = useState(open && ready)
  const [autoPaused, setAutoPaused] = useState(false)
  const live = useRef(false)
  const paging = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusedRef = useRef<HTMLElement | null>(null)
  const helpId = useId()
  useLayoutEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const [error, setError] = useState<string | null>(null)
  const [pendingSessionAction, setPendingSessionAction] = useState(false)
  const [remove, setRemove] = useState<{ id: string; title: string } | null>(null)
  const [swipedId, setSwipedId] = useState<string | null>(null)
  const loadMoreRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const actionPendingRef = useRef(false)
  const refreshGeneration = useRef(0)
  const action = useScopedTask()
  const navigationMotion = useSwipeMotion({
    canStart: (target, event) => {
      if (!event || event.clientX > EDGE_BACK_WIDTH_PX) return false
      if (!(target instanceof Element)) return true
      if (target.closest('.session-row')) return true
      return !target.closest(NAVIGATION_CONTROLS)
    },
    direction: 'right',
    enabled: open && !pendingSessionAction,
    extentPx: () => window.innerWidth,
    initialProgress: 0,
    onCommit: endpoint => {
      if (endpoint === 1 && !actionPendingRef.current) onDismissRequest({ type: 'close' })
    },
    restingEndpoint: 0
  })
  const list = useMemo(() => buildSessionList(ready ? humanSessions(sessions) : sessions, query, now), [query, sessions, ready, now])
  const loadMoreSessions = useCallback(async () => {
    if (paging.current || actionPendingRef.current) return
    paging.current = true
    const generation = refreshGeneration.current
    setError(null)
    let failed = false
    await action.run(() => controller.loadMoreSessions(), { onError: error => {
      failed = true
      if (live.current && generation === refreshGeneration.current) { setError(error.message); setAutoPaused(true) }
    } })
    paging.current = false
    if (live.current && generation === refreshGeneration.current && !failed) setAutoPaused(false)
  }, [action, controller])

  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const date = new Date()
      setNow(date)
      clearTimeout(timer)
      timer = setTimeout(tick, new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - date.getTime() + 50)
    }
    tick()
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => { clearTimeout(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick) }
  }, [open])

  useLayoutEffect(() => {
    const previous = focusedRef.current
    if (!open || !previous || previous.isConnected || document.activeElement !== document.body) return
    const id = previous.dataset.sessionId
    const row = id ? [...panelRef.current!.querySelectorAll<HTMLElement>('.session-main')].find(node => node.dataset.sessionId === id) : null
    ;(row ?? searchRef.current)?.focus({ preventScroll: true })
  })

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus({ preventScroll: true })
    setError(null)
    setAutoPaused(false)
    return () => {
      const opener = restoreFocusRef.current
      if (opener?.isConnected) opener.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || !ready) { setRefreshing(false); return }
    const generation = ++refreshGeneration.current
    setRefreshing(true)
    void action.run(async () => { await controller.refreshSessions() }, {
      onError: error => { if (live.current && refreshGeneration.current === generation) { setError(error.message); setAutoPaused(true) } }
    }).finally(() => { if (live.current && refreshGeneration.current === generation) setRefreshing(false) })
    return () => { ++refreshGeneration.current }
  }, [action, controller, open, ready])

  useEffect(() => {
    const target = loadMoreRef.current
    if (!ready || !open || !target || query.trim() || autoPaused || refreshing || pendingSessionAction || !sessionsHaveMore || sessionsLoadingMore || typeof IntersectionObserver === 'undefined') return
    let retired = false
    const observer = new IntersectionObserver(entries => {
      if (!retired && entries.some(entry => entry.isIntersecting)) void loadMoreSessions()
    }, { root: target.closest('.navigation-session-list') })
    observer.observe(target)
    return () => { retired = true; observer.disconnect() }
  }, [ready, loadMoreSessions, open, sessionsHaveMore, sessionsLoadingMore, query, autoPaused, refreshing, pendingSessionAction])

  const runSessionAction = async (callback: () => Promise<SelectionOutcome | void>, target?: string) => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    setPendingSessionAction(true)
    const generation = refreshGeneration.current
    const wasOffline = !ready
    await action.run(async task => {
      setError(null)
      const outcome = await callback()
      if (!task.isCurrent() || !live.current || generation !== refreshGeneration.current || $sessionSelecting.get()) return
      if (!outcome && !(target && wasOffline && $chat.get().availability === 'cached')) return
      if (target && $chat.get().storedSessionId !== target) return
      onDismissRequest({ type: 'tab', tab: 'sessions' })
    }, { onError: error => { if (live.current && generation === refreshGeneration.current) setError(error.message) } })
    // The pending latch is unconditional cleanup: it must reset even when the
    // scope went stale mid-action, exactly as the previous unguarded finally did.
    actionPendingRef.current = false
    if (live.current) setPendingSessionAction(false)
  }

  const deleteSession = async (id: string) => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    setPendingSessionAction(true)
    await action.run(async () => {
      setError(null)
      await controller.deleteSession(id)
    }, { onError: error => { if (live.current) setError(error.message) } })
    actionPendingRef.current = false
    if (live.current) setPendingSessionAction(false)
  }

  const requestClose = () => {
    if (!actionPendingRef.current) onDismissRequest({ type: 'close' })
  }

  const navigate = (tab: MobileTab) => {
    if (actionPendingRef.current) return
    onDismissRequest({ type: 'tab', tab })
  }

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      aria-hidden={!open}
      className={`sessions-menu ${open ? 'open' : ''}`}
      data-testid="sessions-menu"
      inert={!open ? true : undefined}
      ref={navigationMotion.ref}
      {...navigationMotion.bind}
    >
      <main
        aria-label="Sessions menu"
        className="sessions-menu-content"
        id="sessions-menu"
        onKeyDown={trapFocus}
        onFocusCapture={event => { if (event.target instanceof HTMLElement) focusedRef.current = event.target }}
        ref={panelRef}
        tabIndex={-1}
      >
        <BotWorkspaceHeader
          backLabel="Back"
          botName={displayNameFor({ name: preferences.profile || 'default' })}
          className="sessions-menu-header"
          onBack={requestClose}
          onIdentityClick={() => navigate('sessions')}
          subtitle="Sessions"
        />
        <div className="sessions-menu-body">
          <label className="search-box sessions-menu-search"><IconSearch aria-hidden="true" size={17} /><Input aria-describedby={helpId} aria-label="Search loaded titles" onChange={event => { setQuery(event.target.value); setSwipedId(null) }} placeholder="Search loaded titles" ref={searchRef} value={query} /></label>
          <p className="session-search-help" id={helpId}>{ready ? 'Searches loaded conversation titles for this bot, not message contents or archived chats.' : 'Searches titles saved on this device, not message contents or archived chats.'}</p>
          <p className="session-search-summary" role={open ? 'status' : undefined} aria-live={open ? 'polite' : 'off'} aria-atomic="true">{sessionsLoadingMore || refreshing ? 'Loading sessions…' : `${list.matchCount} matches in ${list.loadedCount} loaded conversations`}</p>

          {!ready && <p role="status">Saved conversations only. Reconnect to create, delete, or load more sessions.</p>}
          {error && <div className="error-banner navigation-error" role="alert">{error} <Button disabled={refreshing || sessionsLoadingMore} onClick={() => {
            if (sessionsHaveMore) void loadMoreSessions()
            else { setAutoPaused(false); setError(null); setRefreshing(true); void action.run(() => controller.refreshSessions(), { onError: error => { if (live.current) { setError(error.message); setAutoPaused(true) } } }).finally(() => { if (live.current) setRefreshing(false) }) }
          }} size="sm" variant="secondary">Retry</Button></div>}

          <section className="navigation-sessions" onClick={event => {
          if (swipedId && !(event.target as HTMLElement).closest('.session-row')) setSwipedId(null)
        }}>
          <div aria-label="Sessions" className="session-list navigation-session-list" role="region">
            <Button className="navigation-new-session" disabled={!ready || pendingSessionAction} onClick={() => void runSessionAction(() => controller.newSession())} type="button" variant="ghost">
              <IconPlus aria-hidden="true" size={20} /><span>New session</span>
            </Button>
            {list.groups.map(group => <section className="session-group" key={group.id} aria-labelledby={`${helpId}-${group.id}`}><h3 id={`${helpId}-${group.id}`}>{group.label}</h3>{group.sessions.map(session => {
              const revealed = swipedId === session.id
              const active = chat.storedSessionId === session.id
              return (
                <SessionRow
                  active={active}
                  remoteReady={ready}
                  savedAt={!ready ? savedTimes.get(session.id) : undefined}
                  savedPersistently={cached.find(item => item.storedSessionId === session.id)?.persistent}
                  key={session.id}
                  onDelete={title => { setRemove({ id: session.id, title }) }}
                  onOpen={(id, isActive) => {
                    if (isActive) navigate('sessions')
                    else void runSessionAction(() => controller.resumeSession(id), id)
                  }}
                  onReveal={setSwipedId}
                  pending={pendingSessionAction}
                  revealed={revealed}
                  session={session}
                />
              )
            })}</section>)}
            {list.matchCount === 0 && <div className="empty-panel">{refreshing ? 'Loading sessions…' : query.trim() ? ready && sessionsHaveMore ? 'No matching loaded titles. Load more sessions to look further.' : 'No matching loaded titles.' : ready ? 'No conversations loaded.' : 'No conversations saved on this device.'}</div>}
            <Button className="navigation-archives" disabled={pendingSessionAction} onClick={() => onDismissRequest({ type: 'archived-chats' })} variant="ghost"><IconArchive aria-hidden="true" size={18} />Archived chats</Button>
            {ready && sessionsHaveMore && (
              <Button
                className="load-more-sessions"
                disabled={pendingSessionAction}
                aria-disabled={sessionsLoadingMore}
                onClick={() => { loadMoreRef.current?.focus({ preventScroll: true }); void loadMoreSessions() }}
                ref={loadMoreRef}
                size="sm"
                variant="secondary"
              >
                {sessionsLoadingMore ? 'Loading more…' : 'Load more sessions'}
              </Button>
            )}
          </div>
          </section>
        </div>
        <BotWorkspaceNavigation active="sessions" showAutomations={false} onSelect={destination => {
          if (destination === 'sessions' || actionPendingRef.current) return
          onDismissRequest(workspaceMenuIntent(destination))
        }} />
        {remove && <ConfirmDialog disabled={!ready} confirmLabel="Delete" description={`Delete ${remove.title}? This cannot be undone.`} onCancel={() => setRemove(null)} onConfirm={() => { const id = remove.id; setRemove(null); void deleteSession(id) }} title="Delete session" />}
      </main>
    </div>
  )
}
