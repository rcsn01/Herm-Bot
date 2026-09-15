import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import { cleanup, render, screen } from '@testing-library/react'

import {
  $groupActivity,
  $groupChats,
  $groupNeedsYou,
  $groupPrompts,
  groupRoomsView,
  sendToGroupChat,
  startGroupEngine,
  stopGroupEngine,
  stopGroupThread,
  useGroupRooms
} from './group-engine'
import { replaceGroupChats, updateGroupChat, type GroupChatRoom } from './group-store'
import { pullGroupChatState } from './groups-sync'
import { groupEngineRequest } from './group-runtime'
import type { GroupMember, GroupMessage, GroupRoom } from './group-model'

type Transport = (method: string, params?: Record<string, unknown>) => Promise<unknown>

// The global setup stubs crypto.randomUUID to a constant; the sync log-union
// dedupes entries by id, so this round-trip suite needs unique ids like
// production minting gives.
let uuidCounter = 0
;(globalThis.crypto as { randomUUID: () => string }).randomUUID = () => `test-uuid-${++uuidCounter}`

let calls: Array<{ method: string; params: Record<string, unknown> }> = []

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

/** The mirror-sync half every scripted transport serves: CAS write with an
 *  advancing revision, read-back of the written snapshot. */
function makeSyncHandlers() {
  let revision = 0
  let written: unknown = null
  return (method: string, params: Record<string, unknown>): unknown => {
    if (method === 'profiles.list') {
      return {
        profiles: [{
          name: 'default',
          ui_meta: written ? { 'hermes-bots-groups': written } : {},
          ui_meta_revisions: { 'hermes-bots-groups': revision }
        }]
      }
    }
    if (method === 'profiles.configure') {
      revision += 1
      written = (params.ui_meta as Record<string, unknown>)['hermes-bots-groups']
      return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': revision } } }
    }
    return {}
  }
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({})
  $groupActivity.set({})
  $groupPrompts.set({})
  $groupNeedsYou.set({})
  calls = []
})

afterEach(() => {
  cleanup()
  stopGroupEngine()
  vi.useRealTimers()
})

describe('lifecycle', () => {
  it('reaches the gateway through the injected transport with CAS read-back', async () => {
    vi.useFakeTimers()
    const sync = makeSyncHandlers()
    startGroupEngine(async (method, params) => {
      calls.push({ method, params: params ?? {} })
      return sync(method, params ?? {})
    })
    updateGroupChat('Room', r => ({
      ...r,
      roomId: 'r-1',
      members: [{ name: 'ada' }],
      log: [userEntry('kick off', 1, 't1')]
    }))
    await vi.advanceTimersByTimeAsync(350) // flush debounce
    const configure = calls.find(call => call.method === 'profiles.configure')
    expect(configure).toBeDefined()
    expect(configure?.params.name).toBe('default')
    expect(configure?.params.ui_meta_expected_revisions).toEqual({ 'hermes-bots-groups': 0 })
    const snapshot = (configure?.params.ui_meta as Record<string, unknown>)['hermes-bots-groups'] as {
      version: number
      rooms: Record<string, unknown>
    }
    expect(snapshot.version).toBe(3)
    expect(Object.keys(snapshot.rooms)).toContain('id:r-1')
    // A plain pull (the flushed room is no longer "changed") then confirms
    // the read-back merge advanced the room's sync revision to the write.
    await pullGroupChatState()
    expect($groupChats.get().Room.syncRevision).toBe(1)
    // stop clears pending work and the transport
    stopGroupEngine()
    updateGroupChat('Room', r => r) // scheduler gone — nothing scheduled
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.filter(call => call.method === 'profiles.configure')).toHaveLength(1)
    expect(() => groupEngineRequest('profiles.list')).toThrow('Group engine transport is not connected.')
  })

  it('bumps every room epoch and clears running on scope teardown', () => {
    replaceGroupChats({ Room: room({ running: true, epoch: 5 }) })
    startGroupEngine(async () => ({}))
    stopGroupEngine()
    const stopped = $groupChats.get().Room
    expect(stopped.running).toBe(false)
    expect(stopped.epoch).toBe(6)
  })
})

