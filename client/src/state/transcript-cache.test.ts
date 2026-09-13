import { describe, expect, it } from 'vitest'

import { loadCachedTranscript, saveCachedTranscript } from './transcript-cache'
import type { TranscriptEntry } from '~/transcript/transcript'

const entry = (overrides: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  author: 'user',
  content: 'Hello there',
  id: 'entry-1',
  kind: 'message',
  streaming: false,
  ...overrides
} as TranscriptEntry)

describe('transcript cache', () => {
  it('round-trips the most recent session transcript per profile', () => {
    saveCachedTranscript('work', { entries: [entry()], storedSessionId: 'stored-9' })

    expect(loadCachedTranscript('work')).toEqual({ entries: [entry()], storedSessionId: 'stored-9' })
  })

  it('keeps profiles separate and reports misses as null', () => {
    saveCachedTranscript('work', { entries: [entry()], storedSessionId: 'stored-9' })

    expect(loadCachedTranscript(null)).toBeNull()
    expect(loadCachedTranscript('default')).toBeNull()
  })

  it('neutralizes streaming rows so nothing comes back as an eternal spinner', () => {
    saveCachedTranscript(null, {
      entries: [entry({ id: 'e2', streaming: true }), entry({ id: 'e3' })],
      storedSessionId: 'stored-1'
    })

    const cached = loadCachedTranscript(null)
    expect(cached?.entries.map(entryItem => (entryItem as { streaming?: boolean }).streaming)).toEqual([false, false])
  })

  it('caps the cached transcript at a bounded number of entries', () => {
    const entries = Array.from({ length: 300 }, (_, index) => entry({ id: `e-${index}` }))
    saveCachedTranscript(null, { entries, storedSessionId: 'stored-1' })

    const cached = loadCachedTranscript(null)
    expect(cached?.entries).toHaveLength(80)
    expect(cached?.entries[0].id).toBe('e-220')
  })

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem('hermes.transcript.v1', '{not json')

    expect(loadCachedTranscript(null)).toBeNull()

    saveCachedTranscript(null, { entries: [entry()], storedSessionId: 'stored-2' })
    expect(loadCachedTranscript(null)?.storedSessionId).toBe('stored-2')
  })

  it('overwrites the previous session when a newer one is saved', () => {
    saveCachedTranscript(null, { entries: [entry()], storedSessionId: 'stored-1' })
    saveCachedTranscript(null, { entries: [entry({ id: 'fresh' })], storedSessionId: 'stored-2' })

    expect(loadCachedTranscript(null)).toEqual({ entries: [entry({ id: 'fresh' })], storedSessionId: 'stored-2' })
  })
})