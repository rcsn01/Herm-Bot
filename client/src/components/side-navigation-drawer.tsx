import { useStore } from '@nanostores/react'
import {
  IconBolt,
  IconCalendarClock,
  IconPlus,
  IconRobot,
  IconSearch,
  IconTrash
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { useSwipeMotion } from '~/gestures/use-swipe-motion'

import { Button, Input } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { displayNameFor } from '~/features/agents/agent-labels'
import { humanSessions } from '~/features/sessions/api'
import type { StoredSession } from '~/lib/types'
import type { MobileTab } from '~/navigation/routes'
import type { DrawerDismissIntent, DrawerDismissRequest } from '~/navigation/use-drawer-controller'
import { useScopedTask } from '~/gateway/scope-guard'
import { $chat } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $preferences } from '~/state/store'
import { $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'

interface SideNavigationDrawerProps {
  activeTab: MobileTab
  controller: GatewayController
  dismissRequest: DrawerDismissRequest | null
  onDismissRequest(intent?: DrawerDismissIntent): void
  onDismissed(): void
  onEdgeOpen?(): void
  open: boolean
}

function gestureOwnedByControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('.session-row')) || Boolean(target.closest('button, input, textarea, select, [contenteditable="true"]'))
}

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

interface SessionRowProps {
  active: boolean
  onDelete(title: string): void
  onReveal(id: string | null): void
  onOpen(id: string, active: boolean): void
  pending: boolean
  revealed: boolean
  session: StoredSession
}

