/**
 * One member's turn: its hidden per-group plumbing session, the submit/poll
 * loop that runs it, the pending clarify/approval prompts mirrored out of
 * it, the late-reply harvest for a turn that timed out, the per-turn drive
 * step (watermark delta, hold consumption, prompt assembly, turn indicator),
 * and that turn's room-log publication.
 *
 * Ported from the desktop Bot Mode's group-turns.ts
 * (apps/desktop/src/plugins/hermes-bots/group-turns.ts).
 *
 * The Group engine creates one captured member gateway and one terminal turn
 * module per lifecycle. The captured gateway's `connectionKey` scopes every
 * stored plumbing-session id this module sends: a room's session map is
 * consulted only while its `sessionConnectionKey` tag matches, so a Gateway
 * switch can never resume another connection's session. The module owns one
 * member's turn end to end, including publication; the round driver
 * (group-rounds.ts) owns room sequencing — rounds, caps, responder rotation,
 * the drive finalizer. Publication living here is a documented PWA divergence
 * from the desktop's group-rounds.ts, which keeps publication in its round
 * driver.
 */

import { botHandle, groupMemberKey, type EngineMember, type GroupEngineRequest, type GroupMember, type GroupMessage } from './group-model'
import {
  $groupChats,
  $groupNeedsYou,
  $groupPrompts,
  GROUP_CHAT_HISTORY_LIMIT,
  appendGroupChatEntry,
  groupSpeakerLabel,
  groupThreadOf,
  recordGroupActivity,
  updateGroupChat,
  type GroupChatRoom,
  type GroupPrompt
} from './group-store'

/** The member request adapter for one captured Gateway connection. Besides
 *  routing each member's RPC with `profile: member.name`, it carries the
 *  connection key that scoped every stored plumbing-session id it sends. */
