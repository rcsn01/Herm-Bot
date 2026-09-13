/**
 * One member's turn: its hidden per-group plumbing session, the submit/poll
 * loop that runs it, the pending clarify/approval prompts mirrored out of
 * it, and the late-reply harvest for a turn that timed out.
 *
 * Ported from the desktop Bot Mode's group-turns.ts
 * (apps/desktop/src/plugins/hermes-bots/group-turns.ts). Room-level
 * sequencing lives in group-rounds.ts, which drives these.
 *
 * Mobile adaptations: every RPC rides the single gateway transport with the
 * member's profile in the params (the desktop routes each member to its own
 * gateway via requestForBot route sockets — no sockets here, so the
 * retainGroupTurnRoute lease machinery is structurally unnecessary), and
 * `$groupClarify` is the PWA's `$groupPrompts` store.
 */

import type { GroupMember } from './group-model'
import { $groupPrompts, groupEngineRequest, recordGroupActivity, type GroupPrompt } from './group-engine'
import { $groupChats, $groupNeedsYou, appendGroupChatEntry, groupMemberKey, updateGroupChat, type GroupChatRoom } from './group-store'

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
 *  reads it — the session's own message shape, not the plugin's GroupMessage.
 *  `content` is a plain string on most providers and a part array on the rest. */
interface GroupTurnTranscriptMessage {
  content?: string | Array<string | { text?: string }>
  role?: string
  text?: string
}

/** #94376: pick the reply a finished turn should surface among the messages
 *  appended since `before`. Scans newest-first and prefers the last
 *  substantive (non-pass) assistant answer over a trailing pass. When only
 *  pass text exists in range, returns the newest one. Returns null only when
 *  no assistant message appears in that range. */
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
 *  reports it. Older backends omit the field entirely. */
interface GroupPendingClarify {
  choices?: string[]
  multi_select?: unknown
  question?: unknown
  questions?: Array<Record<string, unknown>>
  request_id?: string
}

/** A command approval blocking inside a member's session, same wire as the
 *  1:1 approval card. */
interface GroupPendingApproval {
  choices?: string[]
  command?: unknown
  description?: unknown
  request_id?: string
}

/** The `session.resume` fields the room engine reads off a member's hidden
 *  per-group session. */
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

/** A member's per-group session, resolved for one turn. */
interface GroupMemberSessionHandle {
  /** Live runtime id every RPC in this turn targets. */
  runtime: null | string
  /** Durable id persisted in `room.sessions`. */
  stored?: null | string
}

function memberRequest(member: GroupMember, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  // requestForBot equivalent: the member's profile rides the RPC params; the
  // gateway dispatches session.* to that profile's runtime.
  return groupEngineRequest(method, { ...params, profile: member.name })
}

/** Ensure the member's per-group session exists and return a LIVE runtime
 *  session id for it. Gateway-native: session.create mints the session
 *  (lazy until its first message), session.resume by stored id — or by
 *  title, which also covers rehydrated rooms whose sid was lost — reopens
 *  it after restarts. FAIL CLOSED on a transient lookup failure: only JSON-RPC
 *  code 4007 ("genuinely doesn't exist") on BOTH targets falls through to
 *  session.create — any other error throws, because minting a duplicate
 *  session would fork the member's real history. */
