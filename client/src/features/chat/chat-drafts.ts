import { atom } from 'nanostores'

import { $draftOwner, draftOwnerKey, lockDraftOwner, type DraftOwner } from '~/state/draft-owner'

const PREFIX = 'hermes.drafts.v1:'
const LOGOUT_PREFIX = 'hermes.drafts.logout:'
const MAX_RECORDS = 50
const MAX_BYTES = 1_024 * 1_024

export interface DraftAttachment {
  ref: string
  name: string
  type: string
  size: number
  runtimeId: string | null
}
export interface DraftPayload {
  text: string
  attachments: DraftAttachment[]
  edit: { rowId: number; content: string } | null
}
export interface DraftContent extends DraftPayload {
  normal: DraftPayload | null
}
export interface DraftRecovery {
  id: string
  content: DraftContent
  status: 'pending' | 'failed' | 'uncertain' | 'conflict'
}
export interface DraftRecord {
  version: 1
  key: string
  owner: string
  conversation: string
  profile: string | null
  provisional: boolean
  revision: string
  updatedAt: number
  content: DraftContent
  recoveries: DraftRecovery[]
}
export interface DraftContext {
  owner: DraftOwner
  profile: string | null
  conversation: string
  provisional: boolean
}

export const emptyDraft = (): DraftContent => ({ text: '', attachments: [], edit: null, normal: null })
const hasPayload = (value: DraftPayload) => Boolean(value.text || value.attachments.length || value.edit)
const hasContent = (value: DraftContent) => hasPayload(value) || Boolean(value.normal && hasPayload(value.normal))
const clone = <T>(value: T): T => structuredClone(value)
const bytes = (value: string) => new TextEncoder().encode(value).length
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const string = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_BYTES

function payload(value: unknown): value is DraftPayload {
  if (!isObject(value) || !string(value.text) || !Array.isArray(value.attachments) || value.attachments.length > 100) return false
  if (!value.attachments.every(item => isObject(item) && string(item.ref) && string(item.name) && string(item.type)
    && typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
    && (item.runtimeId === null || string(item.runtimeId)))) return false
  return value.edit === null || (isObject(value.edit) && Number.isSafeInteger(value.edit.rowId)
    && Number(value.edit.rowId) > 0 && string(value.edit.content))
}
function content(value: unknown): value is DraftContent {
  return payload(value) && isObject(value) && (value.normal === null || payload(value.normal))
}
function keyScope(key: string): [string, string | null, string] | null {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(key.slice(PREFIX.length)))
    return Array.isArray(value) && value.length === 3 && string(value[0]) && (value[1] === null || string(value[1])) && string(value[2]) ? value as [string, string | null, string] : null
  } catch { return null }
}

function parse(raw: string | null, key: string, owner: string): DraftRecord | null {
  if (!raw || bytes(raw) > MAX_BYTES) return null
  try {
    const value: unknown = JSON.parse(raw)
    const scope = keyScope(key)
    if (!scope || scope[0] !== owner || !isObject(value) || value.version !== 1 || value.key !== key || value.owner !== owner
      || value.conversation !== scope[2] || !string(value.conversation) || typeof value.provisional !== 'boolean' || !string(value.revision)
      || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || !content(value.content)
      || !Array.isArray(value.recoveries) || value.recoveries.length > 100
      || !value.recoveries.every(item => isObject(item) && string(item.id) && content(item.content)
        && ['pending', 'failed', 'uncertain', 'conflict'].includes(String(item.status)))) return null
    // Rebuild the validated fields rather than spreading untrusted storage into state.
    return {
      version: 1, key, owner, profile: scope[1], conversation: value.conversation, provisional: value.provisional,
      revision: value.revision, updatedAt: value.updatedAt,
      content: cleanContent(value.content),
      recoveries: value.recoveries.map(item => ({ id: item.id, status: item.status, content: cleanContent(item.content) }))
    }
  } catch { return null }
}
function cleanContent(value: DraftContent): DraftContent {
  const clean = (value: DraftPayload): DraftPayload => ({
    text: value.text,
    attachments: value.attachments.map(item => ({ ref: item.ref, name: item.name, type: item.type, size: item.size, runtimeId: item.runtimeId })),
    edit: value.edit ? { rowId: value.edit.rowId, content: value.edit.content } : null
  })
  return { ...clean(value), normal: value.normal ? clean(value.normal) : null }
}

