import { useStore } from '@nanostores/react'
import {
  IconAdjustments,
  IconBolt,
  IconCalendarClock,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Button, Input } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import type { MobileTab } from '~/navigation/routes'
import { currentGatewayScope, isCurrentGatewayScope } from '~/gateway/scope-guard'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'
import { $chat, $sessions } from '~/state/store'

interface SideNavigationDrawerProps {
  activeTab: MobileTab
  controller: GatewayController
  open: boolean
  onClose(): void
  onNavigate(tab: MobileTab): void
}

interface SwipeStart {
  id: string
  x: number
  y: number
}

export const PRIMARY_NAVIGATION = [
  { icon: IconBolt, label: 'Capabilities', tab: 'capabilities' },
  { icon: IconCalendarClock, label: 'Cron Jobs', tab: 'cron' },
  { icon: IconAdjustments, label: 'Settings', tab: 'settings' },
  { icon: IconAdjustments, label: 'Sessions', tab: 'sessions' }
] as const

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function SideNavigationDrawer({ activeTab, controller, open, onClose, onNavigate }: SideNavigationDrawerProps) {
  const chat = useStore($chat)
  const sessions = useStore($sessions)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingSessionAction, setPendingSessionAction] = useState(false)
  const [remove, setRemove] = useState<{ id: string; title: string } | null>(null)
  const [swipedId, setSwipedId] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const swipeStart = useRef<SwipeStart | null>(null)
  const actionPendingRef = useRef(false)
  const refreshGeneration = useRef(0)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? sessions.filter(session => session.title.toLowerCase().includes(needle)) : sessions
  }, [query, sessions])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    searchRef.current?.focus()
    setError(null)
    const generation = ++refreshGeneration.current
    const scope = currentGatewayScope()
    void controller.refreshSessions().catch(caught => {
      if (refreshGeneration.current === generation && isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    })
    return () => {
      ++refreshGeneration.current
      const opener = restoreFocusRef.current
      if (opener?.isConnected) opener.focus()
    }
  }, [controller, open])

  const runSessionAction = async (callback: () => Promise<unknown>) => {
    if (actionPendingRef.current) return
    const scope = currentGatewayScope()
    actionPendingRef.current = true
    setPendingSessionAction(true)
    setError(null)
    try {
      await callback()
      if (!isCurrentGatewayScope(scope)) return
      onNavigate('sessions')
      onClose()
    } catch (caught) {
      if (isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    } finally {
      actionPendingRef.current = false
      setPendingSessionAction(false)
    }
  }

  const deleteSession = async (id: string) => {
    const scope = currentGatewayScope()
    setError(null)
    try {
      await controller.deleteSession(id)
    } catch (caught) {
      if (isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    }
  }

  const requestClose = () => {
    if (!actionPendingRef.current) onClose()
  }

  const navigate = (tab: MobileTab) => {
    if (actionPendingRef.current) return
    onNavigate(tab)
    onClose()
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
    if (event.shiftKey && document.activeElement === first) {
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
      inert={!open}
      onClick={event => { if (event.target === event.currentTarget) requestClose() }}
    >
      <aside
        aria-label="Navigation"
        aria-modal="true"
        className="side-drawer-panel"
        id="side-navigation-drawer"
        onKeyDown={trapFocus}
        ref={panelRef}
        role="dialog"
      >
        <header className="side-drawer-top">
          <strong>Hermes</strong>
          <label className="drawer-search"><IconSearch aria-hidden="true" size={17} /><Input aria-label="Search sessions" onChange={event => setQuery(event.target.value)} placeholder="Search sessions" ref={searchRef} value={query} /></label>
          <Button aria-label="Close navigation" className="drawer-icon-button" disabled={pendingSessionAction} onClick={requestClose} variant="ghost"><IconX size={20} /></Button>
        </header>

        <nav aria-label="Primary navigation" className="drawer-primary-navigation">
          {PRIMARY_NAVIGATION.map(item => (
            <button
              aria-current={activeTab === item.tab ? 'page' : undefined}
              disabled={pendingSessionAction}
              key={item.tab}
              onClick={() => navigate(item.tab)}
            >
              <item.icon size={20} /><span>{item.label}</span>
            </button>
          ))}
        </nav>

        {error && <div className="error-banner drawer-error" role="alert">{error}</div>}

        <section className="drawer-sessions" onClick={event => {
          if (swipedId && !(event.target as HTMLElement).closest('.session-row')) setSwipedId(null)
        }}>
          <header className="drawer-sessions-header">
            <button aria-current={activeTab === 'sessions' ? 'page' : undefined} disabled={pendingSessionAction} onClick={() => navigate('sessions')}>Recent sessions</button>
            <Button aria-label="New session" className="drawer-icon-button" disabled={pendingSessionAction} onClick={() => void runSessionAction(() => controller.newSession())} variant="ghost"><IconPlus size={20} /></Button>
          </header>
          <div className="session-list drawer-session-list">
            {filtered.map(session => {
              const date = new Date(session.started_at * 1_000)
              const revealed = swipedId === session.id
              const active = chat.storedSessionId === session.id
              const title = session.title || 'Untitled session'
              return (
                <article
                  className={`session-row ${revealed ? 'delete-revealed' : ''} ${active ? 'active-session' : ''}`}
                  key={session.id}
                  onTouchEnd={event => {
                    const start = swipeStart.current
                    swipeStart.current = null
                    if (!start || start.id !== session.id) return
                    const touch = event.changedTouches[0]
                    if (!touch) return
                    const dx = touch.clientX - start.x
                    const dy = touch.clientY - start.y
                    if (Math.abs(dx) <= Math.abs(dy)) return
                    if (dx < -50) setSwipedId(session.id)
                    else if (dx > 35 && revealed) setSwipedId(null)
                  }}
                  onTouchStart={event => {
                    if (event.touches.length !== 1) return
                    const touch = event.touches[0]
                    if (touch) swipeStart.current = { id: session.id, x: touch.clientX, y: touch.clientY }
                  }}
                >
                  <div className="session-delete-action">
                    <Button
                      aria-hidden={!revealed}
                      aria-label={`Delete ${title}`}
                      disabled={pendingSessionAction}
                      onClick={() => {
                        setSwipedId(null)
                        setRemove({ id: session.id, title })
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
                    disabled={pendingSessionAction}
                    onClick={() => {
                      if (revealed) return setSwipedId(null)
                      if (active) navigate('sessions')
                      else void runSessionAction(() => controller.resumeSession(session.id))
                    }}
                  >
                    <strong>{title}</strong>
                    <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time>
                  </button>
                </article>
              )
            })}
            {filtered.length === 0 && <div className="empty-panel">No sessions match your search.</div>}
          </div>
        </section>
        {remove && <ConfirmDialog confirmLabel="Delete" description={`Delete ${remove.title}? This cannot be undone.`} onCancel={() => setRemove(null)} onConfirm={() => { const id = remove.id; setRemove(null); void deleteSession(id) }} title="Delete session" />}
      </aside>
    </div>
  )
}