export interface GroupMemberGateway {
  readonly connectionKey: string
  request(
    member: GroupMember,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown>
}

export function createGroupMemberGateway(transport: GroupEngineRequest, connectionKey: string): GroupMemberGateway {
  return {
    connectionKey,
    request(member, method, params = {}) {
      return transport(method, { ...params, profile: member.name })
    }
  }
}

export interface GroupTurnInput {
  roomKey: string
  member: GroupMember
  prompt: string
  thread: string
}

export type GroupTurnCancelReason =
  | 'engine-stopped'
  | 'room-stopped'
  | 'newer-user'

export type GroupTurnCommit =
  | { accepted: true }
  | { accepted: false; reason: GroupTurnCancelReason }

export type GroupTurnResult =
  | {
      kind: 'reply'
      text: string
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'pass'
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'timed-out'
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'failed'
      reason?: string
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'cancelled'
      reason: GroupTurnCancelReason
      commit: () => GroupTurnCommit
    }

export type GroupTurnPolicy = 'round' | 'continuation'

export interface GroupTurnSpec {
  roomKey: string
  thread: string
  member: EngineMember
  /** Room roster — feeds the prompt's peer list. */
  members: readonly EngineMember[]
  /** The drive's captured start epoch. 'continuation' bails on any change. */
  driveEpoch: number
  policy: GroupTurnPolicy
}

export interface GroupTurnReport {
  /** Rejected engine-stopped lease: the drive stops and skips its finalizer. */
  abandoned: boolean
  /** The member's reply was appended to the room log. */
  spoke: boolean
  /** The drive must stop: room-stopped, newer-user, invalidated operation,
   *  continuation epoch drift — and a rejected engine-stopped lease also sets
   *  it (abandoned implies stop; the driver checks abandoned first). */
  stop: boolean
}

export interface GroupTurnModule {
  /** One member's turn end to end. Never rejects for member-level failure
   *  (network error classifies as 'failed' ⇒ silent). Never claims a token
   *  when it returns a no-op outcome. */
  takeTurn(spec: GroupTurnSpec): Promise<GroupTurnReport>
  harvest(roomKey: string, member: GroupMember): Promise<void>
  /** Harvest every member holding a stranded marker (engine facade: room open). */
  harvestRoom(roomKey: string, members: readonly GroupMember[]): Promise<void>
  answer(
    entry: GroupPrompt,
    member: GroupMember,
    answers: Record<string, string> | string | undefined
  ): Promise<void>
  interrupt(roomKey: string, member: GroupMember): Promise<void>
  stop(): void
  /** Internal test seam: the raw capture/lease machinery. The driver and the
   *  facade never call it; only this module's tests do. */
  run(input: GroupTurnInput): Promise<GroupTurnResult>
}

function roomOf(roomKey: string): GroupChatRoom {
  return (
    $groupChats.get()[roomKey] || {
      name: roomKey,
      log: [],
      watermarks: {},
      epoch: 0,
      running: false
    }
  )
}

/** "(pass)" (loosely: pass / (pass) / pass.) or empty = the member stayed silent. */
export function isGroupPassText(text: unknown): boolean {
  const trimmed = String(text || '').trim()
  if (!trimmed) return true
  return /^\(?\s*pass\s*\)?\.?$/i.test(trimmed)
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
  members: readonly EngineMember[]
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

/** A held member's skip must consume its delta exactly once — advance the
 *  watermark past the current log. Null = nothing to consume. */
export function heldMemberWatermarkAdvance(seen: number | undefined, logLength: number): null | number {
  return logLength > (seen || 0) ? logLength : null
}

/** One transcript entry in a `session.resume` snapshot, as the turn harvester
 * reads it — the session's own message shape, not the plugin's GroupMessage.
 * `content` is a plain string on most providers and a part array on the rest. */
interface GroupTurnTranscriptMessage {
  content?: string | Array<string | { text?: string }>
  role?: string
  text?: string
}

/** #94376: pick the reply a finished turn should surface among the messages
 * appended since `before`. Scans newest-first and prefers the last
 * substantive (non-pass) assistant answer over a trailing pass. When only
 * pass text exists in range, returns the newest one. Returns null only when
 * no assistant message appears in that range. */
export function pickGroupTurnReply(messages: GroupTurnTranscriptMessage[], before: number): null | string {
  let passText: null | string = null

  for (let i = messages.length - 1; i >= before; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue

    const text =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('')
          : msg?.text || ''

    const replyText = String(text).trim()

    if (isGroupPassText(replyText)) {
      if (passText === null) passText = replyText
      continue
    }

    return replyText
  }

  return passText
}

/** A clarify question blocking inside a member's session, as `session.resume`
 * reports it. Older backends omit the field entirely. */
interface GroupPendingClarify {
  choices?: string[]
  multi_select?: unknown
  question?: unknown
  questions?: Array<Record<string, unknown>>
  request_id?: string
}

/** A command approval blocking inside a member's session, same wire as the
 * 1:1 approval card. */
interface GroupPendingApproval {
  choices?: string[]
  command?: unknown
  description?: unknown
  request_id?: string
}

/** The `session.resume` fields the room engine reads off a member's hidden
 * per-group session. */
interface GroupSessionSnapshot {
  inflight?: boolean
  message_count?: number
  messages?: GroupTurnTranscriptMessage[]
  pending_approval?: GroupPendingApproval
  pending_clarify?: GroupPendingClarify
  running?: boolean
  session_id?: string
  session_key?: string
}

/** 4001-class "the runtime session was reaped" failure. Distinct from 4007
 * ("genuinely never existed"), which must keep flowing to session.create. */
export function isSessionGoneError(error: GatewayErrorLike | null | undefined): boolean {
  if (!error || error.code === 4007) return false
  if (error.code === 4001) return true
  const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : ''
  return message.includes('not in memory') || /session not found/i.test(message)
}

interface GatewayErrorLike {
  code?: number
  data?: { reason?: unknown }
  message?: unknown
}

const GROUP_TURN_TIMEOUT_MS = 180000
const GROUP_TURN_POLL_MS = 2000
const GROUP_TURN_HARD_CAP_MS = 20 * 60000

class TurnStoppedError extends Error {
  constructor() {
    super('Group turn module stopped.')
    this.name = 'TurnStoppedError'
  }
}

interface TurnCapture {
  anchorId: null | string
  epoch: number
  roomKey: string
  member: GroupMember
  memberKey: string
  promptRequestId: null | string
  thread: string
  token: number
}

function failureReason(error: unknown): string | undefined {
  const reason = (error as { data?: { reason?: unknown } } | null | undefined)?.data?.reason
  const normalized = typeof reason === 'string' ? reason.trim() : ''
  return normalized || undefined
}

function hasPendingPrompt(state: GroupSessionSnapshot | null): boolean {
  const clarify = state?.pending_clarify
  const approval = state?.pending_approval
  return Boolean(
    (clarify && typeof clarify === 'object' && clarify.request_id) ||
    (approval && typeof approval === 'object' && approval.request_id)
  )
}

/** Mirror a member's pending clarify/approval prompt into the runtime atoms.
 *  The card records the connection whose member session produced it, so a
 *  connection switch can drop it instead of answering on the wrong Gateway. */
function syncGroupClarify(
  roomKey: string,
  member: GroupMember,
  state: GroupSessionSnapshot | null,
  expectedRequestId: null | string | undefined = undefined,
  connectionKey = ''
): boolean {
  const key = `${roomKey}::${groupMemberKey(member)}`
  const clarify = state && typeof state.pending_clarify === 'object' ? state.pending_clarify : null
  const approval = (state && typeof state.pending_approval === 'object' ? state.pending_approval : null) as GroupPendingApproval

  const pending = clarify || approval
  const requestId = pending?.request_id || null
  const all = $groupPrompts.get()
  const current = all[key]

  if (!requestId) {
    // A poll may be older than a newer request already mirrored for this
    // member. Only clear the request this operation actually observed.
    if (current && expectedRequestId !== undefined && current.requestId === expectedRequestId) {
      const next = { ...all }
      delete next[key]
      $groupPrompts.set(next)
    }
    return false
  }

  // Same request already mirrored — keep the object identity so the card
  // doesn't lose its draft to a re-render.
  if (current?.requestId === requestId) return true

  const base = {
    requestId,
    roomKey,
    connectionKey,
    member: member.name,
    memberKey: groupMemberKey(member),
    // approval.respond keys on the session, not just the request — carry the
    // runtime id the snapshot came from.
    sessionId: state?.session_id || null,
    at: Date.now()
  }

  $groupPrompts.set({
    ...all,
    [key]: clarify
      ? {
          ...base,
          kind: 'clarify' as const,
          question: typeof clarify.question === 'string' ? clarify.question : '',
          choices: Array.isArray(clarify.choices) ? clarify.choices.filter(c => typeof c === 'string' && c) : [],
          multiSelect: Boolean(clarify.multi_select),
          // Batch clarifies carry `questions`; the room card answers them
          // one wire call per question, mirroring the 1:1 batch contract.
          questions: Array.isArray(clarify.questions) ? clarify.questions : null
        }
      : {
          ...base,
          kind: 'approval' as const,
          question: typeof approval.description === 'string' ? approval.description : '',
          command: typeof approval.command === 'string' ? approval.command : '',
          // The server precomputes the choice set from allow_permanent
          // (once/session/always/deny); fall back to the minimal pair.
          choices:
            Array.isArray(approval.choices) && approval.choices.length
              ? approval.choices.filter(c => typeof c === 'string' && c)
              : ['once', 'deny'],
          multiSelect: false,
          questions: null
        }
  })
  // A blocked member is a question for the human — badge the room.
  $groupNeedsYou.set({ ...$groupNeedsYou.get(), [roomKey]: true })

  return true
}

export function createGroupTurnModule(gateway: GroupMemberGateway): GroupTurnModule {
  let stopped = false
  let nextToken = 0
  const latestTokens = new Map<string, number>()
  const markerVersions = new Map<string, number>()

  const operationKey = (roomKey: string, member: GroupMember) => `${roomKey}::${groupMemberKey(member)}`

  /** The one owner of the per-member watermark key format. */
  const watermarkKey = (thread: string, memberKey: string): string => `${thread}::${memberKey}`

  /** The one owner of stored-id eligibility: a room's session map is usable
   *  only while it is tagged with this lifecycle's captured connection key.
   *  A mismatched or untagged map is invisible here — the caller resumes by
   *  the room title instead. */
  const scopedStoredSessionId = (room: GroupChatRoom, memberKey: string): string | undefined => {
    if (room.sessionConnectionKey !== gateway.connectionKey) return undefined
    const stored = room.sessions?.[memberKey]
    return typeof stored === 'string' && stored ? stored : undefined
  }

  const claimToken = (roomKey: string, member: GroupMember): number => {
    const token = ++nextToken
    latestTokens.set(operationKey(roomKey, member), token)
    return token
  }

  const owns = (capture: TurnCapture): boolean =>
    !stopped && latestTokens.get(operationKey(capture.roomKey, capture.member)) === capture.token

  const live = (): boolean => !stopped

  const captureTurn = (input: GroupTurnInput): TurnCapture => {
    const room = roomOf(input.roomKey)
    const last = room.log[room.log.length - 1]
    const anchorId = typeof last?.id === 'string' && last.id ? last.id : null
    return {
      anchorId,
      epoch: room.epoch || 0,
      roomKey: input.roomKey,
      member: input.member,
      memberKey: groupMemberKey(input.member),
      promptRequestId: null,
      thread: input.thread,
      token: claimToken(input.roomKey, input.member)
    }
  }

  const staleReason = (capture: TurnCapture): GroupTurnCancelReason | null => {
    if (stopped) return 'engine-stopped'

    const room = roomOf(capture.roomKey)
    if ((room.epoch || 0) === capture.epoch) return null

    const anchorIndex = capture.anchorId === null
      ? -1
      : room.log.findIndex(entry => entry.id === capture.anchorId)
    const tail = anchorIndex >= 0 ? room.log.slice(anchorIndex + 1) : room.log
    const newerUser = tail.some(entry => entry.from?.kind === 'user' && groupThreadOf(entry) === capture.thread)

    if (newerUser) return 'newer-user'
    if (room.holds?.[capture.memberKey]) return 'room-stopped'
    return null
  }

  const commitFor = (capture: TurnCapture): (() => GroupTurnCommit) => {
    let decided: GroupTurnCommit | null = null
    return () => {
      if (decided) return decided
      const reason = staleReason(capture) || (!owns(capture) ? 'engine-stopped' : null)
      decided = reason ? { accepted: false, reason } : { accepted: true }
      return decided
    }
  }

  const cancelled = (capture: TurnCapture, reason: GroupTurnCancelReason): GroupTurnResult => ({
    kind: 'cancelled',
    reason,
    commit: commitFor(capture)
  })

  const failed = (capture: TurnCapture, error: unknown): GroupTurnResult => {
    const reason = failureReason(error)
    return {
      kind: 'failed',
      ...(reason ? { reason } : {}),
      commit: commitFor(capture)
    }
  }

  const memberRequest = async (
    capture: TurnCapture,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> => {
    // Token loss does not abort the handed-off promise, but it must prevent
    // this operation from starting a recovery, poll, or follow-up request.
    if (!owns(capture)) throw new TurnStoppedError()
    try {
      const result = await gateway.request(capture.member, method, params)
      if (!owns(capture)) throw new TurnStoppedError()
      return result
    } catch (error) {
      // A rejected request has no post-await success path, so check ownership
      // here as well before callers classify 4007/4001 or retry the request.
      if (!owns(capture)) throw new TurnStoppedError()
      throw error
    }
  }

  const ensureGroupChatSession = async (capture: TurnCapture): Promise<GroupMemberSessionHandle> => {
    const room = roomOf(capture.roomKey)
    // Session title keeps the display name (never the durable key — the
    // desktop addresses plumbing sessions as `Group: <name>`); for an
    // id-keyed room the durable id IS the desktop's title, so roomId wins.
    const title = `Group: ${room.roomId || room.name}`
    const known = scopedStoredSessionId(room, capture.memberKey)

    for (const target of [known, title]) {
      if (!target) continue

      try {
        const res = (await memberRequest(capture, 'session.resume', {
          session_id: target,
          omit_messages: true
        })) as GroupSessionSnapshot

        if (res?.session_id) {
          const stored = res.session_key || known || null
          if (owns(capture)) {
            // Tag the room's session provenance with the connection that
            // acquired this runtime session, even when the Gateway returned no
            // stored id — the tag scopes the room's whole session map.
            updateGroupChat(capture.roomKey, (current: GroupChatRoom) => {
              current.sessionConnectionKey = gateway.connectionKey
              if (stored) current.sessions = { ...(current.sessions || {}), [capture.memberKey]: stored }
              return current
            })
          }
          return { runtime: res.session_id, stored }
        }
      } catch (error: unknown) {
        if (error instanceof TurnStoppedError) throw error
        if ((error as { code?: number })?.code !== 4007) {
          const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
          throw new Error(`Could not check ${capture.member?.name || 'member'}'s group session${detail} — not starting a new one`)
        }
        /* genuinely doesn't exist (4007) — try the next target / fall through to create */
      }
    }

    const created = (await memberRequest(capture, 'session.create', {
      title,
      // Room member sessions are plumbing — always hidden from the sidebar.
      hidden: true,
      // Explicit contracts (desktop PR #97008): room plumbing sessions always
      // rebuild from the member profile's CURRENT config on resume, never a
      // stale stored model/provider pin. Older gateways ignore the params.
      room_plumbing: true,
      follow_profile_config: true
    })) as { session_id?: string; stored_session_id?: string }

    const runtime = created?.session_id || null
    const stored = created?.stored_session_id || null
    if (runtime && owns(capture)) {
      // Same tagging rule as a resumed session: the creating connection now
      // owns the room's session map, stored id or not.
      updateGroupChat(capture.roomKey, (r: GroupChatRoom) => {
        r.sessionConnectionKey = gateway.connectionKey
        if (stored) r.sessions = { ...(r.sessions || {}), [capture.memberKey]: stored }
        return r
      })
    }

    return { runtime, stored }
  }

  const submitGroupTurnPrompt = async (
    capture: TurnCapture,
    runtime: string,
    stored: null | string | undefined,
    text: string
  ): Promise<string> => {
    try {
      await memberRequest(capture, 'prompt.submit', { session_id: runtime, text })
      return runtime
    } catch (error: unknown) {
      if (error instanceof TurnStoppedError) throw error
      if (!isSessionGoneError(error as GatewayErrorLike) || !stored) throw error

      const res = (await memberRequest(capture, 'session.resume', {
        session_id: stored,
        omit_messages: true
      })) as GroupSessionSnapshot
      const fresh = res?.session_id
      if (!fresh) throw error

      // The recovery resume itself can outlive an explicit room stop. Do not
      // retry the prompt into an interrupted room; the caller classifies this
      // rejection through the same stale-result policy as the original submit.
      const staleAfterRecovery = staleReason(capture)
      if (staleAfterRecovery) throw new Error(`Group turn became stale: ${staleAfterRecovery}`)

      await memberRequest(capture, 'prompt.submit', { session_id: fresh, text })
      return fresh
    }
  }

  const run = async (input: GroupTurnInput): Promise<GroupTurnResult> => {
    const capture = captureTurn(input)

    if (stopped) return cancelled(capture, 'engine-stopped')

    let session: GroupMemberSessionHandle
    try {
      session = await ensureGroupChatSession(capture)
    } catch (error: unknown) {
      if (error instanceof TurnStoppedError) return cancelled(capture, 'engine-stopped')
      const stale = staleReason(capture)
      return stale ? cancelled(capture, stale) : failed(capture, error)
    }

    const staleAfterSession = staleReason(capture)
    if (staleAfterSession) return cancelled(capture, staleAfterSession)
    if (!session.runtime) return { kind: 'pass', commit: commitFor(capture) }

    if (owns(capture)) {
      recordGroupActivity(input.roomKey, { kind: 'working', member: input.member.name, thread: input.thread })
    }

    let before = 0
    try {
      const pre = (await memberRequest(capture, 'session.resume', {
        session_id: session.stored || session.runtime
      })) as GroupSessionSnapshot
      before = Array.isArray(pre?.messages) ? pre.messages.length : pre?.message_count || 0
    } catch (error: unknown) {
      if (error instanceof TurnStoppedError) return cancelled(capture, 'engine-stopped')
      /* lazy session — zero messages */
    }

    const staleAfterBaseline = staleReason(capture)
    if (staleAfterBaseline) return cancelled(capture, staleAfterBaseline)

    let liveRuntime: string
    try {
      liveRuntime = await submitGroupTurnPrompt(capture, session.runtime, session.stored, input.prompt)
    } catch (error: unknown) {
      if (error instanceof TurnStoppedError) return cancelled(capture, 'engine-stopped')
      const stale = staleReason(capture)
      return stale ? cancelled(capture, stale) : failed(capture, error)
    }

    const staleAfterSubmit = staleReason(capture)
    if (staleAfterSubmit) return cancelled(capture, staleAfterSubmit)

    const started = Date.now()
    let deadline = started + GROUP_TURN_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, GROUP_TURN_POLL_MS))

      if (!owns(capture)) return cancelled(capture, 'engine-stopped')
      const staleBeforePoll = staleReason(capture)
      if (staleBeforePoll) return cancelled(capture, staleBeforePoll)

      let state: GroupSessionSnapshot | null = null
      try {
        state = (await memberRequest(capture, 'session.resume', {
          session_id: session.stored || liveRuntime
        })) as GroupSessionSnapshot
      } catch (error: unknown) {
        if (error instanceof TurnStoppedError) return cancelled(capture, 'engine-stopped')
        continue
      }

      if (!owns(capture)) return cancelled(capture, 'engine-stopped')
      const staleAfterPoll = staleReason(capture)
      if (staleAfterPoll) return cancelled(capture, staleAfterPoll)

      const messages = Array.isArray(state?.messages) ? state.messages : []
      const busy = Boolean(state?.inflight || state?.running)
      const awaitingUser = hasPendingPrompt(state)
      if (owns(capture)) {
        const expectedPromptId = capture.promptRequestId
        syncGroupClarify(input.roomKey, input.member, state, expectedPromptId, gateway.connectionKey)
        const currentPrompt = $groupPrompts.get()[`${input.roomKey}::${capture.memberKey}`]
        if (awaitingUser || !currentPrompt || currentPrompt.requestId === expectedPromptId) {
          capture.promptRequestId = currentPrompt?.requestId || null
        }
      }
      const done = !busy && !awaitingUser

      if (messages.length > before && done) {
        const replyText = pickGroupTurnReply(messages, before)
        if (replyText !== null && !isGroupPassText(replyText)) {
          return { kind: 'reply', text: replyText, commit: commitFor(capture) }
        }
        return { kind: 'pass', commit: commitFor(capture) }
      }

      // Still visibly working — or waiting on the user's answer: extend the
      // deadline (never past the hard cap).
      if (busy || awaitingUser) {
        deadline = Math.min(started + GROUP_TURN_HARD_CAP_MS, Math.max(deadline, Date.now() + GROUP_TURN_TIMEOUT_MS))
      }
    }

    if (!owns(capture)) return cancelled(capture, 'engine-stopped')
    const staleAtTimeout = staleReason(capture)
    if (staleAtTimeout) return cancelled(capture, staleAtTimeout)

    syncGroupClarify(input.roomKey, input.member, null, capture.promptRequestId, gateway.connectionKey)
    updateGroupChat(input.roomKey, (r: GroupChatRoom) => {
      r.stranded = {
        ...(r.stranded || {}),
        [capture.memberKey]: { before, thread: input.thread }
      }
      markerVersions.set(operationKey(input.roomKey, input.member), capture.token)
      return r
    })

    return { kind: 'timed-out', commit: commitFor(capture) }
  }

