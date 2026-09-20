import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $groupChats,
  $groupNeedsYou,
  GROUP_LOG_RETAIN,
  adoptMirrorRoom,
  appendGroupChatEntry,
  durableGroupChatRooms,
  rekeyRoomCoordination,
  replaceGroupChats,
  updateGroupChat,
  type GroupChatRoom
} from './group-store'
import type { GroupMember, GroupMessage } from './group-model'

const STORAGE_KEY_V2 = 'hermes.group-chats.v2'
const STORAGE_KEY_V1 = 'hermes.group-chats.v1'

function room(overrides: Partial<GroupChatRoom> = {}): GroupChatRoom {
  return {
    name: 'Room',
    log: [],
    members: [{ name: 'ada' }],
    watermarks: {},
    epoch: 0,
    running: false,
    ...overrides
  }
}

function memberEntry(name: string, text: string, at = 1000): GroupMessage {
  return { at, from: { kind: 'member', name }, id: `m-${name}-${text}`, text, thread: 'legacy' }
}

function userEntry(text: string, at = 1000): GroupMessage {
  return { at, from: { kind: 'user', name: 'You' }, id: `u-${text}`, text, thread: 'legacy' }
}

beforeEach(() => {
  localStorage.clear()
  $groupChats.set({})
  $groupNeedsYou.set({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('duplicate-append guard (#93127)', () => {
  it('drops a byte-identical member echo back-to-back inside the 10-minute window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const first = appendGroupChatEntry('Room', { kind: 'member', name: 'ada' }, 'hello')
    vi.setSystemTime(10 * 60 * 1000 - 1) // still inside the window
    const echo = appendGroupChatEntry('Room', { kind: 'member', name: 'ada' }, 'hello')
    expect(echo).toBe(first)
    expect($groupChats.get().Room.log).toHaveLength(1)
  })

  it('never dedupes user entries', () => {
    appendGroupChatEntry('Room', { kind: 'user', name: 'You' }, 'again')
    appendGroupChatEntry('Room', { kind: 'user', name: 'You' }, 'again')
    expect($groupChats.get().Room.log).toHaveLength(2)
  })

  it('keeps the same member text after the window has passed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    appendGroupChatEntry('Room', { kind: 'member', name: 'ada' }, 'hello')
    vi.setSystemTime(10 * 60 * 1000 + 1) // one ms past the window
    appendGroupChatEntry('Room', { kind: 'member', name: 'ada' }, 'hello')
    expect($groupChats.get().Room.log).toHaveLength(2)
  })

  it('keeps the same text on a different thread or from a different member', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    appendGroupChatEntry('Room', { kind: 'member', name: 'ada' }, 'hello', 't1')
    appendGroupChatEntry('Room', { kind: 'member', name: 'ada' }, 'hello', 't2')
    appendGroupChatEntry('Room', { kind: 'member', name: 'scout' }, 'hello', 't1')
    expect($groupChats.get().Room.log).toHaveLength(3)
  })
})

describe('log retention', () => {
  it('bounds the log at GROUP_LOG_RETAIN and shifts every watermark index-consistently', () => {
    const log = Array.from({ length: GROUP_LOG_RETAIN + 6 }, (_, i) => memberEntry('ada', `m${i}`))
    replaceGroupChats({
      Room: room({ log, watermarks: { 'Room::ada': 90, 'Room::scout': 3 } })
    })
    const next = updateGroupChat('Room', r => r)
    const drop = log.length - GROUP_LOG_RETAIN
    expect(next.log).toHaveLength(GROUP_LOG_RETAIN)
    expect(next.watermarks['Room::ada']).toBe(90 - drop)
    expect(next.watermarks['Room::scout']).toBe(0)
    // Index-consistent: the watermark still points at the same entry object.
    expect(next.log[next.watermarks['Room::ada']]).toBe(log[90])
  })
})

describe('persistence', () => {
  it('writes the durable shape: runtime state stripped, empty stubs without identity dropped', () => {
    $groupChats.set({
      Room: room({ log: [memberEntry('ada', 'x')], running: true, turn: 'ada', epoch: 2 }),
      Stub: room({ log: [] }),
      'Just created': room({ log: [], roomId: 'r-1', members: [{ name: 'a' }, { name: 'b' }] })
    })
    updateGroupChat('Room', r => r) // any write persists the whole store
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_V2)!) as Record<string, GroupChatRoom>
    expect(Object.keys(stored).sort()).toEqual(['Just created', 'Room'])
    expect(stored.Room.running).toBe(false)
    expect(stored.Room.turn).toBeNull()
    expect(stored.Room.epoch).toBe(2)
    expect(stored['Just created'].roomId).toBe('r-1')
  })

  it('rehydrates the durable shape at import time', async () => {
    updateGroupChat('Room', r => ({ ...r, log: [memberEntry('ada', 'x')], running: true, turn: 'ada' }))
    expect(localStorage.getItem(STORAGE_KEY_V2)).not.toBeNull()
    vi.resetModules()
    const fresh = await import('./group-store')
    const rehydrated = fresh.$groupChats.get().Room
    expect(rehydrated.log).toHaveLength(1)
    expect(rehydrated.running).toBe(false)
    expect(rehydrated.turn).toBeNull()
  })

  it('adoptMirrorRoom is idempotent and seeds watermarks at zero', () => {
    const mirror = {
      name: 'Pulled',
      roomId: 'r-9',
      log: [memberEntry('ada', 'hi')],
      members: [{ name: 'ada' }]
    }
    adoptMirrorRoom(mirror)
    const first = $groupChats.get().Pulled
    expect(first.watermarks).toEqual({})
    expect(first.epoch).toBe(0)
    expect(first.running).toBe(false)
    adoptMirrorRoom(mirror)
    expect($groupChats.get().Pulled).toBe(first)
  })
})

