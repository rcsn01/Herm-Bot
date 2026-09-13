import type { TranscriptEntry } from '~/transcript/transcript'

const STORAGE_KEY = 'hermes.transcript.v1'
const MAX_ENTRIES = 80

export interface CachedTranscript {
  entries: TranscriptEntry[]
  storedSessionId: string
}

interface TranscriptCacheShape {
  [profileKey: string]: CachedTranscript
}

const profileKeyOf = (profile: null | string) => profile ?? 'default'

/** Freeze in-flight rows: a cached streaming bubble must not come back as an
 *  eternal "typing" row; the next reconcile replaces the page wholesale. */
const durableEntries = (entries: readonly TranscriptEntry[]): TranscriptEntry[] =>
  entries
    .filter(entry => typeof entry?.id === 'string' && typeof entry?.content === 'string')
    .map(entry => ({ ...entry, streaming: false }))
    .slice(-MAX_ENTRIES)

/**
 * The PWA's local memory of the most recent session's history, per profile.
 * Rendering it before the gateway answers makes opening a bot feel instant;
 * the next reconcile replaces it with the authoritative page.
 */
export function loadCachedTranscript(profile: null | string): CachedTranscript | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const cache = JSON.parse(raw) as TranscriptCacheShape
    const cached = cache?.[profileKeyOf(profile)]
    if (!cached || typeof cached.storedSessionId !== 'string' || !cached.storedSessionId) return null
    if (!Array.isArray(cached.entries) || cached.entries.length === 0) return null
    return { entries: cached.entries, storedSessionId: cached.storedSessionId }
  } catch {
    return null
  }
}

export function saveCachedTranscript(profile: null | string, transcript: { entries: readonly TranscriptEntry[]; storedSessionId: string }): void {
  if (!transcript.storedSessionId) return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    let cache: TranscriptCacheShape = {}
    try {
      const parsed = raw ? JSON.parse(raw) : null
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) cache = parsed as TranscriptCacheShape
    } catch {
      // A corrupt prior payload is replaced by this save.
    }
    cache[profileKeyOf(profile)] = { entries: durableEntries(transcript.entries), storedSessionId: transcript.storedSessionId }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Quota or serialization problems must never break the conversation.
  }
}