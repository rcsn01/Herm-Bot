import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GroupMessage } from './group-model'

vi.mock('./group-turns', async importOriginal => {
  const actual = await importOriginal<typeof import('./group-turns')>()
  return {
    ...actual,
    harvestStrandedGroupReply: vi.fn(async () => undefined),
    runGroupChatMemberTurn: vi.fn<(group: string, member: { name: string }, prompt: string, thread: string) => Promise<null | string>>()
  }
})

import { $groupChats, replaceGroupChats } from './group-store'
import { setGroupEngineRequest } from './group-engine'
import {
  applyGroupHoldDirective,
  botHandle,
  buildGroupChatTurnPrompt,
  classifyGroupHoldDirective,
  formatGroupChatLine,
  heldMemberWatermarkAdvance,
  parseGroupChatMentions,
  resolveGroupResponders,
  rotateGroupSpeakers,
  sendToGroupChat,
  shouldCommitMemberTurn,
  unaddressedGroupMentions,
  type EngineMember
} from './group-rounds'
import { harvestStrandedGroupReply, runGroupChatMemberTurn } from './group-turns'
import type { GroupMember } from './group-model'

const MEMBERS: EngineMember[] = [{ name: 'research' }, { name: 'builder' }, { name: 'default', title: 'Hermes' }]

function memberNames(members: EngineMember[]): string[] {
  return members.map(member => member.name)
}

function entry(from: 'user' | 'member', name: string, text: string, thread = 't1', at = Date.now()): GroupMessage {
  return { at, from: { kind: from, name }, text, thread }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

async function settle(name: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const room = $groupChats.get()[name]
    if (room && room.running === false) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`room ${name} never settled`)
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({})
  setGroupEngineRequest(async () => {
    throw new Error('no transport in rounds tests')
  })
  vi.mocked(runGroupChatMemberTurn).mockReset()
  vi.mocked(harvestStrandedGroupReply).mockReset()
  vi.mocked(harvestStrandedGroupReply).mockImplementation(async () => undefined)
})

describe('mention parsing', () => {
  it('reads names, handles, and collapsed no-space forms as mentions', () => {
    const members: EngineMember[] = [
      { name: 'Research Bot', handle: 'research' },
      { name: 'builder' }
    ]
    const parsed = parseGroupChatMentions('@research and @ResearchBot plus @Builder', members)
    expect([...parsed.mentioned].sort((left, right) => left.localeCompare(right))).toEqual(['builder', 'Research Bot'])
    expect(parsed.everyone).toBe(false)
  })

  it('reads @everyone and @all as everyone and never as a member', () => {
    const parsed = parseGroupChatMentions('@everyone look', MEMBERS)
    expect(parsed.everyone).toBe(true)
    expect(parsed.mentioned.size).toBe(0)
  })

  it('never matches @user against a bot', () => {
    const members: EngineMember[] = [{ name: 'user' }, { name: 'research' }]
    const parsed = parseGroupChatMentions('@user which account?', members)
    expect(parsed.mentioned.size).toBe(0)
  })

  it('resolves @hermes to the default member', () => {
    const parsed = parseGroupChatMentions('@hermes status?', MEMBERS)
    expect([...parsed.mentioned]).toEqual(['default'])
  })

  it('maps the default profile handle to hermes', () => {
    expect(botHandle('default')).toBe('hermes')
    expect(botHandle('research')).toBe('research')
    expect(botHandle('Research', { handle: 'scan' })).toBe('scan')
  })
})