/** Owns durable drafts independently of the lifetime of the chat screen. */
export class ChatDrafts {
  readonly $version = atom(0)
  readonly $blocked = atom(false)
  private records = new Map<string, DraftRecord>()
  private unsaved = new Set<string>()
  private promotions = new Map<string, string>()
  private submissionGenerations = new Map<string, number>()
  private provisionalIds = new Map<string, string>()
  private tasks = new Map<string, string>()
  private logoutRevision: string | null = null
  private owner: DraftOwner = { gateway: '', principal: null, generation: 0, locked: false }

  constructor(private readonly storage: Storage | null) {}

  setOwner(owner: DraftOwner) {
    const changed = this.owner.generation !== owner.generation || draftOwnerKey(this.owner) !== draftOwnerKey(owner)
    if (changed) {
      for (const record of this.records.values()) {
        if (record.owner !== draftOwnerKey(this.owner)) continue
        let retired = false
        for (const recovery of record.recoveries) if (recovery.status === 'pending') {
          recovery.status = 'uncertain'
          this.submissionGenerations.delete(recovery.id)
          retired = true
        }
        if (retired) this.save(record)
      }
      this.tasks.clear()
    }
    this.owner = owner
    if (changed) {
      try { this.logoutRevision = this.storage?.getItem(LOGOUT_PREFIX + encodeURIComponent(draftOwnerKey(owner))) ?? null } catch { this.logoutRevision = null }
    }
    if (!owner.locked) this.loadOwner()
    this.notify()
  }

  provisionalId(owner: DraftOwner, profile: string | null, runtimeId: string | null) {
    const key = JSON.stringify([draftOwnerKey(owner), owner.generation, profile, runtimeId])
    if (!this.provisionalIds.has(key)) this.provisionalIds.set(key, `provisional:${crypto.randomUUID()}`)
    return this.provisionalIds.get(key)!
  }

  select(context: DraftContext): DraftRecord {
    const owner = draftOwnerKey(context.owner)
    const key = PREFIX + encodeURIComponent(JSON.stringify([owner, context.profile, context.conversation]))
    let record = this.records.get(key)
    if (!record) {
      record = {
        version: 1, key, owner, profile: context.profile, conversation: context.conversation, provisional: context.provisional,
        revision: '', updatedAt: Date.now(), content: emptyDraft(), recoveries: []
      }
      this.records.set(key, record)
    }
    return this.allowed(record) ? clone(record) : { ...record, content: emptyDraft(), recoveries: [] }
  }

  read(key: string): DraftRecord | null {
    const value = this.records.get(key)
    return value && this.allowed(value) ? clone(value) : null
  }

  list(): DraftRecord[] {
    return [...this.records.values()].filter(value => this.allowed(value)
      && (hasContent(value.content) || value.recoveries.length)).map(clone)
  }

  hasUnsaved(key: string) { return this.unsaved.has(key) }

  isSaved(key: string) { return !this.unsaved.has(key) && this.owner.principal !== null }

  write(key: string, value: DraftContent) {
    const record = this.records.get(key)
    if (!record || !this.allowed(record)) return
    this.preserveExternal(record)
    record.content = clone(value)
    this.save(record)
  }

  promote(key: string, context: DraftContext): string {
    const source = this.read(key)
    const destination = this.select(context)
    if (!source || key === destination.key) return destination.key
    const target = this.records.get(destination.key)!
    if (hasContent(source.content)) {
      if (hasContent(target.content)) target.recoveries.push({ id: crypto.randomUUID(), content: source.content, status: 'conflict' })
      else target.content = source.content
    }
    target.recoveries.push(...source.recoveries)
    this.save(target)
    this.promotions.set(key, target.key)
    if (this.isSaved(target.key) || !this.owner.principal) this.retirePromotedSource(key)
    return target.key
  }

  beginSubmission(key: string): string | null {
    const record = this.records.get(key)
    if (!record || !this.allowed(record)) return null
    this.preserveExternal(record)
    const id = crypto.randomUUID()
    this.submissionGenerations.set(id, this.owner.generation)
    record.recoveries.push({ id, content: clone(record.content), status: 'pending' })
    record.content = emptyDraft()
    this.save(record)
    return id
  }

  settleSubmission(key: string, id: string, outcome: 'success' | 'failed' | 'uncertain') {
    if (this.submissionGenerations.get(id) !== this.owner.generation) return
    this.submissionGenerations.delete(id)
    // A late stored-session ID can move the draft while its RPC is still pending.
    const keys = new Set([key, this.promotedKey(key)])
    for (const recordKey of keys) {
      const record = this.records.get(recordKey)
      if (!record || !this.allowed(record)) continue
      this.preserveExternal(record)
      const recovery = record.recoveries.find(item => item.id === id)
      if (!recovery) continue
      if (outcome === 'success') {
        record.recoveries = record.recoveries.filter(item => item.id !== id)
        if (recovery.content.normal && hasPayload(recovery.content.normal)) {
          const normal = { ...recovery.content.normal, normal: null }
          if (hasContent(record.content)) record.recoveries.push({ id: crypto.randomUUID(), content: normal, status: 'conflict' })
          else record.content = normal
        }
      } else recovery.status = outcome
      this.save(record)
    }
  }

