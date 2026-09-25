import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'

import {
  $groupActivity,
  $groupChats,
  $groupNeedsYou,
  $groupPrompts,
  $knownRooms,
  answerGroupPrompt,
  createGroupChat,
  groupRoomsView,
  openGroupRoom,
  publishRosterRooms,
  resetKnownRooms,
  sendToGroupChat,
  startGroupEngine,
  stopGroupEngine,
  stopGroupThread,
  useGroupRooms,
  useKnownRooms
} from './group-engine'
import {
  $groupActivity as $groupActivityState,
  $groupNeedsYou as $groupNeedsYouState,
  $groupPrompts as $groupPromptsState,
  replaceGroupChats,
  updateGroupChat,
  type GroupChatRoom,
  type GroupPrompt
} from './group-store'
import type { GroupMember, GroupMessage, GroupRoom } from './group-model'

function assertGroupStoreExportsAreReadOnly(): void {
  // @ts-expect-error Public group state must not expose a setter.
  $groupChats.set({})
  // @ts-expect-error Public group state must not expose a setter.
  $groupActivity.set({})
  // @ts-expect-error Public group state must not expose a setter.
  $groupPrompts.set({})
  // @ts-expect-error Public group state must not expose a setter.
  $groupNeedsYou.set({})
}

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
  resetKnownRooms()
  $groupActivityState.set({})
  $groupPromptsState.set({})
  $groupNeedsYouState.set({})
  calls = []
})

afterEach(() => {
  cleanup()
  stopGroupEngine()
  vi.useRealTimers()
})

describe('read surface', () => {
  it('exposes needs-you updates through the public handle', () => {
    $groupNeedsYouState.set({ 'name:Room': true })
    expect($groupNeedsYou.get()).toEqual({ 'name:Room': true })
  })
})