describe('durableGroupChatRooms', () => {
  it('strips runtime state and drops identity-less empty stubs', () => {
    const durable = durableGroupChatRooms({
      Real: room({ log: [memberEntry('ada', 'x')], running: true, turn: 'ada', holds: { ada: { at: 1 } } }),
      Stub: room({ log: [] }),
      Created: room({ log: [], roomId: 'r-2', members: [{ name: 'a' }] })
    })
    expect(Object.keys(durable).sort()).toEqual(['Created', 'Real'])
    expect(durable.Real).toMatchObject({ running: false, turn: null, syncRevision: 0 })
    expect(durable.Created.roomId).toBe('r-2')
  })
})

describe('rekeyRoomCoordination', () => {
  it('moves coordination state when a row gains a connectionId', () => {
    const next = rekeyRoomCoordination(room({
      members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
      holds: { research: { at: 1, thread: 't1' } },
      sessions: { research: 'stored-1' },
      stranded: { research: { before: 0, thread: 'legacy' } },
      watermarks: { 't1::research': 5, 't2::ada': 1 }
    }))
    expect(next.holds).toEqual({ 'gw-2::research': { at: 1, thread: 't1' } })
    expect(next.sessions).toEqual({ 'gw-2::research': 'stored-1' })
    expect(next.stranded).toEqual({ 'gw-2::research': { before: 0, thread: 'legacy' } })
    expect(next.watermarks).toEqual({ 't1::gw-2::research': 5, 't2::ada': 1 })
  })

  it('is a no-op for rows already keyed qualified', () => {
    const seeded = room({
      members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
      holds: { 'gw-2::research': { at: 1 } }
    })
    expect(rekeyRoomCoordination(seeded).holds).toEqual({ 'gw-2::research': { at: 1 } })
  })

  it('leaves the bare entry in place when the qualified key already exists', () => {
    const next = rekeyRoomCoordination(room({
      members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
      holds: { research: { at: 1 }, 'gw-2::research': { at: 2 } }
    }))
    expect(next.holds).toEqual({ research: { at: 1 }, 'gw-2::research': { at: 2 } })
  })

  it('leaves the maps alone when the member list lost its rows', () => {
    const seeded = room({ members: [], holds: { research: { at: 1 } } })
    expect(rekeyRoomCoordination(seeded).holds).toEqual({ research: { at: 1 } })
  })
})

describe('storage v1 → v2', () => {
  it('migrates v1 coordination state to the qualified member keys on load', async () => {
    localStorage.setItem(STORAGE_KEY_V1, JSON.stringify({
      Room: {
        name: 'Room',
        log: [memberEntry('research', 'x')],
        members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
        watermarks: { 't1::research': 3, 't1::ada': 1 },
        holds: { research: { at: 1, thread: 't1' } },
        sessions: { research: 'stored-1' },
        stranded: { research: { before: 0, thread: 'legacy' } },
        epoch: 2,
        running: true,
        turn: 'research'
      }
    }))
    vi.resetModules()
    const fresh = await import('./group-store')
    const migrated = fresh.$groupChats.get().Room
    expect(migrated.holds).toEqual({ 'gw-2::research': { at: 1, thread: 't1' } })
    expect(migrated.sessions).toEqual({ 'gw-2::research': 'stored-1' })
    expect(migrated.stranded).toEqual({ 'gw-2::research': { before: 0, thread: 'legacy' } })
    expect(migrated.watermarks).toEqual({ 't1::gw-2::research': 3, 't1::ada': 1 })
    // Runtime state is stripped by the durable guards.
    expect(migrated.running).toBe(false)
    expect(migrated.turn).toBeNull()
    // v1 stays untouched as the rollback copy.
    expect(localStorage.getItem(STORAGE_KEY_V1)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V2)).toBeNull()
  })

  it('loads v2 verbatim without re-keying', async () => {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify({
      Room: {
        name: 'Room',
        log: [memberEntry('research', 'x')],
        members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
        watermarks: { 't1::gw-2::research': 3 },
        holds: { 'gw-2::research': { at: 1 } },
        sessions: { 'gw-2::research': 'stored-1' },
        epoch: 1,
        running: false,
        turn: null
      }
    }))
    vi.resetModules()
    const fresh = await import('./group-store')
    const loaded = fresh.$groupChats.get().Room
    expect(loaded.watermarks).toEqual({ 't1::gw-2::research': 3 })
    expect(loaded.holds).toEqual({ 'gw-2::research': { at: 1 } })
    expect(loaded.sessions).toEqual({ 'gw-2::research': 'stored-1' })
  })

  it('keeps connectionless members and already-qualified rooms as no-ops across the load', async () => {
    localStorage.setItem(STORAGE_KEY_V1, JSON.stringify({
      Room: {
        name: 'Room',
        log: [memberEntry('research', 'x')],
        members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }, { name: 'ada' }],
        watermarks: { 't1::gw-2::research': 3, 't1::ada': 1 },
        epoch: 0,
        running: false,
        turn: null
      }
    }))
    vi.resetModules()
    const fresh = await import('./group-store')
    expect(fresh.$groupChats.get().Room.watermarks).toEqual({ 't1::gw-2::research': 3, 't1::ada': 1 })
  })
})

describe('needs-you badge', () => {
  it('sets the badge for member entries addressing @user, never for user entries', () => {
    appendGroupChatEntry('Room', { kind: 'member', name: 'ada' }, 'ping @user please')
    expect($groupNeedsYou.get().Room).toBe(true)
    $groupNeedsYou.set({})
    appendGroupChatEntry('Room', { kind: 'user', name: 'You' }, 'calling @user now')
    expect($groupNeedsYou.get().Room).toBeUndefined()
  })
})