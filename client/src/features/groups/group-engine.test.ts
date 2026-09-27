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

// Connection keys the engine tests start lifecycles with.
const KEY_A = 'https://gw-a.test'
const KEY_B = 'https://gw-b.test'

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
    }, KEY_A)
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
    startGroupEngine(async () => ({}), KEY_A)
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

    startGroupEngine(transport, KEY_A)
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

    startGroupEngine(oldTransport, KEY_A)
    await vi.waitFor(() => expect(oldCalls).toBe(1))
    stopGroupEngine()
    startGroupEngine(nextTransport, KEY_A)
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
    startGroupEngine(oldTransport, KEY_A)
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
    startGroupEngine(newTransport, KEY_A)

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
    startGroupEngine(transport, KEY_A)
    replaceGroupChats({ 'id:same-transport': room({ name: 'Room', roomId: 'same-transport', members: [{ name: 'ada' }] }) })
    sendToGroupChat('id:same-transport', [{ name: 'ada' }], 'old request', 't-old')
    await vi.advanceTimersByTimeAsync(2000)
    const callsAtStop = memberCalls

    stopGroupEngine()
    startGroupEngine(transport, KEY_A)
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
    }, KEY_A)
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
    }, KEY_A)
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
    }, KEY_A)
    replaceGroupChats({ 'id:r-open': room({
      name: 'Room',
      roomId: 'r-open',
      sessionConnectionKey: KEY_A,
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
    }, KEY_A)
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
      connectionKey: KEY_A, question: 'old', requestId: 'q1', sessionId: 'rt'
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
    }, KEY_A)
    const prompt: GroupPrompt = {
      at: Date.now(), roomKey: 'name:Room', member: 'ada', memberKey: 'ada', kind: 'clarify',
      connectionKey: KEY_A, question: 'Proceed?', requestId: 'q1', sessionId: 'runtime'
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
    startGroupEngine(firstTransport, KEY_A)

    let secondRead!: (value: unknown) => void
    const secondPending = new Promise<unknown>(resolve => { secondRead = resolve })
    startGroupEngine(async method => method === 'profiles.list' ? secondPending : {}, KEY_A)

    expect($groupChats.get()['name:Room']).toMatchObject({ epoch: 6, running: false })
    secondRead({ profiles: [{ name: 'default', ui_meta: {}, ui_meta_revisions: {} }] })
    await Promise.resolve()
  })

  it('clears the previous connection\'s stored ids before the next lifecycle can use them', async () => {
    vi.useFakeTimers()
    let resumesA = 0
    startGroupEngine(async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt-a', session_key: 'stored-a' }
      if (method === 'session.resume') {
        if (resumesA++ === 0) return { messages: [] }
        return { messages: [{ role: 'assistant', content: 'reply from a' }] }
      }
      return {}
    }, KEY_A)
    replaceGroupChats({ 'id:r-1': room({
      name: 'Room', roomId: 'r-1', members: [{ name: 'ada' }],
      log: [userEntry('go', 1, 't1')], watermarks: { 't1::ada': 1 }
    }) })
    sendToGroupChat('id:r-1', [{ name: 'ada' }], 'hello', 't1')
    await vi.advanceTimersByTimeAsync(4000)
    const afterA = $groupChats.get()['id:r-1']
    expect(afterA.sessionConnectionKey).toBe(KEY_A)
    expect(afterA.sessions?.ada).toBe('stored-a')
    expect(afterA.log.some(entry => entry.text === 'reply from a')).toBe(true)

    stopGroupEngine()
    const bCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    let resumesB = 0
    startGroupEngine(async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      bCalls.push({ method, params })
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt-b', session_key: 'stored-b' }
      if (method === 'session.resume') {
        if (resumesB++ === 0) return { messages: [] }
        return { messages: [{ role: 'assistant', content: 'reply from b' }] }
      }
      return {}
    }, KEY_B)

    // The switch swept A's provenance; the shared room state survived.
    const afterSwitch = $groupChats.get()['id:r-1']
    expect(afterSwitch.sessionConnectionKey).toBeUndefined()
    expect(afterSwitch.sessions).toBeUndefined()
    expect(afterSwitch.log).toEqual(afterA.log)
    expect(afterSwitch.watermarks).toEqual(afterA.watermarks)
    expect(afterSwitch.holds).toEqual(afterA.holds)

    sendToGroupChat('id:r-1', [{ name: 'ada' }], 'hello from b', 't2')
    await vi.advanceTimersByTimeAsync(4000)
    // B's first acquisition is the room title — A's stored id is never sent.
    expect(bCalls.filter(call => call.method === 'session.resume' && call.params.omit_messages)
      .map(call => call.params.session_id)).toEqual(['Group: r-1'])
    expect(bCalls.every(call => call.params.session_id !== 'stored-a')).toBe(true)
    const afterB = $groupChats.get()['id:r-1']
    expect(afterB.sessionConnectionKey).toBe(KEY_B)
    expect(afterB.sessions?.ada).toBe('stored-b')
    expect(afterB.log.some(entry => entry.text === 'reply from b')).toBe(true)
  })

  it('discards the active id map on every key change and reacquires by title on switch-back', async () => {
    vi.useFakeTimers()
    const acquired: Record<string, string[]> = { a: [], b: [] }
    const resumes: Record<string, number> = { a: 0, b: 0 }
    const makeTransport = (connection: 'a' | 'b', stored: string): Transport => async (method, params = {}) => {
      if (method === 'profiles.list') return {}
      if (method === 'session.resume' && params.omit_messages) {
        acquired[connection].push(String(params.session_id))
        return { session_id: `rt-${connection}`, session_key: stored }
      }
      if (method === 'session.resume') {
        resumes[connection] += 1
        return resumes[connection] % 2 === 1
          ? { messages: [] }
          : { messages: [{ role: 'assistant', content: '(pass)' }] }
      }
      return {}
    }
    replaceGroupChats({ 'name:Room': room({ name: 'Room', log: [userEntry('seed')] }) })

    startGroupEngine(makeTransport('a', 'stored-a'), KEY_A)
    sendToGroupChat('name:Room', [{ name: 'ada' }], 'go', 't1')
    await vi.advanceTimersByTimeAsync(4000)
    expect(acquired.a).toEqual(['Group: Room'])
    expect($groupChats.get()['name:Room'].sessions?.ada).toBe('stored-a')

    stopGroupEngine()
    startGroupEngine(makeTransport('b', 'stored-b'), KEY_B)
    expect($groupChats.get()['name:Room'].sessions).toBeUndefined()
    sendToGroupChat('name:Room', [{ name: 'ada' }], 'go again', 't2')
    await vi.advanceTimersByTimeAsync(4000)
    expect(acquired.b).toEqual(['Group: Room'])
    expect($groupChats.get()['name:Room'].sessions?.ada).toBe('stored-b')

    stopGroupEngine()
    startGroupEngine(makeTransport('a', 'stored-a-2'), KEY_A)
    // No per-Gateway cache: switching back discards B's map and reacquires
    // by title — A's hidden session remains discoverable, its id not.
    expect($groupChats.get()['name:Room'].sessions).toBeUndefined()
    sendToGroupChat('name:Room', [{ name: 'ada' }], 'back on a', 't3')
    await vi.advanceTimersByTimeAsync(4000)
    expect(acquired.a).toEqual(['Group: Room', 'Group: Room'])
    expect($groupChats.get()['name:Room'].sessionConnectionKey).toBe(KEY_A)
    expect($groupChats.get()['name:Room'].sessions?.ada).toBe('stored-a-2')
  })

  it('sweeps mismatched session state and prompt cards before the initial mirror pull', async () => {
    let releasePull!: (value: unknown) => void
    const pendingPull = new Promise<unknown>(resolve => { releasePull = resolve })
    const stateAtPull: { foreignSessions?: unknown; promptKeys?: string[] } = {}
    const memberCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const transport: Transport = async (method, params = {}) => {
      if (method === 'profiles.list') {
        // Capture the store state the pull observes: the sweep must already
        // have run when the initial read reaches the wire.
        stateAtPull.foreignSessions = $groupChats.get()['id:r-foreign']?.sessions
        stateAtPull.promptKeys = Object.keys($groupPromptsState.get())
        return pendingPull
      }
      memberCalls.push({ method, params })
      return {}
    }
    replaceGroupChats({
      'id:r-foreign': room({
        name: 'Foreign', roomId: 'r-foreign',
        sessionConnectionKey: KEY_B, sessions: { ada: 'stored-b' }, stranded: { ada: { before: 0, thread: 't1' } }
      }),
      'id:r-untagged': room({
        name: 'Untagged', roomId: 'r-untagged', sessions: { ada: 'orphan' }, stranded: { ada: 0 }
      })
    })
    $groupPromptsState.set({
      'id:r-foreign::ada': { at: 1, connectionKey: KEY_B, roomKey: 'id:r-foreign', kind: 'clarify', member: 'ada', memberKey: 'ada', question: 'from b', requestId: 'q-b' },
      'id:r-untagged::ada': { at: 1, connectionKey: KEY_A, roomKey: 'id:r-untagged', kind: 'clarify', member: 'ada', memberKey: 'ada', question: 'same key', requestId: 'q-a' }
    })

    startGroupEngine(transport, KEY_A)

    // The pull observed the already-swept store: no foreign session ids and
    // no foreign prompt card, while the same-key card survived.
    await vi.waitFor(() => expect(stateAtPull.promptKeys).toBeDefined())
    expect(stateAtPull.foreignSessions).toBeUndefined()
    expect(stateAtPull.promptKeys).toEqual(['id:r-untagged::ada'])
    expect($groupChats.get()['id:r-foreign'].sessions).toBeUndefined()
    expect($groupChats.get()['id:r-foreign'].stranded).toBeUndefined()
    expect($groupChats.get()['id:r-untagged'].sessions).toBeUndefined()
    expect($groupChats.get()['id:r-untagged'].stranded).toBeUndefined()

    // An immediately opened room can neither send the swept id nor harvest
    // the swept stranded marker.
    openGroupRoom({ key: 'id:r-foreign', log: [], members: [{ name: 'ada' }], name: 'Foreign', roomId: 'r-foreign' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(memberCalls.filter(call => call.method === 'session.resume')).toEqual([])

    releasePull({ profiles: [] })
    await Promise.resolve()
    // The sweep itself scheduled no mirror write.
    expect(memberCalls.filter(call => call.method === 'profiles.configure')).toEqual([])
  })

  it('retains same-key prompt cards across a restart and drops foreign ones', () => {
    const sameKey: GroupPrompt = { at: 1, connectionKey: KEY_A, roomKey: 'name:Room', kind: 'clarify', member: 'ada', memberKey: 'ada', question: 'same key', requestId: 'q-a' }
    const foreignKey: GroupPrompt = { at: 1, connectionKey: KEY_B, roomKey: 'name:Room', kind: 'approval', member: 'ada', memberKey: 'ada', question: 'other gateway', requestId: 'q-b' }
    $groupPromptsState.set({ 'name:Room::ada': sameKey, 'name:Room::scout': foreignKey })

    startGroupEngine(async () => ({}), KEY_A)
    expect($groupPrompts.get()['name:Room::ada']).toBe(sameKey)
    expect($groupPrompts.get()['name:Room::scout']).toBeUndefined()

    stopGroupEngine()
    startGroupEngine(async () => ({}), KEY_A)
    expect($groupPrompts.get()['name:Room::ada']).toBe(sameKey)
    stopGroupEngine()
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
    }, KEY_A)
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
    }, KEY_A)
    replaceGroupChats({
      'name:Room': room({
        running: true,
        epoch: 2,
        turn: 'ada',
        members: [{ name: 'ada' }, { name: 'scout' }],
        sessionConnectionKey: KEY_A,
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
  it('keeps the last duplicate roster row at the first key position', () => {
    const firstDuplicate: GroupRoom = { key: 'id:duplicate', log: [], members: [], name: 'First' }
    const other: GroupRoom = { key: 'id:other', log: [], members: [], name: 'Other' }
    const lastDuplicate: GroupRoom = { key: 'id:duplicate', log: [], members: [], name: 'Last' }

    expect(groupRoomsView([firstDuplicate, other, lastDuplicate], {})).toEqual([lastDuplicate, other])
  })

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
  function Publisher({ roster, testId = 'published-rooms' }: { roster: GroupRoom[]; testId?: string }) {
    const rooms = useGroupRooms(roster)
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
    const publisher = render(createElement(Publisher, { roster }))
    const readPublished = () => JSON.parse(screen.getByTestId('published-rooms').getAttribute('data-rooms') ?? '[]')
    const rerenderWith = (updated: GroupRoom) => {
      roster[0] = updated
      act(() => publisher.rerender(createElement(Publisher, { roster })))
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

  it('deduplicates equal snapshots from two publishers and keeps changed publishes last-wins', () => {
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
      render(createElement(PublisherPair, { first: [first], second: [equalClone] }))
      expect(listener).toHaveBeenCalledTimes(1)
      expect($knownRooms.get()).toEqual([first])

      const changed = { ...first, name: 'Changed once' }
      const last = { ...first, name: 'Last publish' }
      publishRosterRooms([changed])
      publishRosterRooms([last])
      expect(listener).toHaveBeenCalledTimes(3)
      expect($knownRooms.get()).toEqual([last])
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