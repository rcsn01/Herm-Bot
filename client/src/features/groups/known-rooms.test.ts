import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'

import { $knownRooms, publishRosterRooms, resetKnownRooms, useGroupRooms, useKnownRooms } from './known-rooms'
import { $groupChats, createGroupChat } from './group-engine'
import { replaceGroupChats, type GroupChatRoom } from './group-store'
import type { GroupMember, GroupMessage, GroupRoom } from './group-model'

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

function userEntry(text: string, at = 1000, thread = 'legacy'): GroupMessage {
  return { at, from: { kind: 'user', name: 'You' }, id: `u-${text}`, text, thread }
}

function memberEntry(name: string, text: string, at = 2000): GroupMessage {
  return { at, from: { kind: 'member', name }, id: `m-${text}`, text, thread: 'legacy' }
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({})
  resetKnownRooms()
})

afterEach(() => {
  cleanup()
})

describe('known rooms projection', () => {
  it('keeps the last duplicate roster row at the first key position', () => {
    const firstDuplicate: GroupRoom = { key: 'id:duplicate', log: [], members: [], name: 'First' }
    const other: GroupRoom = { key: 'id:other', log: [], members: [], name: 'Other' }
    const lastDuplicate: GroupRoom = { key: 'id:duplicate', log: [], members: [], name: 'Last' }

    publishRosterRooms([firstDuplicate, other, lastDuplicate])

    expect($knownRooms.get()).toEqual([lastDuplicate, other])
  })

  it('merges roster and local rooms by their keys and filters local empty tombstones', () => {
    const rosterRoom: GroupRoom = {
      key: 'id:r-1',
      log: [memberEntry('ada', 'from the gateway')],
      members: [{ name: 'ada' }],
      name: 'Gateway room',
      roomId: 'r-1'
    }
    publishRosterRooms([rosterRoom])
    replaceGroupChats({
      // The roster row wins this shared store key.
      'id:r-1': room({ name: 'Local copy', roomId: 'r-1', log: [userEntry('local', 1)] }),
      // Falsy room ids filter empty local rooms, regardless of member count.
      'name:Ghost': room({ name: 'Ghost', log: [] }),
      'name:NullId': room({ name: 'Null ID', roomId: null, log: [] }),
      'name:EmptyId': room({ name: 'Empty ID', roomId: '', log: [] }),
      // An id alone is not enough when an empty room has no members.
      'id:no-members': room({ name: 'No members', roomId: 'no-members', members: [], log: [] }),
      // Just-created rooms have a durable id and members, so an empty log is valid.
      'id:r-2': room({ name: 'Just created', roomId: 'r-2', members: [{ name: 'a' }] }),
      // The local store key is authoritative even when the row disagrees.
      'id:map-key': room({ name: 'Mismatched name', roomId: 'different-id', log: [userEntry('saved', 2)] }),
      // A transcript keeps a local room visible without an id or members.
      'name:Local': room({ name: 'Local', roomId: null, members: [], log: [userEntry('hi', 1)] })
    })

    const view = $knownRooms.get()
    expect(view.map(entry => entry.key)).toEqual(['id:r-1', 'id:r-2', 'id:map-key', 'name:Local'])
    expect(view[0]).toEqual(rosterRoom)
    expect(view[1].name).toBe('Just created')
    expect(view[2]).toMatchObject({ key: 'id:map-key', name: 'Mismatched name', roomId: 'different-id' })
    expect(view[3].log).toHaveLength(1)
  })
})

