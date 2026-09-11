import type { GatewayEvent } from '~/compat/hermes-shared'
import type { SessionMessage } from '~/compat/hermes-types'

export interface TranscriptContext {
  source: null | string
  storedSessionId: null | string
}

interface TranscriptEntryBase {
  id: string
  rowId?: number
}

export interface ConversationEntry extends TranscriptEntryBase {
  kind: 'message'
  author: 'assistant' | 'system' | 'user'
  content: string
  reasoning?: string
  streaming: boolean
  editTarget?: TranscriptEditTarget
}

export interface ToolOutputEntry extends TranscriptEntryBase {
  kind: 'tool-output'
  content: string
}

export interface ActivityEntry extends TranscriptEntryBase {
  kind: 'activity'
  activityKind: string
  author: 'assistant' | 'system' | 'user'
  content: string
  reasoning?: string
  streaming: boolean
  editTarget?: TranscriptEditTarget
}

export interface CronInstructionsEntry extends TranscriptEntryBase {
  kind: 'cron-instructions'
  content: string
  originalKind: 'activity' | 'message'
  originalActivityKind?: string
  reasoning?: string
  streaming: boolean
}

export interface TranscriptEditTarget {
  rowId: number
  userOrdinal: number
}

export type TranscriptEntry = ConversationEntry | ToolOutputEntry | ActivityEntry | CronInstructionsEntry

export interface TranscriptSnapshot {
  context: TranscriptContext
  entries: TranscriptEntry[]
}

export type TranscriptChange =
  | { kind: 'gateway-event'; event: GatewayEvent; createId: string }
  | { kind: 'local-user'; content: string; id: string }
  | { kind: 'prepend-history'; rows: readonly SessionMessage[]; fallbackOffset: number }
  | { kind: 'reconcile-history'; rows: readonly SessionMessage[] }
  | { kind: 'set-context'; context: TranscriptContext }

const CRON_MARKER = '[IMPORTANT: You are running as a scheduled cron job.'

type AuthoredEntry = ConversationEntry | ActivityEntry

export function createTranscript(
  context: TranscriptContext,
  rows: readonly SessionMessage[] = []
): TranscriptSnapshot {
  return { context, entries: finalizeEntries(projectRows(rows), context) }
}

export function updateTranscript(transcript: TranscriptSnapshot, change: TranscriptChange): TranscriptSnapshot {
  switch (change.kind) {
    case 'gateway-event':
      return applyGatewayEvent(transcript, change.event, change.createId)
    case 'local-user':
      return withEntries(transcript, [
        ...transcript.entries,
        { author: 'user', content: change.content, id: change.id, kind: 'message', streaming: false }
      ])
    case 'prepend-history': {
      const older = projectRows(change.rows, change.fallbackOffset)
      const existing = new Set(transcript.entries.map(entryIdentity))
      const fresh = older.filter(entry => !existing.has(entryIdentity(entry)))
      return fresh.length ? withEntries(transcript, [...fresh, ...transcript.entries]) : transcript
    }
    case 'reconcile-history': {
      const latest = projectRows(change.rows)
      const first = latest[0]
      if (!first) return withEntries(transcript, [])
      const anchor = transcript.entries.findIndex(entry => entryIdentity(entry) === entryIdentity(first))
      return withEntries(transcript, anchor > 0 ? [...transcript.entries.slice(0, anchor), ...latest] : latest)
    }
    case 'set-context': {
      if (sameContext(transcript.context, change.context)) return transcript
      const finalized = finalizeEntries(transcript.entries, change.context)
      return {
        context: change.context,
        entries: sameEntries(transcript.entries, finalized) ? transcript.entries : finalized
      }
    }
  }
}

