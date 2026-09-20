import { describe, expect, it } from 'vitest'

import { groupAuthorMemberKey, groupMemberKey, groupRoomKey, groupRoomsFromRoster, parseGroupSnapshot, type GroupRoom } from './group-model'

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
      members: [{ name: 'codex', handle: '@codex' }, { name: 'scout', handle: '@scout', connectionId: 'gw-2', connectionKind: 'remote', sourceScoped: true }]
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

describe('groupMemberKey', () => {
  it('qualifies on connectionId presence, not the sourceScoped flag', () => {
    expect(groupMemberKey({ name: 'research', connectionId: 'gw-2', sourceScoped: true })).toBe('gw-2::research')
    expect(groupMemberKey({ name: 'research', connectionId: 'gw-2' })).toBe('gw-2::research')
    expect(groupMemberKey({ name: 'research' })).toBe('research')
  })

  it('separates same-named members on two connections', () => {
    expect(groupMemberKey({ name: 'research', connectionId: 'gw-1' })).not.toBe(groupMemberKey({ name: 'research', connectionId: 'gw-2' }))
  })

  it('keeps the legacy engine key for already-qualified rows (migration no-op)', () => {
    expect(groupMemberKey({ name: 'research', connectionId: 'gw-2', sourceScoped: true })).toBe('gw-2::research')
  })
})

describe('groupRoomKey', () => {
  it('keys by the durable roomId when present, whatever the display name', () => {
    expect(groupRoomKey('Launch', { roomId: 'r-1' })).toBe('id:r-1')
    expect(groupRoomKey('Renamed', { roomId: 'r-1' })).toBe('id:r-1')
  })

  it('keys by display name for rooms without a roomId', () => {
    expect(groupRoomKey('Launch', { roomId: null })).toBe('name:Launch')
    expect(groupRoomKey('Launch', {})).toBe('name:Launch')
  })

  it('never collides distinct roomIds or the two identity classes', () => {
    expect(groupRoomKey('Room', { roomId: 'r-1' })).not.toBe(groupRoomKey('Room', { roomId: 'r-2' }))
    expect(groupRoomKey('id:r-1', {})).not.toBe(groupRoomKey('Room', { roomId: 'r-1' }))
  })
})

describe('groupAuthorMemberKey', () => {
  const members = [
    { name: 'research', connectionId: 'gw-1', connectionLabel: 'gw-1', sourceScoped: true },
    { name: 'research', connectionId: 'gw-2', connectionLabel: 'gw-2', sourceScoped: true },
    { name: 'builder' }
  ]

  it('resolves a lone name match by name', () => {
    expect(groupAuthorMemberKey({ kind: 'member', name: 'builder' }, members)).toBe('builder')
    expect(groupAuthorMemberKey({ kind: 'member', name: 'research' }, [{ name: 'research' }])).toBe('research')
  })

  it('disambiguates same-named members by the author source label', () => {
    expect(groupAuthorMemberKey({ kind: 'member', name: 'research', source: 'gw-1' }, members)).toBe('gw-1::research')
    expect(groupAuthorMemberKey({ kind: 'member', name: 'research', source: 'gw-2' }, members)).toBe('gw-2::research')
  })

  it('falls back to the first bare-name match when the source cannot resolve', () => {
    expect(groupAuthorMemberKey({ kind: 'member', name: 'research', source: 'zzz' }, members)).toBe('gw-1::research')
    expect(groupAuthorMemberKey({ kind: 'member', name: 'research' }, [{ name: 'research' }, { name: 'research' }])).toBe('research')
  })

  it('returns null for user entries and unknown authors', () => {
    expect(groupAuthorMemberKey({ kind: 'user', name: 'You' }, members)).toBeNull()
    expect(groupAuthorMemberKey({ kind: 'member', name: 'nobody' }, members)).toBeNull()
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