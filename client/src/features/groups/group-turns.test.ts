import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $groupPrompts, $groupNeedsYou, setGroupEngineRequest } from './group-engine'
import { $groupChats, replaceGroupChats } from './group-store'
import {
  answerGroupClarify,
  ensureGroupChatSession,
  harvestStrandedGroupReply,
  isGroupPassText,
  isSessionGoneError,
  pickGroupTurnReply,
  runGroupChatMemberTurn,
  syncGroupClarify
} from './group-turns'

type Transport = (method: string, params?: Record<string, unknown>) => Promise<unknown>

let calls: Array<{ method: string; params: Record<string, unknown> }> = []
let transport: Transport = async () => ({})

function install(next: Partial<Record<string, (params: Record<string, unknown>) => unknown>> = {}) {
  setGroupEngineRequest(async (method, params) => {
    calls.push({ method, params: params ?? {} })
    const handler = next[method]
    if (handler) return handler(params ?? {})
    return {}
  })
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({})
  $groupPrompts.set({})
  $groupNeedsYou.set({})
  calls = []
  install()
})

afterEach(() => {
  vi.useRealTimers()
  setGroupEngineRequest(null)
})

describe('pass text', () => {
  it('reads pass, (pass), pass. and empty as silence, but not real text', () => {
    const silentTexts = ['', '   ', 'pass', '(pass)', 'Pass.', '( PASS )']
    for (const silent of silentTexts) {
      expect(isGroupPassText(silent)).toBe(true)
    }
    const spokenTexts = ['I will pass the salt', 'passed the tests', 'passing on this']
    for (const spoken of spokenTexts) {
      expect(isGroupPassText(spoken)).toBe(false)
    }
  })
})

describe('reply selection (#94376)', () => {
  it('surfaces a substantive answer followed by a synthetic continuation pass', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'the full answer, with detail' },
      { role: 'assistant', content: '(pass)' }
    ]
    expect(pickGroupTurnReply(messages, 0)).toBe('the full answer, with detail')
  })

  it('reads a pass-only turn as silent, returning the newest pass text', () => {
    const messages = [
      { role: 'assistant', content: '(pass)' },
      { role: 'assistant', content: 'pass' }
    ]
    expect(pickGroupTurnReply(messages, 0)).toBe('pass')
  })

  it('returns null when no assistant message appears in range', () => {
    expect(pickGroupTurnReply([{ role: 'user', content: 'hi' }], 0)).toBe(null)
    expect(pickGroupTurnReply([{ role: 'assistant', content: 'old' }], 1)).toBe(null)
  })
})

