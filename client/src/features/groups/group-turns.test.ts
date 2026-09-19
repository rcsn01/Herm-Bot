import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GroupMember, GroupMessage } from './group-model'
import { $groupActivity, $groupChats, $groupNeedsYou, $groupPrompts, replaceGroupChats, setGroupSyncScheduler, updateGroupChat, type GroupChatRoom, type GroupPrompt } from './group-store'
import {
  buildGroupChatTurnPrompt,
  createGroupMemberGateway,
  createGroupTurnModule,
  formatGroupChatLine,
  heldMemberWatermarkAdvance,
  isGroupPassText,
  isSessionGoneError,
  pickGroupTurnReply,
  type GroupMemberGateway,
  type GroupTurnModule,
  type GroupTurnPolicy,
  type GroupTurnSpec
} from './group-turns'

type Call = { member: GroupMember; method: string; params: Record<string, unknown> }
type Handler = (member: GroupMember, method: string, params: Record<string, unknown>) => unknown | Promise<unknown>

const MEMBER: GroupMember = { name: 'research' }
let calls: Call[] = []

function room(overrides: Partial<GroupChatRoom> = {}): GroupChatRoom {
  return {
    name: 'Room',
    log: [],
    members: [MEMBER],
    watermarks: {},
    epoch: 0,
    running: false,
    ...overrides
  }
}

function makeModule(handler: Handler = async () => ({})): { gateway: GroupMemberGateway; turns: GroupTurnModule } {
  const gateway: GroupMemberGateway = {
    async request(member, method, params = {}) {
      calls.push({ member, method, params })
      return handler(member, method, params)
    }
  }
  return { gateway, turns: createGroupTurnModule(gateway) }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runInput(thread = 't1') {
  return { group: 'Room', member: MEMBER, prompt: 'room delta', thread }
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({ Room: room() })
  $groupPrompts.set({})
  $groupActivity.set({})
  $groupNeedsYou.set({})
  calls = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pure helpers', () => {
  it('reads pass, (pass), pass. and empty as silence, but not real text', () => {
    for (const text of ['', '   ', 'pass', '(pass)', 'Pass.', '( PASS )']) expect(isGroupPassText(text)).toBe(true)
    for (const text of ['I will pass the salt', 'passed the tests', 'passing on this']) expect(isGroupPassText(text)).toBe(false)
  })

  it('selects substantive text before a trailing synthetic pass', () => {
    expect(pickGroupTurnReply([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'the full answer' },
      { role: 'assistant', content: '(pass)' }
    ], 0)).toBe('the full answer')
  })

  it('returns the newest pass when a turn contains only pass text', () => {
    expect(pickGroupTurnReply([
      { role: 'assistant', content: '(pass)' },
      { role: 'assistant', content: 'pass' }
    ], 0)).toBe('pass')
    expect(pickGroupTurnReply([{ role: 'user', content: 'hi' }], 0)).toBe(null)
  })

  it('classifies recoverable runtime-session failures without treating 4007 as one', () => {
    expect(isSessionGoneError({ code: 4001 })).toBe(true)
    expect(isSessionGoneError({ code: 4007 })).toBe(false)
    expect(isSessionGoneError({ message: 'session not in memory' })).toBe(true)
    expect(isSessionGoneError({ message: 'Session not found' })).toBe(true)
    expect(isSessionGoneError(null)).toBe(false)
  })

  it('formats source-qualified transcript lines', () => {
    const entry = (from: 'user' | 'member', name: string, text: string, source?: string) => ({
      at: 1,
      from: { kind: from, name, ...(source ? { source } : {}) },
      text
    })
    expect(formatGroupChatLine(entry('user', 'You', 'hi'), 'research')).toBe('You (user): hi')
    expect(formatGroupChatLine(entry('member', 'builder', 'hi', 'mac'), 'research')).toBe('builder [mac]: hi')
    expect(formatGroupChatLine(entry('member', 'default', 'hi'), 'research')).toBe('Hermes: hi')
  })

  it('builds the per-member prompt with the group rules and source labels', () => {
    const members = [{ name: 'research' }, { name: 'builder', connectionId: 'c1', connectionLabel: 'mac', sourceScoped: true }]
    const prompt = buildGroupChatTurnPrompt({ groupName: 'Launch', members, viewer: members[0], deltaLines: ['You (user): ship it'] })
    expect(prompt).toContain('[Group chat: "Launch"]')
    expect(prompt).toContain('@builder [mac]')
    expect(prompt).toContain('reply with exactly "(pass)"')
    expect(prompt).toContain('You (user): ship it')
  })

  it('advances a held member watermark past the log, or null when current', () => {
    expect(heldMemberWatermarkAdvance(2, 5)).toBe(5)
    expect(heldMemberWatermarkAdvance(5, 5)).toBe(null)
  })
})

