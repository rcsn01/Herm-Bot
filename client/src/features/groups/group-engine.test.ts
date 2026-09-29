import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $groupActivity,
  $groupChats,
  $groupNeedsYou,
  $groupPrompts,
  answerGroupPrompt,
  createGroupChat,
  openGroupRoom,
  sendToGroupChat,
  startGroupEngine,
  stopGroupEngine,
  stopGroupThread
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
import type { GroupMessage } from './group-model'

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
  $groupActivityState.set({})
  $groupPromptsState.set({})
  $groupNeedsYouState.set({})
  calls = []
})

afterEach(() => {
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