describe('session resolution', () => {
  it('pins session titles to the roomId, with a legacy fallback to the display name', async () => {
    replaceGroupChats({
      Launch: { name: 'Launch', roomId: 'r-42', log: [], members: [], watermarks: {}, epoch: 0, running: false }
    })
    const resumes: Array<Record<string, unknown>> = []
    install({
      'session.resume': params => {
        resumes.push(params)
        return { session_id: 'rt-1', session_key: 'stored-1' }
      }
    })
    await ensureGroupChatSession('Launch', { name: 'research' })
    expect(resumes[0].session_id).toBe('Group: r-42')

    replaceGroupChats({
      Legacy: { name: 'Legacy', roomId: null, log: [], members: [], watermarks: {}, epoch: 0, running: false }
    })
    await ensureGroupChatSession('Legacy', { name: 'research' })
    expect(resumes[1].session_id).toBe('Group: Legacy')
  })

  it('creates member sessions with the room_plumbing + follow_profile_config contracts', async () => {
    let created: Record<string, unknown> = {}
    install({
      'session.resume': () => {
        throw Object.assign(new Error('no session'), { code: 4007 })
      },
      'session.create': params => {
        created = params
        return { session_id: 'rt-9', stored_session_id: 'stored-9' }
      }
    })
    replaceGroupChats({
      Room: { name: 'Room', roomId: 'r-1', log: [], members: [], watermarks: {}, epoch: 0, running: false }
    })
    const handle = await ensureGroupChatSession('Room', { name: 'research' })
    expect(created.title).toBe('Group: r-1')
    expect(created.hidden).toBe(true)
    expect(created.room_plumbing).toBe(true)
    expect(created.follow_profile_config).toBe(true)
    expect(created.profile).toBe('research')
    expect(handle).toEqual({ runtime: 'rt-9', stored: 'stored-9' })
    expect($groupChats.get().Room.sessions?.research).toBe('stored-9')
  })

  it('fails closed on a transient resume failure instead of forking the member session', async () => {
    install({
      'session.resume': () => {
        throw Object.assign(new Error('backend warming'), { code: 5001 })
      }
    })
    await expect(ensureGroupChatSession('Room', { name: 'research' })).rejects.toThrow(/not starting a new one/)
    // session.create must never be reached on a non-4007 failure.
    expect(calls.filter(call => call.method === 'session.create')).toHaveLength(0)
  })

  it('falls through a genuine 4007 to the title lookup, then creates', async () => {
    const resumeIds: Array<unknown> = []
    const resumeTargets: Array<unknown> = []
    install({
      'session.resume': params => {
        resumeTargets.push(params.session_id)
        throw Object.assign(new Error('gone'), { code: 4007 })
      },
      'session.create': () => ({ session_id: 'rt-2', stored_session_id: 'stored-2' })
    })
    replaceGroupChats({
      Room: {
        name: 'Room',
        roomId: 'r-2',
        log: [],
        members: [],
        watermarks: {},
        sessions: { research: 'stored-old' },
        epoch: 0,
        running: false
      }
    })
    await ensureGroupChatSession('Room', { name: 'research' })
    expect(resumeTargets).toEqual(['stored-old', 'Group: r-2'])
  })

  it('resumes the stored session when known and persists the returned session_key', async () => {
    install({
      'session.resume': params =>
        params.session_id === 'stored-old'
          ? { session_id: 'rt-live', session_key: 'stored-old' }
          : { session_id: 'rt-title' }
    })
    replaceGroupChats({
      Room: {
        name: 'Room',
        roomId: null,
        log: [],
        members: [],
        watermarks: {},
        sessions: { research: 'stored-old' },
        epoch: 0,
        running: false
      }
    })
    const handle = await ensureGroupChatSession('Room', { name: 'research' })
    expect(handle.runtime).toBe('rt-live')
    expect($groupChats.get().Room.sessions?.research).toBe('stored-old')
    expect(calls.filter(call => call.method === 'session.create')).toHaveLength(0)
  })
})

describe('session-gone classification', () => {
  it('treats 4001 and not-in-memory as recoverable, 4007 as not', () => {
    expect(isSessionGoneError({ code: 4001 })).toBe(true)
    expect(isSessionGoneError({ code: 4007 })).toBe(false)
    expect(isSessionGoneError({ message: 'session not in memory' })).toBe(true)
    expect(isSessionGoneError({ message: 'Session not found' })).toBe(true)
    expect(isSessionGoneError(null)).toBe(false)
    expect(isSessionGoneError({ code: 4012 })).toBe(false)
  })
})