  restore(key: string, id: string) {
    key = this.promotedKey(key)
    const record = this.records.get(key)
    if (!record || !this.allowed(record)) return
    this.preserveExternal(record)
    const recovery = record.recoveries.find(item => item.id === id)
    if (!recovery || recovery.status === 'pending') return
    if (hasContent(record.content)) record.recoveries.push({ id: crypto.randomUUID(), content: record.content, status: 'conflict' })
    record.content = clone(recovery.content)
    record.recoveries = record.recoveries.filter(item => item.id !== id)
    this.save(record)
  }

  discard(key: string, id?: string) {
    const record = this.records.get(key)
    if (!record || !this.allowed(record)) return
    this.preserveExternal(record)
    if (id) record.recoveries = record.recoveries.filter(item => item.id !== id || item.status === 'pending')
    else { record.content = emptyDraft(); record.recoveries = record.recoveries.filter(item => item.status === 'pending') }
    this.save(record)
  }

  task(key: string): () => void {
    const id = crypto.randomUUID()
    this.tasks.set(id, key)
    this.notify()
    return () => { this.tasks.delete(id); this.notify() }
  }

  flush() {
    for (const key of [...this.unsaved]) {
      const record = this.records.get(key)
      if (record && this.allowed(record)) this.save(record)
    }
    for (const [source, target] of this.promotions) if (this.isSaved(target)) this.retirePromotedSource(source)
  }

  clearOwner(broadcast = true) {
    const owner = draftOwnerKey(this.owner)
    // Clear memory before storage or network work, so late callbacks cannot recreate it.
    for (const [key, record] of this.records) if (record.owner === owner) {
      this.records.delete(key)
      this.unsaved.delete(key)
    }
    this.tasks.clear()
    let cleared = true
    try {
      const keys = this.storageKeys()
      for (const key of keys) {
        if (keyScope(key)?.[0] === owner) this.storage!.removeItem(key)
      }
      if (broadcast) this.storage?.setItem(LOGOUT_PREFIX + encodeURIComponent(owner), crypto.randomUUID())
    } catch { cleared = false }
    this.notify()
    return cleared
  }

  storageChanged(event: StorageEvent) {
    if (event.key === LOGOUT_PREFIX + encodeURIComponent(draftOwnerKey(this.owner))) {
      this.clearOwner(false)
      this.owner = { ...this.owner, locked: true, generation: this.owner.generation + 1 }
      this.notify()
      lockDraftOwner()
      return
    }
    if (!event.key?.startsWith(PREFIX) || this.owner.locked) return
    if (!event.newValue) {
      const local = this.records.get(event.key)
      if (!local || !this.allowed(local)) return
      for (const recovery of local.recoveries) {
        if (recovery.status === 'pending' && !this.submissionGenerations.has(recovery.id)) recovery.status = 'uncertain'
      }
      if (hasContent(local.content) || local.recoveries.length) this.unsaved.add(local.key)
      else this.records.delete(local.key)
      this.notify()
      return
    }
    const external = parse(event.newValue, event.key, draftOwnerKey(this.owner))
    if (!external) return
    const local = this.records.get(event.key)
    if (!local || local.revision === external.revision) { this.records.set(event.key, external); this.notify(); return }
    // Keep the local revision as a recovery copy before adopting another tab's write.
    if (hasContent(local.content) && JSON.stringify(local.content) !== JSON.stringify(external.content)) {
      external.recoveries.push({ id: crypto.randomUUID(), content: local.content, status: 'conflict' })
      external.recoveries.push(...local.recoveries.filter(item => !external.recoveries.some(other => other.id === item.id)))
      this.records.set(event.key, external)
      this.save(external)
    } else { this.records.set(event.key, external); this.notify() }
  }

  private promotedKey(key: string): string {
    return this.promotions.get(key) ?? key
  }
  private retirePromotedSource(key: string) {
    const source = this.records.get(key)
    if (!source || !this.allowed(source)) return
    source.content = emptyDraft()
    source.recoveries = []
    this.save(source)
    if (!this.unsaved.has(key)) this.records.delete(key)
  }

