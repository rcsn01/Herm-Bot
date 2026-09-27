import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GroupMessage, GroupMember } from './group-model'
import { $groupActivity, $groupChats, $groupNeedsYou, replaceGroupChats, type GroupChatRoom } from './group-store'
import { botHandle, type EngineMember } from './group-model'
import {
  applyGroupHoldDirective,
  classifyGroupHoldDirective,
  createGroupRoundDriver,
  parseGroupChatMentions,
  resolveGroupResponders,
  rotateGroupSpeakers,
  unaddressedGroupMentions
} from './group-rounds'
import { createGroupMemberGateway, createGroupTurnModule, type GroupTurnModule, type GroupTurnReport } from './group-turns'

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

const NOOP_REPORT: GroupTurnReport = { abandoned: false, spoke: false, stop: false }

function fakeTurns(takeTurn: GroupTurnModule['takeTurn'] = async () => ({ ...NOOP_REPORT })): GroupTurnModule {
  return {
    takeTurn: vi.fn(takeTurn),
    // The driver must only ever drive turns through takeTurn.
    run: vi.fn(async () => { throw new Error('driver must not call run') }),
    harvest: vi.fn(async () => undefined),
    harvestRoom: vi.fn(async () => undefined),
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

  it('rotates speakers each round', () => {
    expect(rotateGroupSpeakers(MEMBERS, 1).map(member => member.name)).toEqual(['builder', 'default', 'research'])
  })
})

describe('holds and pure continuation detection', () => {
  it('classifies and applies explicit stop/resume directives', () => {
    expect(classifyGroupHoldDirective('stop @builder', ['builder'], false).hold).toEqual(['builder'])
    expect(classifyGroupHoldDirective('resume @builder', ['builder'], false).release).toEqual(['builder'])
    const held = applyGroupHoldDirective({}, { mentioned: ['a'] }, 'stop @a', { at: 1 }, ['a', 'b'])
    expect(Object.keys(held)).toEqual(['a'])
    expect(applyGroupHoldDirective(held, { everyone: true }, 'resume all', { at: 2 }, ['a', 'b'])).toEqual({})
  })

  it('finds a cited member who has not posted after the handoff', () => {
    replaceGroupChats({ 'name:Room': room({ log: [
      entry('member', 'research', 'handing to @builder', 't1', 1),
      entry('member', 'research', 'still waiting', 't1', 2)
    ] }) })
    expect(unaddressedGroupMentions('name:Room', [{ name: 'research' }, { name: 'builder' }], 't1')).toEqual(['builder'])
  })

  it('attributes same-named posters by source so a cited member is not re-driven', () => {
    const members = [
      { name: 'research', connectionId: 'gw-1', connectionLabel: 'gw-1', sourceScoped: true },
      { name: 'research', connectionId: 'gw-2', connectionLabel: 'gw-2', sourceScoped: true },
      { name: 'builder' }
    ]
    replaceGroupChats({ 'name:Room': room({ log: [
      entry('user', 'You', 'start', 't1', 1),
      entry('member', 'builder', '@research report the deploy', 't1', 2),
      { at: 3, from: { kind: 'member', name: 'research', source: 'gw-2' }, id: 'm2', text: 'deploy is green', thread: 't1' }
    ] }) })
    expect(unaddressedGroupMentions('name:Room', members, 't1')).toEqual([])
  })
})

