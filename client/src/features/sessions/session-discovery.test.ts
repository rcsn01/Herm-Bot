import { describe, expect, it } from 'vitest'
import { buildSessionList, sessionCount, sessionDate, sessionPreview, sessionTitle, type DiscoverySession } from './session-discovery'

const row = (id: string, date: Date | null, title = id): DiscoverySession => ({ id, title, started_at: date ? date.getTime() / 1000 : null, preview: 'A preview, not searchable', message_count: 3, source: 'mobile' })

describe('session discovery presentation', () => {
  it('searches normalized displayed titles, never previews, and leaves input order untouched', () => {
    const rows = [row('b', new Date(2026, 6, 1), 'Release NOTES'), row('a', new Date(2026, 6, 2), '')]
    const result = buildSessionList(rows, '  nOtEs ', new Date(2026, 6, 3))
    expect(result.loadedCount).toBe(2)
    expect(result.matchCount).toBe(1)
    expect(result.groups.flatMap(group => group.sessions.map(row => row.id))).toEqual(['b'])
    expect(buildSessionList(rows, 'preview', new Date()).matchCount).toBe(0)
    expect(buildSessionList(rows, 'untitled', new Date()).matchCount).toBe(1)
    expect(rows.map(row => row.id)).toEqual(['b', 'a'])
  })

  it('groups local dates, with stable IDs, newest-first ordering and ID ties', () => {
    const now = new Date(2026, 6, 3, 12)
    const rows = [row('z', new Date(2026, 6, 3, 9)), row('unknown', null), row('old', new Date(2025, 11, 31)), row('yesterday', new Date(2026, 6, 2, 23)), row('earlier', new Date(2026, 6, 1)), row('future', new Date(2026, 6, 4)), row('a', new Date(2026, 6, 3, 9))]
    const result = buildSessionList(rows, '', now)
    expect(result.groups.map(group => group.id)).toEqual(['future', 'today', 'yesterday', 'month-2026-6', 'month-2025-11', 'unknown'])
    expect(result.groups.map(group => group.label)).toContain('Earlier this month')
    expect(result.groups[1].sessions.map(row => row.id)).toEqual(['a', 'z'])
    expect(buildSessionList(rows, 'absent', now).groups).toEqual([])
  })

  it.each([new Date(2026, 2, 9, 0, 15), new Date(2026, 10, 2, 0, 15), new Date(2026, 0, 1, 0, 15)])('uses yesterday across DST and year/month boundaries: %s', now => {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 10)
    expect(buildSessionList([row('previous', yesterday)], '', now).groups[0].label).toBe('Yesterday')
  })

  it('changes grouping at local midnight, without inventing a start date', () => {
    const rows = [row('late', new Date(2026, 6, 3, 23, 50)), row('saved', null)]
    expect(buildSessionList(rows, '', new Date(2026, 6, 3, 23, 59)).groups[0].label).toBe('Today')
    expect(buildSessionList(rows, '', new Date(2026, 6, 4, 0, 1)).groups[0].label).toBe('Yesterday')
    expect(buildSessionList(rows, '', new Date(2026, 6, 4)).groups[1].label).toBe('Date unavailable')
  })

  it.each([null, undefined, NaN, Infinity, -1, '1700000000', 1e20])('rejects invalid external date %s', value => {
    expect(sessionDate(value)).toBeNull()
  })

  it('treats preview text literally and only accepts meaningful optional metadata', () => {
    expect(sessionPreview('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
    expect(sessionPreview({})).toBe('')
    expect(sessionCount(0)).toBe(0)
    expect(sessionCount(2)).toBe(2)
    for (const value of [undefined, -1, 1.5, Infinity, '3']) expect(sessionCount(value)).toBeNull()
    expect(sessionTitle({ title: '  ' })).toBe('Untitled session')
  })
})
