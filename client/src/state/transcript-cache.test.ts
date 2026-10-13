import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptCache, MAX_CACHE_BYTES, MAX_CONVERSATIONS } from './transcript-cache'
import type { DraftOwner } from './draft-owner'

const owner: DraftOwner = { gateway: 'https://a.test', principal: 'account-a', generation: 1, locked: false }
const context = (id = 'a', profile: string | null = null, principal = owner) => ({ owner: principal, profile, storedSessionId: id })
const snapshot = (lastSyncedAt = 1, content = 'hello') => ({ title: 'A', source: null, startedAt: null, lastSyncedAt, entries: [{ kind: 'message' as const, author: 'user' as const, content, id: 'row-1', rowId: 1, editTarget: { rowId: 1, userOrdinal: 0 }, streaming: true }] })
let cache: TranscriptCache
beforeEach(() => { localStorage.clear(); cache = new TranscriptCache(localStorage); cache.setOwner(owner) })

describe('conversation snapshots', () => {
  it('keeps A/B/A, empty selections, and exact profile/session identity', () => {
    cache.write(context(), snapshot(1)); cache.write(context('b'), snapshot(2, 'B'))
    cache.write(context('empty'), { ...snapshot(3), entries: [] })
    expect(cache.read(context())?.entries[0].content).toBe('hello')
    expect(cache.read(context('b'))?.entries[0].content).toBe('B')
    expect(cache.read(context('empty'))?.entries).toEqual([])
    expect(cache.latest(owner, null)?.storedSessionId).toBe('empty')
    expect(cache.read(context('missing'))).toBeNull()
    expect(cache.read(context('a', 'default'))).toBeNull()
    cache.write(context('a', 'default'), snapshot(4, 'literal default'))
    expect(cache.read(context())?.entries[0].content).toBe('hello')
    expect(cache.list(owner)).toHaveLength(4)
  })
  it('isolates account and gateway and retires memory on owner locks', () => {
    cache.write(context(), snapshot())
    const other = { ...owner, principal: 'account-b', generation: 2 }
    expect(cache.read(context('a', null, other))).toBeNull()
    cache.setOwner(other)
    expect(cache.list(other)).toEqual([])
    cache.setOwner({ ...owner, gateway: 'https://b.test', generation: 3 })
    expect(cache.read(context())).toBeNull()
    cache.setOwner({ ...owner, locked: true })
    cache.write(context(), snapshot(9, 'late'))
    expect(cache.read(context())).toBeNull()
    cache.setOwner(owner)
    expect(cache.read(context())?.entries[0].content).toBe('hello')
  })
  it('does not read unverified or legacy history', () => {
    localStorage.setItem('hermes.transcript.v1', JSON.stringify({ default: { storedSessionId: 'a', entries: snapshot().entries } }))
    const fresh = new TranscriptCache(localStorage)
    expect(localStorage.getItem('hermes.transcript.v1')).toBeNull()
    expect(fresh.read(context())).toBeNull()
    fresh.setOwner({ ...owner, gateway: '' })
    expect(fresh.read(context())).toBeNull()
  })
  it('reports confirmed persistence without serializing process metadata', () => {
    cache.write(context(), snapshot())
    expect(cache.read(context())?.persistent).toBe(true)
    const serialized = JSON.parse(localStorage.getItem(localStorage.key(0)!)!)
    expect(serialized.persistent).toBeUndefined()
    expect(serialized.owner).toEqual({ gateway: owner.gateway, principal: owner.principal })
    cache = new TranscriptCache(localStorage); cache.setOwner(owner)
    expect(cache.read(context())?.persistent).toBe(true)
    cache.write(context(), snapshot(2, 'x'.repeat(MAX_CACHE_BYTES)))
    expect(cache.read(context())?.persistent).toBe(false)
    expect(localStorage.length).toBe(0)
  })
  it('keeps principal-less owners memory only and freezes streaming', () => {
    const memoryOwner = { ...owner, principal: null }
    cache.setOwner(memoryOwner)
    cache.write(context('a', null, memoryOwner), snapshot())
    expect(localStorage.length).toBe(0)
    expect(cache.read(context('a', null, memoryOwner))?.persistent).toBe(false)
    expect(cache.read(context('a', null, memoryOwner))?.entries[0]).toMatchObject({ streaming: false })
    cache.setOwner({ ...memoryOwner, generation: 2 })
    expect(cache.list(memoryOwner)).toEqual([])
  })
  it('projects at most 80 entries and evicts oldest synchronized history, never drafts', () => {
    localStorage.setItem('hermes.drafts.test', 'keep')
    for (let i = 0; i <= MAX_CONVERSATIONS; i++) cache.write(context(String(i)), snapshot(i))
    expect(cache.list(owner)).toHaveLength(MAX_CONVERSATIONS)
    expect(cache.read(context('0'))).toBeNull()
    expect(localStorage.getItem('hermes.drafts.test')).toBe('keep')
    cache.write(context('many'), { ...snapshot(99), entries: Array.from({ length: 100 }, (_, i) => ({ ...snapshot().entries[0], id: String(i), rowId: i + 1, editTarget: { rowId: i + 1, userOrdinal: i } })) })
    expect(cache.read(context('many'))?.entries).toHaveLength(80)
  })
  it('retains oversized text only in memory and bounds serialized UTF-8 bytes including keys', () => {
    cache.write(context('oversized'), snapshot(1, 'x'.repeat(MAX_CACHE_BYTES)))
    expect(localStorage.length).toBe(0)
    expect(cache.read(context('oversized'))?.entries[0].content.length).toBe(MAX_CACHE_BYTES)
    for (let i = 0; i < 10; i++) cache.write(context(String(i)), snapshot(i + 2, 'é'.repeat(160000)))
    let total = 0
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i)!; total += new TextEncoder().encode(key + localStorage.getItem(key)).length }
    expect(total).toBeLessThanOrEqual(MAX_CACHE_BYTES)
  })
  it.each([
    { version: 1 }, { lastSyncedAt: Infinity }, { startedAt: 'now' }, { storedSessionId: 'wrong' },
    { entries: [{ ...snapshot().entries[0], author: 'tool' }] },
    { entries: [{ ...snapshot().entries[0], rowId: 1.5 }] },
    { entries: [{ ...snapshot().entries[0], editTarget: { rowId: 2, userOrdinal: -1 } }] },
    { entries: [{ ...snapshot().entries[0], kind: 'unknown' }] },
    { entries: [snapshot().entries[0], snapshot().entries[0]] }
  ])('rejects malformed persisted records %j', invalid => {
    cache.write(context(), snapshot())
    const key = localStorage.key(0)!
    const value = JSON.parse(localStorage.getItem(key)!)
    localStorage.setItem(key, JSON.stringify({ ...value, ...invalid }))
    cache = new TranscriptCache(localStorage); cache.setOwner(owner)
    expect(cache.read(context())).toBeNull()
  })
  it('rebuilds discriminated variants without unexpected sensitive fields', () => {
    cache.write(context(), { ...snapshot(), entries: [
      { id: 'tool', kind: 'tool-output', content: 'done' },
      { id: 'activity', kind: 'activity', activityKind: 'notice', author: 'system', content: 'notice', streaming: true },
      { id: 'cron', kind: 'cron-instructions', originalKind: 'message', content: 'instructions', streaming: true }
    ] })
    cache = new TranscriptCache(localStorage); cache.setOwner(owner)
    expect(cache.read(context())?.entries).toMatchObject([{ kind: 'tool-output' }, { kind: 'activity', streaming: false }, { kind: 'cron-instructions', streaming: false }])
  })
  it('survives denied reads and writes; reports incomplete removal', () => {
    const denied = { length: 1, key: () => null, getItem: vi.fn(() => { throw new Error('denied') }), setItem: vi.fn(() => { throw new Error('quota') }), removeItem: vi.fn(() => { throw new Error('denied') }) }
    cache = new TranscriptCache(denied); cache.setOwner(owner)
    cache.write(context(), snapshot())
    expect(cache.read(context())?.entries[0].content).toBe('hello')
    expect(cache.read(context())?.persistent).toBe(false)
    expect(cache.clearOwner(owner)).toBe(false)
    cache.setOwner({ ...owner, locked: true })
    expect(cache.list(owner)).toEqual([])
  })
})
