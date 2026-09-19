/**
 * Room-level coordination, ported from the desktop Bot Mode's
 * group-rounds.ts (apps/desktop/src/plugins/hermes-bots/group-rounds.ts):
 * the @mention parse, responder resolution, speaker rotation, the per-turn
 * prompt, the #93129 member holds, and the bounded round-robin driver.
 *
 * Behavioral model (desktop, clean-room): a group conversation is ONE ordered
 * room log owned by this store. A user send triggers at most
 * GROUP_CHAT_MAX_ROUNDS serial rounds — never parallel, no LLM router. Who
 * speaks each round is a deterministic @mention parse since the last user
 * message (mentioned members only, else everyone); replying exactly "(pass)"
 * (or nothing, or failing) is silence. Each member runs its turn in its OWN
 * persistent per-group session and is fed only entries NEW since it last
 * saw the room.
 */

import type { GroupMessage } from './group-model'
import { recordGroupActivity } from './group-runtime'
import {
  $groupNeedsYou,
  GROUP_CHAT_HISTORY_LIMIT,
  GROUP_CHAT_MAX_CONTINUATIONS,
  GROUP_CHAT_MAX_MEMBERS,
  GROUP_CHAT_MAX_MESSAGES,
  GROUP_CHAT_MAX_ROUNDS,
  appendGroupChatEntry,
  getGroupRoom,
  groupMemberKey,
  groupSpeakerLabel,
  groupThreadOf,
  mintGroupThreadId,
  updateGroupChat,
  type GroupHoldStamp
} from './group-store'
import type { GroupTurnModule, GroupTurnResult } from './group-turns'

export interface EngineMember {
  connectionId?: string
  connectionKind?: string
  connectionLabel?: string
  displayName?: string
  handle?: string
  name: string
  sourceScoped?: boolean
  title?: string
}

/** The @handle a member is addressed by. The primary profile is presented as
 *  hermes (botHandle, data.ts): a bot named "default" must stay @hermes. */
export function botHandle(name: string, member?: { handle?: string }): string {
  const handle = String(member?.handle || '').trim()
  if (handle) return handle
  return name.trim().toLowerCase() === 'default' ? 'hermes' : name.trim().toLowerCase()
}

/** Deterministic @mention parse (group-rounds.ts parseGroupChatMentions):
 *  @name, @handle, @everyone/@all; names match case-insensitively against
 *  profile names, handles, and collapsed no-space forms. */
export function parseGroupChatMentions(text: unknown, members: EngineMember[]) {
  const source = String(text || '')
  const mentioned = new Set<string>()
  let everyone = false
  const handles = new Map<string, string>()

  for (const member of members) {
    const title = String(member.title || '').trim()
    const handle = String(member.handle || botHandle(member.name, member) || '').trim()
    const forms = new Set([
      member.name.toLowerCase(),
      member.name.toLowerCase().replace(/[\s_-]+/g, ''),
      ...(handle ? [handle.toLowerCase(), handle.toLowerCase().replace(/[\s_-]+/g, '')] : []),
      ...(title
        ? [title.toLowerCase(), title.toLowerCase().replace(/[\s_-]+/g, ''), title.split(/\s+/)[0].toLowerCase()]
        : [])
    ])
    for (const friendly of [member.displayName, member.title]) {
      const value = String(friendly || '').trim().toLowerCase()
      if (value) {
        forms.add(value)
        forms.add(value.replace(/[\s_-]+/g, ''))
      }
    }
    for (const form of forms) {
      if (form) handles.set(form, groupMemberKey(member))
    }
  }

  for (const match of source.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)) {
    const handle = match[1].toLowerCase()
    if (handle === 'everyone' || handle === 'all') {
      everyone = true
      continue
    }
    if (handle === 'user') continue
    const resolved = handles.get(handle) || handles.get(handle.replace(/[._-]+/g, ''))
    if (resolved) mentioned.add(resolved)
  }

  return { everyone, mentioned }
}

/** Members that should take a turn this round: everyone when no member is
 *  @-mentioned since the last user entry (or @everyone appears), otherwise
 *  only the mentioned members. (group-rounds.ts resolveGroupResponders) */