describe('responder resolution', () => {
  it('answers only members mentioned since the last user entry', () => {
    const log = [
      entry('user', 'You', 'hello all', 't1', 1),
      entry('member', 'research', 'working on it', 't1', 2),
      entry('user', 'You', '@builder your turn', 't1', 3)
    ]
    const responders = resolveGroupResponders(log, MEMBERS)
    expect(memberNames(responders)).toEqual(['builder'])
  })

  it('means all members on @everyone or no mention', () => {
    expect(memberNames(resolveGroupResponders([entry('user', 'You', '@everyone hi', 't1', 1)], MEMBERS))).toEqual(
      memberNames(MEMBERS)
    )
    expect(memberNames(resolveGroupResponders([entry('user', 'You', 'plain text', 't1', 1)], MEMBERS))).toEqual(
      memberNames(MEMBERS)
    )
  })

  it('counts member replies as mention sources', () => {
    const log = [
      entry('user', 'You', 'kick off', 't1', 1),
      entry('member', 'research', 'handing to @builder', 't1', 2)
    ]
    expect(memberNames(resolveGroupResponders(log, MEMBERS))).toEqual(['builder'])
  })
})

describe('rotation and transcript lines', () => {
  it('rotates the lead speaker each round', () => {
    const first = rotateGroupSpeakers(MEMBERS, 0).map(m => m.name)
    const second = rotateGroupSpeakers(MEMBERS, 1).map(m => m.name)
    expect(first).toEqual(['research', 'builder', 'default'])
    expect(second).toEqual(['builder', 'default', 'research'])
  })

  it('renders user lines with the user marker and member lines with a source tag', () => {
    expect(formatGroupChatLine(entry('user', 'You', 'hi'), 'research')).toBe('You (user): hi')
    expect(formatGroupChatLine(entry('member', 'research', 'hello'), 'research')).toBe('research (you): hello')
    expect(formatGroupChatLine({ ...entry('member', 'builder', 'hello'), from: { kind: 'member', name: 'builder', source: 'mac-mini' } }, 'research')).toBe(
      'builder [mac-mini]: hello'
    )
    expect(formatGroupChatLine(entry('member', 'default', 'hey'), 'research')).toBe('Hermes: hey')
  })
})

describe('turn prompt', () => {
  it('addresses the default profile as @hermes and carries the delta', () => {
    const prompt = buildGroupChatTurnPrompt({
      groupName: 'Launch',
      members: MEMBERS,
      viewer: MEMBERS[2],
      deltaLines: ['You (user): ship it']
    })
    expect(prompt).toContain('You are @hermes')
    expect(prompt).toContain('[Group chat: "Launch"]')
    expect(prompt).toContain('You (user): ship it')
    expect(prompt).toContain('@research')
    expect(prompt).toContain('reply with exactly "(pass)"')
    expect(prompt).toContain('never thin out real content')
  })

  it('labels source-qualified peers with their connection', () => {
    const members: EngineMember[] = [
      { name: 'research' },
      { name: 'builder', connectionId: 'conn-1', connectionLabel: 'mac-mini', sourceScoped: true }
    ]
    const prompt = buildGroupChatTurnPrompt({ groupName: 'G', members, viewer: members[0], deltaLines: [] })
    expect(prompt).toContain('@builder [mac-mini]')
  })
})