  /** Publish one typed turn result. The lease classification is authoritative:
   * a room stop consumes the current member delta without appending, a newer
   * same-thread send records only supersession, and an engine stop abandons the
   * drive without running its finalizer. */
  const publishTurn = (
    roomKey: string,
    member: EngineMember,
    thread: string,
    markKey: string,
    result: GroupTurnResult,
    includeFailureReason: boolean
  ): GroupTurnReport => {
    const lease = result.commit()

    if (!lease.accepted) {
      if (lease.reason === 'room-stopped') {
        updateGroupChat(roomKey, r => {
          r.watermarks[markKey] = r.log.length
          return r
        }, { sync: false })
        return { abandoned: false, spoke: false, stop: true }
      }
      if (lease.reason === 'newer-user') {
        recordGroupActivity(roomKey, { kind: 'cancelled', member: member.name, thread })
        return { abandoned: false, spoke: false, stop: true }
      }
      return { abandoned: true, spoke: false, stop: true }
    }

    if (result.kind === 'cancelled') {
      if (result.reason === 'room-stopped') {
        updateGroupChat(roomKey, r => {
          r.watermarks[markKey] = r.log.length
          return r
        }, { sync: false })
        return { abandoned: false, spoke: false, stop: true }
      }
      if (result.reason === 'newer-user') {
        recordGroupActivity(roomKey, { kind: 'cancelled', member: member.name, thread })
        return { abandoned: false, spoke: false, stop: true }
      }
      // A live module can invalidate one operation when a newer operation claims
      // its token. That cancellation is a no-op, not a lifecycle abandonment;
      // only a rejected engine-stopped lease suppresses the drive finalizer.
      return { abandoned: false, spoke: false, stop: true }
    }

    if (result.kind === 'reply') {
      recordGroupActivity(roomKey, { kind: 'replied', member: member.name, thread })
    } else if (result.kind === 'pass') {
      recordGroupActivity(roomKey, { kind: 'passed', member: member.name, thread })
    } else if (result.kind === 'timed-out') {
      recordGroupActivity(roomKey, { kind: 'timed-out', member: member.name, thread })
    } else if (result.kind === 'failed') {
      const reason = includeFailureReason ? result.reason : undefined
      recordGroupActivity(roomKey, { kind: 'failed', member: member.name, thread, ...(reason ? { reason } : {}) })
    }

    updateGroupChat(roomKey, r => {
      r.watermarks[markKey] = r.log.length
      return r
    }, { sync: false })

    if (result.kind !== 'reply') return { abandoned: false, spoke: false, stop: false }

    appendGroupChatEntry(roomKey, {
      kind: 'member',
      name: member.name,
      ...(member.connectionLabel || member.sourceScoped ? { source: member.connectionLabel || member.connectionId } : {})
    }, result.text, thread)
    updateGroupChat(roomKey, r => {
      r.watermarks[markKey] = r.log.length
      return r
    }, { sync: false })
    return { abandoned: false, spoke: true, stop: false }
  }