export function resolveGroupResponders(log: GroupMessage[], members: EngineMember[]) {
  let sinceLastUser: GroupMessage[] = []
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].from.kind === 'user') {
      sinceLastUser = log.slice(i)
      break
    }
  }

  const mentioned = new Set<string>()
  let everyone = false
  for (const entry of sinceLastUser) {
    const parsed = parseGroupChatMentions(entry.text, members)
    if (parsed.everyone) everyone = true
    for (const key of parsed.mentioned) mentioned.add(key)
  }

  if (everyone || mentioned.size === 0) return members
  return members.filter(member => mentioned.has(groupMemberKey(member)))
}

/** Rotate the roster so a different member leads each round. */
export function rotateGroupSpeakers<T>(members: T[], round: number): T[] {
  if (members.length < 2) return members
  const shift = round % members.length
  return [...members.slice(shift), ...members.slice(0, shift)]
}

/** Room-log line as a member sees it: `Name (user): …` / `Name: …` /
 *  `Name (you): …`. (group-rounds.ts formatGroupChatLine) */
export function formatGroupChatLine(entry: GroupMessage, viewerName: string): string {
  if (entry.from.kind === 'user') {
    return `${entry.from.name || 'User'} (user): ${entry.text}`
  }
  const suffix = entry.from.name === viewerName ? ' (you)' : ''
  const source = entry.from.source ? ` [${entry.from.source}]` : ''
  return `${groupSpeakerLabel(entry.from.name)}${suffix}${source}: ${entry.text}`
}

interface GroupChatTurnPromptInput {
  deltaLines: string[]
  groupName: string
  members: EngineMember[]
  viewer: EngineMember
}

/** The full per-turn payload for one member: participation rules + the room
 *  delta. Rules travel in the turn payload (not SOUL) so every existing bot
 *  can join a group chat without a profile migration. Byte-faithful port of
 *  the desktop template — the model sees the same contract on both surfaces. */
export function buildGroupChatTurnPrompt({ groupName, members, viewer, deltaLines }: GroupChatTurnPromptInput): string {
  const viewerKey = groupMemberKey(viewer)
  const peers = members.filter(m => groupMemberKey(m) !== viewerKey)
  const peerNames = peers
    .map(m => {
      const handle = m.title ? `${m.title} (@${botHandle(m.name, m)})` : `@${botHandle(m.name, m)}`
      return m.sourceScoped || m.connectionLabel ? `${handle} [${m.connectionLabel || m.connectionId}]` : handle
    })
    .join(', ')

  return [
    `[Group chat: "${groupName}"] You are @${botHandle(viewer.name, viewer)}, one participant in a group chat with ${peerNames || 'no one else yet'} and the user.`,
    '',
    'New messages in the room since your last turn (oldest first):',
    ...deltaLines.map(line => `  ${line}`),
    '',
    'Rules for this room:',
    '- Reply with ONE conversational message ONLY if you have something new worth adding: build on what was just said, claim or hand off work, answer a question aimed at you, or report a real result. Keep chatter short (1-3 sentences) — but when you are delivering a result, an answer the user asked for, or substantive work, give it at full quality and length; never thin out real content to fit the room.',
    '- If you have nothing new to add, reply with exactly "(pass)". Passing is good — it lets the conversation settle.',
    '- Mention a teammate as @name to pull them in; mention @user only for a judgment call or a result the user needs. Do not repeat points already made.',
    '- Never reveal content from your private 1:1 chats. Your reply text goes to the room verbatim — no preamble, no meta-commentary.'
  ].join('\n')
}

// --- member-hold helpers (#93129) — pure, unit-tested ---

/** #93129: classify a USER room message's effect on member holds. Only user
 *  sends reach this, so a bot saying "stopped working on it" can never set a
 *  hold. Conservative on purpose: a standalone stop word next to a mention
 *  holds those members. (group-rounds.ts classifyGroupHoldDirective) */
export function classifyGroupHoldDirective(
  text: string,
  mentionedKeys: Iterable<string> | null | undefined,
  everyone: boolean
) {
  const value = String(text || '')
  const mentioned = [...(mentionedKeys || [])]
  const stop = /\b(stop|halt|pause)\b/i.test(value)
  const resume = /\b(resume|continue|go|proceed)\b/i.test(value)

  if (stop) {
    return { hold: mentioned, holdAll: Boolean(everyone), release: [], releaseAll: false }
  }
  if (resume) {
    return { hold: [], holdAll: false, release: mentioned, releaseAll: Boolean(everyone) }
  }
  return { hold: [], holdAll: false, release: mentioned, releaseAll: false }
}

