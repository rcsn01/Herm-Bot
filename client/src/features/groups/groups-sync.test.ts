import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $groupChats, replaceGroupChats, type GroupChatRoom } from './group-store'
import { setGroupEngineRequest } from './group-engine'
import {
  assignLegacyThreads,
  groupChatGatewayJsonSize,
  groupChatRoomKey,
  groupChatSyncEntryKey,
  groupChatSyncSnapshot,
  mergeGroupChatSyncSnapshots,
  mergeRemoteGroupChatSnapshotIntoRooms,
  normalizeGroupChatSyncSnapshot,
  pullGroupChatState,
  scheduleGroupChatSync,
  startGroupChatSync,
  stopGroupChatSync,
  type GroupChatSyncSnapshot
} from './groups-sync'
import type { GroupMessage } from './group-model'

function userEntry(text: string, at = 1000, thread = 'legacy'): GroupMessage {
  return { at, from: { kind: 'user', name: 'You' }, id: `u-${text}`, text, thread }
}

function memberEntry(name: string, text: string, at = 2000, thread = 'legacy'): GroupMessage {
  return { at, from: { kind: 'member', name }, id: `m-${text}`, text, thread }
}

function room(overrides: Partial<GroupChatRoom> = {}): GroupChatRoom {
  return {
    name: 'Room',
    log: [],
    members: [{ name: 'research' }],
    watermarks: {},
    epoch: 0,
    running: false,
    ...overrides
  }
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({})
  stopGroupChatSync()
  startGroupChatSync()
})

describe('sizing', () => {
  it('charges commas and colons double and escapes non-ASCII wide', () => {
    // {"a":1} — the single ':' charges double, no comma present.
    expect(groupChatGatewayJsonSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length + 1)
    expect(groupChatGatewayJsonSize('é')).toBe(8) // quote + escaped é (6) + quote
    expect(groupChatGatewayJsonSize('𝄞')).toBe(14)
  })
})

describe('room keys', () => {
  it('keys by durable roomId when present, else by name', () => {
    expect(groupChatRoomKey('Launch', { roomId: 'r-1' })).toBe('id:r-1')
    expect(groupChatRoomKey('Launch', { roomId: null })).toBe('name:Launch')
    expect(groupChatRoomKey('Launch', {})).toBe('name:Launch')
  })
})

describe('entry keys', () => {
  it('keys by id when present, collapsing the synthetic legacy family', () => {
    expect(groupChatSyncEntryKey(userEntry('hi'))).toBe('id:u-hi')
    const noId = (thread?: string): GroupMessage => ({ at: 5, from: { kind: 'member', name: 'a' }, text: 'x', ...(thread ? { thread } : {}) })
    expect(groupChatSyncEntryKey(noId('legacy-3'))).toBe(groupChatSyncEntryKey(noId('legacy-7')))
    expect(groupChatSyncEntryKey(noId('legacy'))).toBe(groupChatSyncEntryKey(noId('legacy-1')))
    expect(groupChatSyncEntryKey(noId('t9'))).not.toBe(groupChatSyncEntryKey(noId('legacy')))
  })
})