describe('member turn', () => {
  it('resumes by title when the room has no stored session, and delivers the reply', async () => {
    vi.useFakeTimers()
    install({
      'session.resume': params =>
        params.session_id === 'Group: r-3'
          ? { session_id: 'rt-live', session_key: 'stored-3' }
          : { messages: [], message_count: 0 },
      'prompt.submit': () => ({}),
      'session.create': () => ({ session_id: 'rt-created' })
    })
    replaceGroupChats({
      Room: { name: 'Room', roomId: 'r-3', log: [], members: [], watermarks: {}, epoch: 0, running: false }
    })

    let pollCount = 0
    const base = install
    setGroupEngineRequest(async (method, params) => {
      calls.push({ method, params: params ?? {} })
      if (method === 'session.resume' && params?.session_id === 'Group: r-3') {
        return { session_id: 'rt-live', session_key: 'stored-3' }
      }
      if (method === 'session.resume' && pollCount++ === 0) {
        return { messages: [{ role: 'user', content: 'old' }], message_count: 1 }
      }
      if (method === 'session.resume') {
        return {
          messages: [
            { role: 'user', content: 'old' },
            { role: 'assistant', content: 'the finding' }
          ]
        }
      }
      return {}
    })

    const turnPromise = runGroupChatMemberTurn('Room', { name: 'research' }, 'room delta', 't1')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    const reply = await turnPromise

    expect(reply).toBe('the finding')
    const submits = calls.filter(call => call.method === 'prompt.submit')
    expect(submits).toHaveLength(1)
    expect(submits[0].params.profile).toBe('research')
  })

  it('recovers a 4001 on the first submit via the STORED id and delivers', async () => {
    vi.useFakeTimers()
    let submitted = false
    let submitAttempts = 0
    setGroupEngineRequest(async (method, params) => {
      calls.push({ method, params: params ?? {} })
      if (method === 'session.resume' && params?.omit_messages) {
        if (params.session_id === 'stored-4') return { session_id: 'rt-fresh' }
        throw Object.assign(new Error('gone'), { code: 4007 })
      }
      if (method === 'prompt.submit') {
        submitted = true
        submitAttempts += 1
        if (submitAttempts === 1) {
          throw Object.assign(new Error('not in memory'), { code: 4001 })
        }
        return {}
      }
      if (method === 'session.resume') {
        // The baseline (pre-submit) read sees an empty transcript; the polls
        // see the finished reply.
        return submitted ? { messages: [{ role: 'assistant', content: 'recovered reply' }] } : { messages: [] }
      }
      return {}
    })
    replaceGroupChats({
      Room: {
        name: 'Room',
        roomId: 'r-4',
        log: [],
        members: [],
        watermarks: {},
        sessions: { research: 'stored-4' },
        epoch: 0,
        running: false
      }
    })

    const turnPromise = runGroupChatMemberTurn('Room', { name: 'research' }, 'delta', 't1')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    const reply = await turnPromise

    expect(reply).toBe('recovered reply')
    const submits = calls.filter(call => call.method === 'prompt.submit')
    expect(submits.length).toBeGreaterThanOrEqual(2)
  })

  it('reads a pass-only turn as silent and still advances the watermark (caller side)', async () => {
    vi.useFakeTimers()
    setGroupEngineRequest(async method => {
      calls.push({ method, params: {} })
      if (method === 'session.resume' && !calls.some(call => call.method === 'prompt.submit')) {
        return { session_id: 'rt-5', session_key: 'stored-5' }
      }
      if (method === 'session.resume') {
        return { messages: [{ role: 'assistant', content: '(pass)' }] }
      }
      return {}
    })
    replaceGroupChats({
      Room: { name: 'Room', roomId: 'r-5', log: [], members: [], watermarks: {}, epoch: 0, running: false }
    })

    const turnPromise = runGroupChatMemberTurn('Room', { name: 'research' }, 'delta', 't1')
    await vi.advanceTimersByTimeAsync(2000)
    // Pass-only turns return the pass text; the room loop reads it as silence.
    expect(await turnPromise).toBe('(pass)')
  })

  it('abandons the poll when an explicit stop held the member', async () => {
    vi.useFakeTimers()
    let polls = 0
    setGroupEngineRequest(async method => {
      calls.push({ method, params: {} })
      if (method === 'session.resume' && !calls.some(call => call.method === 'prompt.submit')) {
        return { session_id: 'rt-6', session_key: 'stored-6' }
      }
      if (method === 'session.resume') {
        polls += 1
        return { messages: [], message_count: 0, running: true }
      }
      return {}
    })
    replaceGroupChats({
      Room: {
        name: 'Room',
        roomId: 'r-6',
        log: [],
        members: [],
        watermarks: {},
        sessions: { research: 'stored-6' },
        epoch: 0,
        running: true
      }
    })

    const turnPromise = runGroupChatMemberTurn('Room', { name: 'research' }, 'delta', 't1')
    await vi.advanceTimersByTimeAsync(2000)
    // The stop path: epoch bump + member hold.
    $groupChats.set({
      ...$groupChats.get(),
      Room: {
        ...$groupChats.get().Room,
        epoch: 1,
        holds: { research: { at: Date.now(), thread: 't1' } }
      }
    })
    // The next poll (after the held mutation) must bail immediately.
    await vi.advanceTimersByTimeAsync(2000)
    expect(await turnPromise).toBe(null)
    expect(polls).toBe(1)
  })

  it('records a stranded marker on timeout so the reply can be harvested late', async () => {
    vi.useFakeTimers()
    setGroupEngineRequest(async method => {
      calls.push({ method, params: {} })
      if (method === 'session.resume' && !calls.some(call => call.method === 'prompt.submit')) {
        return { session_id: 'rt-7', session_key: 'stored-7' }
      }
      if (method === 'session.resume') {
        return { messages: [], message_count: 0, running: true }
      }
      return {}
    })
    replaceGroupChats({
      Room: { name: 'Room', roomId: 'r-7', log: [], members: [], watermarks: {}, epoch: 0, running: false }
    })

    const turnPromise = runGroupChatMemberTurn('Room', { name: 'research' }, 'delta', 't2')
    // Hard cap is 20 minutes; the working deadline keeps extending.
    await vi.advanceTimersByTimeAsync(21 * 60000)
    expect(await turnPromise).toBe(null)

    const room = $groupChats.get().Room
    expect(room.stranded?.research).toEqual({ before: 0, thread: 't2' })
  })
})

