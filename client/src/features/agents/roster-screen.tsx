import { useStore } from '@nanostores/react'

import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import { $connection } from '~/state/store'

import { createAgentsApi, mergeAgentRoster } from './agents-api'
import { displayNameFor } from './agent-labels'
import { BotFace } from './bot-face'

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
 * agent enters that profile's latest conversation. Roster enrichment comes
 * from the unscoped profiles.list RPC and degrades to bare profile names from
 * /api/status when the gateway has no roster data.
 */
export function RosterScreen({ onOpenAgent, query = '' }: { onOpenAgent(profile: null | string): void; query?: string }) {
  const connection = useStore($connection)
  const api = useApi(createAgentsApi)
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const roster = useScopedQuery(rosterKey, { queryFn: signal => api.list(signal), retry: false })
  const agents = mergeAgentRoster(connection.status?.profiles, roster.data)
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? agents.filter(agent => `${displayNameFor(agent)} ${agent.preview ?? ''}`.toLowerCase().includes(needle))
    : agents

  if (visible.length === 0) {
    return (
      <section aria-label="Bots" className="screen roster-screen">
        <p className="muted" role="status">
          {agents.length > 0
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
      </div>
    </section>
  )
}