import { atom } from 'nanostores'
import { LocalPrivacy, localPrivacy } from './local-privacy'
import { $draftOwner, draftOwnerKey, type DraftOwner } from './draft-owner'
import type { TranscriptEntry } from '~/transcript/transcript'

const PREFIX = 'hermes.transcript.v2:'
export const MAX_CONVERSATIONS = 20
export const MAX_CACHE_BYTES = 2 * 1024 * 1024
export interface TranscriptCacheContext { owner: DraftOwner; profile: string | null; storedSessionId: string }
export interface CachedConversation extends TranscriptCacheContext {
  version: 2
  privacyRevision?: string | null
  /** Process metadata only; never serialized as history. */
  persistent?: boolean
  title: string
  source: string | null
  startedAt: number | null
  lastSyncedAt: number
  entries: TranscriptEntry[]
}
type Snapshot = Pick<CachedConversation, 'title' | 'source' | 'startedAt' | 'lastSyncedAt' | 'entries'>
type StorageAdapter = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
const keyOf = (context: TranscriptCacheContext) => PREFIX + encodeURIComponent(JSON.stringify([draftOwnerKey(context.owner), context.profile, context.storedSessionId]))
const bytes = (value: string) => new TextEncoder().encode(value).length
const serialize = (snapshot: CachedConversation) => {
  const { persistent: _persistent, ...history } = snapshot
  return JSON.stringify({ ...history, owner: { gateway: snapshot.owner.gateway, principal: snapshot.owner.principal } })
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Rebuild the projection rather than trusting persisted object fields. */
function entryOf(value: unknown): TranscriptEntry | null {
  if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.content !== 'string') return null
  if (value.rowId !== undefined && !positive(value.rowId)) return null
  const base = { id: value.id, content: value.content, ...(value.rowId === undefined ? {} : { rowId: value.rowId as number }) }
  if (value.kind === 'tool-output') return { ...base, kind: value.kind }
  if (value.reasoning !== undefined && typeof value.reasoning !== 'string') return null
  const reasoning = typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}
  if (value.kind === 'cron-instructions') {
    if (value.originalKind !== 'activity' && value.originalKind !== 'message') return null
    if (value.originalActivityKind !== undefined && typeof value.originalActivityKind !== 'string') return null
    return { ...base, ...reasoning, kind: value.kind, originalKind: value.originalKind, ...(typeof value.originalActivityKind === 'string' ? { originalActivityKind: value.originalActivityKind } : {}), streaming: false }
  }
  if (value.kind !== 'message' && value.kind !== 'activity') return null
  if (!['assistant', 'system', 'user'].includes(String(value.author))) return null
  let editTarget
  if (value.editTarget !== undefined) {
    const edit = value.editTarget
    if (!object(edit) || !positive(edit.rowId) || edit.rowId !== value.rowId || !Number.isSafeInteger(edit.userOrdinal) || Number(edit.userOrdinal) < 0 || value.author !== 'user') return null
    editTarget = { rowId: edit.rowId, userOrdinal: edit.userOrdinal as number }
  }
  const authored = { ...base, ...reasoning, author: value.author as 'assistant' | 'system' | 'user', streaming: false, ...(editTarget ? { editTarget } : {}) }
  if (value.kind === 'activity') return typeof value.activityKind === 'string' ? { ...authored, kind: value.kind, activityKind: value.activityKind } : null
  return { ...authored, kind: 'message' }
}
function validate(value: unknown, context: TranscriptCacheContext, privacyRevision: string | null): CachedConversation | null {
  if (!object(value) || value.version !== 2 || (value.privacyRevision ?? null) !== privacyRevision || !object(value.owner) || value.owner.gateway !== context.owner.gateway || value.owner.principal !== context.owner.principal
    || value.profile !== context.profile || value.storedSessionId !== context.storedSessionId || typeof value.title !== 'string'
    || !(value.source === null || typeof value.source === 'string') || !(value.startedAt === null || finite(value.startedAt))
    || !finite(value.lastSyncedAt) || !Array.isArray(value.entries) || value.entries.length > 80) return null
  const entries = value.entries.map(entryOf)
  if (entries.some(entry => !entry) || new Set(entries.map(entry => entry?.id)).size !== entries.length) return null
  return { ...context, version: 2, privacyRevision, title: value.title, source: value.source, startedAt: value.startedAt, lastSyncedAt: value.lastSyncedAt, entries: entries as TranscriptEntry[] }
}

