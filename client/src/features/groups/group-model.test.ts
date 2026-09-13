import { describe, expect, it } from 'vitest'

import { groupRoomsFromRoster, parseGroupSnapshot, type GroupRoom } from './group-model'

const snapshot = {
  version: 3,
  updatedAt: 1_700_000_000_000,
  rooms: {
    'id:r-old': {
      name: 'Research crew',
      roomId: 'r-old',
      revision: 4,
      log: [
        { at: 1_700_000_000_000, from: { kind: 'user', name: 'You' }, text: 'Kick us off' },
        { at: 1_700_000_060_000, from: { kind: 'member', name: 'Codex' }, text: 'On it', id: 'm1' },
        {
          at: 1_700_000_120_000,
          from: { kind: 'member', name: 'Scout', source: 'h-lap02' },
          text: 'Also on it',
          thread: 't-1'
        }
      ],
      members: [
        { name: 'codex', handle: '@codex' },
        { name: 'scout', handle: '@scout', connectionId: 'gw-2', connectionKind: 'remote', sourceScoped: true }
      ]
    },
    'name:Legacy': {
      name: 'Legacy',
      revision: 1,
      log: [{ at: 1_690_000_000_000, from: { kind: 'member', name: 'Bot' }, text: 'older room' }]
    }
  },
  deleted: { 'name:Gone': 9 }
}

describe('parseGroupSnapshot', () => {
  it('parses v3 rooms, newest first, with stable keys', () => {
    const rooms = parseGroupSnapshot(snapshot)

    expect(rooms.map(room => room.key)).toEqual(['id:r-old', 'name:Legacy'])
    expect(rooms[0]).toMatchObject({
      key: 'id:r-old',
      name: 'Research crew',
      roomId: 'r-old',
      members: [{ name: 'codex', handle: '@codex' }, { name: 'scout', handle: '@scout' }]
    } satisfies Partial<GroupRoom>)
    expect(rooms[0].log).toHaveLength(3)
    expect(rooms[0].log[2]).toMatchObject({ from: { kind: 'member', name: 'Scout', source: 'h-lap02' }, text: 'Also on it', thread: 't-1' })
  })

  it('drops empty tombstone rooms and keys listed under deleted', () => {
    const rooms = parseGroupSnapshot({
      version: 3,
      rooms: {
        'id:r-old': snapshot.rooms['id:r-old'],
        'id:r-empty': { name: 'Empty', revision: 2, log: [] },
        ...snapshot.deleted
      },
      deleted: snapshot.deleted
    })

    expect(rooms.map(room => room.key)).toEqual(['id:r-old'])
  })

  it('coerces partial entries the way the desktop writer does', () => {
    const rooms = parseGroupSnapshot({
      rooms: {
        'id:r-loose': {
          log: [
            { from: { kind: 'weird' }, text: 42, at: '1700000123456' },
            { from: { kind: 'member' }, text: 'nameless bot', at: 0 }
          ],
          members: [{ name: 'a' }, 'garbage', { name: 'b', handle: '@b' }]
        }
      }
    })

    const [room] = rooms
    expect(room.log).toHaveLength(2)
    expect(room.log[0]).toMatchObject({ from: { kind: 'user', name: 'You' }, text: '42', at: 1_700_000_123_456 })
    expect(room.log[1]).toMatchObject({ from: { kind: 'member', name: 'Bot' }, text: 'nameless bot', at: 0 })
    expect(room.members).toEqual([{ name: 'a' }, { name: 'b', handle: '@b' }])
  })

  it('returns nothing for malformed payloads', () => {
    expect(parseGroupSnapshot(null)).toEqual([])
    expect(parseGroupSnapshot('nope')).toEqual([])
    expect(parseGroupSnapshot({ rooms: 'nope' })).toEqual([])
    expect(parseGroupSnapshot({ version: 3 })).toEqual([])
  })
})

describe('groupRoomsFromRoster', () => {
  it('reads the group snapshot off the default profile row', () => {
    const response = {
      profiles: [
        { name: 'default', is_default: true, ui_meta: { 'hermes-bots-groups': snapshot } },
        { name: 'codex' }
      ]
    }

    expect(groupRoomsFromRoster(response).map(room => room.key)).toEqual(['id:r-old', 'name:Legacy'])
  })

  it('returns nothing without a default row or snapshot', () => {
    expect(groupRoomsFromRoster({ profiles: [{ name: 'codex' }] })).toEqual([])
    expect(groupRoomsFromRoster({ profiles: [{ name: 'default' }] })).toEqual([])
    expect(groupRoomsFromRoster(['default', 'codex'])).toEqual([])
    expect(groupRoomsFromRoster(null)).toEqual([])
  })
})