import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import { $connection } from '~/state/store'

import { $groupChats } from '~/features/groups/group-store'
import { groupChatRoomKey } from '~/features/groups/groups-sync'
import { $groups } from '~/features/groups/groups-store'

import { createAgentsApi, mergeAgentRoster, type AgentRosterEntry } from './agents-api'
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
export function RosterScreen({ onManageAgent, onOpenAgent, onOpenGroup, query = '' }: { onManageAgent?(agent: AgentRosterEntry): void; onOpenAgent(profile: null | string): void; onOpenGroup(roomId: string): void; query?: string }) {
  const connection = useStore($connection)
  const api = useApi(createAgentsApi)
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const roster = useScopedQuery(rosterKey, { queryFn: signal => api.list(signal), retry: false })
  const statusProfiles = roster.data?.inventoryKnown
    ? (connection.status?.profiles ?? []).filter(profile => {
        const name = typeof profile === 'string' ? profile : profile.name
        return roster.data?.entries.some(entry => entry.name === name)
      })
    : connection.status?.profiles
  const agents = mergeAgentRoster(statusProfiles, roster.data?.entries)
  const localGroups = useStore($groups)
  const localRooms = useStore($groupChats)
  const groups = useMemo(() => {
    const merged = new Map((roster.data?.groups ?? []).map(group => [group.key, group]))
    for (const room of Object.values(localRooms)) {
      if (room.log.length === 0 && (!room.roomId || room.members.length === 0)) continue
      const key = groupChatRoomKey(room.name, room)
      if (!merged.has(key)) {
        merged.set(key, {
          key,
          ...(room.image ? { image: room.image } : {}),
          log: room.log,
          members: room.members,
          name: room.name,
          ...(room.roomId ? { roomId: room.roomId } : {})
        })
      }
    }
    for (const group of localGroups) {
      if (!merged.has(group.key)) merged.set(group.key, group)
    }
    return [...merged.values()]
  }, [localGroups, localRooms, roster.data])
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
          <div className="agent-row-wrap" key={agent.name}>
            <button className="agent-row" onClick={() => onOpenAgent(agent.isDefault ? null : agent.name)}>
              <span aria-hidden className="agent-avatar">
                {agent.meta?.image ?? agent.avatar
                  ? <img alt="" className="agent-avatar-img" src={agent.meta?.image ?? agent.avatar} />
                  : <BotFace color={agent.meta?.color} name={agent.name} shape={agent.meta?.shape} />}
              </span>
              <span className="agent-row-main">
                <span className="agent-row-top">
                  <strong>{displayNameFor(agent)}</strong>
                  {agent.startedAt !== undefined && <time>{relativeDay(agent.startedAt)}</time>}
                </span>
                {agent.preview && <small>{agent.preview}</small>}
              </span>
            </button>
            {onManageAgent && <button aria-label="Profile menu" className="agent-row-actions" data-profile-name={agent.name} onClick={() => onManageAgent(agent)} title={`Manage ${displayNameFor(agent)}`} type="button"><span aria-hidden>⋯</span></button>}
          </div>
        ))}
        {visibleGroups.map(room => {
          const latest = room.log.at(-1)
          const preview = latest
            ? `${latest.from.kind === 'user' ? 'You: ' : `${latest.from.name}: `}${latest.text}`
            : 'No messages yet'
          return (
            <button className="agent-row group-row" key={room.key} onClick={() => onOpenGroup(room.key)}>
              <span aria-hidden className="agent-avatar">
                {room.image ? <img alt="" className="agent-avatar-img" src={room.image} /> : <GroupFaces members={room.members} name={room.name} />}
              </span>
              <span className="agent-row-main">
                <span className="agent-row-top">
                  <strong>{room.name}</strong>
                  {latest && <time>{relativeDay(latest.at / 1000)}</time>}
                </span>
                <small>{room.members.length > 0 ? `${room.members.length} bot${room.members.length === 1 ? '' : 's'} · ` : ''}{preview}</small>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}