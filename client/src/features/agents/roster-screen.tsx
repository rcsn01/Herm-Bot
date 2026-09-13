import { useStore } from '@nanostores/react'

import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import { $connection } from '~/state/store'

import { createAgentsApi, mergeAgentRoster } from './agents-api'
import { displayNameFor } from './agent-labels'
import { BotFace } from './bot-face'

/** The group icon: at most three of the member bots' faces, stacked with a
 *  slight offset — a group reads as the bots in it, not a letter. Faces are
 *  drawn at GROUP_FACE_PX to match the chip (a 52px roster face clipped into
 *  the chip would only show its blank corner). */
const GROUP_FACE_PX = 32

function GroupFaces({ members, name }: { members: { name: string }[]; name: string }) {
  const seated = members.slice(0, 3)
  if (seated.length === 0) return <span className="group-face">{name.slice(0, 1).toUpperCase()}</span>
  return (
    <span className="group-faces">
      {seated.map(member => <span className="group-face" key={member.name}><BotFace name={member.name} size={GROUP_FACE_PX} /></span>)}
    </span>
  )
}

/** Grok-style relative stamp: Today, Yesterday, weekday within a week, else a short date. */
export function relativeDay(seconds: number): string {
  const date = new Date(seconds * 1000)
  const now = new Date()
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'long' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Main screen: the agent roster. One row per gateway profile; tapping an
 * agent enters that profile's latest conversation. Group chats created in
 * the desktop's Bot Mode ride the default profile's ui_meta mirror and list
 * beneath the bots; tapping one opens the room view. Roster enrichment comes
 * from the unscoped profiles.list RPC and degrades to bare profile names from
 * /api/status when the gateway has no roster data.
 */
export function RosterScreen({ onOpenAgent, onOpenGroup, query = '' }: { onOpenAgent(profile: null | string): void; onOpenGroup(roomId: string): void; query?: string }) {
  const connection = useStore($connection)
  const api = useApi(createAgentsApi)
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const roster = useScopedQuery(rosterKey, { queryFn: signal => api.list(signal), retry: false })
  const agents = mergeAgentRoster(connection.status?.profiles, roster.data?.entries)
  const groups = roster.data?.groups ?? []
  const needle = query.trim().toLowerCase()
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle)
  const visible = agents.filter(agent => matches(`${displayNameFor(agent)} ${agent.preview ?? ''}`))
  const visibleGroups = groups.filter(room => matches(room.name))

  if (visible.length === 0 && visibleGroups.length === 0) {
    return (
      <section aria-label="Bots" className="screen roster-screen">
        <p className="muted" role="status">
          {agents.length > 0 || groups.length > 0
            ? 'No bots match this search.'
            : roster.isPending ? 'Loading bots…' : 'No bot profiles exist on this gateway yet.'}
        </p>
      </section>
    )
  }

  return (
    <section aria-label="Bots" className="screen roster-screen">
      <div className="roster-list">
        {visible.map(agent => (
          <button className="agent-row" key={agent.name} onClick={() => onOpenAgent(agent.isDefault ? null : agent.name)}>
            <span aria-hidden className="agent-avatar">
              {agent.avatar ? <img alt="" className="agent-avatar-img" src={agent.avatar} /> : <BotFace name={agent.name} />}
            </span>
            <span className="agent-row-main">
              <span className="agent-row-top">
                <strong>{displayNameFor(agent)}</strong>
                {agent.startedAt !== undefined && <time>{relativeDay(agent.startedAt)}</time>}
              </span>
              {agent.preview && <small>{agent.preview}</small>}
            </span>
          </button>
        ))}
        {visibleGroups.map(room => (
          <button className="agent-row group-row" key={room.key} onClick={() => onOpenGroup(room.key)}>
            <span aria-hidden className="agent-avatar">
              {room.image ? <img alt="" className="agent-avatar-img" src={room.image} /> : <GroupFaces members={room.members} name={room.name} />}
            </span>
            <span className="agent-row-main">
              <span className="agent-row-top">
                <strong>{room.name}</strong>
                <time>{relativeDay(room.log[room.log.length - 1].at / 1000)}</time>
              </span>
              <small>{room.members.length > 0 ? `${room.members.length} bot${room.members.length === 1 ? '' : 's'} · ` : ''}{room.log[room.log.length - 1].from.kind === 'user' ? 'You: ' : `${room.log[room.log.length - 1].from.name}: `}{room.log[room.log.length - 1].text}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}