describe('stranded harvest', () => {
  it('posts the late reply into the stranded thread and clears the marker', async () => {
    setGroupEngineRequest(async method => {
      calls.push({ method, params: {} })
      if (method === 'session.resume') {
        return {
          session_id: 'rt-8',
          messages: [
            { role: 'user', content: 'old' },
            { role: 'assistant', content: 'finished late' }
          ]
        }
      }
      return {}
    })
    replaceGroupChats({
      Room: {
        name: 'Room',
        roomId: 'r-8',
        log: [],
        members: [{ name: 'research' }],
        watermarks: {},
        sessions: { research: 'stored-8' },
        stranded: { research: { before: 1, thread: 't5' } },
        epoch: 0,
        running: false
      }
    })

    await harvestStrandedGroupReply('Room', { name: 'research' })

    const room = $groupChats.get().Room
    expect(room.stranded?.research).toBeUndefined()
    const late = room.log.find(entry => entry.from.kind === 'member')
    expect(late?.text).toBe('finished late')
    expect(late?.thread).toBe('t5')
    expect(room.watermarks['t5::research']).toBe(room.log.length)
  })

  it('keeps the marker while the session is still working or unreachable', async () => {
    setGroupEngineRequest(async () => {
      throw new Error('unreachable')
    })
    replaceGroupChats({
      Room: {
        name: 'Room',
        roomId: 'r-9',
        log: [],
        members: [{ name: 'research' }],
        watermarks: {},
        stranded: { research: { before: 0, thread: 't1' } },
        epoch: 0,
        running: false
      }
    })
    await harvestStrandedGroupReply('Room', { name: 'research' })
    expect($groupChats.get().Room.stranded?.research).toBeTruthy()

    setGroupEngineRequest(async () => ({ messages: [], running: true }))
    await harvestStrandedGroupReply('Room', { name: 'research' })
    expect($groupChats.get().Room.stranded?.research).toBeTruthy()
  })
})