describe('captured member gateway', () => {
  it('injects the member profile and overwrites an accidental profile parameter', async () => {
    const transportCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const gateway = createGroupMemberGateway(async (method, params) => {
      transportCalls.push({ method, params })
      return 'ok'
    })

    await gateway.request(MEMBER, 'session.resume', { profile: 'wrong', session_id: 's1' })
    expect(transportCalls).toEqual([{
      method: 'session.resume',
      params: { profile: 'research', session_id: 's1' }
    }])
  })
})

describe('session resolution and member results', () => {
  it('uses the room title, creates with the plumbing contracts, and persists the stored id', async () => {
    const created: Record<string, unknown> = {}
    let baseline = true
    const { turns } = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) {
        throw Object.assign(new Error('gone'), { code: 4007 })
      }
      if (method === 'session.create') {
        Object.assign(created, params)
        return { session_id: 'rt-created', stored_session_id: 'stored-created' }
      }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return { messages: [{ role: 'assistant', content: 'done' }] }
      }
      return {}
    })
    replaceGroupChats({ Room: room({ roomId: 'r-1' }) })
    vi.useFakeTimers()

    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    const result = await promise

    expect(result.kind).toBe('reply')
    expect(created).toMatchObject({
      title: 'Group: r-1',
      hidden: true,
      room_plumbing: true,
      follow_profile_config: true
    })
    expect($groupChats.get().Room.sessions?.research).toBe('stored-created')
  })

  it('resumes a stored member session and persists its returned key', async () => {
    replaceGroupChats({ Room: room({ sessions: { research: 'stored-old' } }) })
    let baseline = true
    const { turns } = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) {
        expect(params.session_id).toBe('stored-old')
        return { session_id: 'runtime-live', session_key: 'stored-new' }
      }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return { messages: [{ role: 'assistant', content: '(pass)' }] }
      }
      return {}
    })
    vi.useFakeTimers()
    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    const result = await promise
    expect(result.kind).toBe('pass')
    expect($groupChats.get().Room.sessions?.research).toBe('stored-new')
    expect(calls.filter(call => call.method === 'session.create')).toHaveLength(0)
  })

  it('does not fork a session after a transient resume failure', async () => {
    const { turns } = makeModule(async (_member, method) => {
      if (method === 'session.resume') throw Object.assign(new Error('warming'), { code: 5001 })
      return {}
    })

    const result = await turns.run(runInput())
    expect(result.kind).toBe('failed')
    expect(calls.some(call => call.method === 'session.create')).toBe(false)
  })

  it('falls through 4007 lookups and performs one-shot 4001 submit recovery', async () => {
    let submitAttempts = 0
    let baseline = true
    let recoveryResume = false
    const { turns } = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) {
        if (params.session_id === 'stored-old') throw Object.assign(new Error('gone'), { code: 4007 })
        if (params.session_id === 'Group: r-2') throw Object.assign(new Error('gone'), { code: 4007 })
        if (params.session_id === 'stored-new') {
          recoveryResume = false
          return { session_id: 'rt-fresh' }
        }
      }
      if (method === 'session.create') return { session_id: 'rt-live', stored_session_id: 'stored-new' }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        if (recoveryResume) {
          recoveryResume = false
          return { session_id: 'rt-fresh' }
        }
        return { messages: [{ role: 'assistant', content: 'recovered' }] }
      }
      if (method === 'prompt.submit') {
        submitAttempts += 1
        if (submitAttempts === 1) {
          recoveryResume = true
          throw Object.assign(new Error('not in memory'), { code: 4001 })
        }
      }
      return {}
    })
    replaceGroupChats({ Room: room({ roomId: 'r-2', sessions: { research: 'stored-old' } }) })
    vi.useFakeTimers()

    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    const result = await promise

    expect(result.kind).toBe('reply')
    expect(submitAttempts).toBe(2)
    expect(calls.filter(call => call.method === 'session.resume' && call.params.omit_messages).map(call => call.params.session_id)).toEqual([
      'stored-old',
      'Group: r-2',
      'stored-new'
    ])
  })

  it('normalizes pass text to a typed pass result and keeps the two-second poll cadence', async () => {
    let baseline = true
    const { turns } = makeModule(async (_member, method) => {
      if (method === 'session.resume' && calls.filter(call => call.method === 'session.resume').length === 1) {
        return { session_id: 'rt', session_key: 'stored' }
      }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return { messages: [{ role: 'assistant', content: '(pass)' }] }
      }
      return {}
    })
    vi.useFakeTimers()

    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls.filter(call => call.method === 'session.resume')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    const result = await promise
    expect(result.kind).toBe('pass')
  })

  it('returns a failed result with the gateway reason while answer failures still reject', async () => {
    const { turns } = makeModule(async (_member, method) => {
      if (method === 'session.resume' && calls.filter(call => call.method === 'session.resume').length === 1) {
        return { session_id: 'rt', session_key: 'stored' }
      }
      if (method === 'prompt.submit') throw { data: { reason: 'provider unavailable' } }
      return { messages: [] }
    })

    const result = await turns.run(runInput())
    expect(result).toMatchObject({ kind: 'failed', reason: 'provider unavailable' })

    const entry: GroupPrompt = {
      at: Date.now(),
      group: 'Room',
      member: 'research',
      memberKey: 'research',
      kind: 'clarify',
      question: 'Proceed?',
      requestId: 'q1',
      sessionId: 'rt'
    }
    const failing = makeModule(async () => { throw new Error('answer failed') }).turns
    await expect(failing.answer(entry, MEMBER, 'yes')).rejects.toThrow('answer failed')
  })
})