  private allowed(record: DraftRecord) {
    if (this.owner.locked || record.owner !== draftOwnerKey(this.owner)) return false
    try { return (this.storage?.getItem(LOGOUT_PREFIX + encodeURIComponent(record.owner)) ?? null) === this.logoutRevision }
    catch { return true } // Unavailable storage still permits in-memory recovery.
  }
  private storageKeys() {
    if (!this.storage) return []
    return Array.from({ length: this.storage.length }, (_, index) => this.storage!.key(index)).filter((key): key is string => Boolean(key?.startsWith(PREFIX)))
  }
  private loadOwner() {
    if (!this.owner.principal) return
    try {
      for (const key of this.storageKeys()) {
        if (this.records.has(key)) continue
        const record = parse(this.storage!.getItem(key), key, draftOwnerKey(this.owner))
        if (!record) continue
        const invalidateFiles = (value: DraftContent) => {
          for (const item of value.attachments) item.runtimeId = null
          for (const item of value.normal?.attachments ?? []) item.runtimeId = null
        }
        invalidateFiles(record.content)
        for (const recovery of record.recoveries) {
          if (recovery.status === 'pending') recovery.status = 'uncertain'
          invalidateFiles(recovery.content)
        }
        this.records.set(key, record)
      }
    } catch { /* Writes report unavailable storage when there is work to save. */ }
  }
  private preserveExternal(record: DraftRecord) {
    if (!this.owner.principal) return
    try {
      const external = parse(this.storage?.getItem(record.key) ?? null, record.key, record.owner)
      if (external && external.revision !== record.revision) {
        if (hasContent(external.content)) record.recoveries.push({ id: crypto.randomUUID(), content: external.content, status: 'conflict' })
        record.recoveries.push(...external.recoveries.filter(item => !record.recoveries.some(other => other.id === item.id)))
        record.revision = external.revision
      }
    } catch { /* save reports failure */ }
  }
  private save(record: DraftRecord) {
    if (!this.allowed(record)) { this.notify(); return }
    record.revision = crypto.randomUUID()
    record.updatedAt = Date.now()
    const nonempty = hasContent(record.content) || record.recoveries.length > 0
    try {
      if (!this.storage || !this.owner.principal) throw new Error('Memory-only draft')
      if (!content(record.content) || record.recoveries.length > 100 || !record.recoveries.every(item => content(item.content))) throw new Error('Draft too large')
      const raw = JSON.stringify(record)
      const others = this.storageKeys().filter(key => key !== record.key)
        .map(key => this.storage!.getItem(key)).filter((raw): raw is string => raw !== null)
        .filter(raw => { try { return bytes(raw) <= MAX_BYTES && JSON.parse(raw).owner === record.owner } catch { return false } })
      if (nonempty && (others.length >= MAX_RECORDS || bytes(raw) + others.reduce((sum, value) => sum + bytes(value), 0) > MAX_BYTES)) throw new Error('Draft limit')
      if (nonempty) this.storage.setItem(record.key, raw)
      else this.storage.removeItem(record.key)
      this.unsaved.delete(record.key)
    } catch {
      if (nonempty || this.owner.principal) this.unsaved.add(record.key)
      else this.unsaved.delete(record.key)
    }
    this.notify()
  }
  private notify() {
    const records = [...this.records.values()].filter(record => this.allowed(record))
    const blocked = this.unsaved.size > 0 || records.some(record => this.unsaved.has(record.key) || record.content.attachments.length > 0
      || Boolean(record.content.normal?.attachments.length) || record.recoveries.some(item => item.status === 'pending' || item.content.attachments.length > 0))
      || this.tasks.size > 0
    this.$blocked.set(blocked)
    this.$version.set(this.$version.get() + 1)
  }
}

function browserStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}
export const chatDrafts = new ChatDrafts(browserStorage())
chatDrafts.setOwner($draftOwner.get())
$draftOwner.listen(owner => chatDrafts.setOwner(owner))

export function initializeDraftProtection() {
  const storage = (event: StorageEvent) => chatDrafts.storageChanged(event)
  const flush = () => chatDrafts.flush()
  const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
  const stop = chatDrafts.$blocked.subscribe(blocked => {
    window.removeEventListener('beforeunload', beforeUnload)
    if (blocked) window.addEventListener('beforeunload', beforeUnload)
  })
  window.addEventListener('storage', storage)
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', flush)
  return () => {
    flush(); stop()
    window.removeEventListener('storage', storage)
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('beforeunload', beforeUnload)
    document.removeEventListener('visibilitychange', flush)
  }
}
