import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconTrash } from '@tabler/icons-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button, Input } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { SettingsPageShell } from '~/features/settings/settings-page-shell'
import { useApi } from '~/gateway/gateway-api-hooks'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { beginScopedTask, useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import { $chat } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $gatewayReady, $sessionSelecting, requireGatewayReady } from '~/state/store'
import { ARCHIVED_SESSION_LIMIT, createSessionsApi, type ArchivedSession } from './api'
import { sessionCount, sessionPreview, sessionTitle } from './session-discovery'
import { useDiscoveryIdentity } from './use-discovery-identity'

interface Props { controller: GatewayController; onBack(): void; onOpened(): void }
export function ArchivedChatsScreen(props: Props) {
  const identity = useDiscoveryIdentity()
  const ready = useStore($gatewayReady)
  if (!ready) return <SettingsPageShell leading={<Button onClick={props.onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title="Archived chats"><p role="status">Archived chats are not saved on this device. Reconnect to list, restore, open, or delete archived chats.</p></SettingsPageShell>
  return <ArchiveContent key={identity} identity={identity} {...props} />
}

function ArchiveContent({ controller, onBack, onOpened, identity }: Props & { identity: string }) {
  const api = useApi(createSessionsApi)
  const queryClient = useQueryClient()
  const key = useScopeKey('sessions', ['archived', identity])
  const sessions = useScopedQuery(key, { queryFn: signal => api.listArchived(signal), retry: false, staleTime: 0 })
  const selecting = useStore($sessionSelecting)
  const [query, setQuery] = useState('')
  const [remove, setRemove] = useState<ArchivedSession | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retryOpen, setRetryOpen] = useState<ArchivedSession | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  const search = useRef<HTMLInputElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (focused.current && !focused.current.isConnected && document.activeElement === document.body) search.current?.focus({ preventScroll: true })
  })

  const run = async (operation: 'restore' | 'restore-open' | 'open' | 'delete', row: ArchivedSession) => {
    if (pending.current || selecting) return
    pending.current = true
    setBusy(row.id)
    setError(null)
    setFeedback('')
    focused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const task = beginScopedTask()
    const current = () => mounted.current && task.isCurrent()
    const previous = $chat.get()
    const selectionUnchanged = () => !$sessionSelecting.get() && $chat.get().storedSessionId === previous.storedSessionId && $chat.get().runtimeSessionId === previous.runtimeSessionId
    let restored = operation === 'open'
    try {
      requireGatewayReady()
      if (operation === 'delete') await api.remove(row.id)
      else if (!restored) { await api.restore(row.id); restored = true }
      // A completed remote mutation invalidates its captured cache even if the
      // page closed. Never publish feedback or navigate from that retired page.
      if (operation !== 'open' && task.isCurrent()) void queryClient.invalidateQueries({ queryKey: key })
      if (!current()) return
      if (operation === 'restore-open') setRetryOpen(row)
      if (operation !== 'open') {
        let warning = ''
        try { await controller.refreshSessions(task.scope) }
        catch { warning = ' The conversation list could not refresh. Reopen the sessions menu to retry.' }
        if (!current()) return
        setFeedback(`${operation === 'delete' ? 'Deleted.' : 'Restored.'}${warning}`)
      }
      if (operation === 'restore-open' || operation === 'open') {
        if (!selectionUnchanged()) { setFeedback('Restored. Another selection took precedence. Choose Open restored chat to try again.'); return }
        requireGatewayReady()
        const outcome = await controller.resumeSession(row.id)
        if (!current()) return
        if ($sessionSelecting.get() || outcome?.session?.storedSessionId !== row.id || $chat.get().storedSessionId !== row.id) {
          setFeedback('Restored. Opening was superseded. Choose Open restored chat to try again.')
          return
        }
        onOpened()
      }
    } catch (caught) {
      if (current()) setError(`${restored && operation !== 'restore' ? 'Restored, but could not open. ' : ''}${classifyGatewayError(caught).message}`)
    } finally {
      pending.current = false
      if (current()) setBusy(null)
    }
  }

  const rows = sessions.data?.sessions ?? []
  const needle = query.trim().toLowerCase()
  const filtered = rows.filter(row => sessionTitle(row).toLowerCase().includes(needle))
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle={`Only loaded archived titles for this bot are searched. This request returns up to ${ARCHIVED_SESSION_LIMIT} chats, not a verified complete archive.`} title="Archived chats">
    <div className="archive-browser">
      <Input aria-label="Search loaded archived titles" placeholder="Search loaded archived titles" ref={search} value={query} onChange={event => setQuery(event.target.value)} />
      <p className="session-search-summary" role="status" aria-atomic="true">{sessions.isPending ? 'Loading archived chats…' : sessions.error && !sessions.data ? 'Archived chats unavailable.' : `${filtered.length} matches in ${rows.length} loaded archived chats`}</p>
      {rows.length >= ARCHIVED_SESSION_LIMIT && <p>This response reached the {ARCHIVED_SESSION_LIMIT}-chat limit. Older archived chats may not be included.</p>}
      {feedback && <p role="status" aria-atomic="true">{feedback}</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {sessions.error && <><GatewayErrorBanner error={sessions.error} /><Button onClick={() => void sessions.refetch()} disabled={sessions.isFetching} variant="secondary">Retry archived chats</Button></>}
      {retryOpen && <div className="archive-open-retry"><p>Restored: {sessionTitle(retryOpen)}</p><Button aria-disabled={busy !== null || selecting} onClick={() => void run('open', retryOpen)}>Open restored chat</Button></div>}
      <div className="settings-list static">
        {filtered.map(row => <div className="archive-row" key={row.id}>
          <span><strong>{sessionTitle(row)}</strong>{sessionPreview(row.preview) && <span className="session-preview">{sessionPreview(row.preview)}</span>}{sessionCount(row.message_count) !== null && <small>{sessionCount(row.message_count)} messages</small>}</span>
          <div className="button-row">
            <Button aria-label={`Restore ${sessionTitle(row)}`} aria-disabled={busy !== null || selecting} onClick={() => void run('restore', row)} size="sm" variant="secondary">Restore</Button>
            <Button aria-label={`Restore and open ${sessionTitle(row)}`} aria-disabled={busy !== null || selecting} onClick={() => void run('restore-open', row)} size="sm">Restore and open</Button>
            <Button aria-label={`Delete archived ${sessionTitle(row)}`} aria-disabled={busy !== null || selecting} onClick={() => { if (!pending.current && !selecting) setRemove(row) }} size="icon" variant="destructive"><IconTrash aria-hidden="true" size={16} /></Button>
          </div>
          {busy === row.id && <small role="status">Updating chat…</small>}
        </div>)}
      </div>
      {sessions.data && !sessions.error && filtered.length === 0 && <p className="empty-panel">{needle ? 'No matching loaded archived titles.' : 'No archived chats in this response.'}</p>}
      {remove && <ConfirmDialog confirmLabel="Delete permanently" description={`Permanently delete ${sessionTitle(remove)}? This cannot be undone.`} onCancel={() => setRemove(null)} onConfirm={() => { const row = remove; setRemove(null); void run('delete', row) }} title="Delete archived chat" />}
    </div>
  </SettingsPageShell>
}
