import { useStore } from '@nanostores/react'
import { IconSearch, IconTrash } from '@tabler/icons-react'
import { useMemo, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'
import { $sessions } from '~/state/store'

interface SwipeStart {
  id: string
  x: number
  y: number
}

export function SessionsScreen({ controller, onOpenChat }: { controller: GatewayController; onOpenChat(): void }) {
  const sessions = useStore($sessions)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [remove, setRemove] = useState<{ id: string; title: string } | null>(null)
  const [swipedId, setSwipedId] = useState<string | null>(null)
  const swipeStart = useRef<SwipeStart | null>(null)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? sessions.filter(session => session.title.toLowerCase().includes(needle)) : sessions
  }, [query, sessions])

  const action = async (callback: () => Promise<unknown>) => {
    setError(null)
    await callback().catch(caught => setError(errorMessage(caught)))
  }

  return (
    <section className="screen page-screen" onClick={event => {
      if (swipedId && !(event.target as HTMLElement).closest('.session-row')) setSwipedId(null)
    }}>
      <header className="page-heading">
        <div><p className="eyebrow">Gateway history</p><h2>Sessions</h2></div>
        <Button onClick={() => void action(() => controller.newSession()).then(onOpenChat)}>New</Button>
      </header>
      <label className="search-box"><IconSearch size={18} /><Input onChange={event => setQuery(event.target.value)} placeholder="Search sessions" value={query} /></label>
      {error && <div className="error-banner">{error}</div>}
      <div className="session-list">
        {filtered.map(session => {
          const date = new Date(session.started_at * 1_000)
          const revealed = swipedId === session.id
          return (
            <article
              className={`session-row ${revealed ? 'delete-revealed' : ''}`}
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
                const touch = event.touches[0]
                if (touch) swipeStart.current = { id: session.id, x: touch.clientX, y: touch.clientY }
              }}
            >
              <div className="session-delete-action">
                <Button
                  aria-hidden={!revealed}
                  aria-label={`Delete ${session.title || 'Untitled session'}`}
                  onClick={() => {
                    setSwipedId(null)
                    setRemove({ id: session.id, title: session.title || 'Untitled session' })
                  }}
                  tabIndex={revealed ? 0 : -1}
                  variant="destructive"
                >
                  <IconTrash size={18} /> Delete
                </Button>
              </div>
              <button
                className="session-main"
                onClick={() => {
                  if (revealed) return setSwipedId(null)
                  void action(() => controller.resumeSession(session.id)).then(onOpenChat)
                }}
              >
                <strong>{session.title || 'Untitled session'}</strong>
                <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time>
              </button>
            </article>
          )
        })}
        {filtered.length === 0 && <div className="empty-panel">No sessions match your search.</div>}
      </div>
      {remove && <ConfirmDialog confirmLabel="Delete" description={`Delete ${remove.title}? This cannot be undone.`} onCancel={() => setRemove(null)} onConfirm={() => { const id = remove.id; setRemove(null); void action(() => controller.deleteSession(id)) }} title="Delete session" />}
    </section>
  )
}