describe('prompt ownership and answers', () => {
  it('mirrors a pending question, keeps the same request id idempotent, and answers it', async () => {
    let baseline = true
    let poll = 0
    const { turns } = makeModule(async (_member, method) => {
      if (method === 'session.resume' && calls.filter(call => call.method === 'session.resume').length === 1) {
        return { session_id: 'rt', session_key: 'stored' }
      }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        poll += 1
        return poll === 1
          ? { pending_clarify: { request_id: 'q1', question: 'Which account?', choices: ['ops'] }, session_id: 'rt' }
          : { messages: [{ role: 'assistant', content: 'answered' }] }
      }
      return {}
    })
    vi.useFakeTimers()

    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    const key = 'Room::research'
    const first = $groupPrompts.get()[key]
    expect(first?.requestId).toBe('q1')
    expect($groupNeedsYou.get().Room).toBe(true)
    const sameModuleAnswer = turns.answer(first!, MEMBER, 'ops')
    await sameModuleAnswer
    expect(calls.some(call => call.method === 'clarify.respond')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect((await promise).kind).toBe('reply')
  })

  it('routes clarify batches and approvals through the captured gateway', async () => {
    const { turns } = makeModule(async () => ({}))
    const clarify: GroupPrompt = {
      at: Date.now(), group: 'Room', member: 'research', memberKey: 'research', kind: 'clarify',
      question: '', requestId: 'batch', sessionId: 'rt', questions: [{ qid: 'a' }, { id: 'b' }]
    }
    $groupPrompts.set({ 'Room::research': clarify })
    await turns.answer(clarify, MEMBER, { a: 'one', b: 'two' })
    expect(calls.filter(call => call.method === 'clarify.respond').map(call => call.params)).toEqual([
      { request_id: 'batch', question_id: 'a', answer: 'one' },
      { request_id: 'batch', question_id: 'b', answer: 'two' }
    ])
    expect($groupPrompts.get()['Room::research']).toBeUndefined()

    const approval: GroupPrompt = {
      at: Date.now(), group: 'Room', member: 'research', memberKey: 'research', kind: 'approval',
      question: '', requestId: 'approval', sessionId: 'rt', choices: ['once', 'deny']
    }
    $groupPrompts.set({ 'Room::research': approval })
    await turns.answer(approval, MEMBER, 'once')
    expect(calls.find(call => call.method === 'approval.respond')?.params).toEqual({
      session_id: 'rt', request_id: 'approval', choice: 'once'
    })
  })

  it('does not clear a newer prompt when an answer settles after stop', async () => {
    const response = deferred<unknown>()
    const entry: GroupPrompt = {
      at: Date.now(), group: 'Room', member: 'research', memberKey: 'research', kind: 'clarify',
      question: 'Old?', requestId: 'old', sessionId: 'rt'
    }
    const newer = { ...entry, requestId: 'new', question: 'New?' }
    $groupPrompts.set({ 'Room::research': newer })
    const { turns } = makeModule(async () => response.promise)
    const answer = turns.answer(entry, MEMBER, 'yes')
    await Promise.resolve()
    turns.stop()
    response.resolve({})
    await answer
    expect($groupPrompts.get()['Room::research']?.requestId).toBe('new')
  })

  it('does not clear a prompt replaced while an answer is in flight', async () => {
    const response = deferred<unknown>()
    const entry: GroupPrompt = {
      at: Date.now(), group: 'Room', member: 'research', memberKey: 'research', kind: 'clarify',
      question: 'Old?', requestId: 'old', sessionId: 'rt'
    }
    const { turns } = makeModule(async () => response.promise)
    $groupPrompts.set({ 'Room::research': entry })
    const answer = turns.answer(entry, MEMBER, 'yes')
    await Promise.resolve()
    $groupPrompts.set({ 'Room::research': { ...entry, requestId: 'new', question: 'New?' } })
    response.resolve({})
    await answer
    expect($groupPrompts.get()['Room::research']?.requestId).toBe('new')
  })
})

