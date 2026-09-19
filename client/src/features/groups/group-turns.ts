/**
 * One member's turn: its hidden per-group plumbing session, the submit/poll
 * loop that runs it, the pending clarify/approval prompts mirrored out of
 * it, and the late-reply harvest for a turn that timed out.
 *
 * Ported from the desktop Bot Mode's group-turns.ts
 * (apps/desktop/src/plugins/hermes-bots/group-turns.ts). Room-level
 * sequencing lives in group-rounds.ts, which drives this module.
 *
 * The Group engine creates one captured member gateway and one terminal turn
 * module per lifecycle. The module owns member-session behavior and stale
 * operation policy; the round driver owns room-log publication.
 */

import type { GroupMember } from './group-model'
import {
  $groupPrompts,
  recordGroupActivity,
  type GroupEngineRequest,
  type GroupPrompt
} from './group-runtime'
import {
  $groupChats,
  $groupNeedsYou,
  appendGroupChatEntry,
  groupMemberKey,
  groupThreadOf,
  updateGroupChat,
  type GroupChatRoom
} from './group-store'

export interface GroupMemberGateway {
  request(
    member: GroupMember,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown>
}

export function createGroupMemberGateway(transport: GroupEngineRequest): GroupMemberGateway {
  return {
    request(member, method, params = {}) {
      return transport(method, { ...params, profile: member.name })
    }
  }
}

export interface GroupTurnInput {
  group: string
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

export interface GroupTurnModule {
  run(input: GroupTurnInput): Promise<GroupTurnResult>
  harvest(group: string, member: GroupMember): Promise<void>
  answer(
    entry: GroupPrompt,
    member: GroupMember,
    answers: Record<string, string> | string | undefined
  ): Promise<void>
  interrupt(member: GroupMember, storedSessionId: string): Promise<void>
  stop(): void
}

function roomOf(group: string): GroupChatRoom {
  return (
    $groupChats.get()[group] || {
      name: group,
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
  group: string
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

/** Mirror a member's pending clarify/approval prompt into the runtime atoms. */
function syncGroupClarify(
  group: string,
  member: GroupMember,
  state: GroupSessionSnapshot | null,
  expectedRequestId: null | string | undefined = undefined
): boolean {
  const key = `${group}::${groupMemberKey(member)}`
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
    group,
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
  $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: true })

  return true
}

export function createGroupTurnModule(gateway: GroupMemberGateway): GroupTurnModule {
  let stopped = false
  let nextToken = 0
  const latestTokens = new Map<string, number>()
  const markerVersions = new Map<string, number>()

  const operationKey = (group: string, member: GroupMember) => `${group}::${groupMemberKey(member)}`

  const claimToken = (group: string, member: GroupMember): number => {
    const token = ++nextToken
    latestTokens.set(operationKey(group, member), token)
    return token
  }

  const owns = (capture: TurnCapture): boolean =>
    !stopped && latestTokens.get(operationKey(capture.group, capture.member)) === capture.token

  const live = (): boolean => !stopped

  const captureTurn = (input: GroupTurnInput): TurnCapture => {
    const room = roomOf(input.group)
    const last = room.log[room.log.length - 1]
    const anchorId = typeof last?.id === 'string' && last.id ? last.id : null
    return {
      anchorId,
      epoch: room.epoch || 0,
      group: input.group,
      member: input.member,
      memberKey: groupMemberKey(input.member),
      promptRequestId: null,
      thread: input.thread,
      token: claimToken(input.group, input.member)
    }
  }

  const staleReason = (capture: TurnCapture): GroupTurnCancelReason | null => {
    if (stopped) return 'engine-stopped'

    const room = roomOf(capture.group)
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
    const room = roomOf(capture.group)
    const title = `Group: ${room.roomId || capture.group}`
    const known = room.sessions?.[capture.memberKey]

    for (const target of [known, title]) {
      if (!target) continue

      try {
        const res = (await memberRequest(capture, 'session.resume', {
          session_id: target,
          omit_messages: true
        })) as GroupSessionSnapshot

        if (res?.session_id) {
          const stored = res.session_key || known || null
          if (stored && owns(capture)) {
            updateGroupChat(capture.group, (current: GroupChatRoom) => {
              current.sessions = { ...(current.sessions || {}), [capture.memberKey]: stored }
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

    const stored = created?.stored_session_id || null
    if (stored && owns(capture)) {
      updateGroupChat(capture.group, (r: GroupChatRoom) => {
        r.sessions = { ...(r.sessions || {}), [capture.memberKey]: stored }
        return r
      })
    }

    return { runtime: created?.session_id || null, stored }
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
      recordGroupActivity(input.group, { kind: 'working', member: input.member.name, thread: input.thread })
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
        syncGroupClarify(input.group, input.member, state, expectedPromptId)
        const currentPrompt = $groupPrompts.get()[`${input.group}::${capture.memberKey}`]
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

    syncGroupClarify(input.group, input.member, null, capture.promptRequestId)
    updateGroupChat(input.group, (r: GroupChatRoom) => {
      r.stranded = {
        ...(r.stranded || {}),
        [capture.memberKey]: { before, thread: input.thread }
      }
      markerVersions.set(operationKey(input.group, input.member), capture.token)
      return r
    })

    return { kind: 'timed-out', commit: commitFor(capture) }
  }

  const markerIsCurrent = (
    group: string,
    member: GroupMember,
    marker: number | { before: number; thread?: string },
    markerVersion: number
  ): boolean => {
    const current = roomOf(group).stranded?.[groupMemberKey(member)]
    if (current !== marker) {
      if (typeof marker !== 'number' || current !== marker) return false
    }
    return (markerVersions.get(operationKey(group, member)) || 0) === markerVersion
  }

  const harvest = async (group: string, member: GroupMember): Promise<void> => {
    if (!live()) return

    const memberKey = groupMemberKey(member)
    const room = roomOf(group)
    const marker = room.stranded?.[memberKey]
    const strandedBefore = typeof marker === 'number' ? marker : marker?.before
    const strandedThread = (typeof marker === 'object' && marker?.thread) || 'legacy'
    if (typeof strandedBefore !== 'number' || marker === undefined) return

    const token = claimToken(group, member)
    const markerVersion = markerVersions.get(operationKey(group, member)) || 0
    const promptKey = `${group}::${memberKey}`
    const observedPromptId = $groupPrompts.get()[promptKey]?.requestId || null
    const capture: TurnCapture = {
      anchorId: null,
      epoch: room.epoch || 0,
      group,
      member,
      memberKey,
      promptRequestId: observedPromptId,
      thread: strandedThread,
      token
    }

    const ownsMarker = () =>
      live() && owns(capture) && markerIsCurrent(group, member, marker, markerVersion)

    let state: GroupSessionSnapshot | null = null
    try {
      state = (await memberRequest(capture, 'session.resume', {
        session_id: room.sessions?.[memberKey] || `Group: ${room.roomId || group}`
      })) as GroupSessionSnapshot
    } catch {
      return // source unreachable — leave the marker for the next boundary
    }

    if (!ownsMarker()) return
    if (state?.inflight || state?.running) return

    // A stranded member blocked on a clarify is not "grinding" — surface the
    // question card (#90694) and keep the marker until it resolves.
    if (ownsMarker()) {
      const pending = syncGroupClarify(group, member, state, capture.promptRequestId)
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
    updateGroupChat(group, (r: GroupChatRoom) => {
      const next = { ...(r.stranded || {}) }
      delete next[memberKey]
      r.stranded = next
      return r
    })
    markerVersions.delete(operationKey(group, member))

    const messages = Array.isArray(state?.messages) ? state.messages : []
    if (messages.length <= strandedBefore) return

    const reply = pickGroupTurnReply(messages, strandedBefore)
    if (reply && !isGroupPassText(reply) && live() && owns(capture)) {
      recordGroupActivity(group, { kind: 'delivered', member: member.name, thread: strandedThread })
      // The ownership check and the append are synchronous, so an older
      // harvest cannot yield between them and publish after a newer operation.
      appendGroupChatEntry(
        group,
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
        group,
        (r: GroupChatRoom) => {
          r.watermarks[`${strandedThread}::${memberKey}`] = r.log.length
          return r
        },
        { sync: false }
      )
    }
  }

  const answer = async (
    entry: GroupPrompt,
    member: GroupMember,
    answers: Record<string, string> | string | undefined
  ): Promise<void> => {
    if (!live()) return

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
    const key = `${entry.group}::${entry.memberKey}`
    const all = $groupPrompts.get()
    if (all[key]?.requestId === entry.requestId) {
      const next = { ...all }
      delete next[key]
      $groupPrompts.set(next)
    }
  }

  const interrupt = async (member: GroupMember, storedSessionId: string): Promise<void> => {
    if (!live()) return
    await gateway.request(member, 'session.interrupt', { session_id: storedSessionId })
  }

  return {
    run,
    harvest,
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