export async function ensureGroupChatSession(group: string, member: GroupMember): Promise<GroupMemberSessionHandle> {
  const room = roomOf(group)
  // New rooms title member sessions by their immutable roomId so a
  // same-name recreate never resumes the old room's sessions by title;
  // legacy rooms without a roomId fall back to the display name.
  const title = `Group: ${room.roomId || group}`
  const key = groupMemberKey(member)
  const known = room.sessions?.[key]

  for (const target of [known, title]) {
    if (!target) continue

    try {
      const res = (await memberRequest(member, 'session.resume', {
        session_id: target,
        omit_messages: true
      })) as GroupSessionSnapshot

      if (res?.session_id) {
        const stored = res.session_key || known || null

        if (stored) {
          updateGroupChat(group, (current: GroupChatRoom) => {
            current.sessions = { ...(current.sessions || {}), [key]: stored }
            return current
          })
        }

        return { runtime: res.session_id, stored }
      }
    } catch (error: unknown) {
      if ((error as { code?: number })?.code !== 4007) {
        const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
        throw new Error(`Could not check ${member?.name || 'member'}'s group session${detail} — not starting a new one`)
      }
      /* genuinely doesn't exist (4007) — try the next target / fall through to create */
    }
  }

  const created = (await memberRequest(member, 'session.create', {
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

  if (stored) {
    updateGroupChat(group, (r: GroupChatRoom) => {
      r.sessions = { ...(r.sessions || {}), [key]: stored }
      return r
    })
  }

  return { runtime: created?.session_id || null, stored }
}

const GROUP_TURN_TIMEOUT_MS = 180000
const GROUP_TURN_POLL_MS = 2000

/** A gateway rejection as it reaches the room engine. */
interface GatewayErrorLike {
  code?: number
  data?: { reason?: unknown }
  message?: unknown
}

/** 4001-class "the runtime session was reaped" failure. Distinct from 4007
 *  ("genuinely never existed"), which must keep flowing to session.create. */
export function isSessionGoneError(error: GatewayErrorLike | null | undefined): boolean {
  if (!error || error.code === 4007) return false
  if (error.code === 4001) return true
  const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : ''
  return message.includes('not in memory') || /session not found/i.test(message)
}

/** prompt.submit with one belt-and-braces retry: when the runtime session was
 *  reaped between minting and submitting (4001 class), re-resume via the
 *  STORED id — the durable identity — to mint a fresh runtime id, and submit
 *  exactly once more. Returns the runtime id the submit actually landed on. */
async function submitGroupTurnPrompt(
  member: GroupMember,
  runtime: string,
  stored: null | string | undefined,
  text: string
): Promise<string> {
  try {
    await memberRequest(member, 'prompt.submit', { session_id: runtime, text })
    return runtime
  } catch (error: unknown) {
    if (!isSessionGoneError(error as GatewayErrorLike) || !stored) throw error

    const res = (await memberRequest(member, 'session.resume', {
      session_id: stored,
      omit_messages: true
    })) as GroupSessionSnapshot

    const fresh = res?.session_id
    if (!fresh) throw error

    await memberRequest(member, 'prompt.submit', { session_id: fresh, text })
    return fresh
  }
}

// A member turn that is VISIBLY still working (session reports
// inflight/running) keeps its slot alive up to this hard cap. The base
// timeout alone silently dropped long real turns.
const GROUP_TURN_HARD_CAP_MS = 20 * 60000

/** Mirror a member's pending prompt — clarify question OR command approval —
 *  from its resume snapshot into the prompts store, keyed
 *  `${group}::${memberKey}` (#90694). Returns true while a prompt is
 *  blocking, so the turn poll can extend its deadline. Clarify wins when
 *  both are somehow present. */
export function syncGroupClarify(group: string, member: GroupMember, state: GroupSessionSnapshot | null): boolean {
  const key = `${group}::${groupMemberKey(member)}`
  const clarify = state && typeof state.pending_clarify === 'object' ? state.pending_clarify : null
  const approval = (state && typeof state.pending_approval === 'object' ? state.pending_approval : null) as GroupPendingApproval

  const pending = clarify || approval
  const requestId = pending?.request_id || null
  const all = $groupPrompts.get()
  const current = all[key]

  if (!requestId) {
    if (current) {
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

/** Drop every mirrored prompt belonging to `group` (disband/rename). */
export function clearGroupPrompts(group: string): void {
  const all = $groupPrompts.get()
  const next: Record<string, GroupPrompt> = {}
  let changed = false

  for (const [key, value] of Object.entries<GroupPrompt>(all)) {
    if (value?.group === group) {
      changed = true
    } else {
      next[key] = value
    }
  }

  if (changed) $groupPrompts.set(next)
}

/** Answer a member's pending prompt from the room.
 *  - clarify: `clarify.respond`; batch questions send one respond per
 *    question, sequentially — the LAST lock resolves the blocked tool
 *    server-side. allow_expired server-side makes racing the timeout harmless.
 *  - approval: `approval.respond` with the choice (once/session/always/deny),
 *    keyed by session + request_id. */
export async function answerGroupClarify(entry: GroupPrompt, member: GroupMember, answers: Record<string, string> | string | undefined): Promise<void> {
  if (entry.kind === 'approval') {
    await memberRequest(member, 'approval.respond', {
      session_id: entry.sessionId || undefined,
      request_id: entry.requestId,
      choice: typeof answers === 'string' && answers ? answers : 'deny'
    })
  } else if (entry.questions && entry.questions.length) {
    for (const question of entry.questions) {
      // Question ids are opaque on the wire; the batch card keys its answer
      // bag by exactly them.
      const qid = String((question as { qid?: string; id?: string })?.qid ?? (question as { id?: string })?.id)
      await memberRequest(member, 'clarify.respond', {
        request_id: entry.requestId,
        question_id: qid,
        answer: (answers as Record<string, string>)?.[qid] ?? ''
      })
    }
  } else {
    await memberRequest(member, 'clarify.respond', {
      request_id: entry.requestId,
      answer: typeof answers === 'string' ? answers : ''
    })
  }

  const all = $groupPrompts.get()
  const key = `${entry.group}::${entry.memberKey}`

  if (all[key]?.requestId === entry.requestId) {
    const next = { ...all }
    delete next[key]
    $groupPrompts.set(next)
  }
}

/** One member turn, gateway-native: submit the room delta as a prompt into
 *  the member's per-group session, then poll the session until a NEW
 *  assistant message lands (or timeout → pass). While the session visibly
 *  reports work in flight the deadline extends (bounded by the hard cap).
 *  A turn that still times out records a stranded marker so the finished
 *  reply can be harvested into the room at the member's next turn. */
export async function runGroupChatMemberTurn(group: string, member: GroupMember, prompt: string, thread: string): Promise<null | string> {
  const { runtime, stored } = await ensureGroupChatSession(group, member)

  if (!runtime) return null

  // #91868/#94569: remember the epoch this turn was dispatched under so the
  // poll loop below can tell an explicit stop from ordinary room churn.
  const dispatchEpoch = roomOf(group).epoch || 0
  const memberKey = groupMemberKey(member)
  recordGroupActivity(group, { kind: 'working', member: member.name, thread })

  // Baseline: how many messages exist before our submit.
  let before = 0

  try {
    const pre = (await memberRequest(member, 'session.resume', {
      session_id: stored || runtime
    })) as GroupSessionSnapshot

    before = Array.isArray(pre?.messages) ? pre.messages.length : pre?.message_count || 0
  } catch {
    /* lazy session — zero messages */
  }

  // #93602: one-shot recovery when the runtime session was reaped between
  // minting and submitting. Tracks the runtime id the submit landed on.
  const liveRuntime = await submitGroupTurnPrompt(member, runtime, stored, prompt)
  const started = Date.now()
  let deadline = started + GROUP_TURN_TIMEOUT_MS

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, GROUP_TURN_POLL_MS))

    // #91868/#94569: an explicit stop bumped the epoch AND held this member —
    // the member's session was interrupted, so nothing is coming; abandon the
    // poll. Both conditions on purpose: an ordinary newer send bumps the
    // epoch WITHOUT a hold, and that turn must keep polling so finished work
    // can still be delivered (the #93127 commit check decides its fate).
    const roomDuringPoll = roomOf(group)

    if ((roomDuringPoll.epoch || 0) !== dispatchEpoch && (roomDuringPoll.holds || {})[memberKey]) {
      return null
    }

    let state: GroupSessionSnapshot | null = null

    try {
      state = (await memberRequest(member, 'session.resume', {
        session_id: stored || liveRuntime
      })) as GroupSessionSnapshot
    } catch {
      continue
    }

    const messages = Array.isArray(state?.messages) ? state.messages : []
    const busy = Boolean(state?.inflight || state?.running)
    // A clarify blocking inside the member's session is a question for the
    // HUMAN (#90694) — mirror it into the prompts store so a card renders,
    // and hold the turn open.
    const awaitingUser = syncGroupClarify(group, member, state)
    const done = !busy && !awaitingUser

    if (messages.length > before && done) {
      const replyText = pickGroupTurnReply(messages, before)

      if (replyText !== null) {
        recordGroupActivity(group, {
          kind: isGroupPassText(replyText) ? 'passed' : 'replied',
          member: member.name,
          thread
        })
        return replyText
      }

      recordGroupActivity(group, { kind: 'passed', member: member.name, thread })
      return null
    }

    // Still visibly working — or waiting on the user's answer: extend the
    // deadline (never past the hard cap).
    if (busy || awaitingUser) {
      deadline = Math.min(started + GROUP_TURN_HARD_CAP_MS, Math.max(deadline, Date.now() + GROUP_TURN_TIMEOUT_MS))
    }
  }

  // Timeout — clear any still-mirrored question card and read as a pass, but
  // remember the baseline + thread (runtime-only) so the finished reply can
  // be posted late into the RIGHT thread instead of vanishing.
  recordGroupActivity(group, { kind: 'timed-out', member: member.name, thread })
  syncGroupClarify(group, member, null)
  updateGroupChat(group, (r: GroupChatRoom) => {
    r.stranded = {
      ...(r.stranded || {}),
      [groupMemberKey(member)]: { before, thread }
    }
    return r
  })

  return null
}

/** Post a timed-out member's finished reply into the room, if it landed
 *  after we stopped waiting. Called at the member's next turn boundary and
 *  on user sends, so long-running work is delivered late rather than lost. */
export async function harvestStrandedGroupReply(group: string, member: GroupMember): Promise<void> {
  const memberKey = groupMemberKey(member)
  const room = roomOf(group)
  const marker = room.stranded?.[memberKey]
  // Markers were a bare number before threads; normalize both shapes.
  const strandedBefore = typeof marker === 'number' ? marker : marker?.before
  const strandedThread = (typeof marker === 'object' && marker?.thread) || 'legacy'

  if (typeof strandedBefore !== 'number') return

  let state: GroupSessionSnapshot | null = null

  try {
    state = (await memberRequest(member, 'session.resume', {
      session_id: room.sessions?.[memberKey] || `Group: ${room.roomId || group}`
    })) as GroupSessionSnapshot
  } catch {
    return // source unreachable — leave the marker for the next boundary
  }

  if (state?.inflight || state?.running) {
    return // still grinding — keep waiting
  }

  // A stranded member blocked on a clarify is not "grinding" — surface the
  // question card (#90694) and keep the marker until it resolves.
  if (syncGroupClarify(group, member, state)) return

  // Done (or dead): the marker is consumed either way.
  updateGroupChat(group, (r: GroupChatRoom) => {
    const next = { ...(r.stranded || {}) }
    delete next[memberKey]
    r.stranded = next
    return r
  })
  const messages = Array.isArray(state?.messages) ? state.messages : []

  if (messages.length <= strandedBefore) return

  const reply = pickGroupTurnReply(messages, strandedBefore)

  if (reply && !isGroupPassText(reply)) {
    recordGroupActivity(group, { kind: 'delivered', member: member.name, thread: strandedThread })
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
        r.watermarks[`${strandedThread}::${groupMemberKey(member)}`] = r.log.length
        return r
      },
      { sync: false }
    )
  }
}