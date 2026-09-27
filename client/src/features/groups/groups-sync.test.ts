import { beforeEach, describe, expect, it } from 'vitest'

import { $groupActivity, $groupChats, $groupNeedsYou, $groupPrompts, replaceGroupChats, type GroupChatRoom } from './group-store'
import {
  assignLegacyThreads,
  groupChatGatewayJsonSize,
  groupChatSyncEntryKey,
  groupChatSyncSnapshot,
  mergeGroupChatSyncSnapshots,
  mergeRemoteGroupChatSnapshotIntoRooms,
  normalizeGroupChatSyncSnapshot,
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
})

describe('sizing', () => {
  it('charges commas and colons double and escapes non-ASCII wide', () => {
    // {"a":1} — the single ':' charges double, no comma present.
    expect(groupChatGatewayJsonSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length + 1)
    expect(groupChatGatewayJsonSize('é')).toBe(8) // quote + escaped é (6) + quote
    expect(groupChatGatewayJsonSize('𝄞')).toBe(14)
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
      'name:Room': room({ log: longLog, members: Array.from({ length: 9 }, (_, i) => ({ name: `bot${i}` })), syncRevision: 4 })
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
    const snapshot = groupChatSyncSnapshot({ 'name:Empty': room({ name: 'Empty', log: [] }) }, deleted)
    expect(Object.keys(snapshot.rooms)).toHaveLength(0)
    expect(Object.keys(snapshot.deleted ?? {})).toHaveLength(64)
  })

  it('derives the envelope key and the name field from the room row, not the map key', () => {
    replaceGroupChats({
      'id:r-1': room({ name: 'Room', roomId: 'r-1', log: [userEntry('hi')] })
    })
    const snapshot = groupChatSyncSnapshot()
    expect(Object.keys(snapshot.rooms)).toEqual(['id:r-1'])
    expect(snapshot.rooms['id:r-1'].name).toBe('Room')
  })

  it('truncates text and drops images past the char cap', () => {
    replaceGroupChats({
      'name:Room': room({ log: [memberEntry('research', 'x'.repeat(5000))], image: 'z'.repeat(30000) })
    })
    const projected = groupChatSyncSnapshot().rooms['name:Room']
    expect(projected.log[0].text).toHaveLength(1200)
    expect(projected.image).toBeUndefined() // 30000 > 24000
  })

  it('never projects session provenance — the mirror carries no wire-targeted state', () => {
    replaceGroupChats({
      'id:r-1': room({
        name: 'Room', roomId: 'r-1', log: [userEntry('hi')],
        sessionConnectionKey: 'https://gw-a.test', sessions: { research: 'stored-1' },
        stranded: { research: { before: 0, thread: 't1' } }
      })
    })
    const projected = groupChatSyncSnapshot().rooms['id:r-1']
    expect(projected).toBeTruthy()
    expect(projected).not.toHaveProperty('sessionConnectionKey')
    expect(projected).not.toHaveProperty('sessions')
    expect(projected).not.toHaveProperty('stranded')
    expect(JSON.stringify(projected)).not.toContain('stored-1')
  })

  it('shrinks logs then drops rooms to fit the byte cap', () => {
    const rooms: Record<string, GroupChatRoom> = {}
    for (let i = 0; i < 60; i++) {
      rooms[`name:Room ${i}`] = room({
        name: `Room ${i}`,
        log: Array.from({ length: 16 }, (_, j) => memberEntry('research', `${i}-${j}`.padEnd(300, 'y'), j))
      })
    }
    const snapshot = groupChatSyncSnapshot(rooms)
    expect(groupChatGatewayJsonSize(snapshot)).toBeLessThanOrEqual(48000)
  })
})