describe('member holds (#93129)', () => {
  it('classifies explicit stop and resume words only', () => {
    expect(classifyGroupHoldDirective('stop working on it', ['a'], false).hold).toEqual(['a'])
    expect(classifyGroupHoldDirective('please pause @builder', ['builder'], false).hold).toEqual(['builder'])
    expect(classifyGroupHoldDirective('resume @builder', ['builder'], false).release).toEqual(['builder'])
    expect(classifyGroupHoldDirective('what time works for the deploy', ['builder'], false).hold).toEqual([])
    expect(classifyGroupHoldDirective('the unstoppable bot', ['builder'], false).hold).toEqual([])
    // Conservative trade-off: a stop word next to a mention holds it.
    expect(classifyGroupHoldDirective('do not stop @builder', ['builder'], false).hold).toEqual(['builder'])
  })

  it('holds and releases at room scope, with @all covering every member', () => {
    const holds = applyGroupHoldDirective({}, { mentioned: ['a'], everyone: false }, 'stop @a', { at: 5 }, ['a', 'b'])
    expect(Object.keys(holds)).toEqual(['a'])
    const all = applyGroupHoldDirective(holds, { everyone: true }, 'stop', { at: 6 }, ['a', 'b'])
    expect(Object.keys(all).sort()).toEqual(['a', 'b'])
    const released = applyGroupHoldDirective(all, { everyone: true }, 'resume all', { at: 7 }, ['a', 'b'])
    expect(released).toEqual({})
    expect(applyGroupHoldDirective(holds, { mentioned: ['a'] }, 'resume @a', null, ['a', 'b'])).toEqual({})
  })

  it('advances a held member watermark exactly once past the log', () => {
    expect(heldMemberWatermarkAdvance(2, 5)).toBe(5)
    expect(heldMemberWatermarkAdvance(5, 5)).toBe(null)
    expect(heldMemberWatermarkAdvance(undefined, 3)).toBe(3)
  })

  it('sets a hold on a stop send and clears it on a resume send', async () => {
    vi.mocked(runGroupChatMemberTurn).mockResolvedValue('(pass)')
    sendToGroupChat('Holds', [{ name: 'research' }, { name: 'builder' }], 'stop @research')
    await settle('Holds')
    expect(Object.keys($groupChats.get().Holds.holds ?? {})).toEqual(['research'])

    sendToGroupChat('Holds', [{ name: 'research' }, { name: 'builder' }], 'resume @research')
    await settle('Holds')
    expect($groupChats.get().Holds.holds ?? {}).toEqual({})
  })
})

describe('turn commit guard (#93127)', () => {
  it('commits a current-epoch turn', () => {
    expect(shouldCommitMemberTurn(3, 3, true)).toBe(true)
  })

  it('discards a turn whose epoch moved on with a newer user entry in the thread', () => {
    expect(shouldCommitMemberTurn(3, 4, true)).toBe(false)
  })

  it('commits finished work on a cross-thread epoch bump', () => {
    expect(shouldCommitMemberTurn(3, 4, false)).toBe(true)
  })
})

describe('unaddressed mentions (#94478)', () => {
  const members: EngineMember[] = [{ name: 'research' }, { name: 'builder' }]

  it('flags a cited member with no later post', () => {
    replaceGroupChats({
      Room: {
        name: 'Room',
        members: [],
        log: [
          entry('member', 'research', 'handing to @builder', 't1', 1),
          entry('member', 'research', 'still waiting', 't1', 2)
        ],
        watermarks: {},
        epoch: 0,
        running: false
      }
    })
    expect(unaddressedGroupMentions('Room', members, 't1')).toEqual(['builder'])
  })

  it('stops flagging once the cited member posts', () => {
    replaceGroupChats({
      Room: {
        name: 'Room',
        members: [],
        log: [
          entry('member', 'research', 'handing to @builder', 't1', 1),
          entry('member', 'builder', 'on it', 't1', 2)
        ],
        watermarks: {},
        epoch: 0,
        running: false
      }
    })
    expect(unaddressedGroupMentions('Room', members, 't1')).toEqual([])
  })

  it('never treats self-citations or user entries as handoffs and ignores other threads', () => {
    replaceGroupChats({
      Room: {
        name: 'Room',
        members: [],
        log: [
          entry('member', 'research', 'ask @research', 't1', 1),
          entry('member', 'builder', 'ping @research', 't2', 2)
        ],
        watermarks: {},
        epoch: 0,
        running: false
      }
    })
    expect(unaddressedGroupMentions('Room', members, 't1')).toEqual([])
  })
})

