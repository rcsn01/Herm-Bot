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
  rekeyRoomSessionProvenance,
  renameRoomState,
  prepareGroupStateForConnection,
  removeGroupPromptForConnection,
  setGroupSyncScheduler,
  replaceGroupChats,
  updateGroupChat,
  type GroupChatRoom
} from './group-store'
import type { GroupMember, GroupMessage } from './group-model'

const STORAGE_KEY_V4 = 'hermes.group-chats.v4'
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
  $groupPrompts.set({})
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
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_V4)!) as Record<string, GroupChatRoom>
    expect(Object.keys(stored).sort()).toEqual(['id:r-1', 'name:Room'])
    expect(stored['name:Room'].running).toBe(false)
    expect(stored['name:Room'].turn).toBeNull()
    expect(stored['name:Room'].epoch).toBe(2)
    expect(stored['name:Room'].sessions).toBeUndefined()
    expect(stored['name:Room'].stranded).toBeUndefined()
    expect(stored['id:r-1'].roomId).toBe('r-1')
  })

  it('persists a tagged session map and stranded markers, and a tag with empty maps', () => {
    $groupChats.set({
      'id:tagged': room({
        name: 'Tagged', log: [memberEntry('ada', 'x')], roomId: 'tagged',
        sessionConnectionKey: 'https://gw-a.test', sessions: { ada: 'stored-1' },
        stranded: { ada: { before: 0, thread: 't1' } }
      }),
      'id:empty-maps': room({
        name: 'Empty maps', log: [memberEntry('ada', 'x')], roomId: 'empty-maps',
        sessionConnectionKey: 'https://gw-a.test'
      }),
      'id:untagged': room({
        name: 'Untagged', log: [memberEntry('ada', 'x')], roomId: 'untagged',
        sessions: { ada: 'nowhere' }, stranded: { ada: 0 }
      })
    })
    const durable = durableGroupChatRooms($groupChats.get())
    expect(durable['id:tagged']).toMatchObject({
      sessionConnectionKey: 'https://gw-a.test', sessions: { ada: 'stored-1' }, stranded: { ada: { before: 0, thread: 't1' } }
    })
    expect(durable['id:empty-maps']).toMatchObject({ sessionConnectionKey: 'https://gw-a.test', sessions: {}, stranded: {} })
    // An untagged record keeps no session ids or stranded markers.
    expect(durable['id:untagged'].sessionConnectionKey).toBeUndefined()
    expect(durable['id:untagged'].sessions).toBeUndefined()
    expect(durable['id:untagged'].stranded).toBeUndefined()
  })

  it('rehydrates the durable shape at import time', async () => {
    updateGroupChat('name:Room', r => ({ ...r, log: [memberEntry('ada', 'x')], running: true, turn: 'ada' }))
    expect(localStorage.getItem(STORAGE_KEY_V4)).not.toBeNull()
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
  it('re-keys holds and watermarks while leaving session provenance to its policy operation', () => {
    const seeded = room({
      members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
      sessionConnectionKey: 'https://gw-a.test',
      holds: { research: { at: 1, thread: 't1' } },
      sessions: { research: 'stored-1' },
      stranded: { research: { before: 0, thread: 'legacy' } },
      watermarks: { 't1::research': 5, 't2::ada': 1 }
    })
    const next = rekeyRoomCoordination(seeded)
    expect(next.holds).toEqual({ 'gw-2::research': { at: 1, thread: 't1' } })
    expect(next.sessions).toEqual({ research: 'stored-1' })
    expect(next.stranded).toEqual({ research: { before: 0, thread: 'legacy' } })
    expect(next.watermarks).toEqual({ 't1::gw-2::research': 5, 't2::ada': 1 })
    expect(next.sessionConnectionKey).toBe('https://gw-a.test')

    const scoped = rekeyRoomSessionProvenance(next)
    expect(scoped.sessions).toEqual({ 'gw-2::research': 'stored-1' })
    expect(scoped.stranded).toEqual({ 'gw-2::research': { before: 0, thread: 'legacy' } })
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
      'name:Old::ada': { at: 1, kind: 'clarify', connectionKey: 'gw-a', member: 'ada', memberKey: 'ada', question: '?', requestId: 'p1', roomKey: 'name:Old' }
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
      'name:Old::ada': { at: 1, kind: 'clarify', connectionKey: 'gw-a', member: 'ada', memberKey: 'ada', question: '?', requestId: 'p1', roomKey: 'name:Old' },
      'name:New::ada': { at: 2, kind: 'approval', connectionKey: 'gw-a', member: 'ada', memberKey: 'ada', question: 'ok?', requestId: 'p2', roomKey: 'name:New' }
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

describe('storage v1/v2/v3 → v4', () => {
  it('migrates v1 coordination state to the qualified member keys and drops session-bound fields', async () => {
    localStorage.setItem(STORAGE_KEY_V1, JSON.stringify({
      Room: {
        name: 'Room',
        log: [memberEntry('research', 'x')],
        members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
        watermarks: { 't1::research': 3, 't1::ada': 1 },
        holds: { research: { at: 1, thread: 't1' } },
        // Legacy session-bound fields have no recorded Gateway owner — even a
        // legacy record carrying an unexpected tag loses the whole trio.
        sessionConnectionKey: 'https://legacy.test',
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
    expect(migrated.sessionConnectionKey).toBeUndefined()
    expect(migrated.sessions).toBeUndefined()
    expect(migrated.stranded).toBeUndefined()
    expect(migrated.watermarks).toEqual({ 't1::gw-2::research': 3, 't1::ada': 1 })
    // Runtime state is stripped by the durable guards.
    expect(migrated.running).toBe(false)
    expect(migrated.turn).toBeNull()
    // v1 stays untouched as the rollback copy; nothing is written at load.
    expect(localStorage.getItem(STORAGE_KEY_V1)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V2)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V4)).toBeNull()
  })

  it('re-keys the v2 map to durable keys without re-keying coordination or keeping session fields', async () => {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify({
      Room: {
        name: 'Room',
        roomId: 'r-1',
        log: [memberEntry('research', 'x')],
        members: [{ name: 'research', connectionId: 'gw-2', sourceScoped: true }],
        watermarks: { 't1::gw-2::research': 3 },
        holds: { 'gw-2::research': { at: 1 } },
        sessionConnectionKey: 'https://legacy.test',
        sessions: { 'gw-2::research': 'stored-1' },
        stranded: { 'gw-2::research': { before: 0, thread: 'legacy' } },
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
    expect(loaded.sessionConnectionKey).toBeUndefined()
    expect(loaded.sessions).toBeUndefined()
    expect(loaded.stranded).toBeUndefined()
    // v2 stays untouched as the rollback copy; nothing is written at load.
    expect(localStorage.getItem(STORAGE_KEY_V2)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V4)).toBeNull()
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

  it('migrates a v3 room without its session-bound fields and writes v4 only on the next persist', async () => {
    const legacy = JSON.stringify({
      'id:r-1': {
        name: 'Room',
        roomId: 'r-1',
        log: [memberEntry('ada', 'kept')],
        members: [{ name: 'ada' }],
        watermarks: { 't1::ada': 2 },
        holds: { ada: { at: 1, thread: 't1' } },
        image: 'img',
        syncRevision: 4,
        sessionConnectionKey: 'https://legacy.test',
        sessions: { ada: 'stored-legacy' },
        stranded: { ada: { before: 0, thread: 't1' } },
        epoch: 1,
        running: true,
        turn: 'ada'
      }
    })
    localStorage.setItem(STORAGE_KEY_V3, legacy)
    vi.resetModules()
    const fresh = await import('./group-store')
    const migrated = fresh.$groupChats.get()['id:r-1']
    // The whole room survives except the session-bound trio.
    expect(migrated).toMatchObject({
      name: 'Room', roomId: 'r-1', image: 'img', syncRevision: 4, epoch: 1,
      log: [memberEntry('ada', 'kept')], members: [{ name: 'ada' }],
      watermarks: { 't1::ada': 2 }, holds: { ada: { at: 1, thread: 't1' } }
    })
    expect(migrated.sessionConnectionKey).toBeUndefined()
    expect(migrated.sessions).toBeUndefined()
    expect(migrated.stranded).toBeUndefined()
    // Load writes nothing: v4 is absent and v3 is byte-for-byte unchanged.
    expect(localStorage.getItem(STORAGE_KEY_V4)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_V3)).toBe(legacy)

    // A later normal persistence event writes v4.
    fresh.updateGroupChat('id:r-1', r => r)
    expect(localStorage.getItem(STORAGE_KEY_V4)).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_V4)!)['id:r-1'].log).toHaveLength(1)
    expect(localStorage.getItem(STORAGE_KEY_V3)).toBe(legacy)
  })

  it('loads no rooms from a present but malformed v4 value and never falls back to v3', async () => {
    localStorage.setItem(STORAGE_KEY_V3, JSON.stringify({
      'name:Room': room({ log: [memberEntry('ada', 'x')] })
    }))
    for (const malformed of ['', 'not json', 'null', '[1, 2]', '"a string"']) {
      localStorage.setItem(STORAGE_KEY_V4, malformed)
      vi.resetModules()
      const fresh = await import('./group-store')
      expect(Object.keys(fresh.$groupChats.get()), `v4=${JSON.stringify(malformed)}`).toEqual([])
    }
  })

  it('revalidates v4 session provenance per room without discarding room content', async () => {
    localStorage.setItem(STORAGE_KEY_V4, JSON.stringify({
      'id:tagged': {
        name: 'Tagged', roomId: 'tagged', log: [memberEntry('ada', 'x')], members: [{ name: 'ada' }],
        watermarks: {}, epoch: 0,
        sessionConnectionKey: 'https://gw-a.test', sessions: { ada: 'stored-1' },
        stranded: { ada: { before: 0, thread: 't1' } }
      },
      'id:malformed': {
        name: 'Malformed', roomId: 'malformed', log: [memberEntry('ada', 'y')], members: [{ name: 'ada' }],
        watermarks: {}, epoch: 0,
        sessionConnectionKey: 'https://gw-a.test', sessions: { ada: '' }, stranded: { ada: -1 }
      }
    }))
    vi.resetModules()
    const fresh = await import('./group-store')
    const tagged = fresh.$groupChats.get()['id:tagged']
    expect(tagged.sessionConnectionKey).toBe('https://gw-a.test')
    expect(tagged.sessions).toEqual({ ada: 'stored-1' })
    expect(tagged.stranded).toEqual({ ada: { before: 0, thread: 't1' } })
    const malformed = fresh.$groupChats.get()['id:malformed']
    expect(malformed.log).toHaveLength(1)
    expect(malformed.sessionConnectionKey).toBeUndefined()
    expect(malformed.sessions).toBeUndefined()
    expect(malformed.stranded).toBeUndefined()
  })
})

describe('connection-aware prompt storage', () => {
  it('removes only the observed prompt owned by the requested connection', () => {
    const same = {
      at: 1, connectionKey: 'https://gw-a.test', roomKey: 'name:Room', kind: 'clarify' as const,
      member: 'ada', memberKey: 'ada', question: '?', requestId: 'q-a'
    }
    const foreign = { ...same, connectionKey: 'https://gw-b.test', requestId: 'q-b' }
    $groupPrompts.set({ same, foreign })

    expect(removeGroupPromptForConnection('foreign', 'q-b', 'https://gw-a.test')).toBe(false)
    expect(removeGroupPromptForConnection('same', 'stale', 'https://gw-a.test')).toBe(false)
    expect($groupPrompts.get()).toEqual({ same, foreign })
    expect(removeGroupPromptForConnection('same', 'q-a', 'https://gw-a.test')).toBe(true)
    expect($groupPrompts.get()).toEqual({ foreign })
  })
})

describe('connection cleanup', () => {
  it('clears mismatched and untagged session state without touching shared room state or scheduling a write', () => {
    const scheduled: string[] = []
    setGroupSyncScheduler(roomKey => scheduled.push(roomKey))
    const log = [memberEntry('ada', 'hello')]
    replaceGroupChats({
      'id:matching': room({
        name: 'Matching', roomId: 'matching', log,
        sessionConnectionKey: 'https://gw-a.test', sessions: { ada: 'stored-a' },
        stranded: { ada: { before: 0, thread: 't1' } },
        holds: { ada: { at: 1 } }, watermarks: { 't1::ada': 1 }, epoch: 3
      }),
      'id:foreign': room({
        name: 'Foreign', roomId: 'foreign', log: [...log],
        sessionConnectionKey: 'https://gateway-b.test', sessions: { ada: 'stored-b' },
        stranded: { ada: 0 },
        holds: { ada: { at: 1 } }, watermarks: { 't1::ada': 1 }, epoch: 3, turn: 'ada', running: true
      }),
      'id:untagged': room({
        name: 'Untagged', roomId: 'untagged', log: [...log],
        sessions: { ada: 'orphan' }, stranded: { ada: 0 },
        holds: { ada: { at: 1 } }, watermarks: { 't1::ada': 1 }, epoch: 3
      })
    })
    $groupActivity.set({ 'id:foreign': [{ at: 1, epoch: 0, kind: 'working', member: 'ada', thread: 't1' }] })
    $groupNeedsYou.set({ 'id:foreign': true })
    const sameKeyPrompt = {
      at: 1, connectionKey: 'https://gw-a.test', roomKey: 'id:matching', kind: 'clarify' as const,
      member: 'ada', memberKey: 'ada', question: '?', requestId: 'q-a'
    }
    $groupPrompts.set({
      same: sameKeyPrompt,
      foreign: { ...sameKeyPrompt, connectionKey: 'https://gateway-b.test', requestId: 'q-b' },
      untagged: { ...sameKeyPrompt, connectionKey: undefined as unknown as string, requestId: 'q-untagged' }
    })

    prepareGroupStateForConnection('https://gw-a.test')

    const matching = $groupChats.get()['id:matching']
    expect(matching.sessionConnectionKey).toBe('https://gw-a.test')
    expect(matching.sessions).toEqual({ ada: 'stored-a' })
    expect(matching.stranded).toEqual({ ada: { before: 0, thread: 't1' } })

    const foreign = $groupChats.get()['id:foreign']
    expect(foreign.sessionConnectionKey).toBeUndefined()
    expect(foreign.sessions).toBeUndefined()
    expect(foreign.stranded).toBeUndefined()
    // Every shared field survives.
    expect(foreign.log).toEqual(log)
    expect(foreign.members).toEqual([{ name: 'ada' }])
    expect(foreign.watermarks).toEqual({ 't1::ada': 1 })
    expect(foreign.holds).toEqual({ ada: { at: 1 } })
    expect(foreign.epoch).toBe(3)
    expect(foreign.turn).toBe('ada')
    expect(foreign.running).toBe(true)

    const untagged = $groupChats.get()['id:untagged']
    expect(untagged.sessionConnectionKey).toBeUndefined()
    expect(untagged.sessions).toBeUndefined()
    expect(untagged.stranded).toBeUndefined()
    expect(untagged.log).toEqual(log)

    // Runtime feeds are untouched and no mirror write was scheduled.
    expect($groupActivity.get()['id:foreign']).toHaveLength(1)
    expect($groupNeedsYou.get()['id:foreign']).toBe(true)
    expect($groupPrompts.get()).toEqual({ same: sameKeyPrompt })
    expect($groupPrompts.get().same).toBe(sameKeyPrompt)
    expect(scheduled).toEqual([])

    // The sweep is durable: v4 storage carries no cleared provenance.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_V4)!) as Record<string, GroupChatRoom>
    expect(stored['id:matching'].sessionConnectionKey).toBe('https://gw-a.test')
    expect(stored['id:foreign'].sessions).toBeUndefined()
    expect(stored['id:untagged'].stranded).toBeUndefined()
    setGroupSyncScheduler(null)
  })

  it('is a no-op without a notification or a persist when every room already belongs to the connection', () => {
    replaceGroupChats({
      'id:matching': room({
        name: 'Matching', roomId: 'matching', log: [memberEntry('ada', 'x')],
        sessionConnectionKey: 'https://gw-a.test', sessions: { ada: 'stored-a' }
      })
    })
    const persisted = localStorage.getItem(STORAGE_KEY_V4)!
    const listener = vi.fn()
    const promptListener = vi.fn()
    const unsubscribe = $groupChats.listen(listener)
    const unsubscribePrompts = $groupPrompts.listen(promptListener)
    try {
      prepareGroupStateForConnection('https://gw-a.test')
      expect(listener).not.toHaveBeenCalled()
      expect(promptListener).not.toHaveBeenCalled()
      expect(localStorage.getItem(STORAGE_KEY_V4)).toBe(persisted)
      expect($groupChats.get()['id:matching'].sessions).toEqual({ ada: 'stored-a' })
    } finally {
      unsubscribe()
      unsubscribePrompts()
    }
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