describe('full round', () => {
  function installRoundTransport(replyText: string) {
    let resumed = 0
    const sync = makeSyncHandlers()
    startGroupEngine(async (method, params) => {
      calls.push({ method, params: params ?? {} })
      const syncResult = sync(method, params ?? {})
      if (method === 'profiles.list' || method === 'profiles.configure') return syncResult
      if (method === 'session.resume' && params?.session_id === 'Group: r-1') {
        return { session_id: 'rt-live', session_key: 'stored-1' }
      }
      if (method === 'session.resume' && params?.session_id === 'stored-1' && resumed++ === 0) {
        return { messages: [], message_count: 0 } // the pre-submit baseline
      }
      if (method === 'session.resume') {
        return {
          session_id: 'rt-live',
          inflight: false,
          running: false,
          messages: [
            { role: 'user', content: 'hello @ada' },
            { role: 'assistant', content: replyText }
          ]
        }
      }
      if (method === 'prompt.submit') return {}
      return {}
    })
  }

  it('delivers a member reply, advances watermarks, and fires the mirror flush', async () => {
    vi.useFakeTimers()
    installRoundTransport('Found three candidates in the specs.')
    replaceGroupChats({ Room: room({ name: 'Room', roomId: 'r-1', members: [{ name: 'ada' }] }) })
    const thread = sendToGroupChat('Room', [{ name: 'ada' }], 'hello @ada')
    expect(thread).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2000) // turn poll → reply lands
    await vi.advanceTimersByTimeAsync(2000) // next round boundary → settle

    const driven = $groupChats.get().Room
    const replies = driven.log.filter(entry => entry.from.kind === 'member')
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe('Found three candidates in the specs.')
    expect(driven.watermarks[`${thread}::ada`]).toBe(driven.log.length)
    expect(driven.running).toBe(false)
    // The member's RPCs ride the profile param.
    const submit = calls.find(call => call.method === 'prompt.submit')
    expect(submit?.params.profile).toBe('ada')
    // Activity: queued → working → replied → settled.
    expect($groupActivity.get().Room.map(entry => entry.kind)).toEqual(['queued', 'working', 'replied', 'settled'])
    // The mirror flush published through the injected transport.
    expect(calls.some(call => call.method === 'profiles.configure')).toBe(true)
  })

  it('records a "(pass)" reply as silence and appends nothing', async () => {
    vi.useFakeTimers()
    installRoundTransport('(pass)')
    replaceGroupChats({ Room: room({ name: 'Room', roomId: 'r-1', members: [{ name: 'ada' }] }) })
    sendToGroupChat('Room', [{ name: 'ada' }], 'hello @ada')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    const driven = $groupChats.get().Room
    expect(driven.log.filter(entry => entry.from.kind === 'member')).toHaveLength(0)
    expect($groupActivity.get().Room.map(entry => entry.kind)).toEqual(['queued', 'working', 'passed', 'settled'])
  })
})

describe('stopGroupThread', () => {
  it('bumps the epoch, holds every member, and interrupts the speaker session', async () => {
    const sync = makeSyncHandlers()
    startGroupEngine(async (method, params) => {
      calls.push({ method, params: params ?? {} })
      return sync(method, params ?? {})
    })
    replaceGroupChats({
      Room: room({
        running: true,
        epoch: 2,
        turn: 'ada',
        members: [{ name: 'ada' }, { name: 'scout' }],
        sessions: { ada: 'stored-ada', scout: 'stored-scout' },
        log: [userEntry('go', 1, 't1')]
      })
    })
    await stopGroupThread('Room', 't1', [{ name: 'ada' }, { name: 'scout' }])
    const stopped = $groupChats.get().Room
    expect(stopped.epoch).toBe(3)
    expect(stopped.running).toBe(false)
    expect(stopped.turn).toBeNull()
    expect(stopped.holds?.ada).toBeDefined()
    expect(stopped.holds?.scout).toBeDefined()
    const interrupt = calls.find(call => call.method === 'session.interrupt')
    expect(interrupt?.params).toEqual({ session_id: 'stored-ada', profile: 'ada' })
  })
})

describe('groupRoomsView', () => {
  it('unions roster and local rooms by durable key, filtering empty tombstones', () => {
    const rosterRoom: GroupRoom = {
      key: 'id:r-1',
      log: [memberEntry('ada', 'from the gateway')],
      members: [{ name: 'ada' }],
      name: 'Room',
      roomId: 'r-1'
    }
    const view = groupRoomsView([rosterRoom], {
      // Same durable key — the roster's richer copy wins.
      Room: room({ name: 'Room', roomId: 'r-1', log: [] }),
      // Empty tombstone: no transcript, no durable identity — filtered.
      Ghost: room({ name: 'Ghost', log: [] }),
      // Just-created: durable identity + members with an empty log — retained.
      'Just created': room({ name: 'Just created', roomId: 'r-2', members: [{ name: 'a' }] }),
      // Local-only named room with transcript — included under its name key.
      Local: room({ name: 'Local', log: [userEntry('hi', 1, 'legacy')] })
    })
    expect(view.map(entry => entry.key).sort()).toEqual(['Ghost-undefined', 'id:r-1', 'id:r-2', 'name:Local'].filter(k => k !== 'Ghost-undefined'))
    expect(view.find(entry => entry.key === 'id:r-1')?.log[0].text).toBe('from the gateway')
    expect(view.find(entry => entry.key === 'id:r-2')?.name).toBe('Just created')
    expect(view.find(entry => entry.key === 'name:Local')?.log).toHaveLength(1)
  })
})

describe('useGroupRooms', () => {
  function Publisher({ roster }: { roster: GroupRoom[] }) {
    useGroupRooms(roster)
    return null
  }
  function Reader() {
    const rooms = useGroupRooms()
    return createElement('div', { 'data-testid': 'known-rooms-count' }, String(rooms.length))
  }

  it('publishes the merged view with roster data; provider-free callers read the last view', () => {
    replaceGroupChats({
      Room: room({ name: 'Room', roomId: 'r-1', members: [{ name: 'ada' }] }),
      Ghost: room({ name: 'Ghost', log: [] })
    })
    render(
      createElement(Fragment, null, createElement(Publisher, { roster: [] }), createElement(Reader))
    )
    // The just-created room survives the tombstone filter; the ghost does not.
    expect(screen.getByTestId('known-rooms-count').textContent).toBe('1')
    cleanup()
    // The app-header contract: no roster data, read the last published view.
    render(createElement(Reader))
    expect(screen.getByTestId('known-rooms-count').textContent).toBe('1')
  })
})