describe('round lifecycle and guards', () => {
  it('stamps member holds from a stop send', async () => {
    turns = fakeTurns()
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('name:Holds', [{ name: 'research' }, { name: 'builder' }], 'stop @research', 't1')
    await settle('name:Holds')
    expect($groupChats.get()['name:Holds'].holds?.research).toBeTruthy()
  })

  it('settles a quiet round with the settled finalizer', async () => {
    turns = fakeTurns()
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('name:Quiet', MEMBERS, 'fyi, deploy went out', 't1')
    await settle('name:Quiet')
    expect($groupChats.get()['name:Quiet'].running).toBe(false)
    expect($groupActivity.get()['name:Quiet'].map(item => item.kind)).toContain('settled')
    expect(vi.mocked(turns.takeTurn)).toHaveBeenCalledTimes(MEMBERS.length)
  })

  it('clears the needs-you badge on send and dedupes the roster on durable identity', () => {
    $groupNeedsYou.set({ 'name:Room': true })
    turns = fakeTurns()
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('name:Room', [{ name: 'research' }, { name: 'research' }, { name: 'builder' }], 'hello', 't1')
    expect($groupNeedsYou.get()['name:Room']).toBe(false)
    expect($groupChats.get()['name:Room'].members.map(member => member.name)).toEqual(['research', 'builder'])
  })

  it('stamps holds under the qualified key and keeps a connectionless twin distinct', async () => {
    driver.sendToGroupChat('name:Keys', [
      { name: 'research', connectionId: 'gw-2', connectionLabel: 'gw-2', sourceScoped: true, title: 'Researcher' },
      { name: 'research' }
    ], 'stop @Researcher', 't1')
    await settle('name:Keys')
    const holds = $groupChats.get()['name:Keys'].holds || {}
    expect(holds['gw-2::research']).toBeTruthy()
    expect(holds.research).toBeUndefined()
  })

  it('interrupts the current speaker by member key', async () => {
    const interrupt = vi.fn(async () => undefined)
    turns = { ...fakeTurns(), interrupt }
    driver = createGroupRoundDriver(turns)
    const connected = { name: 'research', connectionId: 'gw-2', sourceScoped: true }
    replaceGroupChats({
      'name:Stop': room({ name: 'Stop', running: true, epoch: 2, turn: 'gw-2::research', sessions: { 'gw-2::research': 'stored' }, members: [connected] })
    })
    await driver.stopGroupThread('name:Stop', 't1', [connected])
    expect($groupChats.get()['name:Stop']).toMatchObject({ epoch: 3, running: false, turn: null })
    expect($groupChats.get()['name:Stop'].holds?.['gw-2::research']).toBeDefined()
    expect(interrupt).toHaveBeenCalledWith('name:Stop', connected)
  })

  it('misses the interrupt on a stale turn key', async () => {
    const interrupt = vi.fn(async () => undefined)
    turns = { ...fakeTurns(), interrupt }
    driver = createGroupRoundDriver(turns)
    const connected = { name: 'research', connectionId: 'gw-2', sourceScoped: true }
    replaceGroupChats({
      'name:Stop': room({ name: 'Stop', running: true, epoch: 2, turn: 'research', sessions: { 'gw-2::research': 'stored' }, members: [connected] })
    })
    await driver.stopGroupThread('name:Stop', 't1', [connected])
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('caps chatty members at the room message limit', async () => {
    vi.useFakeTimers()
    // The REAL turn module over a fake gateway: the caps test exercises the
    // full pipeline — takeTurn drive step, publication, and the driver's cap.
    let resumes = 0
    const gateway = createGroupMemberGateway(async (method, params = {}) => {
      if (method === 'session.resume') {
        if (params.omit_messages) return { session_id: 'rt', session_key: 'stored' }
        resumes += 1
        return resumes % 2 === 1
          ? { messages: [] }
          : { messages: [{ role: 'assistant', content: 'another thought @everyone keep going' }] }
      }
      return {}
    }, 'gw-current')
    turns = createGroupTurnModule(gateway)
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('name:Loud', [{ name: 'research' }, { name: 'builder' }], 'go wild', 't1')
    await vi.advanceTimersByTimeAsync(30000)
    const result = $groupChats.get()['name:Loud']
    expect(result.log.filter(item => item.from.kind === 'member').length).toBeLessThanOrEqual(10)
    expect($groupActivity.get()['name:Loud'].map(item => item.kind)).toContain('capped')
    expect(result.running).toBe(false)
  })

  it('chains a send onto a running room without using a second driver', async () => {
    vi.useFakeTimers()
    let release!: (value: GroupTurnReport) => void
    const first = new Promise<GroupTurnReport>(resolve => { release = resolve })
    const takeTurn = vi.fn<GroupTurnModule['takeTurn']>()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ ...NOOP_REPORT })
    turns = fakeTurns(takeTurn)
    driver = createGroupRoundDriver(turns)
    driver.sendToGroupChat('name:Chain', [{ name: 'research' }], 'first', 't1')
    driver.sendToGroupChat('name:Chain', [{ name: 'research' }], 'second', 't1')
    release({ abandoned: false, spoke: true, stop: false })
    await vi.advanceTimersByTimeAsync(400)
    expect($groupChats.get()['name:Chain'].log.filter(item => item.from.kind === 'user')).toHaveLength(2)
    expect($groupChats.get()['name:Chain'].running).toBe(false)
    expect(vi.mocked(turns.takeTurn).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('interrupts the current speaker after applying local stop state', async () => {
    const interrupt = vi.fn(async () => undefined)
    turns = { ...fakeTurns(), interrupt }
    driver = createGroupRoundDriver(turns)
    replaceGroupChats({ 'name:Stop': room({ name: 'Stop', running: true, epoch: 2, turn: 'research', sessions: { research: 'stored' }, members: [{ name: 'research' }] }) })
    await driver.stopGroupThread('name:Stop', 't1', [{ name: 'research' }])
    expect($groupChats.get()['name:Stop']).toMatchObject({ epoch: 3, running: false, turn: null })
    expect($groupChats.get()['name:Stop'].holds?.research).toBeDefined()
    expect(interrupt).toHaveBeenCalledWith('name:Stop', { name: 'research' })
  })

  it('does not start a delayed send after driver deactivation', async () => {
    driver.deactivate()
    expect(driver.sendToGroupChat('name:Noop', [{ name: 'research' }], 'text')).toBe(null)
    expect($groupChats.get()['name:Noop']).toBeUndefined()
  })

  it('keeps local stop state when the captured turn module is already stopped', async () => {
    const transport = vi.fn(async () => ({}))
    const stoppedTurns = createGroupTurnModule(createGroupMemberGateway(transport, 'gw-current'))
    stoppedTurns.stop()
    driver = createGroupRoundDriver(stoppedTurns)
    replaceGroupChats({ 'name:Stopped': room({ name: 'Stopped', epoch: 2, running: true, turn: 'research', sessions: { research: 'stored' }, members: [{ name: 'research' }] }) })
    await driver.stopGroupThread('name:Stopped', 't1', [{ name: 'research' }])
    expect($groupChats.get()['name:Stopped']).toMatchObject({ epoch: 3, running: false, turn: null })
    expect($groupChats.get()['name:Stopped'].holds?.research).toBeDefined()
    expect(transport).not.toHaveBeenCalled()
  })
})