interface GroupMentionParse {
  everyone?: boolean
  mentioned?: Iterable<string>
}

/** Next holds map after one user message. Holds are keyed by memberKey at
 *  ROOM scope (group-rounds.ts applyGroupHoldDirective). */
export function applyGroupHoldDirective(
  holds: Record<string, GroupHoldStamp> | null | undefined,
  mentions: GroupMentionParse | null | undefined,
  text: string,
  stamp: GroupHoldStamp | null | undefined,
  allMemberKeys: string[] = []
): Record<string, GroupHoldStamp> {
  const prior: Record<string, GroupHoldStamp> = holds && typeof holds === 'object' ? holds : {}
  const action = classifyGroupHoldDirective(text, mentions?.mentioned || [], Boolean(mentions?.everyone))

  if (action.releaseAll) {
    return Object.keys(prior).length ? {} : prior
  }

  const toHold = action.holdAll ? [...allMemberKeys] : action.hold
  let next = prior
  for (const key of toHold) {
    if (next === prior) next = { ...prior }
    next[key] = { at: stamp?.at || Date.now(), byMessageId: stamp?.byMessageId || null, thread: stamp?.thread || null }
  }
  for (const key of action.release) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      if (next === prior) next = { ...prior }
      delete next[key]
    }
  }
  return next
}

/** A held member's skip must consume its delta exactly once — advance the
 *  watermark past the current log. Null = nothing to consume. */
export function heldMemberWatermarkAdvance(seen: number | undefined, logLength: number): null | number {
  return logLength > (seen || 0) ? logLength : null
}

// --- end member-hold helpers ---

/** Members cited by @mention in a thread who have not posted any entry after
 *  the citing one — the unresolved-handoff detector (#94478). */
export function unaddressedGroupMentions(group: string, members: EngineMember[], thread: string): string[] {
  const log = getGroupRoom(group).log.filter(entry => groupThreadOf(entry) === thread)
  const citedAt = new Map<string, number>()

  for (const entry of log) {
    const parsed = parseGroupChatMentions(entry.text || '', members)
    if (entry.from.kind !== 'member') continue
    for (const key of parsed.mentioned) {
      const citingMember = members.find(m => m.name === entry.from?.name)
      const citingKey = citingMember ? groupMemberKey(citingMember) : null
      if (citingKey && citingKey !== key) citedAt.set(key, log.indexOf(entry))
    }
  }

  const lastPostAt = new Map<string, number>()
  for (const entry of log) {
    if (entry.from.kind !== 'member') continue
    const speaker = members.find(m => m.name === entry.from?.name)
    const speakerKey = speaker ? groupMemberKey(speaker) : null
    if (speakerKey) lastPostAt.set(speakerKey, log.indexOf(entry))
  }

  return [...citedAt.keys()].filter(key => {
    const citedIdx = citedAt.get(key) ?? -1
    const answeredIdx = lastPostAt.get(key)
    return answeredIdx === undefined || answeredIdx <= citedIdx
  })
}

/** Internal driver seam: it captures one terminal member-turn module. */
export interface GroupRoundDriver {
  sendToGroupChat(group: string, members: EngineMember[], text: string, thread?: null | string): null | string
  stopGroupThread(group: string, thread: null | string, members?: EngineMember[] | null): Promise<void>
  deactivate(): void
}

interface PublishedTurn {
  abandoned: boolean
  spoke: boolean
  stop: boolean
}

/** Publish one typed turn result. The lease classification is authoritative:
 * a room stop consumes the current member delta without appending, a newer
 * same-thread send records only supersession, and an engine stop abandons the
 * drive without running its finalizer. */