describe('known rooms', () => {
  function Publisher({ roster, testId = 'published-rooms', expected }: { roster: GroupRoom[]; testId?: string; expected?: GroupRoom[] }) {
    const rooms = useGroupRooms(roster)
    if (expected) expect(rooms).toEqual(expected)
    return createElement('div', { 'data-testid': testId, 'data-rooms': JSON.stringify(rooms) }, String(rooms.length))
  }
  function Reader() {
    const rooms = useKnownRooms()
    return createElement('div', {
      'data-testid': 'known-rooms-count',
      'data-rooms': JSON.stringify(rooms)
    }, String(rooms.length))
  }
  function PublisherPair({ first, second }: { first: GroupRoom[]; second: GroupRoom[] }) {
    return createElement('div', null,
      createElement(Publisher, { roster: first, testId: 'publisher-first' }),
      createElement(Publisher, { roster: second, testId: 'publisher-second' })
    )
  }
  function bareRosterRoom(): GroupRoom {
    return {
      key: 'name:original',
      log: [{ at: 1, from: { kind: 'user', name: 'You' }, text: 'message' }],
      members: [{ name: 'ada' }],
      name: 'Room'
    }
  }

  type FieldChange = {
    field: string
    first: (room: GroupRoom) => GroupRoom
    next?: (room: GroupRoom) => GroupRoom
  }
  const fieldChanges: FieldChange[] = [
    { field: 'room key', first: room => ({ ...room, key: 'name:changed' }) },
    { field: 'room name', first: room => ({ ...room, name: 'Changed room' }) },
    { field: 'room image', first: room => ({ ...room, image: '' }), next: room => ({ ...room, image: 'image-2' }) },
    { field: 'room id', first: room => ({ ...room, roomId: 'room-1' }), next: room => ({ ...room, roomId: 'room-2' }) },
    { field: 'message timestamp', first: room => ({ ...room, log: [{ ...room.log[0], at: 2 }] }) },
    { field: 'author kind', first: room => ({ ...room, log: [{ ...room.log[0], from: { ...room.log[0].from, kind: 'member' } }] }) },
    { field: 'author name', first: room => ({ ...room, log: [{ ...room.log[0], from: { ...room.log[0].from, name: 'ada' } }] }) },
    {
      field: 'author source',
      first: room => ({ ...room, log: [{ ...room.log[0], from: { ...room.log[0].from, source: 'source-1' } }] }),
      next: room => ({ ...room, log: [{ ...room.log[0], from: { ...room.log[0].from, source: 'source-2' } }] })
    },
    { field: 'message id', first: room => ({ ...room, log: [{ ...room.log[0], id: 'entry-1' }] }), next: room => ({ ...room, log: [{ ...room.log[0], id: 'entry-2' }] }) },
    { field: 'message text', first: room => ({ ...room, log: [{ ...room.log[0], text: 'changed' }] }) },
    { field: 'message thread', first: room => ({ ...room, log: [{ ...room.log[0], thread: 'thread-1' }] }), next: room => ({ ...room, log: [{ ...room.log[0], thread: 'thread-2' }] }) },
    { field: 'member name', first: room => ({ ...room, members: [{ ...room.members[0], name: 'grace' }] }) },
    { field: 'member handle', first: room => ({ ...room, members: [{ ...room.members[0], handle: 'ada-1' }] }), next: room => ({ ...room, members: [{ ...room.members[0], handle: 'ada-2' }] }) },
    { field: 'member connection id', first: room => ({ ...room, members: [{ ...room.members[0], connectionId: 'connection-1' }] }), next: room => ({ ...room, members: [{ ...room.members[0], connectionId: 'connection-2' }] }) },
    { field: 'member connection kind', first: room => ({ ...room, members: [{ ...room.members[0], connectionKind: 'desktop' }] }), next: room => ({ ...room, members: [{ ...room.members[0], connectionKind: 'mobile' }] }) },
    { field: 'member connection label', first: room => ({ ...room, members: [{ ...room.members[0], connectionLabel: 'label-1' }] }), next: room => ({ ...room, members: [{ ...room.members[0], connectionLabel: 'label-2' }] }) },
    { field: 'member source scope', first: room => ({ ...room, members: [{ ...room.members[0], sourceScoped: true }] }), next: room => ({ ...room, members: [{ ...room.members[0], sourceScoped: false }] }) }
  ]

  it('retains the roster half across local clears', () => {
    const gatewayRoom: GroupRoom = {
      key: 'id:r-1',
      log: [memberEntry('ada', 'from the gateway')],
      members: [{ name: 'ada' }],
      name: 'Room',
      roomId: 'r-1'
    }
    publishRosterRooms([gatewayRoom])
    replaceGroupChats({})
    expect($knownRooms.get().map(room => room.key)).toEqual(['id:r-1'])
  })

  it('publishes by content signature, never array identity', () => {
    const gatewayRoom: GroupRoom = {
      key: 'id:r-2',
      log: [],
      members: [{ name: 'ada' }],
      name: 'Room',
      roomId: 'r-2'
    }
    publishRosterRooms([gatewayRoom])
    // listen, not subscribe: subscribe calls the listener immediately with
    // the current value, so the no-op assertion below could never pass.
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      // A freshly built content-equal roster is a no-op.
      publishRosterRooms([{ ...gatewayRoom }])
      expect(listener).not.toHaveBeenCalled()
      // A changed name is one write.
      publishRosterRooms([{ ...gatewayRoom, name: 'Renamed' }])
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('publishes changed nested room content when key and name stay the same', () => {
    const original: GroupRoom = {
      key: 'id:r-nested',
      image: 'old-image',
      log: [{
        at: 10,
        from: { kind: 'member', name: 'ada', source: 'old-source' },
        id: 'entry-1',
        text: 'old text',
        thread: 'thread-1'
      }],
      members: [{
        name: 'ada',
        handle: 'ada',
        connectionId: 'old-connection',
        connectionKind: 'desktop',
        connectionLabel: 'Old label',
        sourceScoped: true
      }],
      name: 'Room',
      roomId: 'r-nested'
    }
    const updated: GroupRoom = {
      ...original,
      image: 'new-image',
      log: [{ ...original.log[0], from: { ...original.log[0].from, source: 'new-source' }, text: 'new text' }],
      members: [{ ...original.members[0], connectionLabel: 'New label' }]
    }
    publishRosterRooms([original])
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      publishRosterRooms([updated])
      expect(listener).toHaveBeenCalledTimes(1)
      expect($knownRooms.get()).toEqual([updated])
    } finally {
      unsubscribe()
    }
  })

  it('treats separately allocated snapshots with reordered object properties as equal', () => {
    const original: GroupRoom = {
      key: 'id:r-object-order',
      image: 'image',
      log: [{
        at: 10,
        from: { kind: 'member', name: 'ada', source: 'remote' },
        id: 'entry',
        text: 'message',
        thread: 'thread'
      }],
      members: [{
        name: 'ada',
        handle: 'ada',
        connectionId: 'connection',
        connectionKind: 'desktop',
        connectionLabel: 'label',
        sourceScoped: true
      }],
      name: 'Room',
      roomId: 'r-object-order'
    }
    const equalClone: GroupRoom = {
      roomId: 'r-object-order',
      name: 'Room',
      members: [{
        sourceScoped: true,
        connectionLabel: 'label',
        connectionKind: 'desktop',
        connectionId: 'connection',
        handle: 'ada',
        name: 'ada'
      }],
      log: [{
        thread: 'thread',
        text: 'message',
        id: 'entry',
        from: { source: 'remote', name: 'ada', kind: 'member' },
        at: 10
      }],
      image: 'image',
      key: 'id:r-object-order'
    }
    publishRosterRooms([original])
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      publishRosterRooms([equalClone])
      expect(listener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it.each(fieldChanges)('publishes a change to $field', ({ first, next }) => {
    const original = bareRosterRoom()
    publishRosterRooms([original])
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      const firstChange = first(original)
      publishRosterRooms([firstChange])
      expect(listener).toHaveBeenCalledTimes(1)
      expect($knownRooms.get()).toEqual([firstChange])

      if (next) {
        const secondChange = next(firstChange)
        publishRosterRooms([secondChange])
        expect(listener).toHaveBeenCalledTimes(2)
        expect($knownRooms.get()).toEqual([secondChange])
      }
    } finally {
      unsubscribe()
    }
  })

  it.each(fieldChanges)('updates the immediate hook view when $field changes', ({ first, next }) => {
    const original = bareRosterRoom()
    const roster = [original]
    const publisher = render(createElement(Publisher, { roster, expected: [original] }))
    const readPublished = () => JSON.parse(screen.getByTestId('published-rooms').getAttribute('data-rooms') ?? '[]')
    const rerenderWith = (updated: GroupRoom) => {
      roster[0] = updated
      act(() => publisher.rerender(createElement(Publisher, { roster, expected: [updated] })))
      expect(readPublished()).toEqual([updated])
      expect($knownRooms.get()).toEqual([updated])
    }

    const firstChange = first(original)
    rerenderWith(firstChange)
    if (next) rerenderWith(next(firstChange))
  })

  it.each([
    { label: 'NaN and zero', first: 0, second: Number.NaN },
    { label: 'positive and negative infinity', first: Number.POSITIVE_INFINITY, second: Number.NEGATIVE_INFINITY },
    { label: 'negative zero and zero', first: -0, second: 0 }
  ])('keeps timestamp values distinct for $label', ({ first, second }) => {
    const original = bareRosterRoom()
    const withTimestamp = (at: number): GroupRoom => ({
      ...original,
      log: [{ ...original.log[0], at }]
    })
    publishRosterRooms([withTimestamp(first)])
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      publishRosterRooms([withTimestamp(second)])
      expect(listener).toHaveBeenCalledTimes(1)
      expect(Object.is($knownRooms.get()[0].log[0].at, second)).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('does not conflate room snapshots at the old string delimiters', () => {
    const emptyRoom = (key: string, name: string): GroupRoom => ({ key, name, log: [], members: [] })
    const collisions: Array<{ first: GroupRoom[]; second: GroupRoom[] }> = [
      {
        first: [emptyRoom('name:a', 'b::c')],
        second: [emptyRoom('name:a::b', 'c')]
      },
      {
        first: [emptyRoom('name:a', 'x'), emptyRoom('name:b', 'y')],
        second: [emptyRoom('name:a', 'x|name:b::y')]
      }
    ]
    for (const { first, second } of collisions) {
      resetKnownRooms()
      publishRosterRooms(first)
      const listener = vi.fn()
      const unsubscribe = $knownRooms.listen(listener)
      try {
        publishRosterRooms(second)
        expect(listener).toHaveBeenCalledTimes(1)
        expect($knownRooms.get()).toEqual(second)
      } finally {
        unsubscribe()
      }
    }
  })

  it('preserves member and log order in the signature', () => {
    const original: GroupRoom = {
      key: 'id:r-order',
      log: [userEntry('first', 1), memberEntry('ada', 'second', 2)],
      members: [{ name: 'ada' }, { name: 'grace' }],
      name: 'Room'
    }
    publishRosterRooms([original])
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      const reorderedMembers: GroupRoom = { ...original, members: [...original.members].reverse() }
      publishRosterRooms([reorderedMembers])
      expect(listener).toHaveBeenCalledTimes(1)
      expect($knownRooms.get()[0].members.map(member => member.name)).toEqual(['grace', 'ada'])

      const reorderedLog: GroupRoom = { ...reorderedMembers, log: [...original.log].reverse() }
      publishRosterRooms([reorderedLog])
      expect(listener).toHaveBeenCalledTimes(2)
      expect($knownRooms.get()[0].log.map(entry => entry.text)).toEqual(['second', 'first'])
    } finally {
      unsubscribe()
    }
  })

  it('reorders rooms when distinct-key snapshot order changes', () => {
    const first = { ...bareRosterRoom(), key: 'id:first', name: 'First' }
    const second = { ...bareRosterRoom(), key: 'id:second', name: 'Second' }
    publishRosterRooms([first, second])
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      publishRosterRooms([second, first])
      expect(listener).toHaveBeenCalledTimes(1)
      expect($knownRooms.get().map(room => room.key)).toEqual(['id:second', 'id:first'])
    } finally {
      unsubscribe()
    }
  })

  it('keeps room, member, and log order in the immediate hook view', () => {
    const first = {
      ...bareRosterRoom(),
      key: 'id:first-order',
      name: 'First',
      members: [{ name: 'ada' }, { name: 'grace' }],
      log: [userEntry('first', 1), memberEntry('ada', 'second', 2)]
    }
    const second = { ...bareRosterRoom(), key: 'id:second-order', name: 'Second' }
    const roster = [first, second]
    const publisher = render(createElement(Publisher, { roster }))
    const readPublished = () => JSON.parse(screen.getByTestId('published-rooms').getAttribute('data-rooms') ?? '[]')

    roster[0] = {
      ...first,
      members: [...first.members].reverse(),
      log: [...first.log].reverse()
    }
    roster.reverse()
    act(() => publisher.rerender(createElement(Publisher, { roster })))

    expect(readPublished().map((room: GroupRoom) => room.key)).toEqual(['id:second-order', 'id:first-order'])
    expect(readPublished()[1].members.map((member: GroupMember) => member.name)).toEqual(['grace', 'ada'])
    expect(readPublished()[1].log.map((entry: GroupMessage) => entry.text)).toEqual(['second', 'first'])
    expect($knownRooms.get().map(room => room.key)).toEqual(['id:second-order', 'id:first-order'])
  })

  it('recomputes on $groupChats writes with no roster publish at all', () => {
    replaceGroupChats({
      'id:r-3': room({ name: 'Local only', roomId: 'r-3', members: [{ name: 'ada' }] })
    })
    expect($knownRooms.get().map(room => room.key)).toContain('id:r-3')
  })

  it('projects a newly-created local room through public read handles', () => {
    const members = [{ name: 'default' }, { name: 'work' }]
    const created = createGroupChat('Research team', members, new Set())

    expect(created.roomId).toEqual(expect.any(String))
    expect(created.key).toMatch(/^id:/)
    expect(created.key).toBe(`id:${created.roomId}`)
    expect(created.members).toEqual(members)
    expect(created.log).toEqual([])
    expect($groupChats.get()[created.key]).toEqual(expect.objectContaining({
      log: [],
      members,
      name: 'Research team',
      roomId: created.roomId
    }))
    expect($knownRooms.get()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: created.key,
        log: [],
        members,
        name: 'Research team',
        roomId: created.roomId
      })
    ]))
  })

  it('resetKnownRooms clears the retained roster half and the signature state', () => {
    const gatewayRoom: GroupRoom = {
      key: 'id:r-4',
      log: [],
      members: [{ name: 'ada' }],
      name: 'Room',
      roomId: 'r-4'
    }
    publishRosterRooms([gatewayRoom])
    replaceGroupChats({
      'id:local': room({ name: 'Local', roomId: 'local', members: [{ name: 'ada' }] })
    })
    resetKnownRooms()
    expect($knownRooms.get().map(room => room.key)).toEqual(['id:local'])
    // The signature state is cleared: the same content publishes again.
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    publishRosterRooms([gatewayRoom])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('clears populated rosters once and treats empty publications after reset as no-ops', () => {
    const gatewayRoom = bareRosterRoom()
    publishRosterRooms([gatewayRoom])
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      publishRosterRooms([])
      expect(listener).toHaveBeenCalledTimes(1)
      expect($knownRooms.get()).toEqual([])

      publishRosterRooms([])
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }

    resetKnownRooms()
    const afterResetListener = vi.fn()
    const unsubscribeAfterReset = $knownRooms.listen(afterResetListener)
    try {
      publishRosterRooms([])
      expect(afterResetListener).not.toHaveBeenCalled()
    } finally {
      unsubscribeAfterReset()
    }
  })

  it('deduplicates equal snapshots and applies the last publisher, including an empty publication', () => {
    const first: GroupRoom = {
      key: 'id:r-publishers',
      log: [{ at: 1, from: { kind: 'member', name: 'ada', source: 'remote' }, id: 'entry', text: 'text', thread: 'thread' }],
      members: [{ name: 'ada', handle: 'a', connectionId: 'connection', sourceScoped: true }],
      name: 'Room',
      roomId: 'r-publishers'
    }
    const equalClone: GroupRoom = {
      roomId: 'r-publishers',
      name: 'Room',
      members: [{ sourceScoped: true, connectionId: 'connection', handle: 'a', name: 'ada' }],
      log: [{ thread: 'thread', text: 'text', id: 'entry', from: { source: 'remote', name: 'ada', kind: 'member' }, at: 1 }],
      key: 'id:r-publishers'
    }
    const listener = vi.fn()
    const unsubscribe = $knownRooms.listen(listener)
    try {
      const pair = render(createElement(PublisherPair, { first: [first], second: [equalClone] }))
      expect(listener).toHaveBeenCalledTimes(1)
      expect($knownRooms.get()).toEqual([first])

      const changed = { ...first, name: 'First publisher' }
      act(() => pair.rerender(createElement(PublisherPair, { first: [changed], second: [equalClone] })))
      expect($knownRooms.get()).toEqual([changed])
      expect(listener).toHaveBeenCalledTimes(2)

      const last = { ...first, name: 'Second publisher' }
      act(() => pair.rerender(createElement(PublisherPair, { first: [changed], second: [last] })))
      expect($knownRooms.get()).toEqual([last])
      expect(listener).toHaveBeenCalledTimes(3)

      // The second publisher clears the shared roster while the first remains mounted.
      act(() => pair.rerender(createElement(PublisherPair, { first: [changed], second: [] })))
      expect($knownRooms.get()).toEqual([])
      expect(listener).toHaveBeenCalledTimes(4)
    } finally {
      unsubscribe()
    }
  })

  it('useGroupRooms publishes the roster input; the view is retained after unmount', () => {
    replaceGroupChats({
      'id:r-5': room({ name: 'Room', roomId: 'r-5', members: [{ name: 'ada' }] }),
      'name:Ghost': room({ name: 'Ghost', log: [] })
    })
    render(createElement(Publisher, { roster: [{
      key: 'id:r-gw',
      log: [memberEntry('ada', 'from the gateway')],
      members: [{ name: 'ada' }],
      name: 'Gateway room',
      roomId: 'r-gw'
    }] }))
    expect($knownRooms.get().map(room => room.key)).toEqual(['id:r-gw', 'id:r-5'])
    cleanup()
    // The app-header contract: the roster half outlives the publisher.
    render(createElement(Reader))
    expect(screen.getByTestId('known-rooms-count').textContent).toBe('2')
  })

  it('refreshes the immediate and retained views when a reused array changes', () => {
    const original: GroupRoom = {
      key: 'id:r-reused',
      log: [memberEntry('ada', 'old text')],
      members: [{ name: 'ada', handle: 'old-handle' }],
      name: 'Room',
      roomId: 'r-reused'
    }
    const updated: GroupRoom = {
      ...original,
      image: 'new-image',
      log: [{ ...original.log[0], text: 'new text', thread: 'new-thread' }],
      members: [{ ...original.members[0], handle: 'new-handle' }]
    }
    const roster = [original]
    const publisher = render(createElement(Publisher, { roster }))
    const readPublished = () => JSON.parse(screen.getByTestId('published-rooms').getAttribute('data-rooms') ?? '[]')
    expect(readPublished()).toEqual([original])

    roster[0] = updated
    act(() => publisher.rerender(createElement(Publisher, { roster })))

    expect(readPublished()).toEqual([updated])
    expect($knownRooms.get()).toEqual([updated])
    publisher.unmount()
    render(createElement(Reader))
    const retained = JSON.parse(screen.getByTestId('known-rooms-count').getAttribute('data-rooms') ?? '[]')
    expect(retained).toEqual([updated])
  })

  it('useKnownRooms re-renders on $groupChats writes without any publisher', () => {
    render(createElement(Reader))
    expect(screen.getByTestId('known-rooms-count').textContent).toBe('0')
    act(() => {
      replaceGroupChats({
        'id:r-6': room({ name: 'Seeded', roomId: 'r-6', members: [{ name: 'ada' }] })
      })
    })
    expect(screen.getByTestId('known-rooms-count').textContent).toBe('1')
  })
})