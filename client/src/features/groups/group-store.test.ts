import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $groupActivity,
  $groupChats,
  $groupNeedsYou,
  $groupPrompts,
  GROUP_LOG_RETAIN,
  adoptMirrorRoom,
  appendGroupChatEntry,
  durableGroupChatRooms,
  getGroupRoom,
  rekeyRoomCoordination,
  renameRoomState,
  replaceGroupChats,
  updateGroupChat,
  type GroupChatRoom
} from './group-store'
import type { GroupMember, GroupMessage } from './group-model'

const STORAGE_KEY_V3 = 'hermes.group-chats.v3'
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
    const first = appendGroupChatEntry('name:Room', { kind: 'member', name: 'ada' }, 'hello')
    vi.setSystemTime(10 * 60 * 1000 - 1) // still inside the window
    const echo = appendGroupChatEntry('name:Room', { kind: 'member', name: 'ada' }, 'hello')
    expect(echo).toBe(first)
    expect($groupChats.get()['name:Room'].log).toHaveLength(1)
  })

  it('never dedupes user entries', () => {
    appendGroupChatEntry('name:Room', { kind: 'user', name: 'You' }, 'again')
    appendGroupChatEntry('name:Room', { kind: 'user', name: 'You' }, 'again')
    expect($groupChats.get()['name:Room'].log).toHaveLength(2)
  })

  it('keeps the same member text after the window has passed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    appendGroupChatEntry('name:Room', { kind: 'member', name: 'ada' }, 'hello')
    vi.setSystemTime(10 * 60 * 1000 + 1) // one ms past the window
    appendGroupChatEntry('name:Room', { kind: 'member', name: 'ada' }, 'hello')
    expect($groupChats.get()['name:Room'].log).toHaveLength(2)
  })

  it('keeps the same text on a different thread or from a different member', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    appendGroupChatEntry('name:Room', { kind: 'member', name: 'ada' }, 'hello', 't1')
    appendGroupChatEntry('name:Room', { kind: 'member', name: 'ada' }, 'hello', 't2')
    appendGroupChatEntry('name:Room', { kind: 'member', name: 'scout' }, 'hello', 't1')
    expect($groupChats.get()['name:Room'].log).toHaveLength(3)
  })
})

describe('log retention', () => {
  it('bounds the log at GROUP_LOG_RETAIN and shifts every watermark index-consistently', () => {
    const log = Array.from({ length: GROUP_LOG_RETAIN + 6 }, (_, i) => memberEntry('ada', `m${i}`))
    replaceGroupChats({
      'name:Room': room({ log, watermarks: { 'Room::ada': 90, 'Room::scout': 3 } })
    })
    const next = updateGroupChat('name:Room', r => r)
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
      'name:Room': room({ log: [memberEntry('ada', 'x')], running: true, turn: 'ada', epoch: 2 }),
      'name:Stub': room({ name: 'Stub', log: [] }),
      'id:r-1': room({ name: 'Just created', log: [], roomId: 'r-1', members: [{ name: 'a' }, { name: 'b' }] })
    })
    updateGroupChat('name:Room', r => r) // any write persists the whole store
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_V3)!) as Record<string, GroupChatRoom>
    expect(Object.keys(stored).sort()).toEqual(['id:r-1', 'name:Room'])
    expect(stored['name:Room'].running).toBe(false)
    expect(stored['name:Room'].turn).toBeNull()
    expect(stored['name:Room'].epoch).toBe(2)
    expect(stored['id:r-1'].roomId).toBe('r-1')
  })

  it('rehydrates the durable shape at import time', async () => {
    updateGroupChat('name:Room', r => ({ ...r, log: [memberEntry('ada', 'x')], running: true, turn: 'ada' }))
    expect(localStorage.getItem(STORAGE_KEY_V3)).not.toBeNull()
    vi.resetModules()
    const fresh = await import('./group-store')
    const rehydrated = fresh.$groupChats.get()['name:Room']
    expect(rehydrated.log).toHaveLength(1)
    expect(rehydrated.running).toBe(false)
    expect(rehydrated.turn).toBeNull()
  })

  it('adoptMirrorRoom is idempotent, keys by the durable room key, and seeds watermarks at zero', () => {
    const mirror = {
      key: 'id:r-9',
      name: 'Pulled',
      roomId: 'r-9',
      log: [memberEntry('ada', 'hi')],
      members: [{ name: 'ada' }]
    }
    adoptMirrorRoom(mirror)
    const first = $groupChats.get()['id:r-9']
    expect(first.watermarks).toEqual({})
    expect(first.epoch).toBe(0)
    expect(first.running).toBe(false)
    adoptMirrorRoom(mirror)
    expect($groupChats.get()['id:r-9']).toBe(first)
  })
})