function publishTurnResult(
  group: string,
  member: EngineMember,
  thread: string,
  markKey: string,
  result: GroupTurnResult,
  includeFailureReason: boolean
): PublishedTurn {
  const lease = result.commit()

  if (!lease.accepted) {
    if (lease.reason === 'room-stopped') {
      updateGroupChat(group, r => {
        r.watermarks[markKey] = r.log.length
        return r
      }, { sync: false })
      return { abandoned: false, spoke: false, stop: true }
    }
    if (lease.reason === 'newer-user') {
      recordGroupActivity(group, { kind: 'cancelled', member: member.name, thread })
      return { abandoned: false, spoke: false, stop: true }
    }
    return { abandoned: true, spoke: false, stop: true }
  }

  if (result.kind === 'cancelled') {
    if (result.reason === 'room-stopped') {
      updateGroupChat(group, r => {
        r.watermarks[markKey] = r.log.length
        return r
      }, { sync: false })
      return { abandoned: false, spoke: false, stop: true }
    }
    if (result.reason === 'newer-user') {
      recordGroupActivity(group, { kind: 'cancelled', member: member.name, thread })
      return { abandoned: false, spoke: false, stop: true }
    }
    // A live module can invalidate one operation when a newer operation claims
    // its token. That cancellation is a no-op, not a lifecycle abandonment;
    // only a rejected engine-stopped lease suppresses the drive finalizer.
    return { abandoned: false, spoke: false, stop: true }
  }

  if (result.kind === 'reply') {
    recordGroupActivity(group, { kind: 'replied', member: member.name, thread })
  } else if (result.kind === 'pass') {
    recordGroupActivity(group, { kind: 'passed', member: member.name, thread })
  } else if (result.kind === 'timed-out') {
    recordGroupActivity(group, { kind: 'timed-out', member: member.name, thread })
  } else if (result.kind === 'failed') {
    const reason = includeFailureReason ? result.reason : undefined
    recordGroupActivity(group, { kind: 'failed', member: member.name, thread, ...(reason ? { reason } : {}) })
  }

  updateGroupChat(group, r => {
    r.watermarks[markKey] = r.log.length
    return r
  }, { sync: false })

  if (result.kind !== 'reply') return { abandoned: false, spoke: false, stop: false }

  appendGroupChatEntry(group, {
    kind: 'member',
    name: member.name,
    ...(member.connectionLabel || member.sourceScoped ? { source: member.connectionLabel || member.connectionId } : {})
  }, result.text, thread)
  updateGroupChat(group, r => {
    r.watermarks[markKey] = r.log.length
    return r
  }, { sync: false })
  return { abandoned: false, spoke: true, stop: false }
}