  /** One member's turn end to end: the drive step the round driver used to
   *  copy-paste into both of its loops, plus that turn's publication. */
  const takeTurn = async (spec: GroupTurnSpec): Promise<GroupTurnReport> => {
    const room = roomOf(spec.roomKey)
    const memberKey = groupMemberKey(spec.member)

    // A member with a standing stranded marker takes no new turn. Checked
    // before any token claim, so the refusal never invalidates an in-flight
    // harvest. (The driver's per-loop pre-filters moved here: one invariant,
    // one owner. A legacy numeric marker 0 is a valid marker.)
    if (room.stranded && Object.prototype.hasOwnProperty.call(room.stranded, memberKey)) {
      return { abandoned: false, spoke: false, stop: false }
    }

    const markKey = watermarkKey(spec.thread, memberKey)
    const seen = room.watermarks[markKey] || 0
    const delta = room.log.slice(seen).filter(entry => groupThreadOf(entry) === spec.thread)
    if (!delta.length) return { abandoned: false, spoke: false, stop: false }

    // #93129: a held member takes no turn — consume the delta exactly once so
    // the same entries never re-trigger the skip. Continuations skip silently
    // without consuming (group-rounds.ts:489).
    const heldEntry = (room.holds || {})[memberKey]
    if (heldEntry) {
      if (spec.policy === 'round') {
        const advance = heldMemberWatermarkAdvance(seen, room.log.length)
        updateGroupChat(spec.roomKey, r => {
          if (advance !== null) r.watermarks[markKey] = advance
          if (r.holds?.[memberKey] && !r.holds[memberKey].noted) {
            r.holds = { ...r.holds, [memberKey]: { ...r.holds[memberKey], noted: true } }
          }
          return r
        })
        if (!heldEntry.noted) {
          recordGroupActivity(spec.roomKey, { kind: 'held', member: spec.member.name, thread: spec.thread })
        }
      }
      return { abandoned: false, spoke: false, stop: false }
    }

    const prompt = buildGroupChatTurnPrompt({
      // The prompt header is model-visible (the desktop prompt carries the
      // display name) — it must never be the durable key.
      groupName: room.name,
      members: spec.members,
      viewer: spec.member,
      deltaLines: delta.slice(-GROUP_CHAT_HISTORY_LIMIT).map(entry => formatGroupChatLine(entry, spec.member.name))
    })

    updateGroupChat(spec.roomKey, r => ({ ...r, turn: memberKey }), { sync: false })
    const result = await run({ roomKey: spec.roomKey, member: spec.member, prompt, thread: spec.thread })

    // Continuations deliberately retain their strict drive-level epoch policy.
    // Do not inherit normal-loop cross-thread acceptance: bail before the lease
    // is committed (group-rounds.ts:503). The driveIsLive() half of the old
    // driver-side bail is unreachable in flight: stopGroupEngine deactivates
    // the driver, stops the turn module, and bumps every room epoch
    // synchronously — no interleaving point — so this epoch check catches it;
    // in-loop abandonment returns immediately and can never be observed here.
    if (spec.policy === 'continuation' && (roomOf(spec.roomKey).epoch || 0) !== spec.driveEpoch) {
      return { abandoned: false, spoke: false, stop: true }
    }

    return publishTurn(spec.roomKey, spec.member, spec.thread, markKey, result, spec.policy === 'round')
  }