/** Private history is readable only after verification in this app lifetime. */
export class TranscriptCache {
  readonly $version = atom(0)
  private owner: DraftOwner | null = null
  private memory = new Map<string, CachedConversation>()
  private persistentKeys = new Set<string>()
  private resetRevision: string | null = null
  constructor(private readonly storage: StorageAdapter | null, private readonly privacy = new LocalPrivacy(storage)) {
    try { storage?.removeItem('hermes.transcript.v1') } catch { /* Legacy data is never read. */ }
  }
  private canPersist() {
    const allowed = this.privacy.historyAllowed() && (!this.owner || this.privacy.resetDurable(draftOwnerKey(this.owner)))
    if (!allowed) this.persistentKeys.clear()
    return allowed
  }
  refreshPrivacy() {
    this.canPersist()
    this.$version.set(this.$version.get() + 1)
  }
  setOwner(owner: DraftOwner) {
    if (!this.owner || this.owner.generation !== owner.generation || draftOwnerKey(this.owner) !== draftOwnerKey(owner) || owner.locked) { this.memory.clear(); this.persistentKeys.clear() }
    this.owner = { ...owner }
    this.resetRevision = this.privacy.revision(draftOwnerKey(owner))
    this.$version.set(this.$version.get() + 1)
  }
  private eligible(owner: DraftOwner) {
    return this.owner && this.privacy.isCurrent(draftOwnerKey(owner), this.resetRevision) && !owner.locked && !this.owner.locked && Boolean(owner.gateway) && owner.generation === this.owner.generation && draftOwnerKey(owner) === draftOwnerKey(this.owner)
  }
  private keys(): string[] {
    try { return Array.from({ length: this.storage?.length ?? 0 }, (_, i) => this.storage?.key(i)).filter((key): key is string => Boolean(key?.startsWith(PREFIX))) } catch { return [] }
  }
  read(context: TranscriptCacheContext): CachedConversation | null {
    if (!this.eligible(context.owner)) return null
    const key = keyOf(context)
    const memory = this.memory.get(key)
    const persistent = this.canPersist()
    if (memory) return structuredClone({ ...memory, persistent: persistent && this.persistentKeys.has(key) })
    if (!context.owner.principal || !persistent) return null
    try {
      const raw = this.storage?.getItem(key)
      const snapshot = raw ? validate(JSON.parse(raw), context, this.resetRevision) : null
      if (snapshot) { this.memory.set(key, snapshot); this.persistentKeys.add(key) }
      return snapshot ? structuredClone({ ...snapshot, persistent: true }) : null
    } catch { return null }
  }
  list(owner: DraftOwner, profile?: string | null): CachedConversation[] {
    if (!this.eligible(owner)) return []
    const keys = new Set([...this.memory.keys(), ...(owner.principal && this.canPersist() ? this.keys() : [])])
    const results: CachedConversation[] = []
    for (const key of keys) {
      try {
        const [identity, storedProfile, storedSessionId] = JSON.parse(decodeURIComponent(key.slice(PREFIX.length)))
        if (identity !== draftOwnerKey(owner) || !(storedProfile === null || typeof storedProfile === 'string') || typeof storedSessionId !== 'string' || !storedSessionId || (profile !== undefined && profile !== storedProfile)) continue
        const snapshot = this.read({ owner, profile: storedProfile, storedSessionId })
        if (snapshot) results.push(snapshot)
      } catch { /* Ignore corrupt identities. */ }
    }
    return results.sort((a, b) => b.lastSyncedAt - a.lastSyncedAt)
  }
  latest(owner: DraftOwner, profile: string | null) { return this.list(owner, profile)[0] ?? null }
  write(context: TranscriptCacheContext, snapshot: Snapshot) {
    if (!this.eligible(context.owner) || !context.storedSessionId) return
    const value = validate({ ...context, ...snapshot, entries: snapshot.entries.slice(-80), version: 2, privacyRevision: this.resetRevision }, context, this.resetRevision)
    if (!value) return
    const key = keyOf(context)
    const histories = this.list(context.owner).filter(item => keyOf(item) !== key).sort((a, b) => a.lastSyncedAt - b.lastSyncedAt)
    this.memory.set(key, value)
    this.persistentKeys.delete(key)
    this.$version.set(this.$version.get() + 1)
    let evictionsSucceeded = true
    while (histories.length >= MAX_CONVERSATIONS) evictionsSucceeded = this.remove(histories.shift()!) && evictionsSucceeded
    const serialized = serialize(value)
    const size = bytes(key) + bytes(serialized)
    if (size > MAX_CACHE_BYTES) { try { if (context.owner.principal) this.storage?.removeItem(key) } catch { /* Memory remains available. */ } return }
    const total = () => size + histories.reduce((sum, item) => sum + bytes(keyOf(item)) + bytes(serialize(item)), 0)
    while (total() > MAX_CACHE_BYTES && histories.length) evictionsSucceeded = this.remove(histories.shift()!) && evictionsSucceeded
    if (!evictionsSucceeded || !context.owner.principal || !this.storage || !this.canPersist()) return
    try {
      // Charge actual stored bytes too. Corrupt or externally edited records
      // cannot make a subsequent write exceed this owner's persistent budget.
      let storedBytes = size
      let storedCount = 1
      for (let i = 0; i < this.storage.length; ++i) {
        const candidate = this.storage.key(i)
        if (!candidate?.startsWith(PREFIX) || candidate === key) continue
        let identity: unknown
        try { identity = JSON.parse(decodeURIComponent(candidate.slice(PREFIX.length)))[0] } catch { continue }
        if (identity !== draftOwnerKey(context.owner)) continue
        const raw = this.storage.getItem(candidate)
        if (raw !== null) { storedCount++; storedBytes += bytes(candidate) + bytes(raw) }
      }
      if (storedCount <= MAX_CONVERSATIONS && storedBytes <= MAX_CACHE_BYTES) {
        if (!this.canPersist() || !this.eligible(context.owner)) return
        this.storage.setItem(key, serialized)
        if (!this.canPersist() || !this.eligible(context.owner)) { this.storage.removeItem(key); return }
        if (this.storage.getItem(key) === serialized) {
          this.persistentKeys.add(key)
          this.$version.set(this.$version.get() + 1)
        }
      }
    } catch { /* Quota/denial does not affect drafts or navigation. */ }
  }
  private remove(snapshot: CachedConversation) {
    const key = keyOf(snapshot)
    this.memory.delete(key)
    this.persistentKeys.delete(key)
    try { this.storage?.removeItem(key); return !this.storage || this.storage.getItem(key) === null } catch { return false }
  }
  clearOwner(owner: DraftOwner, persistent = true): boolean {
    let cleared = true
    try { if (persistent && this.storage) { for (let i = 0; i < this.storage.length; ++i) this.storage.key(i) } } catch { cleared = false }
    for (const key of new Set([...this.memory.keys(), ...(persistent ? this.keys() : [])])) {
      try {
        const scope: unknown = JSON.parse(decodeURIComponent(key.slice(PREFIX.length)))
        if (!Array.isArray(scope) || scope.length !== 3 || typeof scope[0] !== 'string' || !(scope[1] === null || typeof scope[1] === 'string') || typeof scope[2] !== 'string') { cleared = false; continue }
        if (scope[0] !== draftOwnerKey(owner)) continue
        this.memory.delete(key)
        this.persistentKeys.delete(key)
        if (persistent) {
          this.storage?.removeItem(key)
          if (this.storage?.getItem(key) !== null && this.storage) cleared = false
        }
      } catch { cleared = false }
    }
    this.$version.set(this.$version.get() + 1)
    return cleared
  }
}
let storage: Storage | null = null
try { storage = typeof localStorage === 'undefined' ? null : localStorage } catch { /* Memory only. */ }
export const transcriptCache = new TranscriptCache(storage, localPrivacy)
transcriptCache.setOwner($draftOwner.get())
$draftOwner.listen(owner => transcriptCache.setOwner(owner))
localPrivacy.$state.listen(() => transcriptCache.refreshPrivacy())
