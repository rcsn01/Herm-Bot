import { beforeEach, expect, it, vi } from 'vitest'
import { LocalPrivacy, PRIVACY_KEY } from './local-privacy'
import { TranscriptCache } from './transcript-cache'
import { ChatDrafts, emptyDraft } from '~/features/chat/chat-drafts'
import { draftOwnerKey } from './draft-owner'

const owner = { gateway: 'https://a.test', principal: 'account-a', generation: 1, locked: false }
const context = { owner, profile: null, storedSessionId: 'saved-a' }
const snapshot = { title: 'A', source: null, startedAt: null, lastSyncedAt: 1, entries: [{ id: '1', kind: 'message' as const, author: 'user' as const, content: 'private history', streaming: false }] }
beforeEach(() => { vi.restoreAllMocks(); localStorage.clear() })

it('defaults history on only when the preference is absent and validates the stored policy', () => {
  expect(new LocalPrivacy(localStorage).historyAllowed()).toBe(true)
  for (const raw of ['bad', '{}', 'null', '{"version":2,"saveHistory":true}', '{"version":1,"saveHistory":"yes"}']) {
    localStorage.setItem(PRIVACY_KEY, raw)
    const privacy = new LocalPrivacy(localStorage)
    expect(privacy.historyAllowed()).toBe(false)
    expect(privacy.$state.get().error).toMatch(/could not be read/)
  }
  expect(new LocalPrivacy(null).historyAllowed()).toBe(false)
})

it('removes all disk history but retains verified memory history and drafts', () => {
  const privacy = new LocalPrivacy(localStorage)
  const cache = new TranscriptCache(localStorage, privacy)
  cache.setOwner(owner)
  cache.write(context, snapshot)
  localStorage.setItem('hermes.transcript.v2:malformed-other-account', 'bad')
  localStorage.setItem('hermes.transcript.v1', 'old private history')
  localStorage.setItem('hermes.drafts.v1:keep', 'draft')
  localStorage.setItem('hermes.mobile.session.v2:keep', 'bookmark')
  localStorage.setItem('hermes.theme', 'dark')
  expect(privacy.setHistorySaving(false)).toEqual({ complete: true, failures: [] })
  expect(cache.read(context)).toMatchObject({ persistent: false, entries: snapshot.entries })
  cache.write(context, { ...snapshot, lastSyncedAt: 2 })
  expect(Object.keys(localStorage).filter(key => key.startsWith('hermes.transcript.'))).toEqual([])
  expect(localStorage.getItem('hermes.drafts.v1:keep')).toBe('draft')
  expect(localStorage.getItem('hermes.mobile.session.v2:keep')).toBe('bookmark')
  expect(localStorage.getItem('hermes.theme')).toBe('dark')
  const cold = new TranscriptCache(localStorage, new LocalPrivacy(localStorage)); cold.setOwner(owner)
  expect(cold.read(context)).toBeNull()
  privacy.setHistorySaving(true)
  expect(Object.keys(localStorage).some(key => key.startsWith('hermes.transcript.'))).toBe(false)
  cache.write(context, { ...snapshot, lastSyncedAt: 3 })
  expect(cache.read(context)?.persistent).toBe(true)
})

it('rechecks another tab’s policy before persistent reads and writes, before an event arrives', () => {
  const first = new LocalPrivacy(localStorage)
  const second = new LocalPrivacy(localStorage)
  const cache = new TranscriptCache(localStorage, first); cache.setOwner(owner); cache.write(context, snapshot)
  second.setHistorySaving(false)
  expect(first.historyAllowed()).toBe(false)
  cache.write(context, snapshot)
  expect(cache.read(context)?.persistent).toBe(false)
  expect(Object.keys(localStorage).filter(key => key.startsWith('hermes.transcript.'))).toEqual([])
})

it('initialization retries removal of history left behind while disabled and cleans up its listener', () => {
  const privacy = new LocalPrivacy(localStorage)
  privacy.setHistorySaving(false)
  localStorage.setItem('hermes.transcript.v2:bad', 'leftover')
  const stop = privacy.initialize()
  expect(localStorage.getItem('hermes.transcript.v2:bad')).toBeNull()
  stop()
  expect(privacy.historyAllowed()).toBe(false)
})

it('reports failed preference writes, disables the process, and keeps the warning after policy reads', () => {
  const privacy = new LocalPrivacy(localStorage)
  const cache = new TranscriptCache(localStorage, privacy); cache.setOwner(owner)
  const stop = privacy.$state.listen(() => cache.refreshPrivacy())
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota') })
  expect(privacy.setHistorySaving(false).complete).toBe(false)
  expect(privacy.historyAllowed()).toBe(false)
  expect(privacy.$state.get().error).toMatch(/may not survive restart/)
  stop()
})

it('attempts other deletions after a failure and reports incomplete removal', () => {
  localStorage.setItem('hermes.transcript.v2:failed', 'private')
  localStorage.setItem('hermes.transcript.v2:removed', 'private')
  const remove = Storage.prototype.removeItem
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
    if (key.endsWith('failed')) throw new Error('Denied')
    remove.call(this, key)
  })
  const privacy = new LocalPrivacy(localStorage)
  expect(privacy.setHistorySaving(false).complete).toBe(false)
  expect(privacy.historyAllowed()).toBe(false)
  expect(localStorage.getItem('hermes.transcript.v2:removed')).toBeNull()
  expect(privacy.$state.get().error).toMatch(/could not be removed/)
})

