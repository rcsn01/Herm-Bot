import type { StoredSession } from '~/lib/types'

export type DiscoverySession = Omit<StoredSession, 'started_at' | 'message_count'> & {
  started_at: number | null
  message_count: number | null
}

export function sessionTitle(session: { title?: string }): string {
  return typeof session.title === 'string' && session.title.trim() ? session.title : 'Untitled session'
}

export function sessionDate(seconds: unknown): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date : null
}

export function sessionPreview(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function sessionCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Presentation only. Never changes the gateway roster or fetches transcript bodies. */
export function buildSessionList<T extends DiscoverySession>(sessions: T[], query: string, now: Date) {
  const needle = query.trim().toLowerCase()
  const rows = sessions.filter(row => sessionTitle(row).toLowerCase().includes(needle)).sort((a, b) => {
    const byDate = (sessionDate(b.started_at)?.getTime() ?? -Infinity) - (sessionDate(a.started_at)?.getTime() ?? -Infinity)
    return (Number.isNaN(byDate) ? 0 : byDate) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const groups = new Map<string, { id: string; label: string; sessions: T[] }>()
  for (const row of rows) {
    const date = sessionDate(row.started_at)
    let id: string, label: string
    if (!date) { id = 'unknown'; label = 'Date unavailable' }
    else if (date >= tomorrow) { id = 'future'; label = 'Future dates' }
    else if (date >= today) { id = 'today'; label = 'Today' }
    else if (date >= yesterday) { id = 'yesterday'; label = 'Yesterday' }
    else {
      id = `month-${date.getFullYear()}-${date.getMonth()}`
      label = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
        ? 'Earlier this month' : date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    }
    if (!groups.has(id)) groups.set(id, { id, label, sessions: [] })
    groups.get(id)!.sessions.push(row)
  }
  return { groups: [...groups.values()], loadedCount: sessions.length, matchCount: rows.length }
}