describe('stale results and lifecycle ownership', () => {
  function deferredPollModule() {
    const poll = deferred<unknown>()
    let baseline = true
    const module = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt', session_key: 'stored' }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return poll.promise
      }
      return {}
    })
    return { ...module, poll }
  }

  it('returns room-stopped for an in-flight poll after a member hold', async () => {
    vi.useFakeTimers()
    const { turns, poll } = deferredPollModule()
    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    const callsAtHold = calls.length
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      holds: { research: { at: Date.now(), thread: 't1' } }
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'late' }] })
    const result = await promise
    expect(result).toMatchObject({ kind: 'cancelled', reason: 'room-stopped' })
    expect(result.commit()).toEqual({ accepted: false, reason: 'room-stopped' })
    expect(calls.length).toBe(callsAtHold)
  })

  it('classifies a newer same-thread user before a hold and rejects its commit lease', async () => {
    vi.useFakeTimers()
    const { turns, poll } = deferredPollModule()
    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      log: [...r.log, { id: 'new-user', at: Date.now(), from: { kind: 'user', name: 'You' }, text: 'new', thread: 't1' }]
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'old reply' }] })
    const result = await promise
    expect(result).toMatchObject({ kind: 'cancelled', reason: 'newer-user' })
    expect(result.commit()).toEqual({ accepted: false, reason: 'newer-user' })
    expect($groupChats.get().Room.watermarks).toEqual({})
  })

  it('accepts a normal-loop cross-thread late result', async () => {
    vi.useFakeTimers()
    const { turns, poll } = deferredPollModule()
    const promise = turns.run(runInput('t1'))
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      log: [...r.log, { id: 'other-thread', at: Date.now(), from: { kind: 'user', name: 'You' }, text: 'other', thread: 't2' }]
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'late answer' }] })
    const result = await promise
    expect(result.kind).toBe('reply')
    expect(result.commit()).toEqual({ accepted: true })
  })

  it('rechecks the commit lease after run returns', async () => {
    vi.useFakeTimers()
    const { turns, poll } = deferredPollModule()
    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    poll.resolve({ messages: [{ role: 'assistant', content: 'answer' }] })
    const result = await promise
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      log: [...r.log, { id: 'later', at: Date.now(), from: { kind: 'user', name: 'You' }, text: 'later', thread: 't1' }]
    }))
    expect(result.commit()).toEqual({ accepted: false, reason: 'newer-user' })
  })

  it('rejects failure and timeout leases after the module stops', async () => {
    const failedTurns = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt' }
      if (method === 'prompt.submit') throw new Error('provider unavailable')
      return {}
    }).turns
    const failed = await failedTurns.run(runInput())
    expect(failed.kind).toBe('failed')
    failedTurns.stop()
    expect(failed.commit()).toEqual({ accepted: false, reason: 'engine-stopped' })

    vi.useFakeTimers()
    let baseline = true
    const timedOutTurns = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt' }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return { messages: [], running: true }
      }
      return {}
    }).turns
    const timeoutPromise = timedOutTurns.run(runInput('late'))
    await vi.advanceTimersByTimeAsync(20 * 60000 + 2000)
    const timedOut = await timeoutPromise
    expect(timedOut.kind).toBe('timed-out')
    expect($groupChats.get().Room.stranded?.research).toEqual({ before: 0, thread: 'late' })
    timedOutTurns.stop()
    expect(timedOut.commit()).toEqual({ accepted: false, reason: 'engine-stopped' })
  })

  it('stops without aborting an in-flight request and prevents every later request or write', async () => {
    const first = deferred<unknown>()
    const { turns } = makeModule(async (_member, method) => method === 'session.resume' ? first.promise : {})
    const promise = turns.run(runInput())
    await Promise.resolve()
    turns.stop()
    first.resolve({ session_id: 'rt', session_key: 'stored' })
    const result = await promise
    expect(result).toMatchObject({ kind: 'cancelled', reason: 'engine-stopped' })
    expect(calls).toHaveLength(1)
    expect($groupChats.get().Room.sessions).toBeUndefined()
    expect($groupPrompts.get()).toEqual({})
  })

  it('drops a deferred poll after stop without publishing a marker or reply', async () => {
    vi.useFakeTimers()
    const poll = deferred<unknown>()
    let baseline = true
    const { turns } = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt' }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return poll.promise
      }
      return {}
    })
    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    const callsAtStop = calls.length
    turns.stop()
    poll.resolve({ messages: [{ role: 'assistant', content: 'late reply' }] })
    const result = await promise
    expect(result).toMatchObject({ kind: 'cancelled', reason: 'engine-stopped' })
    expect(calls.length).toBe(callsAtStop)
    expect(calls.some(call => call.method === 'session.interrupt')).toBe(false)
    expect($groupChats.get().Room.sessions).toBeUndefined()
    expect($groupChats.get().Room.stranded).toBeUndefined()
    expect($groupChats.get().Room.log.filter(entry => entry.from.kind === 'member')).toHaveLength(0)
    expect($groupActivity.get().Room?.filter(entry => entry.kind !== 'working')).toEqual([])
  })

  it('does not submit after a room stop during the baseline resume', async () => {
    const baseline = deferred<unknown>()
    let submitted = false
    const { turns } = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt', session_key: 'stored' }
      if (method === 'session.resume') return baseline.promise
      submitted = method === 'prompt.submit'
      return {}
    })
    const promise = turns.run(runInput())
    await Promise.resolve()
    await Promise.resolve()
    updateGroupChat('Room', r => ({
      ...r,
      epoch: r.epoch + 1,
      holds: { research: { at: Date.now(), thread: 't1' } }
    }))
    baseline.resolve({ messages: [] })
    const result = await promise
    expect(result).toMatchObject({ kind: 'cancelled', reason: 'room-stopped' })
    expect(submitted).toBe(false)
  })

  it('does not let an empty harvest claim the active turn token', async () => {
    vi.useFakeTimers()
    const { turns, poll } = deferredPollModule()
    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    await turns.harvest('Room', MEMBER)
    poll.resolve({ messages: [{ role: 'assistant', content: 'reply' }] })
    expect((await promise).kind).toBe('reply')
  })

  it('keeps a replacement stranded marker when an older harvest resolves', async () => {
    const oldMarker = { before: 0, thread: 'old' }
    const read = deferred<unknown>()
    replaceGroupChats({ Room: room({ stranded: { research: oldMarker }, sessions: { research: 'stored' } }) })
    const { turns } = makeModule(async () => read.promise)
    const harvest = turns.harvest('Room', MEMBER)
    await Promise.resolve()
    const replacement = { before: 2, thread: 'new' }
    updateGroupChat('Room', r => ({ ...r, stranded: { research: replacement } }))
    read.resolve({ messages: [{ role: 'assistant', content: 'old reply' }] })
    await harvest
    expect($groupChats.get().Room.stranded?.research).toEqual(replacement)
    expect($groupChats.get().Room.log).toHaveLength(0)
  })

  it('does not let an older poll clear a newer prompt after token ownership changes', async () => {
    vi.useFakeTimers()
    const oldPoll = deferred<unknown>()
    const harvestRead = deferred<unknown>()
    let resumeCount = 0
    const { turns } = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt' }
      if (method === 'session.resume') {
        resumeCount += 1
        if (resumeCount === 1) return { messages: [] }
        if (resumeCount === 2) return oldPoll.promise
        return harvestRead.promise
      }
      return {}
    })
    const promise = turns.run(runInput())
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      sessions: { research: 'stored' },
      stranded: { research: { before: 0, thread: 't1' } }
    }))
    const harvest = turns.harvest('Room', MEMBER)
    await Promise.resolve()
    const newer: GroupPrompt = {
      at: Date.now(), group: 'Room', member: 'research', memberKey: 'research', kind: 'clarify',
      question: 'New?', requestId: 'new', sessionId: 'rt'
    }
    $groupPrompts.set({ 'Room::research': newer })
    oldPoll.resolve({ pending_clarify: null, messages: [{ role: 'assistant', content: 'old' }] })
    const result = await promise
    expect(result.kind).toBe('cancelled')
    expect(result.commit()).toEqual({ accepted: false, reason: 'engine-stopped' })
    expect($groupPrompts.get()['Room::research']).toBe(newer)
    harvestRead.resolve({ messages: [], running: true })
    await harvest
    expect(resumeCount).toBe(3)
  })
})