describe('normalize', () => {
  it('lifts v1 name-keyed snapshots without giving wall-clock tombstones a revision', () => {
    const legacy = { version: 1, rooms: { Old: { log: [userEntry('hi')] } }, deleted: { Gone: 123 } }
    const norm = normalizeGroupChatSyncSnapshot(legacy as unknown as GroupChatSyncSnapshot)
    expect(norm.rooms['name:Old']?.name).toBe('Old')
    // v1 tombstones carry wall-clock ms and must not outrank revisions.
    expect(norm.deleted?.['name:Gone']).toBe(0)
  })

  it('lifts v2 name-keyed snapshots with revisioned tombstones', () => {
    const legacy = {
      version: 2,
      rooms: { Old: { log: [userEntry('hi')] } },
      deleted: { Gone: 9 }
    }
    const norm = normalizeGroupChatSyncSnapshot(legacy as unknown as GroupChatSyncSnapshot)
    expect(norm.rooms['name:Old']?.name).toBe('Old')
    expect(norm.deleted?.['name:Gone']).toBe(9)
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

  it('accepts durable-key labels in the rename pass', () => {
    const merged = mergeGroupChatSyncSnapshots(
      { version: 3, rooms: {} },
      { version: 3, rooms: { 'id:r-2': { name: 'New Name', revision: 3, log: [userEntry('hi')] } } },
      { changedRooms: ['id:r-2'], deletedRooms: [], writeRevision: 3 }
    )
    expect(merged.rooms['id:r-2']?.revision).toBe(3)
  })
})

describe('merge remote into rooms', () => {
  it('merges the compact projection without discarding local engine state', () => {
    replaceGroupChats({
      'name:Room': room({
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
    const mergedRoom = merged['name:Room']
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
      'name:Room': room({ log: [{ ...userEntry('full text', 10), id: 'shared' }], syncRevision: 1 })
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
    expect(mergeRemoteGroupChatSnapshotIntoRooms(remote)['name:Room'].log[0].text).toBe('full text')
  })

  it('honors tombstones but preserves rooms mid-write', () => {
    replaceGroupChats({
      'id:r-9': room({ name: 'Gone', log: [userEntry('hi')], roomId: 'r-9' }),
      'name:Keep': room({ name: 'Keep', log: [userEntry('hi')] })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'name:Keep': { name: 'Keep', revision: 1, log: [userEntry('hi')] } },
      deleted: { 'id:r-9': 1 }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote, $groupChats.get(), {
      deletedRooms: [],
      preserveRooms: ['name:Keep']
    })
    expect(merged['id:r-9']).toBeUndefined()
    expect(merged['name:Keep']).toBeTruthy()
  })

  it('renames an id-keyed room in place: the map key never moves, the name field follows', () => {
    replaceGroupChats({
      'id:r-3': room({ name: 'Old', log: [userEntry('hi')], roomId: 'r-3', syncRevision: 1 })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'id:r-3': { name: 'Renamed', roomId: 'r-3', revision: 2, log: [userEntry('hi')] } }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)
    expect(merged['id:r-3']).toBeTruthy()
    expect(merged['id:r-3'].name).toBe('Renamed')
    expect(merged['name:Old']).toBeUndefined()
  })

  it('renames a name-keyed room through the old envelope key and sweeps the feed atoms', () => {
    replaceGroupChats({
      'name:Old': room({ name: 'Old', log: [userEntry('local')], epoch: 7, syncRevision: 1 })
    })
    $groupActivity.set({ 'name:Old': [{ at: 1, epoch: 7, kind: 'queued', member: 'research', thread: 'legacy' }] })
    $groupPrompts.set({
      'name:Old::research': { at: 1, connectionKey: 'https://gw-a.test', kind: 'clarify', member: 'research', memberKey: 'research', question: '?', requestId: 'p1', roomKey: 'name:Old' }
    })
    $groupNeedsYou.set({ 'name:Old': true })

    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'name:Old': { name: 'New', revision: 5, log: [userEntry('local')] } }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)

    expect(merged['name:New']).toBeTruthy()
    expect(merged['name:New'].name).toBe('New')
    expect(merged['name:New'].epoch).toBe(7)
    expect(merged['name:Old']).toBeUndefined()
    expect($groupActivity.get()['name:New']).toHaveLength(1)
    expect($groupActivity.get()['name:Old']).toBeUndefined()
    expect($groupPrompts.get()['name:New::research'].roomKey).toBe('name:New')
    expect($groupPrompts.get()['name:Old::research']).toBeUndefined()
    expect($groupNeedsYou.get()).toEqual({ 'name:New': true })
  })

  it('recreates a tombstone-and-renamed room when the desktop re-keyed first; the atoms strand', () => {
    replaceGroupChats({
      'name:Old': room({ name: 'Old', log: [userEntry('local')], syncRevision: 1 })
    })
    $groupActivity.set({ 'name:Old': [{ at: 1, epoch: 0, kind: 'queued', member: 'research', thread: 'legacy' }] })

    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: { 'name:New': { name: 'New', revision: 5, log: [userEntry('local')] } },
      deleted: { 'name:Old': 5 }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)

    expect(merged['name:New']).toBeTruthy()
    expect(merged['name:New'].log.map(entry => entry.text)).toEqual(['local'])
    expect(merged['name:Old']).toBeUndefined()
    // No pairing is attempted across a tombstone + creation — the atoms strand.
    expect($groupActivity.get()['name:Old']).toHaveLength(1)
    expect($groupActivity.get()['name:New']).toBeUndefined()
  })

  it('dedupes an identity-carrying local row with its remote twin to one member', () => {
    replaceGroupChats({
      'name:Room': room({
        log: [userEntry('local', 10)],
        members: [{ name: 'research', connectionId: 'conn-1', sourceScoped: true }],
        syncRevision: 2
      })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room',
          revision: 2,
          log: [userEntry('local', 10)],
          members: [{ name: 'research', connectionId: 'conn-1', sourceScoped: true }]
        }
      }
    }
    expect(mergeRemoteGroupChatSnapshotIntoRooms(remote)['name:Room'].members).toEqual([
      { name: 'research', connectionId: 'conn-1', sourceScoped: true }
    ])
  })

  it('keeps a bare local row and its qualified remote twin as two rows on a revision tie', () => {
    replaceGroupChats({
      'name:Room': room({ log: [userEntry('local', 10)], members: [{ name: 'research' }], syncRevision: 2 })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room',
          revision: 2,
          log: [userEntry('local', 10)],
          members: [{ name: 'research', connectionId: 'conn-1', sourceScoped: true }]
        }
      }
    }
    expect(mergeRemoteGroupChatSnapshotIntoRooms(remote)['name:Room'].members).toEqual([
      { name: 'research' },
      { name: 'research', connectionId: 'conn-1', sourceScoped: true }
    ])
  })

  it('preserves matching local session provenance and never imports session fields from the wire', () => {
    replaceGroupChats({
      'name:Room': room({
        log: [userEntry('local', 10)],
        syncRevision: 1,
        sessionConnectionKey: 'https://gw-a.test',
        sessions: { research: 'local-stored' },
        stranded: { research: { before: 0, thread: 't1' } }
      }),
      'name:Fresh': room({ name: 'Fresh', log: [userEntry('seed', 10)], syncRevision: 1 })
    })
    // A hostile or legacy wire snapshot carrying session-bound fields must
    // not leak them into the local map, whether or not a local twin exists.
    const remote = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room', revision: 9, log: [userEntry('local', 10), memberEntry('research', 'from desktop', 30)],
          members: [],
          sessionConnectionKey: 'https://wire.test',
          sessions: { research: 'wire-stored' },
          stranded: { research: 0 }
        },
        'name:Fresh': {
          name: 'Fresh', revision: 9, log: [userEntry('seed', 10)], members: [],
          sessionConnectionKey: 'https://wire.test',
          sessions: { research: 'wire-stored' },
          stranded: { research: 0 }
        }
      }
    } as unknown as GroupChatSyncSnapshot
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)

    // The local room keeps its own provenance triple and merges only shared
    // content from the wire.
    const kept = merged['name:Room']
    expect(kept.sessionConnectionKey).toBe('https://gw-a.test')
    expect(kept.sessions).toEqual({ research: 'local-stored' })
    expect(kept.stranded).toEqual({ research: { before: 0, thread: 't1' } })
    expect(kept.log.map(entry => entry.text)).toEqual(['local', 'from desktop'])

    // A room adopted from the wire starts with no session state of any kind.
    const fresh = merged['name:Fresh']
    expect(fresh.sessionConnectionKey).toBeUndefined()
    expect(fresh.sessions).toEqual({})
    expect(fresh.stranded).toEqual({})
  })

  it('moves coordination state to the qualified key at the merge boundary', () => {
    replaceGroupChats({
      'name:Room': room({
        log: [userEntry('local', 10)],
        members: [{ name: 'research' }],
        sessions: { research: 'stored-1' },
        holds: { research: { at: 1, byMessageId: null, thread: 't1' } },
        stranded: { research: { before: 0, thread: 'legacy' } },
        watermarks: { 'legacy::research': 5 },
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
          revision: 2,
          log: [userEntry('local', 10)],
          members: [{ name: 'research', connectionId: 'conn-1', sourceScoped: true }]
        }
      }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)
    expect(merged['name:Room'].members).toEqual([
      { name: 'research' },
      { name: 'research', connectionId: 'conn-1', sourceScoped: true }
    ])
    expect(merged['name:Room'].sessions).toEqual({ 'conn-1::research': 'stored-1' })
    expect(merged['name:Room'].holds).toEqual({ 'conn-1::research': { at: 1, byMessageId: null, thread: 't1' } })
    expect(merged['name:Room'].stranded).toEqual({ 'conn-1::research': { before: 0, thread: 'legacy' } })
    expect(merged['name:Room'].watermarks['legacy::conn-1::research']).toBe(5)
  })

  it('carries coordination state to the qualified key when the desktop enriches the roster', () => {
    replaceGroupChats({
      'name:Room': room({
        log: [userEntry('local', 10)],
        members: [{ name: 'research' }],
        sessions: { research: 'stored-1' },
        watermarks: { 't1::research': 3 },
        syncRevision: 1
      })
    })
    const remote: GroupChatSyncSnapshot = {
      version: 3,
      rooms: {
        'name:Room': {
          name: 'Room',
          revision: 3,
          log: [userEntry('local', 10)],
          members: [{ name: 'research', connectionId: 'conn-1', sourceScoped: true }]
        }
      }
    }
    const merged = mergeRemoteGroupChatSnapshotIntoRooms(remote)
    expect(merged['name:Room'].members).toEqual([{ name: 'research', connectionId: 'conn-1', sourceScoped: true }])
    expect(merged['name:Room'].sessions).toEqual({ 'conn-1::research': 'stored-1' })
    expect(merged['name:Room'].watermarks['t1::conn-1::research']).toBe(3)
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