describe('lifecycle', () => {
  it('reaches the gateway through the injected transport with CAS read-back', async () => {
    vi.useFakeTimers()
    const sync = makeSyncHandlers()
    startGroupEngine(async (method, params) => {
      calls.push({ method, params: params ?? {} })
      return sync(method, params ?? {})
    })
    updateGroupChat('id:r-1', r => ({
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
    // A plain pull through the engine facade confirms the read-back revision.
    openGroupRoom({ key: 'id:r-1', log: [], members: [{ name: 'ada' }], name: 'Room', roomId: 'r-1' })
    await vi.waitFor(() => expect($groupChats.get()['id:r-1'].syncRevision).toBe(1))
    expect($groupChats.get()['id:r-1'].syncRevision).toBe(1)
    // stop clears pending work and the transport
    stopGroupEngine()
    updateGroupChat('id:r-1', r => r) // scheduler gone — nothing scheduled
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.filter(call => call.method === 'profiles.configure')).toHaveLength(1)
    expect(sendToGroupChat('id:r-1', [{ name: 'ada' }], 'after stop')).toBe(null)
    await stopGroupThread('id:r-1', 't1', [{ name: 'ada' }])
    await expect(Promise.resolve()).resolves.toBeUndefined()
  })

  it('bumps every room epoch and clears running on scope teardown', () => {
    replaceGroupChats({ 'name:Room': room({ running: true, epoch: 5 }) })
    startGroupEngine(async () => ({}))
    stopGroupEngine()
    const stopped = $groupChats.get()['name:Room']
    expect(stopped.running).toBe(false)
    expect(stopped.epoch).toBe(6)
  })

  it('holds engine writes behind the initial pull', async () => {
    vi.useFakeTimers()
    let releaseInitial!: (value: unknown) => void
    const initial = new Promise<unknown>(resolve => { releaseInitial = resolve })
    let written: unknown = null
    let revision = 0
    let configures = 0
    const transport = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'profiles.list') {
        if (revision === 0 && written === null) return initial
        return {
          profiles: [{
            name: 'default',
            ui_meta: written ? { 'hermes-bots-groups': written } : {},
            ui_meta_revisions: { 'hermes-bots-groups': revision }
          }]
        }
      }
      if (method === 'profiles.configure') {
        configures += 1
        written = (params?.ui_meta as Record<string, unknown>)['hermes-bots-groups']
        revision += 1
        return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': revision } } }
      }
      return {}
    }

    startGroupEngine(transport)
    updateGroupChat('id:r-barrier', current => ({
      ...current,
      roomId: 'r-barrier',
      members: [{ name: 'ada' }],
      log: [userEntry('queued')]
    }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(configures).toBe(0)

    releaseInitial({ profiles: [{ name: 'default', ui_meta: {}, ui_meta_revisions: {} }] })
    await vi.waitFor(() => expect(configures).toBe(1))
  })

  it('isolates a stopped engine pull from the next engine lifecycle', async () => {
    let releaseOld!: (value: unknown) => void
    const oldRead = new Promise<unknown>(resolve => { releaseOld = resolve })
    let oldCalls = 0
    const oldTransport = async (method: string) => {
      if (method === 'profiles.list') {
        oldCalls += 1
        return oldRead
      }
      return {}
    }
    const nextTransport = async (method: string) => {
      if (method === 'profiles.list') {
        return {
          profiles: [{
            name: 'default',
            ui_meta: {
              'hermes-bots-groups': {
                version: 3,
                rooms: { 'name:Next': { name: 'Next', revision: 1, log: [userEntry('next')] } }
              }
            },
            ui_meta_revisions: { 'hermes-bots-groups': 1 }
          }]
        }
      }
      return {}
    }

    startGroupEngine(oldTransport)
    await vi.waitFor(() => expect(oldCalls).toBe(1))
    stopGroupEngine()
    startGroupEngine(nextTransport)
    await vi.waitFor(() => expect($groupChats.get()['name:Next']).toBeTruthy())

    releaseOld({
      profiles: [{
        name: 'default',
        ui_meta: {
          'hermes-bots-groups': {
            version: 3,
            rooms: { 'name:Old': { name: 'Old', revision: 1, log: [userEntry('old')] } }
          }
        },
        ui_meta_revisions: { 'hermes-bots-groups': 1 }
      }]
    })
    await Promise.resolve()
    await Promise.resolve()

    expect($groupChats.get()['name:Old']).toBeUndefined()
    expect($groupChats.get()['name:Next']).toBeTruthy()
  })

  it('isolates an old member turn when a new lifecycle replaces its transport', async () => {
    vi.useFakeTimers()
    let releaseOldPoll!: (value: unknown) => void
    const oldPoll = new Promise<unknown>(resolve => { releaseOldPoll = resolve })
    let oldResume = 0
    let oldMemberCalls = 0
    const oldTransport: Transport = async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume') {
        oldMemberCalls += 1
        if (params.omit_messages) return { session_id: 'old-runtime', session_key: 'old-stored' }
        if (oldResume++ === 0) return { messages: [] }
        return oldPoll
      }
      if (method === 'prompt.submit') { oldMemberCalls += 1; return {} }
      return {}
    }
    startGroupEngine(oldTransport)
    replaceGroupChats({ 'id:r-old': room({ name: 'Room', roomId: 'r-old', members: [{ name: 'ada' }] }) })
    sendToGroupChat('id:r-old', [{ name: 'ada' }], 'old request', 't-old')
    await vi.advanceTimersByTimeAsync(2000)
    const oldCallsAtStop = oldMemberCalls

    stopGroupEngine()
    let newResume = 0
    const newTransport: Transport = async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'new-runtime', session_key: 'new-stored' }
      if (method === 'session.resume') return newResume++ === 0
        ? { messages: [] }
        : { messages: [{ role: 'assistant', content: 'new reply' }] }
      return {}
    }
    startGroupEngine(newTransport)

    releaseOldPoll({
      messages: [{ role: 'assistant', content: 'old reply' }]
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(oldMemberCalls).toBe(oldCallsAtStop)
    expect($groupChats.get()['id:r-old'].log.some(item => item.text === 'old reply')).toBe(false)

    sendToGroupChat('id:r-old', [{ name: 'ada' }], 'new request', 't-new')
    await vi.advanceTimersByTimeAsync(2000)
    expect($groupChats.get()['id:r-old'].log.some(item => item.text === 'new reply')).toBe(true)
  })

  it('keeps a stopped module inert when the same raw transport is reused', async () => {
    vi.useFakeTimers()
    let releaseOldPoll!: (value: unknown) => void
    const oldPoll = new Promise<unknown>(resolve => { releaseOldPoll = resolve })
    let turnNumber = 0
    let resumePhase = 0
    let memberCalls = 0
    const transport: Transport = async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume' && params.omit_messages) {
        turnNumber += 1
        resumePhase = 0
        memberCalls += 1
        return { session_id: `runtime-${turnNumber}` }
      }
      if (method === 'session.resume') {
        memberCalls += 1
        if (resumePhase++ === 0) return { messages: [] }
        if (turnNumber === 1) return oldPoll
        return { messages: [{ role: 'assistant', content: 'new lifecycle reply' }] }
      }
      if (method === 'prompt.submit') {
        memberCalls += 1
        return {}
      }
      return {}
    }
    startGroupEngine(transport)
    replaceGroupChats({ 'id:same-transport': room({ name: 'Room', roomId: 'same-transport', members: [{ name: 'ada' }] }) })
    sendToGroupChat('id:same-transport', [{ name: 'ada' }], 'old request', 't-old')
    await vi.advanceTimersByTimeAsync(2000)
    const callsAtStop = memberCalls

    stopGroupEngine()
    startGroupEngine(transport)
    releaseOldPoll({ messages: [{ role: 'assistant', content: 'old reply' }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(memberCalls).toBe(callsAtStop)
    expect($groupChats.get()['id:same-transport'].log.some(item => item.text === 'old reply')).toBe(false)

    sendToGroupChat('id:same-transport', [{ name: 'ada' }], 'new request', 't-new')
    await vi.advanceTimersByTimeAsync(2000)
    expect($groupChats.get()['id:same-transport'].log.some(item => item.text === 'new lifecycle reply')).toBe(true)
  })

  it('deactivates delayed drives so they cannot consult the next lifecycle', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    const firstPoll = new Promise<unknown>(resolve => { release = resolve })
    let pollCount = 0
    let oldMemberCalls = 0
    startGroupEngine(async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume' && params.omit_messages) { oldMemberCalls += 1; return { session_id: 'rt', session_key: 'stored' } }
      if (method === 'session.resume') {
        oldMemberCalls += 1
        if (pollCount++ === 0) return { messages: [] }
        return firstPoll
      }
      if (method === 'prompt.submit') { oldMemberCalls += 1; return {} }
      return {}
    })
    sendToGroupChat('name:Room', [{ name: 'ada' }], 'first', 't1')
    sendToGroupChat('name:Room', [{ name: 'ada' }], 'second', 't1')
    stopGroupEngine()
    const callsAtStop = oldMemberCalls
    let newResume = 0
    startGroupEngine(async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'new-rt', session_key: 'new-stored' }
      if (method === 'session.resume') return newResume++ === 0
        ? { messages: [] }
        : { messages: [{ role: 'assistant', content: 'new lifecycle' }] }
      return {}
    })
    sendToGroupChat('name:Room', [{ name: 'ada' }], 'new lifecycle request', 't2')
    release({ messages: [{ role: 'assistant', content: 'old' }] })
    await vi.advanceTimersByTimeAsync(400)
    expect(oldMemberCalls).toBe(callsAtStop)
    expect($groupChats.get()['name:Room'].log.some(item => item.text === 'old')).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect($groupChats.get()['name:Room'].log.some(item => item.text === 'new lifecycle')).toBe(true)
    expect($groupChats.get()['name:Room'].running).toBe(false)
  })

  it('harvests an opened room through its captured lifecycle', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => { release = resolve })
    let oldHarvestCalls = 0
    startGroupEngine(async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume') {
        oldHarvestCalls += 1
        return pending
      }
      return {}
    })
    replaceGroupChats({ 'id:r-open': room({
      name: 'Room',
      roomId: 'r-open',
      sessions: { ada: 'old-stored' },
      stranded: { ada: { before: 0, thread: 't1' } }
    }) })
    openGroupRoom({ key: 'id:r-open', log: [], members: [{ name: 'ada' }], name: 'Room', roomId: 'r-open' })
    await Promise.resolve()
    expect(oldHarvestCalls).toBe(1)

    stopGroupEngine()
    let newMemberCalls = 0
    startGroupEngine(async (method) => {
      if (method === 'profiles.list') return {}
      newMemberCalls += 1
      return { messages: [{ role: 'assistant', content: 'new lifecycle' }] }
    })
    release({ messages: [{ role: 'assistant', content: 'old harvest' }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(newMemberCalls).toBe(0)
    expect($groupChats.get()['id:r-open'].log.some(item => item.text === 'old harvest')).toBe(false)
    expect($groupChats.get()['id:r-open'].stranded?.ada).toBeTruthy()
  })

  it('fails closed when no lifecycle is active', async () => {
    replaceGroupChats({ 'name:Room': room({ epoch: 2 }) })
    await stopGroupThread('name:Room', 't1', [{ name: 'ada' }])
    expect(sendToGroupChat('name:Room', [{ name: 'ada' }], 'no transport')).toBe(null)
    const prompt: GroupPrompt = {
      at: Date.now(), roomKey: 'name:Room', member: 'ada', memberKey: 'ada', kind: 'clarify',
      question: 'old', requestId: 'q1', sessionId: 'rt'
    }
    $groupPromptsState.set({ 'name:Room::ada': prompt })
    const before = $groupChats.get()['name:Room']
    const answer = await answerGroupPrompt(prompt, { name: 'ada' }, 'yes')
    expect(answer).toBeUndefined()
    expect($groupPrompts.get()['name:Room::ada']).toBe(prompt)
    expect($groupChats.get()['name:Room'].epoch).toBe(before.epoch)
  })

  it('routes prompt answers through the active captured member adapter', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    startGroupEngine(async (method, params = {}) => {
      if (method !== 'profiles.list') calls.push({ method, params })
      return {}
    })
    const prompt: GroupPrompt = {
      at: Date.now(), roomKey: 'name:Room', member: 'ada', memberKey: 'ada', kind: 'clarify',
      question: 'Proceed?', requestId: 'q1', sessionId: 'runtime'
    }
    $groupPromptsState.set({ 'name:Room::ada': prompt })
    await answerGroupPrompt(prompt, { name: 'ada' }, 'yes')
    expect(calls).toContainEqual({
      method: 'clarify.respond',
      params: { request_id: 'q1', answer: 'yes', profile: 'ada' }
    })
    expect($groupPrompts.get()['name:Room::ada']).toBeUndefined()
  })

  it('tears down the old lifecycle on a repeated start', async () => {
    const firstTransport = async () => ({})
    replaceGroupChats({ 'name:Room': room({ epoch: 5, running: true }) })
    startGroupEngine(firstTransport)

    let secondRead!: (value: unknown) => void
    const secondPending = new Promise<unknown>(resolve => { secondRead = resolve })
    startGroupEngine(async method => method === 'profiles.list' ? secondPending : {})

    expect($groupChats.get()['name:Room']).toMatchObject({ epoch: 6, running: false })
    secondRead({ profiles: [{ name: 'default', ui_meta: {}, ui_meta_revisions: {} }] })
    await Promise.resolve()
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
    replaceGroupChats({ 'id:r-1': room({ name: 'Room', roomId: 'r-1', members: [{ name: 'ada' }] }) })
    const thread = sendToGroupChat('id:r-1', [{ name: 'ada' }], 'hello @ada')
    expect(thread).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2000) // turn poll → reply lands
    await vi.advanceTimersByTimeAsync(2000) // next round boundary → settle

    const driven = $groupChats.get()['id:r-1']
    const replies = driven.log.filter(entry => entry.from.kind === 'member')
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe('Found three candidates in the specs.')
    expect(driven.watermarks[`${thread}::ada`]).toBe(driven.log.length)
    expect(driven.running).toBe(false)
    // The member's RPCs ride the profile param.
    const submit = calls.find(call => call.method === 'prompt.submit')
    expect(submit?.params.profile).toBe('ada')
    // Activity: queued → working → replied → settled.
    expect($groupActivity.get()['id:r-1'].map(entry => entry.kind)).toEqual(['queued', 'working', 'replied', 'settled'])
    // The mirror flush published through the injected transport.
    expect(calls.some(call => call.method === 'profiles.configure')).toBe(true)
  })

  it('records a "(pass)" reply as silence and appends nothing', async () => {
    vi.useFakeTimers()
    installRoundTransport('(pass)')
    replaceGroupChats({ 'id:r-1': room({ name: 'Room', roomId: 'r-1', members: [{ name: 'ada' }] }) })
    sendToGroupChat('id:r-1', [{ name: 'ada' }], 'hello @ada')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    const driven = $groupChats.get()['id:r-1']
    expect(driven.log.filter(entry => entry.from.kind === 'member')).toHaveLength(0)
    expect($groupActivity.get()['id:r-1'].map(entry => entry.kind)).toEqual(['queued', 'working', 'passed', 'settled'])
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
      'name:Room': room({
        running: true,
        epoch: 2,
        turn: 'ada',
        members: [{ name: 'ada' }, { name: 'scout' }],
        sessions: { ada: 'stored-ada', scout: 'stored-scout' },
        log: [userEntry('go', 1, 't1')]
      })
    })
    await stopGroupThread('name:Room', 't1', [{ name: 'ada' }, { name: 'scout' }])
    const stopped = $groupChats.get()['name:Room']
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
      'id:r-1': room({ name: 'Room', roomId: 'r-1', log: [] }),
      // Empty tombstone: no transcript, no durable identity — filtered.
      'name:Ghost': room({ name: 'Ghost', log: [] }),
      // Just-created: durable identity + members with an empty log — retained.
      'id:r-2': room({ name: 'Just created', roomId: 'r-2', members: [{ name: 'a' }] }),
      // Local-only named room with transcript — included under its name key.
      'name:Local': room({ name: 'Local', log: [userEntry('hi', 1, 'legacy')] })
    })
    expect(view.map(entry => entry.key).sort()).toEqual(['Ghost-undefined', 'id:r-1', 'id:r-2', 'name:Local'].filter(k => k !== 'Ghost-undefined'))
    expect(view.find(entry => entry.key === 'id:r-1')?.log[0].text).toBe('from the gateway')
    expect(view.find(entry => entry.key === 'id:r-2')?.name).toBe('Just created')
    expect(view.find(entry => entry.key === 'name:Local')?.log).toHaveLength(1)
  })
})

describe('known rooms', () => {
  function Publisher({ roster }: { roster: GroupRoom[] }) {
    useGroupRooms(roster)
    return null
  }
  function Reader() {
    const rooms = useKnownRooms()
    return createElement('div', { 'data-testid': 'known-rooms-count' }, String(rooms.length))
  }

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
    // A freshly built content-equal roster is a no-op.
    publishRosterRooms([{ ...gatewayRoom }])
    expect(listener).not.toHaveBeenCalled()
    // A changed name is one write.
    publishRosterRooms([{ ...gatewayRoom, name: 'Renamed' }])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
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