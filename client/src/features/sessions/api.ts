import type { GatewayApi } from '~/gateway/gateway-api'
import type { StoredSession } from '~/lib/types'

/**
 * Sessions a human can continue in the conversation UI. The gateway's
 * `session.list` RPC deny-lists only its noisy internal sources (``tool``
 * sub-agent runs, ``kanban`` dispatcher workers — tui_gateway/methods_session.py)
 * and still returns cron rows, so mirroring the desktop recents split means
 * dropping the automation sources here too: the desktop separates its recents
 * from the cron section with ``exclude_sources=cron`` on GET /api/sessions
 * (web_routers/sessions.py). Deny-listing keeps the drawer stable across
 * gateways that pre-filter differently and leaves unknown/custom
 * `HERMES_SESSION_SOURCE` values visible, like the RPC does.
 */
const AUTOMATION_SOURCES = new Set(['cron', 'kanban', 'tool'])

/**
 * Titles Bot Mode itself mints for its plumbing sessions (ported from
 * apps/desktop/src/plugins/hermes-bots/session-sweep.ts isBotModeSweepTitle):
 * group member sessions are titled `Group: <roomId>` (group-turns.ts
 * ensureGroupChatSession), bot-to-bot CLI handoffs create exactly 'Bot Chat'
 * and 'Agent Inbox'. The desktop's own sweep matches these by exact title or
 * prefix — deliberately title-based, so a user's real conversation keeps
 * whatever title it has and is never filtered.
 */
const BOT_MODE_SWEEP_TITLES = new Set(['Bot Chat', 'Agent Inbox'])

function isBotModePlumbing(session: StoredSession): boolean {
  const title = String(session.title ?? '').trim()
  return BOT_MODE_SWEEP_TITLES.has(title) || title.startsWith('Group: ')
}

export function humanSessions(sessions: StoredSession[]): StoredSession[] {
  return sessions.filter(session =>
    !AUTOMATION_SOURCES.has((session.source ?? '').trim().toLowerCase()) && !isBotModePlumbing(session))
}

export interface SessionsApi {
  /** JSON-RPC session.list — profile in RPC params (RPCs are unscoped by wire, scoped by params). */
  list(limit: number, signal?: AbortSignal): Promise<{ sessions: StoredSession[] }>
  rename(id: string, title: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
  archive(id: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
  restore(id: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
  remove(id: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
}

export function createSessionsApi(api: GatewayApi): SessionsApi {
  return {
    list: (limit, signal) =>
      // include_hidden: the desktop's Bot Mode marks its conversations hidden
      // from global lists (apps/desktop/src/plugins/hermes-bots/canonical-chat.ts
      // — "Always born hidden from the global sidebar"), and the gateway's
      // session.list RPC only returns them to surfaces that own them
      // (tui_gateway/methods_session.py — "the Bots pane's per-profile
      // browser, plugin session pickers", which pass include_hidden). The
      // mobile app is the bot's owner surface: without the flag, every
      // desktop-created conversation is invisible to the recents list and
      // opening a profile always mints a fresh session instead of resuming.
      api.rpc<{ sessions: StoredSession[] }>('session.list', { include_hidden: true, limit, profile: api.profileKey }, { signal }),
    rename: (id, title, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        body: { profile: api.profileKey, title }, method: 'PATCH', signal, timeoutMs
      }).then(() => undefined),
    archive: (id, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        body: { archived: true, profile: api.profileKey }, method: 'PATCH', signal, timeoutMs
      }).then(() => undefined),
    restore: (id, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        body: { archived: false }, method: 'PATCH', signal, timeoutMs
      }).then(() => undefined),
    remove: (id, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE', signal, timeoutMs
      }).then(() => undefined)
  }
}