describe('timeouts and stranded harvest', () => {
  it('records a stranded marker at the hard cap', async () => {
    vi.useFakeTimers()
    let baseline = true
    const { turns } = makeModule(async (_member, method) => {
      if (method === 'session.resume' && calls.filter(call => call.method === 'session.resume').length === 1) {
        return { session_id: 'rt', session_key: 'stored' }
      }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return { messages: [], running: true }
      }
      return {}
    })
    const promise = turns.run(runInput('late'))
    await vi.advanceTimersByTimeAsync(20 * 60000 + 2000)
    const result = await promise
    expect(result.kind).toBe('timed-out')
    expect($groupChats.get().Room.stranded?.research).toEqual({ before: 0, thread: 'late' })
  })

  it('harvests a legacy zero baseline marker', async () => {
    replaceGroupChats({ Room: room({ stranded: { research: 0 }, sessions: { research: 'stored' } }) })
    const { turns } = makeModule(async () => ({ messages: [{ role: 'assistant', content: 'zero baseline reply' }] }))
    await turns.harvest('Room', MEMBER)
    expect($groupChats.get().Room.stranded?.research).toBeUndefined()
    expect($groupChats.get().Room.log.find(entry => entry.text === 'zero baseline reply')).toBeTruthy()
  })

  it('harvests a late substantive reply into its original thread and watermark', async () => {
    replaceGroupChats({ Room: room({
      sessions: { research: 'stored' },
      stranded: { research: { before: 1, thread: 'late-thread' } },
      log: [{ id: 'user', at: 1, from: { kind: 'user', name: 'You' }, text: 'ask', thread: 'late-thread' }]
    }) })
    const { turns } = makeModule(async () => ({
      messages: [
        { role: 'user', content: 'ask' },
        { role: 'assistant', content: 'finished late' }
      ],
      running: false
    }))
    await turns.harvest('Room', MEMBER)
    const result = $groupChats.get().Room
    expect(result.stranded?.research).toBeUndefined()
    expect(result.log.find(entry => entry.from.kind === 'member')).toMatchObject({ text: 'finished late', thread: 'late-thread' })
    expect(result.watermarks['late-thread::research']).toBe(result.log.length)
  })

  it('clears the prompt observed by a harvest but retains a newer prompt', async () => {
    const marker = { before: 0, thread: 't1' }
    const oldPrompt: GroupPrompt = {
      at: Date.now(), group: 'Room', member: 'research', memberKey: 'research', kind: 'clarify',
      question: 'Old?', requestId: 'old', sessionId: 'rt'
    }
    replaceGroupChats({ Room: room({ stranded: { research: marker }, sessions: { research: 'stored' } }) })
    $groupPrompts.set({ 'Room::research': oldPrompt })
    const first = makeModule(async () => ({ messages: [], running: false })).turns
    await first.harvest('Room', MEMBER)
    expect($groupPrompts.get()['Room::research']).toBeUndefined()
    expect($groupChats.get().Room.stranded?.research).toBeUndefined()

    const read = deferred<unknown>()
    const newerMarker = { before: 0, thread: 't2' }
    replaceGroupChats({ Room: room({ stranded: { research: newerMarker }, sessions: { research: 'stored' } }) })
    $groupPrompts.set({ 'Room::research': oldPrompt })
    const second = makeModule(async () => read.promise).turns
    const harvest = second.harvest('Room', MEMBER)
    await Promise.resolve()
    const newerPrompt = { ...oldPrompt, requestId: 'new', question: 'New?' }
    $groupPrompts.set({ 'Room::research': newerPrompt })
    read.resolve({ messages: [], running: false })
    await harvest
    expect($groupPrompts.get()['Room::research']?.requestId).toBe('new')
    expect($groupChats.get().Room.stranded?.research).toEqual(newerMarker)
  })

  it('keeps a stranded marker for unreachable or still-working sessions', async () => {
    replaceGroupChats({ Room: room({ stranded: { research: { before: 0, thread: 't1' } } }) })
    const unreachable = makeModule(async () => { throw new Error('unreachable') }).turns
    await unreachable.harvest('Room', MEMBER)
    expect($groupChats.get().Room.stranded?.research).toBeTruthy()

    const working = makeModule(async () => ({ running: true, messages: [] })).turns
    await working.harvest('Room', MEMBER)
    expect($groupChats.get().Room.stranded?.research).toBeTruthy()
  })
})

