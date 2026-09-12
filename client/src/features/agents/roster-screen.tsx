import { useStore } from '@nanostores/react'

import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import { $connection } from '~/state/store'

import { createAgentsApi, mergeAgentRoster } from './agents-api'

/** Deterministic avatar hue so every profile keeps the same color across visits. */
function agentHue(name: string): number {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) % 360
  return hash
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
    ? agents.filter(agent => `${agent.title || agent.name} ${agent.preview ?? ''}`.toLowerCase().includes(needle))
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
            <span aria-hidden className="agent-avatar" style={{ background: `oklch(0.62 0.14 ${agentHue(agent.name)})` }}>
              {agent.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="agent-row-main">
              <span className="agent-row-top">
                <strong>{agent.title || agent.name}</strong>
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