export function createGroupRoundDriver(turns: GroupTurnModule): GroupRoundDriver {
  let deactivated = false
  let abandoned = false

  const driveIsLive = () => !deactivated && !abandoned
  const roomEpochIsCurrent = (group: string, epoch: number) => (getGroupRoom(group).epoch || 0) === epoch

  const recordRoomCancellation = (group: string, thread: string) => {
    if (driveIsLive()) recordGroupActivity(group, { kind: 'cancelled', member: null, thread })
  }

  const runGroupChatRounds = async (group: string, members: EngineMember[], thread: string): Promise<void> => {
    const startEpoch = getGroupRoom(group).epoch || 0
    let posted = 0
    let continuations = 0
    let exitKind: 'capped' | 'settled' = 'settled'

    try {
      for (let round = 0; round < GROUP_CHAT_MAX_ROUNDS; round++) {
        // Deliver any replies that finished after their turn timed out — every
        // member, so long work is late, never lost.
        for (const member of members) {
          if (!driveIsLive()) return
          if (!roomEpochIsCurrent(group, startEpoch)) {
            recordRoomCancellation(group, thread)
            return
          }
          await turns.harvest(group, member)
        }

        if (!driveIsLive()) return
        if (!roomEpochIsCurrent(group, startEpoch)) {
          recordRoomCancellation(group, thread)
          return
        }

        const roomLog = getGroupRoom(group).log.filter(entry => groupThreadOf(entry) === thread)
        const strandedNow = getGroupRoom(group).stranded || {}
        const responders = rotateGroupSpeakers(resolveGroupResponders(roomLog, members), round).filter(
          member => !Object.prototype.hasOwnProperty.call(strandedNow, groupMemberKey(member))
        )

        let spokeThisRound = 0

        for (const member of responders) {
          if (!driveIsLive()) return
          if (!roomEpochIsCurrent(group, startEpoch) || posted >= GROUP_CHAT_MAX_MESSAGES) {
            if (!roomEpochIsCurrent(group, startEpoch)) recordRoomCancellation(group, thread)
            else exitKind = 'capped'
            return
          }

          const room = getGroupRoom(group)
          const memberKey = groupMemberKey(member)
          const markKey = `${thread}::${memberKey}`
          const seen = room.watermarks[markKey] || 0
          const delta = room.log.slice(seen).filter(entry => groupThreadOf(entry) === thread)
          if (!delta.length) continue

          // #93129: a held member takes no turn — consume the delta exactly
          // once so the same entries never re-trigger the skip.
          const heldEntry = (room.holds || {})[memberKey]
          if (heldEntry) {
            const advance = heldMemberWatermarkAdvance(seen, room.log.length)
            updateGroupChat(group, r => {
              if (advance !== null) r.watermarks[markKey] = advance
              if (r.holds?.[memberKey] && !r.holds[memberKey].noted) {
                r.holds = { ...r.holds, [memberKey]: { ...r.holds[memberKey], noted: true } }
              }
              return r
            })
            if (!heldEntry.noted) {
              recordGroupActivity(group, { kind: 'held', member: member.name, thread })
            }
            continue
          }

          const prompt = buildGroupChatTurnPrompt({
            groupName: group,
            members,
            viewer: member,
            deltaLines: delta.slice(-GROUP_CHAT_HISTORY_LIMIT).map(entry => formatGroupChatLine(entry, member.name))
          })

          updateGroupChat(group, r => ({ ...r, turn: member.name }), { sync: false })
          const result = await turns.run({ group, member, prompt, thread })
          const outcome = publishTurnResult(group, member, thread, markKey, result, true)
          if (outcome.abandoned) {
            abandoned = true
            return
          }
          if (outcome.stop) return
          if (outcome.spoke) {
            posted += 1
            spokeThisRound += 1
          }
        }

        if (spokeThisRound === 0) {
          // #94478: a quiet round is not always consensus — cited members may
          // still be owed a turn. One bounded continuation round for exactly
          // those members.
          const pendingKeys = unaddressedGroupMentions(group, members, thread)
          continuations += 1

          if (pendingKeys.length && continuations <= GROUP_CHAT_MAX_CONTINUATIONS) {
            const citedMembers = members.filter(member => pendingKeys.includes(groupMemberKey(member)))
            if (citedMembers.length && posted < GROUP_CHAT_MAX_MESSAGES) {
              const stranded = getGroupRoom(group).stranded || {}
              const continuationResponders = citedMembers.filter(member => !Object.prototype.hasOwnProperty.call(stranded, groupMemberKey(member)))

              for (const member of continuationResponders) {
                if (!driveIsLive() || !roomEpochIsCurrent(group, startEpoch) || posted >= GROUP_CHAT_MAX_MESSAGES || continuations > GROUP_CHAT_MAX_CONTINUATIONS) break

                const room = getGroupRoom(group)
                const memberKey = groupMemberKey(member)
                const markKey = `${thread}::${memberKey}`
                const seen = room.watermarks[markKey] || 0
                const delta = room.log.slice(seen).filter(entry => groupThreadOf(entry) === thread)
                if (!delta.length) continue
                if ((room.holds || {})[memberKey]) continue // holds apply to continuation turns

                const prompt = buildGroupChatTurnPrompt({
                  groupName: group,
                  members,
                  viewer: member,
                  deltaLines: delta.slice(-GROUP_CHAT_HISTORY_LIMIT).map(entry => formatGroupChatLine(entry, member.name))
                })

                updateGroupChat(group, r => ({ ...r, turn: member.name }), { sync: false })
                const continuationResult = await turns.run({ group, member, prompt, thread })

                // Continuations deliberately retain their strict drive-level
                // epoch policy. Do not inherit normal-loop cross-thread acceptance.
                if (!driveIsLive() || !roomEpochIsCurrent(group, startEpoch)) return

                const outcome = publishTurnResult(group, member, thread, markKey, continuationResult, false)
                if (outcome.abandoned) {
                  abandoned = true
                  return
                }
                if (outcome.stop) return
                if (outcome.spoke) {
                  posted += 1
                  spokeThisRound += 1
                }
              }
            }
          }

          if (spokeThisRound === 0) {
            if (pendingKeys.length && (continuations > GROUP_CHAT_MAX_CONTINUATIONS || posted >= GROUP_CHAT_MAX_MESSAGES)) {
              exitKind = 'capped'
            }
            return
          }
        }
      }

      // All rounds ran with someone still speaking — the round cap ended it.
      exitKind = 'capped'
    } finally {
      if (driveIsLive() && roomEpochIsCurrent(group, startEpoch)) {
        recordGroupActivity(group, { kind: exitKind, member: null, thread })
        updateGroupChat(group, r => ({ ...r, running: false, turn: null }), { sync: false })
        // A member whose turn timed out after the final round is stranded
        // until the next send — the room reopen harvests it.
      }
    }
  }

  const startDrive = (group: string, members: EngineMember[], thread: string): void => {
    if (!driveIsLive()) return
    const driveEpoch = getGroupRoom(group).epoch || 0
    void runGroupChatRounds(group, members, thread).catch(() => {
      if (!driveIsLive() || !roomEpochIsCurrent(group, driveEpoch)) return
      updateGroupChat(group, r => ({ ...r, running: false }), { sync: false })
    })
  }

  const sendToGroupChat = (group: string, members: EngineMember[], text: string, thread?: null | string): null | string => {
    if (!driveIsLive()) return null

    const trimmed = String(text || '').trim()
    if (!trimmed || !members.length) return null

    const target = thread || mintGroupThreadId()
    // A fresh user send answers the room — clear the needs-you badge.
    $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: false })
    // Refresh the durable room roster on every send (backfills older rooms and
    // keeps the mirror complete), deduped on durable identity like the
    // desktop's durableGroupChatMembers.
    const seen = new Set<string>()
    const roster = members
      .filter(member => {
        const key = `${member.connectionId || 'legacy'}::${member.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, GROUP_CHAT_MAX_MEMBERS)
    updateGroupChat(group, room => ({ ...room, members: roster }))

    const sent = appendGroupChatEntry(group, { kind: 'user', name: 'You' }, trimmed, target)

    const wasRunning = getGroupRoom(group).running === true
    updateGroupChat(group, room => ({
      ...room,
      epoch: (room.epoch || 0) + 1,
      running: true,
      // #93129: user text is the ONLY input that changes member holds.
      holds: applyGroupHoldDirective(
        room.holds,
        parseGroupChatMentions(trimmed, members),
        trimmed,
        { at: sent?.at, byMessageId: sent?.id, thread: target },
        members.map(member => groupMemberKey(member))
      )
    }))
    recordGroupActivity(group, { kind: 'queued', member: 'You', thread: target })

    if (!wasRunning) {
      startDrive(group, members, target)
    } else {
      // A loop is live; it bails at its next boundary. Chain the fresh loop so
      // exactly one drive owns the room.
      setTimeout(() => startDrive(group, members, target), 250)
    }

    return target
  }

  const stopGroupThread = async (group: string, thread: null | string, members: EngineMember[] | null = null): Promise<void> => {
    const room = getGroupRoom(group)
    const roster = Array.isArray(members) && members.length ? members : room.members || []
    const turnName = room.turn || null

    const stamp: GroupHoldStamp = { at: Date.now(), byMessageId: null, thread: thread || null }

    updateGroupChat(group, r => {
      const holds: Record<string, GroupHoldStamp> = { ...(r.holds || {}) }
      for (const member of roster) {
        const key = groupMemberKey(member)
        if (key && !holds[key]) holds[key] = { ...stamp }
      }
      return { ...r, epoch: (r.epoch || 0) + 1, running: false, turn: null, holds }
    })

    recordGroupActivity(group, { kind: 'stopped', member: 'You', thread: thread || null })

    const onTurn = turnName ? roster.find(member => member?.name === turnName) : null
    const sessionId = onTurn ? (room.sessions || {})[groupMemberKey(onTurn)] : null

    if (onTurn && sessionId) {
      try {
        await turns.interrupt(onTurn, sessionId)
      } catch {
        /* best-effort — the epoch/hold legs already stopped the room */
      }
    }
  }

  return {
    sendToGroupChat,
    stopGroupThread,
    deactivate() {
      deactivated = true
    }
  }
}