  const markerIsCurrent = (
    roomKey: string,
    member: GroupMember,
    marker: number | { before: number; thread?: string },
    markerVersion: number
  ): boolean => {
    const current = roomOf(roomKey).stranded?.[groupMemberKey(member)]
    if (current !== marker) {
      if (typeof marker !== 'number' || current !== marker) return false
    }
    return (markerVersions.get(operationKey(roomKey, member)) || 0) === markerVersion
  }

  const harvest = async (roomKey: string, member: GroupMember): Promise<void> => {
    if (!live()) return

    const memberKey = groupMemberKey(member)
    const room = roomOf(roomKey)
    const marker = room.stranded?.[memberKey]
    const strandedBefore = typeof marker === 'number' ? marker : marker?.before
    const strandedThread = (typeof marker === 'object' && marker?.thread) || 'legacy'
    if (typeof strandedBefore !== 'number' || marker === undefined) return

    const token = claimToken(roomKey, member)
    const markerVersion = markerVersions.get(operationKey(roomKey, member)) || 0
    const promptKey = `${roomKey}::${memberKey}`
    const observedPromptId = $groupPrompts.get()[promptKey]?.requestId || null
    const capture: TurnCapture = {
      anchorId: null,
      epoch: room.epoch || 0,
      roomKey,
      member,
      memberKey,
      promptRequestId: observedPromptId,
      thread: strandedThread,
      token
    }

    const ownsMarker = () =>
      live() && owns(capture) && markerIsCurrent(roomKey, member, marker, markerVersion)

    let state: GroupSessionSnapshot | null = null
    try {
      // Harvest reads a stored id only under a matching connection tag; with
      // none, the room title is the only eligible target.
      state = (await memberRequest(capture, 'session.resume', {
        session_id: scopedStoredSessionId(room, memberKey) || `Group: ${room.roomId || room.name}`
      })) as GroupSessionSnapshot
    } catch {
      return // source unreachable — leave the marker for the next boundary
    }

    if (!ownsMarker()) return
    if (state?.inflight || state?.running) return

    // A stranded member blocked on a clarify is not "grinding" — surface the
    // question card (#90694) and keep the marker until it resolves.
    if (ownsMarker()) {
      const pending = syncGroupClarify(roomKey, member, state, capture.promptRequestId, gateway.connectionKey)
      const currentPrompt = $groupPrompts.get()[promptKey]
      if (pending) {
        capture.promptRequestId = currentPrompt?.requestId || null
        return
      }
      // A different request appeared while this harvest was reading. Leave
      // both it and the stranded marker for the newer owner; only the request
      // observed before the await may be cleared by this harvest.
      if (currentPrompt && currentPrompt.requestId !== capture.promptRequestId) return
    }
    if (!ownsMarker()) return

    // Done (or dead): consume the marker either way.
    updateGroupChat(roomKey, (r: GroupChatRoom) => {
      const next = { ...(r.stranded || {}) }
      delete next[memberKey]
      r.stranded = next
      return r
    })
    markerVersions.delete(operationKey(roomKey, member))

    const messages = Array.isArray(state?.messages) ? state.messages : []
    if (messages.length <= strandedBefore) return

    const reply = pickGroupTurnReply(messages, strandedBefore)
    if (reply && !isGroupPassText(reply) && live() && owns(capture)) {
      recordGroupActivity(roomKey, { kind: 'delivered', member: member.name, thread: strandedThread })
      // The ownership check and the append are synchronous, so an older
      // harvest cannot yield between them and publish after a newer operation.
      appendGroupChatEntry(
        roomKey,
        {
          kind: 'member',
          name: member.name,
          ...(member.connectionLabel || member.sourceScoped
            ? { source: member.connectionLabel || member.connectionId }
            : {})
        },
        reply,
        strandedThread
      )
      updateGroupChat(
        roomKey,
        (r: GroupChatRoom) => {
          r.watermarks[watermarkKey(strandedThread, memberKey)] = r.log.length
          return r
        },
        { sync: false }
      )
    }
  }

