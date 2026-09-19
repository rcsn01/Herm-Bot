import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GroupMessage, GroupMember } from './group-model'
import { $groupActivity } from './group-runtime'
import { $groupChats, $groupNeedsYou, replaceGroupChats, type GroupChatRoom } from './group-store'
import {
  applyGroupHoldDirective,
  botHandle,
  buildGroupChatTurnPrompt,
  classifyGroupHoldDirective,
  createGroupRoundDriver,
  formatGroupChatLine,
  heldMemberWatermarkAdvance,
  parseGroupChatMentions,
  resolveGroupResponders,
  rotateGroupSpeakers,
  unaddressedGroupMentions,
  type EngineMember
} from './group-rounds'
import { createGroupMemberGateway, createGroupTurnModule, type GroupTurnModule, type GroupTurnResult } from './group-turns'

const MEMBERS: EngineMember[] = [
  { name: 'research' },
  { name: 'builder' },
  { name: 'default', title: 'Hermes' }
]

function entry(from: 'user' | 'member', name: string, text: string, thread = 't1', at = Date.now(), id?: string): GroupMessage {
  return { at, from: { kind: from, name }, text, thread, ...(id ? { id } : {}) }
}

function room(overrides: Partial<GroupChatRoom> = {}): GroupChatRoom {
  return {
    name: 'Room',
    log: [],
    members: MEMBERS,
    watermarks: {},
    epoch: 0,
    running: false,
    ...overrides
  }
}

function result(kind: GroupTurnResult['kind'], commit: () => { accepted: true } | { accepted: false; reason: 'engine-stopped' | 'room-stopped' | 'newer-user' }, text = 'reply', reason?: string): GroupTurnResult {
  if (kind === 'reply') return { kind, text, commit }
  if (kind === 'failed') return { kind, ...(reason ? { reason } : {}), commit }
  if (kind === 'cancelled') return { kind, reason: 'room-stopped', commit }
  return { kind, commit }
}

function accepted(kind: GroupTurnResult['kind'] = 'pass', text = 'reply', reason?: string): GroupTurnResult {
  return result(kind, () => ({ accepted: true }), text, reason)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

function fakeTurns(run: GroupTurnModule['run'] = async () => accepted()): GroupTurnModule {
  return {
    run: vi.fn(run),
    harvest: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn()
  }
}

let turns: GroupTurnModule
let driver: ReturnType<typeof createGroupRoundDriver>

async function settle(name: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ($groupChats.get()[name]?.running === false) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`room ${name} never settled`)
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({})
  $groupActivity.set({})
  $groupNeedsYou.set({})
  turns = fakeTurns()
  driver = createGroupRoundDriver(turns)
})

describe('mention and prompt helpers', () => {
  it('reads names, handles, collapsed names, and everyone mentions', () => {
    const members: EngineMember[] = [{ name: 'Research Bot', handle: 'research' }, { name: 'builder' }]
    expect([...parseGroupChatMentions('@research and @ResearchBot plus @Builder', members).mentioned].sort()).toEqual(['Research Bot', 'builder'])
    expect(parseGroupChatMentions('@everyone look', members).everyone).toBe(true)
    expect(parseGroupChatMentions('@user which account?', members).mentioned.size).toBe(0)
    expect(botHandle('default')).toBe('hermes')
    expect(botHandle('Research', { handle: 'scan' })).toBe('scan')
  })

  it('resolves only mentioned members since the latest user entry', () => {
    const log = [
      entry('user', 'You', 'hello all', 't1', 1),
      entry('member', 'research', 'working', 't1', 2),
      entry('user', 'You', '@builder your turn', 't1', 3)
    ]
    expect(resolveGroupResponders(log, MEMBERS).map(member => member.name)).toEqual(['builder'])
    expect(resolveGroupResponders([entry('user', 'You', 'plain', 't1')], MEMBERS).map(member => member.name)).toEqual(MEMBERS.map(member => member.name))
  })

  it('rotates speakers and formats source-qualified transcript lines', () => {
    expect(rotateGroupSpeakers(MEMBERS, 1).map(member => member.name)).toEqual(['builder', 'default', 'research'])
    expect(formatGroupChatLine(entry('user', 'You', 'hi'), 'research')).toBe('You (user): hi')
    expect(formatGroupChatLine({ ...entry('member', 'builder', 'hi'), from: { kind: 'member', name: 'builder', source: 'mac' } }, 'research')).toBe('builder [mac]: hi')
    expect(formatGroupChatLine(entry('member', 'default', 'hi'), 'research')).toBe('Hermes: hi')
  })

  it('builds the per-member prompt with the group rules and source labels', () => {
    const members: EngineMember[] = [{ name: 'research' }, { name: 'builder', connectionId: 'c1', connectionLabel: 'mac', sourceScoped: true }]
    const prompt = buildGroupChatTurnPrompt({ groupName: 'Launch', members, viewer: members[0], deltaLines: ['You (user): ship it'] })
    expect(prompt).toContain('[Group chat: "Launch"]')
    expect(prompt).toContain('@builder [mac]')
    expect(prompt).toContain('reply with exactly "(pass)"')
    expect(prompt).toContain('You (user): ship it')
  })
})

