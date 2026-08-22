import { useStore } from '@nanostores/react'
import { IconArchive, IconGitBranch, IconPencil, IconSearch, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'

import { Badge, Button, Input } from '~/compat/primitives'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'
import { $chat, $sessions, $view } from '~/state/store'

export function SessionsScreen({ controller }: { controller: GatewayController }) {
  const sessions = useStore($sessions)
  const chat = useStore($chat)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? sessions.filter(session => `${session.title} ${session.preview} ${session.id}`.toLowerCase().includes(needle)) : sessions
  }, [query, sessions])

  const action = async (callback: () => Promise<unknown>) => {
    setError(null)
    await callback().catch(caught => setError(errorMessage(caught)))
  }

  return (
    <section className="screen page-screen">
      <header className="page-heading">
        <div><p className="eyebrow">Gateway history</p><h2>Sessions</h2></div>
        <Button onClick={() => void action(() => controller.newSession()).then(() => $view.set('chat'))}>New</Button>
      </header>
      <label className="search-box"><IconSearch size={18} /><Input onChange={event => setQuery(event.target.value)} placeholder="Search sessions" value={query} /></label>
      {error && <div className="error-banner">{error}</div>}
      <div className="session-list">
        {filtered.map(session => (
          <article className="session-row" key={session.id}>
            <button className="session-main" onClick={() => void action(() => controller.resumeSession(session.id)).then(() => $view.set('chat'))}>
              <span><strong>{session.title || 'Untitled session'}</strong>{chat.storedSessionId === session.id && <Badge>Open</Badge>}</span>
              <p>{session.preview || `${session.message_count} messages`}</p>
              <small>{new Date(session.started_at * 1000).toLocaleString()} · {session.source || 'Hermes'}</small>
            </button>
            <div className="session-actions">
              <Button aria-label="Rename" onClick={() => {
                const title = window.prompt('Session title', session.title)
                if (title !== null) void action(() => controller.renameSession(session.id, title))
              }} size="icon-sm" variant="ghost"><IconPencil size={17} /></Button>
              <Button aria-label="Archive" onClick={() => void action(() => controller.archiveSession(session.id))} size="icon-sm" variant="ghost"><IconArchive size={17} /></Button>
              {chat.storedSessionId === session.id && <Button aria-label="Branch" onClick={() => void action(() => controller.branchSession()).then(() => $view.set('chat'))} size="icon-sm" variant="ghost"><IconGitBranch size={17} /></Button>}
              <Button aria-label="Delete" onClick={() => {
                if (window.confirm(`Delete “${session.title || 'Untitled session'}”?`)) void action(() => controller.deleteSession(session.id))
              }} size="icon-sm" variant="ghost"><IconTrash size={17} /></Button>
            </div>
          </article>
        ))}
        {filtered.length === 0 && <div className="empty-panel">No sessions match your search.</div>}
      </div>
    </section>
  )
}