it('invalidates stale cache and draft writes before another tab handles the reset event', () => {
  const privacy = new LocalPrivacy(localStorage)
  const otherTab = new LocalPrivacy(localStorage)
  const cache = new TranscriptCache(localStorage, privacy); cache.setOwner(owner); cache.write(context, snapshot)
  const drafts = new ChatDrafts(localStorage, privacy); drafts.setOwner(owner)
  const record = drafts.select({ owner, profile: null, conversation: 'a', provisional: false })
  drafts.write(record.key, { ...emptyDraft(), text: 'old draft' })
  const pending = drafts.beginSubmission(record.key)!
  const revision = privacy.revision(draftOwnerKey(owner))
  expect(otherTab.beginReset(draftOwnerKey(owner)).complete).toBe(true)
  expect(privacy.isCurrent(draftOwnerKey(owner), revision)).toBe(false)
  cache.clearOwner(owner)
  cache.write(context, snapshot)
  drafts.clearOwner(false)
  drafts.write(record.key, { ...emptyDraft(), text: 'late draft' })
  drafts.settleSubmission(record.key, pending, 'failed')
  drafts.flush()
  expect(Object.keys(localStorage).filter(key => key.startsWith('hermes.drafts.v1:') || key.startsWith('hermes.transcript.v2:'))).toEqual([])
  expect(cache.read(context)).toBeNull()
})

it('broadcasts reset revisions separately from logout, including a local-only fallback on failure', () => {
  const privacy = new LocalPrivacy(localStorage)
  const listener = vi.fn(); privacy.$reset.listen(listener)
  const key = draftOwnerKey(owner)
  privacy.beginReset(key)
  const resetKey = Object.keys(localStorage).find(key => key.startsWith('hermes.privacy.reset.v1:'))!
  const other = new LocalPrivacy(localStorage)
  other.storageChanged({ key: resetKey })
  expect(other.$reset.get()?.owner).toBe(key)
  expect(Object.keys(localStorage).some(key => key.startsWith('hermes.drafts.logout:'))).toBe(false)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied') })
  expect(privacy.beginReset(key).complete).toBe(false)
  expect(privacy.resetDurable(key)).toBe(false)
  const drafts = new ChatDrafts(localStorage, privacy); drafts.setOwner(owner)
  const draft = drafts.select({ owner, profile: null, conversation: 'new-work', provisional: false })
  drafts.write(draft.key, { ...emptyDraft(), text: 'must remain in memory' })
  expect(drafts.read(draft.key)?.content.text).toBe('must remain in memory')
  expect(drafts.isSaved(draft.key)).toBe(false)
  expect(drafts.hasUnsaved(draft.key)).toBe(true)
  expect(listener).toHaveBeenCalledTimes(2)
})

it('does not restore pre-reset records after removal failure, restart, or a delayed storage event', () => {
  const privacy = new LocalPrivacy(localStorage)
  const drafts = new ChatDrafts(localStorage, privacy); drafts.setOwner(owner)
  const record = drafts.select({ owner, profile: null, conversation: 'a', provisional: false })
  drafts.write(record.key, { ...emptyDraft(), text: 'must stay retired' })
  const raw = localStorage.getItem(record.key)!
  const cache = new TranscriptCache(localStorage, privacy); cache.setOwner(owner); cache.write(context, snapshot)
  privacy.beginReset(draftOwnerKey(owner))
  // Leave disk records behind, as if deletion was denied.
  drafts.clearOwner(false, false)
  const nextOwner = { ...owner, generation: 2 }
  drafts.setOwner(nextOwner)
  drafts.storageChanged(new StorageEvent('storage', { key: record.key, newValue: raw }))
  expect(drafts.list()).toEqual([])
  const coldDrafts = new ChatDrafts(localStorage, new LocalPrivacy(localStorage)); coldDrafts.setOwner(nextOwner)
  expect(coldDrafts.list()).toEqual([])
  const coldCache = new TranscriptCache(localStorage, new LocalPrivacy(localStorage)); coldCache.setOwner(nextOwner)
  expect(coldCache.read({ ...context, owner: nextOwner })).toBeNull()
  const fresh = drafts.select({ owner: nextOwner, profile: null, conversation: 'a', provisional: false })
  drafts.write(fresh.key, { ...emptyDraft(), text: 'new valid work' })
  drafts.storageChanged(new StorageEvent('storage', { key: fresh.key, newValue: null }))
  expect(drafts.hasUnsaved(fresh.key)).toBe(false)
  expect(drafts.read(fresh.key)?.content.text).toBe('new valid work')
  const reopened = new ChatDrafts(localStorage, new LocalPrivacy(localStorage)); reopened.setOwner(nextOwner)
  expect(reopened.list()[0].content.text).toBe('new valid work')
})

it('does not silently enable history if another tab clears storage after a failed opt-out', () => {
  const privacy = new LocalPrivacy(localStorage)
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied') })
  privacy.setHistorySaving(false)
  set.mockRestore()
  localStorage.clear()
  privacy.storageChanged({ key: null })
  expect(privacy.historyAllowed()).toBe(false)
  expect(privacy.$state.get().error).toMatch(/may not survive restart/)
  expect(privacy.setHistorySaving(true).complete).toBe(true)
  expect(privacy.historyAllowed()).toBe(true)
})

it('detects enumeration failures without enabling history', () => {
  const privacy = new LocalPrivacy({ get length(): number { throw new Error('Denied') }, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  expect(privacy.setHistorySaving(false).complete).toBe(false)
  expect(privacy.historyAllowed()).toBe(false)
})
