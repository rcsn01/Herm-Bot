import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatDrafts, emptyDraft, type DraftContext } from './chat-drafts'

const owner = { gateway: 'https://gateway.test', principal: JSON.stringify(['org', 'user']), generation: 1, locked: false }
const context = (conversation = 'one', profile: string | null = null): DraftContext => ({ owner, profile, conversation, provisional: false })
function repository(storage: Storage | null = localStorage) {
  const drafts = new ChatDrafts(storage)
  drafts.setOwner(owner)
  return drafts
}
const text = (value: string) => ({ ...emptyDraft(), text: value })
beforeEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('durable drafts', () => {
  it('preserves exact whitespace across instances and removes empty drafts', () => {
    const drafts = repository()
    const { key } = drafts.select(context())
    drafts.write(key, text('  unfinished\n'))
    expect(repository().select(context()).content.text).toBe('  unfinished\n')
    drafts.write(key, emptyDraft())
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('isolates accounts, gateways, conversations and null profiles', () => {
    const drafts = repository()
    drafts.write(drafts.select(context()).key, text('private'))
    expect(drafts.select(context('two')).content.text).toBe('')
    expect(drafts.select(context('one', 'default')).content.text).toBe('')
    const other = { ...owner, principal: JSON.stringify(['org', 'other']), generation: 2 }
    drafts.setOwner(other)
    expect(drafts.list()).toHaveLength(0)
    expect(drafts.select({ ...context(), owner: other }).content.text).toBe('')
    drafts.setOwner({ ...owner, gateway: 'https://other.test' })
    expect(drafts.list()).toHaveLength(0)
  })

  it('does not expose records while identity is locked or unavailable', () => {
    const drafts = repository()
    drafts.write(drafts.select(context()).key, text('private'))
    drafts.setOwner({ ...owner, locked: true })
    expect(drafts.list()).toEqual([])
    expect(drafts.select({ ...context(), owner: { ...owner, locked: true } }).content.text).toBe('')
    drafts.setOwner({ ...owner, principal: null })
    expect(drafts.list()).toEqual([])
  })

  it.each(['corrupt', 'version', 'owner', 'row', 'attachment'])('validates %s storage', kind => {
    const drafts = repository()
    const { key } = drafts.select(context())
    drafts.write(key, text('valid'))
    const value = JSON.parse(localStorage.getItem(key)!)
    if (kind === 'version') value.version = 2
    if (kind === 'owner') value.owner = 'other'
    if (kind === 'row') value.content.edit = { rowId: -1, content: 'old' }
    if (kind === 'attachment') value.content.attachments = [{ ref: 'bad' }]
    localStorage.setItem(key, kind === 'corrupt' ? '{' : JSON.stringify(value))
    expect(repository().select(context()).content.text).toBe('')
  })

  it('retains memory-only and quota-failed work and blocks destructive reload', () => {
    const drafts = repository(null)
    const { key } = drafts.select(context())
    drafts.write(key, text('keep'))
    expect(drafts.read(key)?.content.text).toBe('keep')
    expect(drafts.isSaved(key)).toBe(false)
    expect(drafts.$blocked.get()).toBe(true)
    const durable = repository()
    const otherKey = durable.select(context()).key
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota') })
    durable.write(otherKey, text('also keep'))
    expect(durable.read(otherKey)?.content.text).toBe('also keep')
    expect(durable.$blocked.get()).toBe(true)
    set.mockRestore()
    durable.flush()
    expect(durable.isSaved(otherKey)).toBe(true)
    expect(durable.$blocked.get()).toBe(false)
  })

  it('does not evict unfinished work at the record or UTF-8 byte limit', () => {
    const drafts = repository()
    for (let index = 0; index < 50; index++) drafts.write(drafts.select(context(String(index))).key, text('keep'))
    const key = drafts.select(context('overflow')).key
    drafts.write(key, text('fifty-first'))
    expect(drafts.isSaved(key)).toBe(false)
    expect(drafts.read(key)?.content.text).toBe('fifty-first')
    expect(repository().list()).toHaveLength(50)
    const oversized = drafts.select(context('large')).key
    drafts.write(oversized, text('😀'.repeat(300_000)))
    expect(drafts.isSaved(oversized)).toBe(false)
    expect(drafts.read(oversized)?.content.text.length).toBe(600_000)
  })

  it('promotes a provisional record without overwriting an existing destination', () => {
    const drafts = repository()
    const source = drafts.select({ ...context('provisional'), provisional: true })
    const target = drafts.select(context('stored'))
    drafts.write(source.key, text('new draft'))
    drafts.write(target.key, text('previous draft'))
    drafts.promote(source.key, context('stored'))
    expect(drafts.read(target.key)?.content.text).toBe('previous draft')
    expect(drafts.read(target.key)?.recoveries[0].content.text).toBe('new draft')
    expect(localStorage.getItem(source.key)).toBeNull()
  })

  it('keeps newer text when settling a pending submission and recovers failures explicitly', () => {
    const drafts = repository()
    const { key } = drafts.select(context())
    drafts.write(key, text('first'))
    const first = drafts.beginSubmission(key)!
    expect(drafts.$blocked.get()).toBe(true)
    drafts.write(key, text('next'))
    drafts.settleSubmission(key, first, 'failed')
    expect(drafts.read(key)?.content.text).toBe('next')
    expect(drafts.read(key)?.recoveries[0].content.text).toBe('first')
    drafts.restore(key, first)
    expect(drafts.read(key)?.content.text).toBe('first')
    expect(drafts.read(key)?.recoveries[0].content.text).toBe('next')
    const second = drafts.beginSubmission(key)!
    drafts.write(key, text('third'))
    drafts.settleSubmission(key, second, 'success')
    expect(drafts.read(key)?.content.text).toBe('third')
  })

  it('marks a restarted pending submission uncertain without resending it', () => {
    const drafts = repository()
    const { key } = drafts.select(context())
    drafts.write(key, text('possibly delivered'))
    drafts.beginSubmission(key)
    const fresh = repository()
    expect(fresh.read(key)?.recoveries[0].status).toBe('uncertain')
    expect(fresh.read(key)?.content.text).toBe('')
  })

  it('preserves another tab revision rather than silently overwriting it', () => {
    const one = repository()
    const { key } = one.select(context())
    one.write(key, text('original'))
    const two = repository()
    two.write(key, text('second tab'))
    one.write(key, text('first tab'))
    expect(one.read(key)?.content.text).toBe('first tab')
    expect(one.read(key)?.recoveries.some(item => item.content.text === 'second tab')).toBe(true)
  })

  it('preserves a concurrent storage event as a conflict copy', () => {
    const one = repository()
    const { key } = one.select(context())
    one.write(key, text('first tab'))
    const two = repository()
    two.write(key, text('second tab'))
    one.storageChanged(new StorageEvent('storage', { key, newValue: localStorage.getItem(key) }))
    expect(one.read(key)?.recoveries.some(item => item.content.text === 'first tab')).toBe(true)
  })

  it('keeps attachment metadata but no raw files, and blocks updates for those records', () => {
    const drafts = repository()
    const { key } = drafts.select(context())
    drafts.write(key, { ...text('prompt'), attachments: [{ ref: '@file:a', name: 'a.txt', type: 'text/plain', size: 5, runtimeId: 'runtime' }] })
    expect(drafts.$blocked.get()).toBe(true)
    expect(repository().read(key)?.content.attachments[0].name).toBe('a.txt')
    drafts.write(key, text('prompt'))
    expect(drafts.$blocked.get()).toBe(false)
  })

  it('clears all record kinds on local logout and rejects late settlement', () => {
    const drafts = repository()
    const { key } = drafts.select(context())
    drafts.write(key, text('private'))
    const id = drafts.beginSubmission(key)!
    drafts.clearOwner()
    drafts.setOwner({ ...owner, locked: true })
    drafts.settleSubmission(key, id, 'failed')
    expect(drafts.list()).toEqual([])
    expect(localStorage.getItem(key)).toBeNull()
  })
})


it('retires pending callbacks on authentication changes even for the same account', () => {
  const drafts = repository()
  const { key } = drafts.select(context())
  drafts.write(key, text('before reauthentication'))
  const id = drafts.beginSubmission(key)!
  drafts.setOwner({ ...owner, generation: 2, locked: true })
  drafts.setOwner({ ...owner, generation: 3 })
  drafts.settleSubmission(key, id, 'success')
  expect(drafts.read(key)?.recoveries[0].status).toBe('uncertain')
})

it('retains a draft when removing its stored record fails', () => {
  const drafts = repository()
  const { key } = drafts.select(context())
  drafts.write(key, text('stored'))
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
  drafts.discard(key)
  expect(drafts.$blocked.get()).toBe(true)
  expect(drafts.isSaved(key)).toBe(false)
  remove.mockRestore()
  drafts.flush()
  expect(localStorage.getItem(key)).toBeNull()
  expect(drafts.$blocked.get()).toBe(false)
})


it.each(['success', 'failed'] as const)('settles a %s submission after its provisional draft is promoted', outcome => {
  const drafts = repository()
  const provisional = { ...context('unlinked'), provisional: true }
  const { key } = drafts.select(provisional)
  drafts.write(key, text('first message'))
  const id = drafts.beginSubmission(key)!
  const destination = drafts.promote(key, context('durable'))
  drafts.settleSubmission(key, id, outcome)
  expect(drafts.read(destination)?.recoveries.some(item => item.status === 'pending')).toBe(false)
  if (outcome === 'failed') {
    drafts.restore(key, id)
    expect(drafts.read(destination)?.content.text).toBe('first message')
  } else expect(drafts.read(destination)?.recoveries).toEqual([])
})

it('releases an imported pending snapshot when another tab removes the stored record', () => {
  const origin = repository()
  const { key } = origin.select(context())
  origin.write(key, text('delivery may have happened'))
  origin.beginSubmission(key)
  const other = repository()
  other.storageChanged(new StorageEvent('storage', { key, newValue: localStorage.getItem(key) }))
  expect(other.read(key)?.recoveries[0].status).toBe('pending')
  localStorage.removeItem(key)
  other.storageChanged(new StorageEvent('storage', { key, newValue: null }))
  expect(other.read(key)?.recoveries[0].status).toBe('uncertain')
  expect(other.isSaved(key)).toBe(false)
  expect(other.$blocked.get()).toBe(true)
})

it('does not retire its own running submission when another tab removes storage', () => {
  const drafts = repository()
  const { key } = drafts.select(context())
  drafts.write(key, text('still running'))
  const id = drafts.beginSubmission(key)!
  localStorage.removeItem(key)
  drafts.storageChanged(new StorageEvent('storage', { key, newValue: null }))
  expect(drafts.read(key)?.recoveries[0].status).toBe('pending')
  drafts.settleSubmission(key, id, 'success')
  expect(drafts.read(key)?.recoveries).toEqual([])
})

it('rejects writes and stale storage events before another tab’s logout event arrives', () => {
  const one = repository()
  const { key } = one.select(context())
  one.write(key, text('private'))
  const raw = localStorage.getItem(key)!
  const two = repository()
  expect(two.clearOwner()).toBe(true)
  one.write(key, text('late typing'))
  one.storageChanged(new StorageEvent('storage', { key, newValue: raw }))
  expect(localStorage.getItem(key)).toBeNull()
  expect(one.read(key)).toBeNull()
  const marker = Object.keys(localStorage).find(key => key.startsWith('hermes.drafts.logout:'))!
  one.storageChanged(new StorageEvent('storage', { key: marker, newValue: localStorage.getItem(marker) }))
  expect(one.list()).toEqual([])
  expect(one.select(context()).content.text).toBe('')
})

it('derives recovery profile labels from the validated key instead of untrusted payload fields', () => {
  const drafts = repository()
  const { key } = drafts.select(context('one', 'work'))
  drafts.write(key, text('work draft'))
  const raw = JSON.parse(localStorage.getItem(key)!)
  raw.profile = 'fabricated'
  localStorage.setItem(key, JSON.stringify(raw))
  expect(repository().read(key)?.profile).toBe('work')
})

it('removes malformed account-owned records on logout', () => {
  const drafts = repository()
  const { key } = drafts.select(context())
  localStorage.setItem(key, '{broken')
  expect(drafts.clearOwner()).toBe(true)
  expect(localStorage.getItem(key)).toBeNull()
})

it('reports failed logout removal without exposing the cleared memory copy', () => {
  const drafts = repository()
  const { key } = drafts.select(context())
  drafts.write(key, text('private'))
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
  expect(drafts.clearOwner()).toBe(false)
  expect(drafts.list()).toEqual([])
})