describe('clarify and approvals (#90694)', () => {
  const member = { name: 'research' }

  it('mirrors a question, badges needs-you, and is idempotent per request', () => {
    const state = {
      session_id: 'rt-x',
      pending_clarify: { request_id: 'q1', question: 'Which account?', choices: ['ops', 'billing'] }
    }
    expect(syncGroupClarify('Room', member, state)).toBe(true)
    const key = 'Room::research'
    expect($groupPrompts.get()[key]?.question).toBe('Which account?')
    expect($groupNeedsYou.get().Room).toBe(true)

    // Same request — identity kept, no duplicate.
    expect(syncGroupClarify('Room', member, state)).toBe(true)
    expect(Object.keys($groupPrompts.get())).toEqual([key])

    // Resolved — mirror cleared.
    expect(syncGroupClarify('Room', member, { session_id: 'rt-x' })).toBe(false)
    expect($groupPrompts.get()[key]).toBeUndefined()
  })

  it('never mirrors for older backends without pending fields', () => {
    expect(syncGroupClarify('Room', member, {})).toBe(false)
    expect(syncGroupClarify('Room', member, null)).toBe(false)
    expect(Object.keys($groupPrompts.get())).toHaveLength(0)
  })

  it('routes an answer through clarify.respond and clears the mirror', async () => {
    const state = {
      session_id: 'rt-y',
      pending_clarify: { request_id: 'q2', question: 'Proceed?' }
    }
    syncGroupClarify('Room', member, state)
    const entry = $groupPrompts.get()['Room::research']!

    install({})
    await answerGroupClarify(entry, member, 'yes')

    const respond = calls.find(call => call.method === 'clarify.respond')
    expect(respond?.params).toMatchObject({ request_id: 'q2', answer: 'yes', profile: 'research' })
    expect($groupPrompts.get()['Room::research']).toBeUndefined()
  })

  it('answers batch questions one wire call per question', async () => {
    const state = {
      session_id: 'rt-y',
      pending_clarify: {
        request_id: 'q3',
        questions: [
          { qid: 'a', question: 'First?' },
          { id: 'b', question: 'Second?' }
        ]
      }
    }
    syncGroupClarify('Room', member, state)
    const entry = $groupPrompts.get()['Room::research']!

    install({})
    await answerGroupClarify(entry, member, { a: 'one', b: 'two' })

    const answers = calls.filter(call => call.method === 'clarify.respond')
    expect(answers).toHaveLength(2)
    expect(answers[0].params).toMatchObject({ question_id: 'a', answer: 'one' })
    expect(answers[1].params).toMatchObject({ question_id: 'b', answer: 'two' })
  })

  it('routes an approval choice through approval.respond keyed by session', async () => {
    const state = {
      session_id: 'rt-z',
      pending_approval: { request_id: 'ap1', command: 'rm -rf /', choices: ['once', 'deny'] }
    }
    syncGroupClarify('Room', member, state)
    const entry = $groupPrompts.get()['Room::research']!
    expect(entry.kind).toBe('approval')
    expect(entry.choices).toEqual(['once', 'deny'])

    install({})
    await answerGroupClarify(entry, member, 'once')

    const approval = calls.find(call => call.method === 'approval.respond')
    expect(approval?.params).toMatchObject({ request_id: 'ap1', choice: 'once', session_id: 'rt-z' })
  })

  it('mirrors a batch clarify card with questions intact', () => {
    const state = {
      pending_clarify: {
        request_id: 'q4',
        multi_select: true,
        questions: [{ qid: 'a', question: 'Pick' }]
      }
    }
    syncGroupClarify('Room', member, state)
    const entry = $groupPrompts.get()['Room::research']!
    expect(entry.multiSelect).toBe(true)
    expect(entry.questions).toEqual([{ qid: 'a', question: 'Pick' }])
  })
})