describe('sync snapshot', () => {
  it('builds a v3 envelope with bounded logs, members, and text', () => {
    const longLog = Array.from({ length: 30 }, (_, i) => memberEntry('research', `msg ${i}`, i))
    replaceGroupChats({
      Room: room({ log: longLog, members: Array.from({ length: 9 }, (_, i) => ({ name: `bot${i}` })), syncRevision: 4 })
    })
    const snapshot = groupChatSyncSnapshot()
    const projected = snapshot.rooms['name:Room']
    expect(snapshot.version).toBe(3)
    expect(projected.log).toHaveLength(16)
    expect(projected.members).toHaveLength(6)
    expect(projected.revision).toBe(4)
    expect(projected.name).toBe('Room')
  })

  it('skips empty runtime tombstones and bounds deleted to 64', () => {
    const deleted: Record<string, number> = {}
    for (let i = 0; i < 70; i++) deleted[`name:gone-${i}`] = i
    const snapshot = groupChatSyncSnapshot({ Empty: room({ log: [] }) }, deleted)
    expect(Object.keys(snapshot.rooms)).toHaveLength(0)
    expect(Object.keys(snapshot.deleted ?? {})).toHaveLength(64)
  })

  it('truncates text and drops images past the char cap', () => {
    replaceGroupChats({
      Room: room({ log: [memberEntry('research', 'x'.repeat(5000))], image: 'z'.repeat(30000) })
    })
    const projected = groupChatSyncSnapshot().rooms['name:Room']
    expect(projected.log[0].text).toHaveLength(1200)
    expect(projected.image).toBeUndefined() // 30000 > 24000
  })

  it('shrinks logs then drops rooms to fit the byte cap', () => {
    const rooms: Record<string, GroupChatRoom> = {}
    for (let i = 0; i < 60; i++) {
      rooms[`Room ${i}`] = room({
        name: `Room ${i}`,
        log: Array.from({ length: 16 }, (_, j) => memberEntry('research', `${i}-${j}`.padEnd(300, 'y'), j))
      })
    }
    const snapshot = groupChatSyncSnapshot(rooms)
    expect(groupChatGatewayJsonSize(snapshot)).toBeLessThanOrEqual(48000)
  })
})

describe('normalize', () => {
  it('lifts v1/v2 name-keyed snapshots to the v3 shape', () => {
    const legacy = { version: 1, rooms: { Old: { log: [userEntry('hi')] } }, deleted: { Gone: 123 } }
    const norm = normalizeGroupChatSyncSnapshot(legacy as unknown as GroupChatSyncSnapshot)
    expect(norm.rooms['name:Old']?.name).toBe('Old')
    // v1 tombstones carry wall-clock ms and must not outrank revisions.
    expect(norm.deleted?.['name:Gone']).toBe(0)
  })
})

describe('merge snapshots', () => {
  it('unions logs idempotently on stable entry keys', () => {
    const local: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'name:Room': { name: 'Room', revision: 1, log: [userEntry('one')] } }
    }
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'name:Room': { name: 'Room', revision: 1, log: [userEntry('one'), memberEntry('research', 'hello')] } }
    }
    const merged = mergeGroupChatSyncSnapshots(remote, local)
    expect(merged.rooms['name:Room']?.log.map(entry => entry.text)).toEqual(['one', 'hello'])
    expect(merged.rooms['name:Room']?.revision).toBe(1)
  })

  it('identity fields follow the higher revision; a tie unions members', () => {
    const local: GroupChatSyncSnapshot = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room Local',
          revision: 2,
          log: [],
          members: [{ name: 'builder' }]
        }
      }
    }
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room Remote',
          revision: 1,
          log: [],
          members: [{ name: 'research' }]
        }
      }
    }
    expect(mergeGroupChatSyncSnapshots(remote, local).rooms['name:Room']?.name).toBe('Room Local')
    expect(mergeGroupChatSyncSnapshots(remote, local).rooms['name:Room']?.members?.map(m => m.name)).toEqual(['builder'])
    const tie = mergeGroupChatSyncSnapshots(remote, {
      version: 3,
      rooms: { 'name:Room': { name: 'Room Local', revision: 1, log: [], members: [{ name: 'builder' }] } }
    })
    expect(tie.rooms['name:Room']?.members?.map(m => m.name).sort()).toEqual(['builder', 'research'])
  })

  it('tombstones: id-keyed are final, name-keyed are revision-gated', () => {
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'id:r-1': { name: 'Ghost', revision: 9, log: [userEntry('hi')] } },
      deleted: { 'id:r-1': 1 }
    }
    const local: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'id:r-1': { name: 'Ghost', revision: 9, log: [userEntry('hi')] } }
    }
    expect(Object.keys(mergeGroupChatSyncSnapshots(remote, local).rooms)).toHaveLength(0)

    const gatedRemote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'name:Old': { name: 'Old', revision: 5, log: [userEntry('hi')] } },
      deleted: { 'name:Old': 5 }
    }
    const gated = mergeGroupChatSyncSnapshots(gatedRemote, {
      version: 3,
      rooms: { 'name:Old': { name: 'Old', revision: 5, log: [userEntry('hi')] } }
    })
    expect(gated.rooms['name:Old']).toBeUndefined()
    // A newer local revision outlives the stale tombstone.
    const survivor = mergeGroupChatSyncSnapshots(gatedRemote, {
      version: 3,
      rooms: { 'name:Old': { name: 'Old', revision: 6, log: [userEntry('hi')] } }
    })
    expect(survivor.rooms['name:Old']).toBeTruthy()
    expect(survivor.deleted?.['name:Old']).toBeUndefined()
  })

  it('a rename pass never tombstones the room being written', () => {
    const merged = mergeGroupChatSyncSnapshots(
      { version: 3, rooms: {} },
      { version: 3, rooms: { 'id:r-2': { name: 'New Name', revision: 3, log: [userEntry('hi')] } } },
      { changedRooms: ['New Name'], deletedRooms: ['Old Name'], writeRevision: 3 }
    )
    expect(merged.rooms['id:r-2']?.name).toBe('New Name')
  })
})