function SessionRow({ active, onDelete, onOpen, onReveal, pending, revealed, session }: SessionRowProps) {
  const date = new Date(session.started_at * 1_000)
  const title = session.title || 'Untitled session'
  const motion = useSwipeMotion({
    canStart: target => {
      if (!(target instanceof HTMLElement)) return true
      if (target.closest('.session-delete-action')) return false
      return true
    },
    direction: 'left',
    enabled: !pending,
    extentPx: () => 104,
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
          disabled={pending}
          onClick={() => {
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
        disabled={pending}
        onClick={() => {
          if (revealed) return onReveal(null)
          onOpen(session.id, active)
        }}
      >
        <strong>{title}</strong>
        <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time>
      </button>
    </article>
  )
}

export function SideNavigationDrawer({ activeTab, controller, dismissRequest, onDismissRequest, onDismissed, onEdgeOpen, open }: SideNavigationDrawerProps) {
  const chat = useStore($chat)
  const preferences = useStore($preferences)
  const sessions = useStore($sessions)
  const sessionsHaveMore = useStore($sessionsHasMore)
  const sessionsLoadingMore = useStore($sessionsLoadingMore)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingSessionAction, setPendingSessionAction] = useState(false)
  const [remove, setRemove] = useState<{ id: string; title: string } | null>(null)
  const [swipedId, setSwipedId] = useState<string | null>(null)
  const loadMoreRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const actionPendingRef = useRef(false)
  const handledDismissRef = useRef<number | null>(null)
  const previousOpenRef = useRef(open)
  const refreshGeneration = useRef(0)
  const action = useScopedTask()
  const filtered = useMemo(() => {
    const visible = humanSessions(sessions)
    const needle = query.trim().toLowerCase()
    return needle ? visible.filter(session => session.title.toLowerCase().includes(needle)) : visible
  }, [query, sessions])
  const drawerMotion = useSwipeMotion({
    canStart: target => {
      if (!open) return target instanceof HTMLElement && Boolean(target.closest('[data-drawer-edge]'))
      return !gestureOwnedByControl(target)
    },
    direction: 'right',
    enabled: open || Boolean(onEdgeOpen),
    extentPx: () => panelRef.current?.getBoundingClientRect().width || panelRef.current?.clientWidth || window.innerWidth,
    initialProgress: open ? 0 : 1,
    onCommit: endpoint => {
      if (open && endpoint === 1) onDismissed()
      else if (!open && endpoint === 0) onEdgeOpen?.()
    },
    restingEndpoint: open ? 0 : 1
  })
  const loadMoreSessions = useCallback(async () => {
    await action.run(() => controller.loadMoreSessions(), { onError: error => setError(error.message) })
  }, [action, controller])

  useEffect(() => {
    if (open && !previousOpenRef.current) drawerMotion.animateTo(0)
    if (!open && previousOpenRef.current) drawerMotion.setProgress(1)
    previousOpenRef.current = open
  }, [drawerMotion.animateTo, drawerMotion.setProgress, open])

  useEffect(() => {
    if (!open || !dismissRequest || handledDismissRef.current === dismissRequest.id) return
    handledDismissRef.current = dismissRequest.id
    drawerMotion.animateTo(1, { onSettled: onDismissed })
  }, [dismissRequest, drawerMotion.animateTo, onDismissed, open])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus({ preventScroll: true })
    setError(null)
    const generation = ++refreshGeneration.current
    void action.run(async () => { await controller.refreshSessions() }, {
      onError: error => { if (refreshGeneration.current === generation) setError(error.message) }
    })
    return () => {
      ++refreshGeneration.current
      const opener = restoreFocusRef.current
      if (opener?.isConnected) opener.focus()
    }
  }, [action, controller, open])

  useEffect(() => {
    const target = loadMoreRef.current
    if (!open || !target || !sessionsHaveMore || sessionsLoadingMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMoreSessions()
    }, { root: target.closest('.drawer-session-list') })
    observer.observe(target)
    return () => observer.disconnect()
  }, [loadMoreSessions, open, sessionsHaveMore, sessionsLoadingMore])

  const runSessionAction = async (callback: () => Promise<unknown>) => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    setPendingSessionAction(true)
    await action.run(async task => {
      setError(null)
      await callback()
      if (!task.isCurrent()) return
      onDismissRequest({ type: 'tab', tab: 'sessions' })
    }, { onError: error => setError(error.message) })
    // The pending latch is unconditional cleanup: it must reset even when the
    // scope went stale mid-action, exactly as the previous unguarded finally did.
    actionPendingRef.current = false
    setPendingSessionAction(false)
  }

  const deleteSession = async (id: string) => {
    await action.run(async () => {
      setError(null)
      await controller.deleteSession(id)
    }, { onError: error => setError(error.message) })
  }

  const requestClose = () => {
    if (!actionPendingRef.current) onDismissRequest()
  }

  const navigate = (tab: MobileTab) => {
    if (actionPendingRef.current) return
    onDismissRequest({ type: 'tab', tab })
  }

  const navigateModel = () => {
    if (actionPendingRef.current) return
    onDismissRequest({ type: 'model' })
  }

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
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
      className={`side-drawer-backdrop ${open ? 'open' : ''}`}
      data-testid="side-navigation-backdrop"
      inert={!open && !onEdgeOpen ? true : undefined}
      onClick={event => { if (event.target === event.currentTarget) requestClose() }}
      ref={drawerMotion.ref}
      {...drawerMotion.bind}
    >
      {!open && onEdgeOpen && <div aria-hidden className="drawer-edge-open" data-drawer-edge />}
      <aside
        aria-label="Navigation"
        aria-modal="true"
        className="side-drawer-panel"
        id="side-navigation-drawer"
        onKeyDown={trapFocus}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="side-drawer-top">
          <button aria-label="Open bot chat" className="drawer-identity" onClick={() => navigate('sessions')}>
            <strong>{displayNameFor({ name: preferences.profile || 'default' })}</strong>
          </button>
          <label className="drawer-search"><IconSearch aria-hidden="true" size={17} /><Input aria-label="Search sessions" onChange={event => setQuery(event.target.value)} placeholder="Search sessions" value={query} /></label>
          <nav aria-label="Bot sections" className="drawer-sections">
            <button aria-current={activeTab === 'capabilities' ? 'page' : undefined} onClick={() => navigate('capabilities')}><IconBolt aria-hidden="true" size={17} />Capabilities</button>
            <button aria-current={activeTab === 'cron' ? 'page' : undefined} onClick={() => navigate('cron')}><IconCalendarClock aria-hidden="true" size={17} />Cron Jobs</button>
            <button onClick={navigateModel}><IconRobot aria-hidden="true" size={17} />Model</button>
          </nav>
        </header>

        {error && <div className="error-banner drawer-error" role="alert">{error}</div>}

        <section className="drawer-sessions" onClick={event => {
          if (swipedId && !(event.target as HTMLElement).closest('.session-row')) setSwipedId(null)
        }}>
          <header className="drawer-sessions-header">
            <button aria-current={activeTab === 'sessions' ? 'page' : undefined} disabled={pendingSessionAction} onClick={() => navigate('sessions')}>Recent sessions</button>
            <Button aria-label="New session" className="drawer-icon-button" disabled={pendingSessionAction} onClick={() => void runSessionAction(() => controller.newSession())} variant="ghost"><IconPlus size={20} /></Button>
          </header>
          <div aria-label="Sessions" className="session-list drawer-session-list" role="region">
            {filtered.map(session => {
              const revealed = swipedId === session.id
              const active = chat.storedSessionId === session.id
              return (
                <SessionRow
                  active={active}
                  key={session.id}
                  onDelete={title => { setRemove({ id: session.id, title }) }}
                  onOpen={(id, isActive) => {
                    if (isActive) navigate('sessions')
                    else void runSessionAction(() => controller.resumeSession(id))
                  }}
                  onReveal={setSwipedId}
                  pending={pendingSessionAction}
                  revealed={revealed}
                  session={session}
                />
              )
            })}
            {filtered.length === 0 && <div className="empty-panel">No sessions match your search.</div>}
            {sessionsHaveMore && (
              <Button
                className="load-more-sessions"
                disabled={pendingSessionAction || sessionsLoadingMore}
                onClick={() => void loadMoreSessions()}
                ref={loadMoreRef}
                size="sm"
                variant="secondary"
              >
                {sessionsLoadingMore ? 'Loading more…' : 'Load more sessions'}
              </Button>
            )}
          </div>
        </section>
        {remove && <ConfirmDialog confirmLabel="Delete" description={`Delete ${remove.title}? This cannot be undone.`} onCancel={() => setRemove(null)} onConfirm={() => { const id = remove.id; setRemove(null); void deleteSession(id) }} title="Delete session" />}
      </aside>
    </div>
  )
}
