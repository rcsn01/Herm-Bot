import { useStore } from '@nanostores/react'
import { IconArchive, IconGitBranch, IconPencil, IconSearch, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'

import { Badge, Button, Input } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'
import { $chat, $sessions } from '~/state/store'

export function SessionsScreen({ controller, onOpenChat }: { controller: GatewayController; onOpenChat(): void }) {
  const sessions = useStore($sessions)
  const chat = useStore($chat)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null)
  const [remove, setRemove] = useState<{ id: string; title: string } | null>(null)
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
        <Button onClick={() => void action(() => controller.newSession()).then(onOpenChat)}>New</Button>
      </header>
      <label className="search-box"><IconSearch size={18} /><Input onChange={event => setQuery(event.target.value)} placeholder="Search sessions" value={query} /></label>
      {error && <div className="error-banner">{error}</div>}
      <div className="session-list">
        {filtered.map(session => (
          <article className="session-row" key={session.id}>
            <button className="session-main" onClick={() => void action(() => controller.resumeSession(session.id)).then(onOpenChat)}>
              <span><strong>{session.title || 'Untitled session'}</strong>{chat.storedSessionId === session.id && <Badge>Open</Badge>}</span>
              <p>{session.preview || `${session.message_count} messages`}</p>
              <small>{new Date(session.started_at * 1000).toLocaleString()} · {session.source || 'Hermes'}</small>
            </button>
            <div className="session-actions">
              <Button aria-label="Rename" onClick={() => setRename({ id: session.id, title: session.title })} size="icon-sm" variant="ghost"><IconPencil size={17} /></Button>
              <Button aria-label="Archive" onClick={() => void action(() => controller.archiveSession(session.id))} size="icon-sm" variant="ghost"><IconArchive size={17} /></Button>
              {chat.storedSessionId === session.id && <Button aria-label="Branch" onClick={() => void action(() => controller.branchSession()).then(onOpenChat)} size="icon-sm" variant="ghost"><IconGitBranch size={17} /></Button>}
              <Button aria-label="Delete" onClick={() => setRemove({ id: session.id, title: session.title || 'Untitled session' })} size="icon-sm" variant="ghost"><IconTrash size={17} /></Button>
            </div>
          </article>
        ))}
        {filtered.length === 0 && <div className="empty-panel">No sessions match your search.</div>}
      </div>
      {rename && <TextDialog initialValue={rename.title} label="Session title" onCancel={() => setRename(null)} onSubmit={title => { const id = rename.id; setRename(null); void action(() => controller.renameSession(id, title)) }} title="Rename session" />}
      {remove && <ConfirmDialog confirmLabel="Delete" description={`Delete ${remove.title}? This cannot be undone.`} onCancel={() => setRemove(null)} onConfirm={() => { const id = remove.id; setRemove(null); void action(() => controller.deleteSession(id)) }} title="Delete session" />}
    </section>
  )
}