  /** Harvest every member holding a stranded marker (engine facade: room
   *  open). The module owns the stranded-marker invariant, so the facade no
   *  longer reads the marker shape to decide whom to harvest. */
  const harvestRoom = async (roomKey: string, members: readonly GroupMember[]): Promise<void> => {
    for (const member of members) {
      const room = roomOf(roomKey)
      if (room.stranded && Object.prototype.hasOwnProperty.call(room.stranded, groupMemberKey(member))) {
        await harvest(roomKey, member)
      }
    }
  }

  const answer = async (
    entry: GroupPrompt,
    member: GroupMember,
    answers: Record<string, string> | string | undefined
  ): Promise<void> => {
    if (!live()) return
    // A card produced by another connection's lifecycle can never be answered
    // here: its request id and runtime session id belong to that Gateway.
    if (entry.connectionKey !== gateway.connectionKey) return

    const send = async (method: string, params: Record<string, unknown>): Promise<boolean> => {
      if (!live()) return false
      try {
        await gateway.request(member, method, params)
      } catch (error) {
        if (!live()) return false
        throw error
      }
      return live()
    }

    if (entry.kind === 'approval') {
      if (!await send('approval.respond', {
        session_id: entry.sessionId || undefined,
        request_id: entry.requestId,
        choice: typeof answers === 'string' && answers ? answers : 'deny'
      })) return
    } else if (entry.questions && entry.questions.length) {
      for (const question of entry.questions) {
        const qid = String((question as { qid?: string; id?: string })?.qid ?? (question as { id?: string })?.id)
        if (!await send('clarify.respond', {
          request_id: entry.requestId,
          question_id: qid,
          answer: (answers as Record<string, string>)?.[qid] ?? ''
        })) return
      }
    } else {
      if (!await send('clarify.respond', {
        request_id: entry.requestId,
        answer: typeof answers === 'string' ? answers : ''
      })) return
    }

    if (!live()) return
    const key = `${entry.roomKey}::${entry.memberKey}`
    const all = $groupPrompts.get()
    if (all[key]?.requestId === entry.requestId) {
      const next = { ...all }
      delete next[key]
      $groupPrompts.set(next)
    }
  }

  /** Best-effort remote interrupt of the current speaker's session. The
   *  module resolves the stored id itself and only for the captured
   *  connection: a mismatched or absent tag sends no wire request, leaving
   *  the driver's local stop state as the only leg. */
  const interrupt = async (roomKey: string, member: GroupMember): Promise<void> => {
    if (!live()) return
    const storedSessionId = scopedStoredSessionId(roomOf(roomKey), groupMemberKey(member))
    if (!storedSessionId) return
    await gateway.request(member, 'session.interrupt', { session_id: storedSessionId })
  }

  return {
    run,
    takeTurn,
    harvest,
    harvestRoom,
    answer,
    interrupt,
    stop() {
      stopped = true
    }
  }
}

interface GroupMemberSessionHandle {
  runtime: null | string
  stored?: null | string
}
