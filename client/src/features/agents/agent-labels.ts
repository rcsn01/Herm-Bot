import type { AgentRosterEntry } from './agents-api'

/**
 * The identity every bot surface reads — ported from hermes-agent
 * apps/desktop/src/plugins/hermes-bots/labels.ts (displayName): the roster,
 * the drawer and chat surfaces all render the same label. Desktop branches
 * that need local bot-meta (the Bot Mode title) or alias routing can't apply
 * here; the PWA sees only the profiles.list row.
 */
export function displayNameFor(agent: { displayName?: string; name: string; title?: string }): string {
  // Core-profile display name (profile.yaml, set via `hermes profile rename
  // <name>` or the dashboard) — rides the profiles.list row; presentation-only.
  if (typeof agent.displayName === 'string' && agent.displayName.trim()) {
    return agent.displayName.trim()
  }

  // The primary profile is literally named "default" — as a bot identity
  // that reads like nobody bothered. Present it as Hermes (the agent it is)
  // unless the user gives it a real title.
  if (agent.name.trim().toLowerCase() === 'default' && !agent.title) {
    return 'Hermes'
  }

  const raw = (agent.title || agent.name || '').replace(/[-_]+/g, ' ').trim()

  return raw.replace(/\b\w/g, ch => ch.toUpperCase())
}