describe('merge remote into rooms', () => {
  it('merges the compact projection without discarding local engine state', () => {
    replaceGroupChats({
      Room: room({
        log: [userEntry('local rich', 10)],
        members: [{ name: 'builder' }],
        sessions: { builder: 'stored-1' },
        watermarks: { 'legacy::builder': 5 },
        epoch: 7,
        running: true,
        syncRevision: 2
      })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room',
          revision: 1,
          log: [userEntry('local rich', 10), memberEntry('research', 'from desktop', 20)],
          members: [{ name: 'research', connectionId: 'conn-1' }]
        }
      }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)
    const mergedRoom = merged.Room
    expect(mergedRoom.sessions).toEqual({ builder: 'stored-1' })
    expect(mergedRoom.watermarks['legacy::builder']).toBe(5)
    expect(mergedRoom.epoch).toBe(7)
    expect(mergedRoom.running).toBe(true)
    expect(mergedRoom.syncRevision).toBe(2)
    expect(mergedRoom.log.map(entry => entry.text)).toEqual(['local rich', 'from desktop'])
    expect(mergedRoom.members.map(m => m.name).sort()).toEqual(['builder', 'research'])
  })

  it('prefers the local rich copy when the same entry exists compact', () => {
    replaceGroupChats({
      Room: room({ log: [{ ...userEntry('full text', 10), id: 'shared' }], syncRevision: 1 })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room',
          revision: 2,
          log: [{ at: 10, from: { kind: 'user', name: 'You' }, id: 'shared', text: 'trunc' }]
        }
      }
    }
    expect(mergeRemoteGroupChatSnapshotIntoRooms(remote).Room.log[0].text).toBe('full text')
  })

  it('honors tombstones but preserves rooms mid-write', () => {
    replaceGroupChats({
      Gone: room({ log: [userEntry('hi')], roomId: 'r-9' }),
      Keep: room({ log: [userEntry('hi')] })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'name:Keep': { name: 'Keep', revision: 1, log: [userEntry('hi')] } },
      deleted: { 'id:r-9': 1 }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote, $groupChats.get(), {
      deletedRooms: [],
      preserveRooms: ['Keep']
    })
    expect(merged.Gone).toBeUndefined()
    expect(merged.Keep).toBeTruthy()
  })

  it('follows a remote rename to the new display name', () => {
    replaceGroupChats({
      Old: room({ log: [userEntry('hi')], roomId: 'r-3', syncRevision: 1 })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'id:r-3': { name: 'Renamed', roomId: 'r-3', revision: 2, log: [userEntry('hi')] } }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)
    expect(merged.Renamed).toBeTruthy()
    expect(merged.Old).toBeUndefined()
  })
})