describe('holds and pure continuation detection', () => {
  it('classifies and applies explicit stop/resume directives', () => {
    expect(classifyGroupHoldDirective('stop @builder', ['builder'], false).hold).toEqual(['builder'])
    expect(classifyGroupHoldDirective('resume @builder', ['builder'], false).release).toEqual(['builder'])
    const held = applyGroupHoldDirective({}, { mentioned: ['a'] }, 'stop @a', { at: 1 }, ['a', 'b'])
    expect(Object.keys(held)).toEqual(['a'])
    expect(applyGroupHoldDirective(held, { everyone: true }, 'resume all', { at: 2 }, ['a', 'b'])).toEqual({})
    expect(heldMemberWatermarkAdvance(2, 5)).toBe(5)
    expect(heldMemberWatermarkAdvance(5, 5)).toBe(null)
  })

  it('finds a cited member who has not posted after the handoff', () => {
    replaceGroupChats({ Room: room({ log: [
      entry('member', 'research', 'handing to @builder', 't1', 1),
      entry('member', 'research', 'still waiting', 't1', 2)
    ] }) })
    expect(unaddressedGroupMentions('Room', [{ name: 'research' }, { name: 'builder' }], 't1')).toEqual(['builder'])
  })
})

describe('round driver publication', () => {
  it('settles an all-pass round and treats a failed result as silence', async () => {
    turns = fakeTurns(async ({ member }) => member.name === 'builder' ? accepted('failed', 'unused', 'gateway hiccup') : accepted('pass'))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Quiet', MEMBERS, 'fyi, deploy went out', 't1')
    await settle('Quiet')
    expect($groupChats.get().Quiet.log).toHaveLength(1)
    expect($groupActivity.get().Quiet.map(item => item.kind)).toContain('failed')
    expect($groupActivity.get().Quiet.find(item => item.kind === 'failed')?.reason).toBe('gateway hiccup')
    expect(turns.run).toHaveBeenCalledTimes(3)
  })

  it('publishes only after an accepted reply lease and advances the member watermark', async () => {
    turns = fakeTurns(async ({ member }) => member.name === 'research' ? accepted('reply', 'found the bug') : accepted('pass'))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Reply', MEMBERS, 'investigate', 't9')
    await settle('Reply')
    const roomState = $groupChats.get().Reply
    expect(roomState.log.filter(item => item.from.kind === 'member')).toHaveLength(1)
    expect(roomState.log.find(item => item.from.kind === 'member')).toMatchObject({ text: 'found the bug', thread: 't9' })
    expect(roomState.watermarks['t9::research']).toBe(roomState.log.length)
  })

  it('records a failed reason in the normal loop but hides it for continuation failures', async () => {
    const commit = vi.fn(() => ({ accepted: true as const }))
    const handoffRoom = room({ log: [entry('member', 'research', 'handing to @builder', 't1', 1)] })
    replaceGroupChats({ Room: handoffRoom })
    turns = fakeTurns(async ({ member }) => {
      if (member.name === 'research') return accepted('pass')
      return { kind: 'failed', reason: 'continuation detail', commit } as GroupTurnResult
    })
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Room', [{ name: 'research' }, { name: 'builder' }], '@research start', 't1')
    await settle('Room')
    const failed = $groupActivity.get().Room.filter(item => item.kind === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].reason).toBeUndefined()
  })

  it('does not append or advance on a rejected newer-user lease, but records supersession', async () => {
    const commit = vi.fn(() => ({ accepted: false as const, reason: 'newer-user' as const }))
    turns = fakeTurns(async () => ({ kind: 'reply', text: 'old reply', commit }))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Stale', [{ name: 'research' }], 'start', 't1')
    await settle('Stale')
    const result = $groupChats.get().Stale
    expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect(result.watermarks).toEqual({})
    expect($groupActivity.get().Stale.map(item => item.kind)).toContain('cancelled')
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('consumes a room-stopped watermark without appending a reply', async () => {
    turns = fakeTurns(async () => ({
      kind: 'cancelled',
      reason: 'room-stopped',
      commit: () => ({ accepted: true as const })
    }))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Stopped', [{ name: 'research' }], 'start', 't1')
    await settle('Stopped')
    const result = $groupChats.get().Stopped
    expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect(result.watermarks['t1::research']).toBe(result.log.length)
  })

  it('suppresses result activity when a room-stopped lease rejects', async () => {
    const commit = vi.fn(() => ({ accepted: false as const, reason: 'room-stopped' as const }))
    turns = fakeTurns(async () => ({ kind: 'reply', text: 'stale', commit }))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Rejected stop', [{ name: 'research' }], 'start', 't1')
    await settle('Rejected stop')
    const result = $groupChats.get()['Rejected stop']
    expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
    expect(result.watermarks['t1::research']).toBe(result.log.length)
    expect($groupActivity.get()['Rejected stop'].some(item => item.kind === 'replied')).toBe(false)
  })

  it('keeps a normal-loop cross-thread late reply in its original thread', async () => {
    turns = fakeTurns(async () => {
      const current = $groupChats.get().Cross
      $groupChats.set({
        ...$groupChats.get(),
        Cross: { ...current, epoch: current.epoch + 1, log: [...current.log, entry('user', 'You', 'other', 't2')] }
      })
      return accepted('reply', 'late original')
    })
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Cross', [{ name: 'research' }], 'start', 't1')
    // The old drive intentionally has no finalizer after the epoch change;
    // publication itself is the behavior under test.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect($groupChats.get().Cross.log.find(item => item.text === 'late original')).toMatchObject({ thread: 't1' })
  })

  it('drops a continuation after any epoch change before commit or publication', async () => {
    const continuationCommit = vi.fn(() => ({ accepted: true as const }))
    replaceGroupChats({ Room: room({ log: [entry('member', 'research', 'handoff @builder', 't1', 1)] }) })
    turns = fakeTurns(async ({ member }) => {
      if (member.name === 'research') return accepted('pass')
      const current = $groupChats.get().Room
      $groupChats.set({
        ...$groupChats.get(),
        Room: { ...current, epoch: current.epoch + 1, log: [...current.log, entry('user', 'You', 'other', 't2')] }
      })
      return { kind: 'reply', text: 'continuation late', commit: continuationCommit } as GroupTurnResult
    })
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Room', [{ name: 'research' }, { name: 'builder' }], '@research go', 't1')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(continuationCommit).not.toHaveBeenCalled()
    expect($groupChats.get().Room.log.some(item => item.text === 'continuation late')).toBe(false)
    expect($groupChats.get().Room.watermarks['t1::builder']).toBeUndefined()
    expect($groupActivity.get().Room.filter(item => item.member === 'builder')).toEqual([])
  })

  it('settles a live driver when an operation is invalidated without publishing', async () => {
    turns = fakeTurns(async () => ({
      kind: 'cancelled',
      reason: 'engine-stopped',
      commit: () => ({ accepted: true as const })
    }))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Invalidated operation', [{ name: 'research' }], 'start', 't1')
    await settle('Invalidated operation')
    expect($groupChats.get()['Invalidated operation'].running).toBe(false)
    expect($groupActivity.get()['Invalidated operation'].filter(item => item.member === 'research')).toEqual([])
  })

  it('does not publish an invalidated failure or timeout', async () => {
    for (const kind of ['failed', 'timed-out'] as const) {
      const pending = deferred<GroupTurnResult>()
      let stopped = false
      turns = {
        ...fakeTurns(async () => pending.promise),
        stop: vi.fn(() => { stopped = true })
      }
      driver = createGroupRoundDriver(turns)
      const group = `Invalidated ${kind}`
      driver.sendToGroupChat(group, [{ name: 'research' }], 'start', 't1')
      pending.resolve({
        kind,
        ...(kind === 'failed' ? { reason: 'late failure' } : {}),
        commit: () => stopped
          ? { accepted: false as const, reason: 'engine-stopped' as const }
          : { accepted: true as const }
      } as GroupTurnResult)
      turns.stop()
      await Promise.resolve()
      await Promise.resolve()
      const result = $groupChats.get()[group]
      expect(result.log.filter(item => item.from.kind === 'member')).toHaveLength(0)
      expect(result.watermarks).toEqual({})
      expect($groupActivity.get()[group].some(item => item.kind === kind)).toBe(false)
    }
  })
})

describe('round lifecycle and guards', () => {
  it('holds a member on a stop send and consumes its delta once', async () => {
    turns = fakeTurns(async () => accepted('pass'))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Holds', [{ name: 'research' }, { name: 'builder' }], 'stop @research', 't1')
    await settle('Holds')
    expect($groupChats.get().Holds.holds?.research).toBeTruthy()
    expect($groupActivity.get().Holds.map(item => item.kind)).toContain('held')
  })

  it('caps chatty members at the room message limit', async () => {
    turns = fakeTurns(async () => accepted('reply', 'another thought @everyone keep going'))
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Loud', [{ name: 'research' }, { name: 'builder' }], 'go wild', 't1')
    await settle('Loud')
    expect($groupChats.get().Loud.log.filter(item => item.from.kind === 'member').length).toBeLessThanOrEqual(10)
  })

  it('chains a send onto a running room without using a second driver', async () => {
    vi.useFakeTimers()
    let release!: (value: GroupTurnResult) => void
    const first = new Promise<GroupTurnResult>(resolve => { release = resolve })
    const run = vi.fn<GroupTurnModule['run']>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(accepted('pass'))
    turns = fakeTurns(run)
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('Chain', [{ name: 'research' }], 'first', 't1')
    driver.sendToGroupChat('Chain', [{ name: 'research' }], 'second', 't1')
    release(accepted('reply', 'first done'))
    await vi.advanceTimersByTimeAsync(400)
    expect($groupChats.get().Chain.log.filter(item => item.from.kind === 'user')).toHaveLength(2)
    expect($groupChats.get().Chain.running).toBe(false)
  })

  it('interrupts the current speaker after applying local stop state', async () => {
    const interrupt = vi.fn(async () => undefined)
    turns = { ...fakeTurns(), interrupt }
    driver = createGroupRoundDriver(turns)
    replaceGroupChats({ Stop: room({ name: 'Stop', running: true, epoch: 2, turn: 'research', sessions: { research: 'stored' }, members: [{ name: 'research' }] }) })
    await driver.stopGroupThread('Stop', 't1', [{ name: 'research' }])
    expect($groupChats.get().Stop).toMatchObject({ epoch: 3, running: false, turn: null })
    expect($groupChats.get().Stop.holds?.research).toBeDefined()
    expect(interrupt).toHaveBeenCalledWith({ name: 'research' }, 'stored')
  })

  it('does not start a delayed send after driver deactivation', async () => {
    driver.deactivate()
    expect(driver.sendToGroupChat('Noop', [{ name: 'research' }], 'text')).toBe(null)
    expect($groupChats.get().Noop).toBeUndefined()
  })

  it('keeps local stop state when the captured turn module is already stopped', async () => {
    const transport = vi.fn(async () => ({}))
    const stoppedTurns = createGroupTurnModule(createGroupMemberGateway(transport))
    stoppedTurns.stop()
    driver = createGroupRoundDriver(stoppedTurns)
    replaceGroupChats({ Stopped: room({ name: 'Stopped', epoch: 2, running: true, turn: 'research', sessions: { research: 'stored' }, members: [{ name: 'research' }] }) })
    await driver.stopGroupThread('Stopped', 't1', [{ name: 'research' }])
    expect($groupChats.get().Stopped).toMatchObject({ epoch: 3, running: false, turn: null })
    expect($groupChats.get().Stopped.holds?.research).toBeDefined()
    expect(transport).not.toHaveBeenCalled()
  })
})
