import { useEffect, useMemo } from 'react'

import { createAgentsApi } from '~/features/agents/agents-api'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'

import type { GroupRoom } from './group-model'
import { $groups } from './groups-store'

/**
 * The desktop-mirrored group chats, from the same unscoped profiles.list RPC
 * the roster uses — react-query dedupes the fetch, so opening a room costs
 * nothing on top of the main screen.
 */
export function useGroupRooms(): GroupRoom[] {
  const api = useApi(createAgentsApi)
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const roster = useScopedQuery(rosterKey, { queryFn: signal => api.list(signal), retry: false })
  const rooms = useMemo(() => roster.data?.groups ?? [], [roster.data])
  useEffect(() => {
    $groups.set(rooms)
  }, [rooms])
  return rooms
}

/**
 * One desktop Bot Mode group chat, rendered from the ui_meta mirror: the
 * room log is display-only (user messages sit right with no caption; member
 * messages sit left, captioned by bot name and, when the speaker lives on
 * another machine, its connection label). The room's per-member turn engine
 * lives in the desktop plugin — Mobile reads the shared log until sending
 * arrives here, so there is no composer yet.
 */
export function GroupChatScreen({ roomId }: { roomId: string }) {
  const rooms = useGroupRooms()
  const room = rooms.find(candidate => candidate.key === roomId)

  if (!room) {
    return (
      <section aria-label="Group chat" className="screen page-screen group-screen">
        <p className="muted" role="status">This group chat is not available on this gateway yet.</p>
      </section>
    )
  }

  return (
    <section aria-label={`Group chat ${room.name}`} className="screen page-screen group-screen">
      <div className="group-log" aria-live="polite">
        {room.members.length > 0 && (
          <p className="muted group-members">{room.members.length} bot{room.members.length === 1 ? '' : 's'} · {room.members.map(member => member.handle ?? member.name).join(', ')}</p>
        )}
        {room.log.map(entry => (
          <article className={`message ${entry.from.kind === 'user' ? 'user' : 'assistant'}`} key={entry.id ?? `${entry.at}-${entry.from.name}`}>
            {entry.from.kind === 'member' && (
              <div className="message-meta">
                <span>{entry.from.name}{entry.from.source ? ` · ${entry.from.source}` : ''}</span>
              </div>
            )}
            <div className="message-content">{entry.text}</div>
          </article>
        ))}
      </div>
      <p className="muted group-send-note">Reading only for now — sending to group chats is not available in Mobile yet.</p>
    </section>
  )
}