function applyGatewayEvent(transcript: TranscriptSnapshot, event: GatewayEvent, createId: string): TranscriptSnapshot {
  const payload = record(event.payload)
  if (event.type === 'message.delta') {
    return updateAssistant(transcript, text(payload.delta ?? payload.text), true, createId)
  }
  if (event.type === 'thinking.delta' || event.type === 'reasoning.delta') {
    const withAssistant = updateAssistant(transcript, '', true, createId)
    const entries = [...withAssistant.entries]
    const last = entries.at(-1)
    if (!isAssistant(last)) return transcript
    entries[entries.length - 1] = { ...last, reasoning: `${last.reasoning ?? ''}${text(payload.delta ?? payload.text)}` }
    return withEntries(withAssistant, entries)
  }
  if (event.type === 'message.complete') {
    return updateAssistant(transcript, text(payload.delta), false, createId)
  }
  return transcript
}

function updateAssistant(
  transcript: TranscriptSnapshot,
  delta: string,
  streaming: boolean,
  createId: string
): TranscriptSnapshot {
  const entries = [...transcript.entries]
  const last = entries.at(-1)
  if (isAssistant(last)) {
    if (!delta && last.streaming === streaming) return transcript
    entries[entries.length - 1] = { ...last, content: `${last.content}${delta}`, streaming }
  } else {
    entries.push({ author: 'assistant', content: delta, id: createId, kind: 'message', streaming })
  }
  return withEntries(transcript, entries)
}

function isAssistant(entry: TranscriptEntry | undefined): entry is AuthoredEntry {
  return Boolean(entry && (entry.kind === 'message' || entry.kind === 'activity') && entry.author === 'assistant')
}

function withEntries(transcript: TranscriptSnapshot, entries: TranscriptEntry[]): TranscriptSnapshot {
  const finalized = finalizeEntries(entries, transcript.context)
  if (sameEntries(transcript.entries, finalized)) return transcript
  return { ...transcript, entries: finalized }
}

function projectRows(rows: readonly SessionMessage[], fallbackOffset = 0): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  rows.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
    const projected = candidate as SessionMessage & Record<string, unknown>
    const storedRole = isStoredRole(projected.role) ? projected.role : 'assistant'
    const contentValue = projected.display_content !== undefined
      ? projected.display_content
      : projected.content ?? projected.text ?? (storedRole === 'tool' ? projected.context ?? projected.name : undefined)
    const content = text(contentValue)
    const displayKind = typeof projected.display_kind === 'string'
      ? projected.display_kind
      : inferLegacyDisplayKind(storedRole, content)
    if (displayKind === 'hidden') return

    const rowIdValue = projected.row_id ?? projected.id
    const rowId = typeof rowIdValue === 'number' && Number.isInteger(rowIdValue) ? rowIdValue : undefined
    const reasoningValue = projected.reasoning ?? projected.reasoning_content
    const reasoning = typeof reasoningValue === 'string' ? reasoningValue : undefined
    const activityContent = timelineDisplayContent(displayKind, projected.display_metadata, content)
    if (storedRole === 'assistant' && activityContent === null && !content.trim() && !reasoning?.trim()) return

    const base = {
      id: rowId === undefined ? `history-${fallbackOffset + index}` : `history-row-${rowId}`,
      ...(rowId === undefined ? {} : { rowId })
    }
    if (activityContent !== null) {
      entries.push({ ...base, activityKind: displayKind!, author: 'system', content: activityContent, kind: 'activity', reasoning, streaming: false })
    } else if (storedRole === 'tool') {
      entries.push({ ...base, content, kind: 'tool-output' })
    } else if (displayKind) {
      entries.push({ ...base, activityKind: displayKind, author: storedRole, content, kind: 'activity', reasoning, streaming: false })
    } else {
      entries.push({ ...base, author: storedRole, content, kind: 'message', reasoning, streaming: false })
    }
  })
  return entries
}