describe('durableGroupChatRooms', () => {
  it('strips runtime state and drops identity-less empty stubs', () => {
    const durable = durableGroupChatRooms({
      'name:Real': room({ log: [memberEntry('ada', 'x')], running: true, turn: 'ada', holds: { ada: { at: 1 } } }),
      'name:Stub': room({ name: 'Stub', log: [] }),
      'id:r-2': room({ name: 'Created', log: [], roomId: 'r-2', members: [{ name: 'a' }] })
    })
    expect(Object.keys(durable).sort()).toEqual(['id:r-2', 'name:Real'])
    expect(durable['name:Real']).toMatchObject({ running: false, turn: null, syncRevision: 0 })
    expect(durable['id:r-2'].roomId).toBe('r-2')
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

describe('renameRoomState', () => {
  it('moves activity, prompts, and the needs-you flag to the new key', () => {
    $groupActivity.set({
      'name:Old': [{ at: 1, epoch: 0, kind: 'queued', member: 'ada', thread: 'legacy' }]
    })
    $groupPrompts.set({
      'name:Old::ada': { at: 1, kind: 'clarify', member: 'ada', memberKey: 'ada', question: '?', requestId: 'p1', roomKey: 'name:Old' }
    })
    $groupNeedsYou.set({ 'name:Old': true })

    renameRoomState('name:Old', 'name:New')

    expect(Object.keys($groupActivity.get())).toEqual(['name:New'])
    expect($groupActivity.get()['name:New']).toHaveLength(1)
    expect($groupPrompts.get()['name:New::ada'].roomKey).toBe('name:New')
    expect($groupPrompts.get()['name:Old::ada']).toBeUndefined()
    expect($groupNeedsYou.get()).toEqual({ 'name:New': true })
  })

  it('appends to a non-empty target activity list and never overwrites target-side prompts or badges', () => {
    $groupActivity.set({
      'name:Old': [{ at: 1, epoch: 0, kind: 'queued', member: 'ada', thread: 'legacy' }],
      'name:New': [{ at: 2, epoch: 0, kind: 'stopped', member: null, thread: null }]
    })
    $groupPrompts.set({
      'name:Old::ada': { at: 1, kind: 'clarify', member: 'ada', memberKey: 'ada', question: '?', requestId: 'p1', roomKey: 'name:Old' },
      'name:New::ada': { at: 2, kind: 'approval', member: 'ada', memberKey: 'ada', question: 'ok?', requestId: 'p2', roomKey: 'name:New' }
    })
    $groupNeedsYou.set({ 'name:Old': false, 'name:New': true })

    renameRoomState('name:Old', 'name:New')

    const activity = $groupActivity.get()['name:New']
    expect(activity).toHaveLength(2)
    expect(activity[0].kind).toBe('stopped')
    expect(activity[1].kind).toBe('queued')
    expect($groupPrompts.get()['name:New::ada'].requestId).toBe('p2')
    expect($groupPrompts.get()['name:Old::ada']).toBeUndefined()
    expect($groupNeedsYou.get()).toEqual({ 'name:New': true })
  })
})

describe('unknown-key stubs', () => {
  it('derives the display name from a name: key', () => {
    expect(getGroupRoom('name:Launch').name).toBe('Launch')
  })

  it('derives the roomId from an id: key so the stub matches its own map key', () => {
    const stub = getGroupRoom('id:r-7')
    expect(stub.name).toBe('id:r-7')
    expect(stub.roomId).toBe('r-7')
    updateGroupChat('id:r-7', r => r)
    expect(Object.keys($groupChats.get())).toEqual(['id:r-7'])
  })
})

describe('storage v1 → v2 → v3', () => {
  it('migrates v1 coordination state to the qualified member keys and re-keys the map on load', async () => {
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
    const migrated = fresh.$groupChats.get()['name:Room']
    expect(migrated.holds).toEqual({ 'gw-2::research': { at: 1, thread: 't1' } })
    expect(migrated.sessions).toEqual({ 'gw-2::research': 'stored-1' })
    expect(migrated.stranded).toEqual({ 'gw-2::research': { before: 0, thread: 'legacy' } })
    expect(migrated.watermarks).toEqual({ 't1::gw-2::research': 3, 't1::ada': 1 })
    // Runtime state is stripped by the durable guards.
    expect(migrated.running).toBe(false)
    expect(migrated.turn).toBeNull()
    // v1 stays untouched as the rollback copy; nothing is written at load.
    expect(localStorage.getItem(STORAGE_KEY_V1)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V2)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V3)).toBeNull()
  })

  it('re-keys the v2 map to durable keys without re-keying coordination', async () => {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify({
      Room: {
        name: 'Room',
        roomId: 'r-1',
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
    const loaded = fresh.$groupChats.get()['id:r-1']
    expect(loaded.name).toBe('Room')
    expect(loaded.watermarks).toEqual({ 't1::gw-2::research': 3 })
    expect(loaded.holds).toEqual({ 'gw-2::research': { at: 1 } })
    expect(loaded.sessions).toEqual({ 'gw-2::research': 'stored-1' })
    // v2 stays untouched as the rollback copy; nothing is written at load.
    expect(localStorage.getItem(STORAGE_KEY_V2)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V3)).toBeNull()
  })

  it('keeps roomId-less v2 rooms name-keyed', async () => {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify({
      Room: {
        name: 'Room',
        log: [memberEntry('research', 'x')],
        members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
        watermarks: { 't1::gw-2::research': 3 },
        epoch: 1,
        running: false,
        turn: null
      }
    }))
    vi.resetModules()
    const fresh = await import('./group-store')
    expect(fresh.$groupChats.get()['name:Room'].watermarks).toEqual({ 't1::gw-2::research': 3 })
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
    expect(fresh.$groupChats.get()['name:Room'].watermarks).toEqual({ 't1::gw-2::research': 3, 't1::ada': 1 })
  })
})

describe('needs-you badge', () => {
  it('sets the badge for member entries addressing @user, never for user entries', () => {
    appendGroupChatEntry('name:Room', { kind: 'member', name: 'ada' }, 'ping @user please')
    expect($groupNeedsYou.get()['name:Room']).toBe(true)
    $groupNeedsYou.set({})
    appendGroupChatEntry('name:Room', { kind: 'user', name: 'You' }, 'calling @user now')
    expect($groupNeedsYou.get()['name:Room']).toBeUndefined()
  })
})