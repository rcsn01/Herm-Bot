import { useStore } from '@nanostores/react'
import { IconPlus, IconSearch, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { useSwipeMotion } from '~/gestures/use-swipe-motion'

import { Button, Input } from '~/compat/primitives'
import { BotWorkspaceHeader } from '~/components/bot-workspace-header'
import { BotWorkspaceNavigation } from '~/components/bot-workspace-navigation'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { displayNameFor } from '~/features/agents/agent-labels'
import { humanSessions } from '~/features/sessions/api'
import type { StoredSession } from '~/lib/types'
import type { MobileTab } from '~/navigation/routes'
import type { NavigationPageDismissIntent } from '~/navigation/use-navigation-page-controller'
import { useScopedTask } from '~/gateway/scope-guard'
import { $chat } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $preferences } from '~/state/store'
import { $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'

interface SessionsMenuProps {
  controller: GatewayController
  onDismissRequest(intent?: NavigationPageDismissIntent): void
  open: boolean
}

const EDGE_BACK_WIDTH_PX = 28
const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
const NAVIGATION_CONTROLS = 'button, input, textarea, select, [contenteditable="true"], .session-row'

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
    canStart: (target, event) => {
      if (event && event.clientX <= EDGE_BACK_WIDTH_PX) return false
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

export function SessionsMenu({ controller, onDismissRequest, open }: SessionsMenuProps) {
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
  const filtered = useMemo(() => {
    const visible = humanSessions(sessions)
    const needle = query.trim().toLowerCase()
    return needle ? visible.filter(session => session.title.toLowerCase().includes(needle)) : visible
  }, [query, sessions])
  const loadMoreSessions = useCallback(async () => {
    await action.run(() => controller.loadMoreSessions(), { onError: error => setError(error.message) })
  }, [action, controller])

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
    }, { root: target.closest('.navigation-session-list') })
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
    if (!actionPendingRef.current) onDismissRequest({ type: 'close' })
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
          <label className="search-box sessions-menu-search"><IconSearch aria-hidden="true" size={17} /><Input aria-label="Search sessions" onChange={event => setQuery(event.target.value)} placeholder="Search sessions" value={query} /></label>

          {error && <div className="error-banner navigation-error" role="alert">{error}</div>}

          <section className="navigation-sessions" onClick={event => {
          if (swipedId && !(event.target as HTMLElement).closest('.session-row')) setSwipedId(null)
        }}>
          <div aria-label="Sessions" className="session-list navigation-session-list" role="region">
            <Button className="navigation-new-session" disabled={pendingSessionAction} onClick={() => void runSessionAction(() => controller.newSession())} type="button" variant="ghost">
              <span>New session</span><IconPlus aria-hidden="true" size={20} />
            </Button>
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
        </div>
        <BotWorkspaceNavigation active="sessions" onSelect={destination => {
          if (destination === 'sessions') return
          if (destination === 'model') navigateModel()
          else navigate(destination)
        }} />
        {remove && <ConfirmDialog confirmLabel="Delete" description={`Delete ${remove.title}? This cannot be undone.`} onCancel={() => setRemove(null)} onConfirm={() => { const id = remove.id; setRemove(null); void deleteSession(id) }} title="Delete session" />}
      </main>
    </div>
  )
}