function finalizeEntries(input: readonly TranscriptEntry[], context: TranscriptContext): TranscriptEntry[] {
  const entries = input.map(restoreCronEntry)
  const firstUser = entries.findIndex(isEffectiveUser)
  if (isCronContext(context) && firstUser >= 0 && entries[firstUser].content.startsWith(CRON_MARKER)) {
    const entry = entries[firstUser] as AuthoredEntry
    entries[firstUser] = {
      id: entry.id,
      ...(entry.rowId === undefined ? {} : { rowId: entry.rowId }),
      content: entry.content,
      kind: 'cron-instructions',
      originalKind: entry.kind,
      ...(entry.kind === 'activity' ? { originalActivityKind: entry.activityKind } : {}),
      reasoning: entry.reasoning,
      streaming: entry.streaming
    }
  }

  let userOrdinal = -1
  return entries.map(entry => {
    if (entry.kind === 'cron-instructions') {
      userOrdinal += 1
      return entry
    }
    if (!isEffectiveUser(entry)) return entry
    userOrdinal += 1
    const editTarget = entry.rowId !== undefined && entry.rowId > 0
      ? { rowId: entry.rowId, userOrdinal }
      : undefined
    if (sameEditTarget(entry.editTarget, editTarget)) return entry
    const next = { ...entry }
    if (editTarget) next.editTarget = editTarget
    else delete next.editTarget
    return next
  })
}

function restoreCronEntry(entry: TranscriptEntry): TranscriptEntry {
  if (entry.kind !== 'cron-instructions') return entry
  const base = {
    id: entry.id,
    ...(entry.rowId === undefined ? {} : { rowId: entry.rowId }),
    author: 'user' as const,
    content: entry.content,
    reasoning: entry.reasoning,
    streaming: entry.streaming
  }
  return entry.originalKind === 'activity'
    ? { ...base, activityKind: entry.originalActivityKind ?? '', kind: 'activity' }
    : { ...base, kind: 'message' }
}

function isEffectiveUser(entry: TranscriptEntry): entry is AuthoredEntry {
  return (entry.kind === 'message' || entry.kind === 'activity') && entry.author === 'user'
}

function entryIdentity(entry: TranscriptEntry): string {
  return entry.rowId === undefined ? entry.id : `row:${entry.rowId}`
}

function sameContext(left: TranscriptContext, right: TranscriptContext): boolean {
  return left.source === right.source && left.storedSessionId === right.storedSessionId
}

function sameEntries(left: readonly TranscriptEntry[], right: readonly TranscriptEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function sameEditTarget(left: TranscriptEditTarget | undefined, right: TranscriptEditTarget | undefined): boolean {
  return left === right || Boolean(left && right && left.rowId === right.rowId && left.userOrdinal === right.userOrdinal)
}

function isCronContext(context: TranscriptContext): boolean {
  return context.source === 'cron' || Boolean(context.storedSessionId?.startsWith('cron_'))
}

function isStoredRole(role: unknown): role is ConversationEntry['author'] | 'tool' {
  return role === 'assistant' || role === 'system' || role === 'tool' || role === 'user'
}

function inferLegacyDisplayKind(role: ConversationEntry['author'] | 'tool', content: string): string | undefined {
  if (role !== 'user') return undefined
  if (/^\[ASYNC DELEGATION (?:BATCH )?COMPLETE\s+[—-]\s+deleg_[^\]\n]+\]\s*\nA background (?:fan-out|subagent)\b/.test(content)) {
    return 'async_delegation_complete'
  }
  return undefined
}

function timelineDisplayContent(displayKind: string | undefined, metadata: SessionMessage['display_metadata'], content = ''): string | null {
  if (displayKind === 'model_switch') return 'model changed'
  if (displayKind === 'auto_continue') return 'resumed interrupted turn'
  if (displayKind === 'personality_switch') return 'personality changed'
  if (displayKind !== 'async_delegation_complete') return null

  const parsed = parseDisplayMetadata(metadata)
  const countFromMetadata = parsed && typeof parsed.task_count === 'number' ? parsed.task_count : undefined
  const countFromLegacyText = content.match(/A background fan-out of (\d+) subagent\(s\)/)?.[1]
  const count = countFromMetadata ?? (countFromLegacyText ? Number(countFromLegacyText) : content.startsWith('[ASYNC DELEGATION COMPLETE ') ? 1 : undefined)
  return count === undefined ? 'background agent work finished' : `${count} background agent${count === 1 ? '' : 's'} finished`
}

function parseDisplayMetadata(metadata: SessionMessage['display_metadata']): Record<string, unknown> | null {
  let parsed: unknown = metadata
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