describe('legacy threads', () => {
  it('splits on a user entry after a lull and keeps follow-ups together', () => {
    const gap = 16 * 60000
    const threadless = (entry: GroupMessage): GroupMessage => {
      const { thread: _drop, ...rest } = entry
      return rest
    }
    const log = [
      threadless(userEntry('first', 0)),
      threadless(memberEntry('research', 'answer', 60000)),
      threadless(memberEntry('research', 'follow-up', 70000)),
      threadless(userEntry('new topic', gap * 2))
    ]
    const threaded = assignLegacyThreads(log)
    expect(threaded.map(entry => entry.thread)).toEqual(['legacy-0', 'legacy-0', 'legacy-0', 'legacy-1'])
  })

  it('keeps explicit threads untouched', () => {
    const log = [userEntry('a', 0, 't1'), memberEntry('b', 'x', 1, 't2')]
    expect(assignLegacyThreads(log).every((entry, i) => entry.thread === log[i].thread)).toBe(true)
  })
})

describe('flush job', () => {
  it('pulls the remote snapshot into rooms', async () => {
    setGroupEngineRequest(async method => {
      if (method === 'profiles.list') {
        return {
          profiles: [
            {
              name: 'default',
              ui_meta: {
                'hermes-bots-groups': {
                  version: 3,
                  rooms: { 'name:Pulled': { name: 'Pulled', revision: 2, log: [userEntry('from mirror')] } }
                }
              },
              ui_meta_revisions: { 'hermes-bots-groups': 2 }
            }
          ]
        }
      }
      return {}
    })
    const pulled = await pullGroupChatState()
    expect(pulled).toBe(true)
    expect($groupChats.get().Pulled.log[0].text).toBe('from mirror')
    expect($groupChats.get().Pulled.syncRevision).toBe(2)
  })

  it('writes through the CAS protocol with read-back, retrying on revision races', async () => {
    vi.useFakeTimers()
    let revision = 3
    let writes = 0
    let stale = true
    setGroupEngineRequest(async (method, params) => {
      if (method === 'profiles.list') {
        return {
          profiles: [
            {
              name: 'default',
              ui_meta: { 'hermes-bots-groups': { version: 3, rooms: {}, deleted: {} } },
              ui_meta_revisions: { 'hermes-bots-groups': revision }
            }
          ]
        }
      }
      if (method === 'profiles.configure') {
        writes += 1
        const expected = (params?.ui_meta_expected_revisions as Record<string, number>)?.['hermes-bots-groups']
        expect(expected).toBe(3)
        if (stale) {
          // Another client raced ahead while the write was in flight: the
          // acknowledged revision does not match writeRevision → the read-back
          // check fails and the job retries.
          revision = expected + 1
          stale = false
          return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': expected } } }
        }
        revision = expected + 1
        return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': revision } } }
      }
      return {}
    })

    replaceGroupChats({ Room: room({ log: [userEntry('hi')] }) })
    scheduleGroupChatSync({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(400)
    // First flush: write accepted but revision read-back shows a race → retry
    // after backoff with fresh remote state.
    expect(writes).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes).toBe(2)
    vi.useRealTimers()
  })

  it('never publishes an empty snapshot unless a disband allows it', async () => {
    vi.useFakeTimers()
    let writes = 0
    setGroupEngineRequest(async method => {
      if (method === 'profiles.configure') writes += 1
      return {}
    })
    scheduleGroupChatSync({})
    await vi.advanceTimersByTimeAsync(400)
    expect(writes).toBe(0)
    vi.useRealTimers()
  })
})