describe('round lifecycle', () => {
  it('settles when everyone passes, logging only the user message', async () => {
    vi.mocked(runGroupChatMemberTurn).mockResolvedValue('(pass)')
    sendToGroupChat('Quiet', MEMBERS, 'fyi, deploy went out')
    await settle('Quiet')

    const log = $groupChats.get().Quiet.log
    expect(log).toHaveLength(1)
    expect(log[0].from.kind).toBe('user')
    expect(runGroupChatMemberTurn).toHaveBeenCalledTimes(3)
  })

  it('lands member replies in the send thread and advances watermarks', async () => {
    vi.mocked(runGroupChatMemberTurn).mockImplementation(async (_group, member) =>
      member.name === 'research' ? 'found the bug' : '(pass)'
    )
    sendToGroupChat('Reply', MEMBERS, 'investigate', 't9')
    await settle('Reply')

    const room = $groupChats.get().Reply
    const replies = room.log.filter(entry => entry.from.kind === 'member')
    expect(replies).toHaveLength(1)
    expect(replies[0].from.name).toBe('research')
    expect(replies[0].thread).toBe('t9')
    expect(room.watermarks['t9::research']).toBe(room.log.length)
  })

  it('feeds a second send only the NEW messages', async () => {
    const turns: string[] = []
    vi.mocked(runGroupChatMemberTurn).mockImplementation(async (_group, member, prompt) => {
      turns.push(prompt)
      return member.name === 'research' ? `reply ${turns.length}` : '(pass)'
    })
    sendToGroupChat('Delta', [{ name: 'research' }], 'first')
    await settle('Delta')
    sendToGroupChat('Delta', [{ name: 'research' }], 'second')
    await settle('Delta')

    // The member's own reply is behind its watermark — the second prompt
    // carries only the new user message (desktop delta contract).
    const second = turns[1]
    expect(second).toContain('You (user): second')
    expect(second).not.toContain('You (user): first')
    expect(second).not.toContain('reply 1')
  })

  it('treats a failed member turn as a pass, not a room error', async () => {
    vi.mocked(runGroupChatMemberTurn).mockImplementation(async (_group, member) => {
      if (member.name === 'builder') throw new Error('gateway hiccup')
      return '(pass)'
    })
    sendToGroupChat('Flaky', MEMBERS, 'anyone around?')
    await settle('Flaky')

    expect($groupChats.get().Flaky.log).toHaveLength(1)
  })

  it('stops chatty members at the message cap', async () => {
    vi.mocked(runGroupChatMemberTurn).mockResolvedValue('another thought @everyone keep going')
    sendToGroupChat('Loud', [{ name: 'research' }, { name: 'builder' }], 'go wild')
    await settle('Loud')

    const posted = $groupChats.get().Loud.log.filter(entry => entry.from.kind === 'member')
    expect(posted.length).toBeLessThanOrEqual(10)
  })

  it('clears the needs-you badge on a user send and sets it when a member addresses @user', async () => {
    const { $groupNeedsYou } = await import('./group-store')
    vi.mocked(runGroupChatMemberTurn).mockImplementation(async (_group, member) =>
      member.name === 'research' ? 'blocked — @user which account?' : '(pass)'
    )
    sendToGroupChat('Escalate', [{ name: 'research' }], 'sort the invoices')
    await settle('Escalate')
    expect($groupNeedsYou.get().Escalate).toBe(true)

    sendToGroupChat('Escalate', [{ name: 'research' }], 'use the ops account')
    expect($groupNeedsYou.get().Escalate).toBe(false)
  })

  it('chains a send onto a running room without forking the drive', async () => {
    vi.useFakeTimers()
    try {
      let releaseFirst: (value: string) => void = () => undefined
      const first = new Promise<string>(resolve => {
        releaseFirst = resolve
      })
      vi.mocked(runGroupChatMemberTurn).mockImplementationOnce(() => first as Promise<null | string>).mockResolvedValue('(pass)')

      sendToGroupChat('Chain', [{ name: 'research' }], 'first')
      sendToGroupChat('Chain', [{ name: 'research' }], 'second')

      releaseFirst('done')
      await vi.advanceTimersByTimeAsync(400)
      const room = $groupChats.get().Chain
      expect(room.log.filter(entry => entry.from.kind === 'user')).toHaveLength(2)
      expect(room.running).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a running thread: bumps the epoch, holds every member, and interrupts the mid-turn session', async () => {
    const interrupts: Array<Record<string, unknown>> = []
    setGroupEngineRequest(async (method, params) => {
      if (method === 'session.interrupt') interrupts.push(params ?? {})
      return {}
    })
    replaceGroupChats({
      Stop: {
        name: 'Stop',
        roomId: 'r1',
        log: [],
        members: [{ name: 'research' }],
        watermarks: {},
        sessions: { research: 'sess-1' },
        epoch: 0,
        running: true,
        turn: 'research'
      }
    })
    const { stopGroupThread } = await import('./group-rounds')
    await stopGroupThread('Stop', 't1', [{ name: 'research' }])

    const room = $groupChats.get().Stop
    expect(room.epoch).toBe(1)
    expect(room.running).toBe(false)
    expect(room.holds?.research).toBeTruthy()
    expect(interrupts).toEqual([{ session_id: 'sess-1', profile: 'research' }])
  })
})

describe('send guards', () => {
  it('rejects empty text and empty rosters', () => {
    expect(sendToGroupChat('G', MEMBERS, '   ')).toBe(null)
    expect(sendToGroupChat('G', [], 'hi')).toBe(null)
    expect($groupChats.get().G).toBeUndefined()
  })

  it('mints a thread id when the composer starts a new thread', async () => {
    vi.mocked(runGroupChatMemberTurn).mockResolvedValue('(pass)')
    const thread = sendToGroupChat('Fresh', [{ name: 'research' }], 'new topic')
    expect(thread).toMatch(/^t/)
    await settle('Fresh')
    expect($groupChats.get().Fresh.log[0].thread).toBe(thread)
  })

  it('continues the latest thread when the composer replies', async () => {
    vi.mocked(runGroupChatMemberTurn).mockResolvedValue('(pass)')
    const thread = sendToGroupChat('Continue', [{ name: 'research' }], 'topic one', 'tabc')
    await settle('Continue')
    // The composer passes the latest thread id back (targetThread).
    sendToGroupChat('Continue', [{ name: 'research' }], 'follow-up', thread)
    await settle('Continue')

    const log = $groupChats.get().Continue.log
    expect(log.every(entry => entry.thread === 'tabc')).toBe(true)
  })
})

describe('duplicate append guard (#93127)', () => {
  it('drops an adjacent identical member reply but keeps other speakers and threads', async () => {
    const { appendGroupChatEntry } = await import('./group-store')
    const reply = appendGroupChatEntry('Echo', { kind: 'member', name: 'research' }, 'same text', 't1')
    const again = appendGroupChatEntry('Echo', { kind: 'member', name: 'research' }, 'same text', 't1')
    expect(again.id).toBe(reply.id)
    expect($groupChats.get().Echo.log).toHaveLength(1)

    appendGroupChatEntry('Echo', { kind: 'member', name: 'builder' }, 'same text', 't1')
    expect($groupChats.get().Echo.log).toHaveLength(2)

    appendGroupChatEntry('Echo', { kind: 'member', name: 'research' }, 'same text', 't2')
    expect($groupChats.get().Echo.log).toHaveLength(3)

    appendGroupChatEntry('Echo', { kind: 'user', name: 'You' }, 'same text', 't1')
    expect($groupChats.get().Echo.log).toHaveLength(4)
  })

  it('converts the empty-response sentinel like the gateway does', async () => {
    const { appendGroupChatEntry } = await import('./group-store')
    appendGroupChatEntry('Sentinel', { kind: 'member', name: 'research' }, '(empty)', 't1')
    const log = $groupChats.get().Sentinel.log
    expect(log[0].text).toContain('The model returned no response')
    expect(log[0].text).not.toBe('(empty)')
  })
})