describe('drive step and publication', () => {
  function userEntry(text: string, thread = 't1', id = 'u1'): GroupMessage {
    return { id, at: Date.now(), from: { kind: 'user', name: 'You' }, text, thread }
  }

  function turnSpec(policy: GroupTurnPolicy = 'round', overrides: Partial<GroupTurnSpec> = {}): GroupTurnSpec {
    return {
      group: 'Room',
      thread: 't1',
      member: MEMBER,
      members: [MEMBER],
      driveEpoch: $groupChats.get().Room?.epoch || 0,
      policy,
      ...overrides
    }
  }

  function replyHandler(replyText: string): Handler {
    let baseline = true
    return async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt', session_key: 'stored' }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return { messages: [{ role: 'assistant', content: replyText }] }
      }
      return {}
    }
  }

  function deferredPollHandler() {
    const poll = deferred<unknown>()
    let baseline = true
    const handler: Handler = async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt', session_key: 'stored' }
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return poll.promise
      }
      return {}
    }
    return { handler, poll }
  }

  const failingHandler: Handler = async (_member, method, params) => {
    if (method === 'session.resume' && params.omit_messages) return { session_id: 'rt', session_key: 'stored' }
    if (method === 'prompt.submit') throw { data: { reason: 'gateway hiccup' } }
    return { messages: [] }
  }

  it('publishes only after an accepted reply lease and advances the member watermark', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('investigate', 't9', 'u9')] }) })
    vi.useFakeTimers()
    const { turns } = makeModule(replyHandler('found the bug'))
    const promise = turns.takeTurn(turnSpec('round', { thread: 't9' }))
    await vi.advanceTimersByTimeAsync(2000)
    const report = await promise
    expect(report).toEqual({ abandoned: false, spoke: true, stop: false })
    const result = $groupChats.get().Room
    expect(result.log.find(item => item.from.kind === 'member')).toMatchObject({ text: 'found the bug', thread: 't9' })
    expect(result.watermarks['t9::research']).toBe(result.log.length)
    expect($groupActivity.get().Room.map(item => item.kind)).toContain('replied')
  })

  it('treats a failed result as silence but records its reason in the normal loop', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('fyi')] }) })
    const { turns } = makeModule(failingHandler)
    const report = await turns.takeTurn(turnSpec('round'))
    expect(report).toEqual({ abandoned: false, spoke: false, stop: false })
    const result = $groupChats.get().Room
    expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect(result.watermarks['t1::research']).toBe(result.log.length)
    const failed = $groupActivity.get().Room.find(item => item.kind === 'failed')
    expect(failed?.reason).toBe('gateway hiccup')
  })

  it('records a failed reason in the normal loop but hides it for continuation failures', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    const normal = makeModule(failingHandler).turns
    await normal.takeTurn(turnSpec('round'))
    expect($groupActivity.get().Room.find(item => item.kind === 'failed')?.reason).toBe('gateway hiccup')

    $groupActivity.set({})
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    const continuation = makeModule(failingHandler).turns
    await continuation.takeTurn(turnSpec('continuation'))
    expect($groupActivity.get().Room.find(item => item.kind === 'failed')?.reason).toBeUndefined()
  })

  it('does not append or advance on a rejected newer-user lease, but records supersession', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    vi.useFakeTimers()
    const { handler, poll } = deferredPollHandler()
    const { turns } = makeModule(handler)
    const promise = turns.takeTurn(turnSpec('round'))
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      log: [...r.log, userEntry('newer', 't1', 'u2')]
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'old reply' }] })
    const report = await promise
    expect(report).toEqual({ abandoned: false, spoke: false, stop: true })
    const result = $groupChats.get().Room
    expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect(result.watermarks).toEqual({})
    expect($groupActivity.get().Room.map(item => item.kind)).toContain('cancelled')
  })

  it('consumes a room-stopped watermark without appending a reply', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    vi.useFakeTimers()
    const { handler, poll } = deferredPollHandler()
    const { turns } = makeModule(handler)
    const promise = turns.takeTurn(turnSpec('round'))
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      holds: { research: { at: Date.now(), thread: 't1' } }
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'late reply' }] })
    const report = await promise
    expect(report).toEqual({ abandoned: false, spoke: false, stop: true })
    const result = $groupChats.get().Room
    expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect(result.watermarks['t1::research']).toBe(result.log.length)
  })

  it('suppresses result activity when a room-stopped lease rejects', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    vi.useFakeTimers()
    const { handler, poll } = deferredPollHandler()
    const { turns } = makeModule(handler)
    const promise = turns.takeTurn(turnSpec('round'))
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      holds: { research: { at: Date.now(), thread: 't1' } }
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'stale' }] })
    await promise
    const result = $groupChats.get().Room
    expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect(result.watermarks['t1::research']).toBe(result.log.length)
    expect($groupActivity.get().Room.some(item => item.kind === 'replied')).toBe(false)
  })

  it('keeps a normal-loop cross-thread late reply in its original thread', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    vi.useFakeTimers()
    const { handler, poll } = deferredPollHandler()
    const { turns } = makeModule(handler)
    const promise = turns.takeTurn(turnSpec('round'))
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      log: [...r.log, userEntry('other', 't2', 'u2')]
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'late original' }] })
    const report = await promise
    expect(report).toEqual({ abandoned: false, spoke: true, stop: false })
    expect($groupChats.get().Room.log.find(item => item.text === 'late original')).toMatchObject({ thread: 't1' })
  })

  it('drops a continuation after any epoch change before commit or publication', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    vi.useFakeTimers()
    const { handler, poll } = deferredPollHandler()
    const { turns } = makeModule(handler)
    const promise = turns.takeTurn(turnSpec('continuation'))
    await vi.advanceTimersByTimeAsync(2000)
    updateGroupChat('Room', r => ({
      ...r,
      epoch: 1,
      log: [...r.log, userEntry('other', 't2', 'u2')]
    }))
    poll.resolve({ messages: [{ role: 'assistant', content: 'continuation late' }] })
    const report = await promise
    expect(report).toEqual({ abandoned: false, spoke: false, stop: true })
    expect($groupChats.get().Room.log.some(item => item.text === 'continuation late')).toBe(false)
    expect($groupChats.get().Room.watermarks['t1::research']).toBeUndefined()
    expect($groupActivity.get().Room.filter(item => item.member === 'research' && item.kind !== 'working')).toEqual([])
  })

  it('does not publish an operation invalidated by a newer operation', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    vi.useFakeTimers()
    const { handler, poll } = deferredPollHandler()
    const { turns } = makeModule(handler)
    const promise = turns.takeTurn(turnSpec('round'))
    await vi.advanceTimersByTimeAsync(2000)
    // A newer operation for the same member claims the capture token mid-turn.
    void turns.run(runInput())
    poll.resolve({ messages: [{ role: 'assistant', content: 'superseded reply' }] })
    const report = await promise
    expect(report).toEqual({ abandoned: true, spoke: false, stop: true })
    expect($groupChats.get().Room.log.some(item => item.text === 'superseded reply')).toBe(false)
    expect($groupChats.get().Room.watermarks['t1::research']).toBeUndefined()
    expect($groupActivity.get().Room.filter(item => item.kind !== 'working')).toEqual([])
  })

  it('does not publish an invalidated failure or timeout', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    vi.useFakeTimers()
    const { handler, poll } = deferredPollHandler()
    const { turns } = makeModule(handler)
    const promise = turns.takeTurn(turnSpec('round'))
    await vi.advanceTimersByTimeAsync(2000)
    turns.stop()
    poll.resolve({ messages: [{ role: 'assistant', content: 'late reply' }] })
    const report = await promise
    expect(report).toEqual({ abandoned: true, spoke: false, stop: true })
    expect($groupChats.get().Room.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect($groupChats.get().Room.watermarks).toEqual({})
    expect($groupChats.get().Room.stranded).toBeUndefined()
    expect($groupActivity.get().Room.filter(item => item.kind !== 'working')).toEqual([])
  })

  it('consumes a held member delta exactly once and notes the hold', async () => {
    replaceGroupChats({ Room: room({
      log: [userEntry('stop @research')],
      holds: { research: { at: 1, byMessageId: null, thread: 't1' } }
    }) })
    const { turns } = makeModule(async () => { throw new Error('must not be called') })
    const first = await turns.takeTurn(turnSpec('round'))
    expect(first).toEqual({ abandoned: false, spoke: false, stop: false })
    const result = $groupChats.get().Room
    expect(result.watermarks['t1::research']).toBe(result.log.length)
    expect(result.holds?.research?.noted).toBe(true)
    expect($groupActivity.get().Room.filter(item => item.kind === 'held')).toHaveLength(1)
    expect(calls).toHaveLength(0)

    // The consumed delta never re-triggers the skip (empty delta skips first).
    const second = await turns.takeTurn(turnSpec('round'))
    expect(second).toEqual({ abandoned: false, spoke: false, stop: false })
    expect($groupActivity.get().Room.filter(item => item.kind === 'held')).toHaveLength(1)
  })

  it('refuses a stranded member without claiming a token', async () => {
    replaceGroupChats({ Room: room({
      log: [userEntry('start')],
      stranded: { research: { before: 0, thread: 't1' } },
      sessions: { research: 'stored' }
    }) })
    const { turns } = makeModule(async () => ({ messages: [{ role: 'assistant', content: 'late reply' }] }))
    const report = await turns.takeTurn(turnSpec('round'))
    expect(report).toEqual({ abandoned: false, spoke: false, stop: false })
    expect(calls).toHaveLength(0)
    expect($groupChats.get().Room.stranded?.research).toEqual({ before: 0, thread: 't1' })

    // No token was claimed: the subsequent harvest still owns the marker.
    await turns.harvest('Room', MEMBER)
    expect($groupChats.get().Room.stranded?.research).toBeUndefined()
    expect($groupChats.get().Room.log.find(item => item.text === 'late reply')).toBeTruthy()
  })

  it('skips without a token when the thread delta is empty', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('other thread', 't2', 'u2')] }) })
    const { turns } = makeModule(async () => { throw new Error('must not be called') })
    const report = await turns.takeTurn(turnSpec('round'))
    expect(report).toEqual({ abandoned: false, spoke: false, stop: false })
    expect(calls).toHaveLength(0)
  })

  it('sets the turn indicator unsynced before the run starts', async () => {
    replaceGroupChats({ Room: room({ log: [userEntry('start')] }) })
    const syncs: string[] = []
    setGroupSyncScheduler(group => syncs.push(group))
    vi.useFakeTimers()
    const first = deferred<unknown>()
    let baseline = true
    const { turns } = makeModule(async (_member, method, params) => {
      if (method === 'session.resume' && params.omit_messages) return first.promise
      if (method === 'session.resume') {
        if (baseline) {
          baseline = false
          return { messages: [] }
        }
        return { messages: [{ role: 'assistant', content: 'done' }] }
      }
      return {}
    })
    const promise = turns.takeTurn(turnSpec('round'))
    await Promise.resolve()
    await Promise.resolve()
    expect($groupChats.get().Room.turn).toBe('research')
    expect(syncs).toEqual([])
    first.resolve({ session_id: 'rt', session_key: 'stored' })
    await vi.advanceTimersByTimeAsync(2000)
    await promise
    setGroupSyncScheduler(null)
  })

  it('skips a held continuation silently without consuming its delta', async () => {
    replaceGroupChats({ Room: room({
      log: [userEntry('start')],
      holds: { research: { at: 1, byMessageId: null, thread: 't1' } }
    }) })
    const { turns } = makeModule(async () => { throw new Error('must not be called') })
    const report = await turns.takeTurn(turnSpec('continuation'))
    expect(report).toEqual({ abandoned: false, spoke: false, stop: false })
    expect(calls).toHaveLength(0)
    expect($groupChats.get().Room.watermarks['t1::research']).toBeUndefined()
    expect($groupChats.get().Room.holds?.research?.noted).toBeFalsy()
    expect($groupActivity.get().Room?.some(item => item.kind === 'held') ?? false).toBe(false)
  })

  it('harvestRoom harvests only members holding a stranded marker', async () => {
    const builder: GroupMember = { name: 'builder' }
    replaceGroupChats({ Room: room({
      members: [MEMBER, builder],
      log: [userEntry('start')],
      stranded: { research: { before: 0, thread: 't1' } },
      sessions: { research: 'stored' }
    }) })
    const { turns } = makeModule(async () => ({ messages: [{ role: 'assistant', content: 'late reply' }] }))
    await turns.harvestRoom('Room', [MEMBER, builder])
    expect(calls.every(item => item.member === MEMBER)).toBe(true)
    expect($groupChats.get().Room.stranded?.research).toBeUndefined()
    expect($groupChats.get().Room.log.find(item => item.text === 'late reply')).toBeTruthy()
  })
})
