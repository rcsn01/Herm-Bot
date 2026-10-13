import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { GatewayEvent } from '~/compat/hermes-shared'
import { atom } from 'nanostores'

import type { ChatSuggestion, SlashCompletionPayload } from '~/features/chat/chat-interaction'
import { classifyGatewayError, errorMessage, GatewayError } from '~/gateway/gateway-error'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { isConfirmedMissingSession, type RuntimeSession, type SessionHistoryPage, type SessionRuntime } from '~/gateway/session-runtime'
import type { ChatState, PendingPrompt, SessionInfoSnapshot, ToolActivity } from '~/lib/types'
import { transcriptCache, type CachedConversation } from '~/state/transcript-cache'
import { $draftOwner, draftOwnerKey } from './draft-owner'
import { $sessions, requireGatewayReady } from './store'
import { createTranscript, updateTranscript } from '~/transcript/transcript'

/**
 * The Conversation is the deep module between the UI and the GatewaySession's
 * chat surface (see the repository's CONTEXT.md). It owns the active session's chat
 * state end to end — the `$chat` atom (this module is its sole writer),
 * gateway-event reduction, prompt submission (send / queue / interrupt /
 * steer / redirect / retry-from), interactive-prompt responses, attachments
 * (upload RPCs and reference resolution), slash completion, and transcript
 * history (reconcile + paging, including the reconcile-on-`message.complete`
 * policy). The GatewayController constructs
 * it and forwards runtime events into it. The Session selection module owns
 * *which* session is live; the Conversation owns session *content*.
 */
export const emptyChatState = (): ChatState => ({
  availability: 'empty',
  lastSyncedAt: null,
  contractVersion: null,
  error: null,
  historyBackfilled: false,
  historyHasMore: false,
  historyLoadingOlder: false,
  historyNextOffset: 0,
  info: null,
  transcript: createTranscript({ source: null, storedSessionId: null }),
  pendingPrompt: null,
  running: false,
  runtimeSessionId: null,
  storedSessionId: null,
  tools: []
})

export const $chat = atom<ChatState>(emptyChatState())

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

function upsertTool(tools: ToolActivity[], payload: Record<string, unknown>, status: ToolActivity['status']) {
  const id = text(payload.tool_call_id ?? payload.id) || `${text(payload.name)}-${tools.length}`
  const next: ToolActivity = {
    detail: text(payload.output ?? payload.detail ?? payload.message),
    id,
    name: text(payload.name ?? payload.tool_name) || 'Tool',
    status
  }
  const index = tools.findIndex(tool => tool.id === id)
  if (index < 0) return [...tools, next]
  const result = [...tools]
  result[index] = { ...result[index], ...next }
  return result
}

function sessionInfoSnapshot(raw: object): SessionInfoSnapshot {
  const info = record(raw)
  let usage: SessionInfoSnapshot['usage'] = null
  if (typeof info.usage === 'object' && info.usage !== null) {
    const rawUsage = record(info.usage)
    const used = Number(rawUsage.total ?? rawUsage.total_tokens ?? 0)
    const limit = Number(rawUsage.context_limit ?? rawUsage.max_tokens ?? 0)
    if (used || limit) usage = { used, limit }
  }
  const model = text(info.model).trim()
  const reasoningEffort = text(info.reasoning_effort).trim()
  return {
    title: text(info.title),
    running: Boolean(info.running),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    usage
  }
}

function pendingPrompt(type: string, payload: Record<string, unknown>): PendingPrompt {
  return {
    kind: type.split('.')[0] as PendingPrompt['kind'],
    question: String(payload.question ?? payload.message ?? payload.command ?? ''),
    requestId: text(payload.request_id)
  }
}

export function reduceGatewayEvent(state: ChatState, event: GatewayEvent): ChatState {
  const payload = record(event.payload)
  if (event.session_id && event.session_id !== state.runtimeSessionId) return state

  switch (event.type) {
    case 'session.info': {
      const marker = payload.desktop_contract
      const contractVersion = marker === undefined
        ? state.contractVersion
        : typeof marker === 'number' && Number.isFinite(marker) ? marker : state.contractVersion
      const storedSessionId = text(payload.stored_session_id) || state.storedSessionId
      const context = {
        source: storedSessionId === state.transcript.context.storedSessionId ? state.transcript.context.source : null,
        storedSessionId
      }
      return {
        ...state,
        contractVersion,
        info: sessionInfoSnapshot(payload),
        running: Boolean(payload.running),
        storedSessionId,
        transcript: updateTranscript(state.transcript, { kind: 'set-context', context })
      }
    }
    case 'message.start':
      return { ...state, error: null, running: true, info: state.info ? { ...state.info, running: true } : null }
    case 'message.delta':
    case 'thinking.delta':
    case 'reasoning.delta':
    case 'message.complete':
      return {
        ...state,
        transcript: updateTranscript(state.transcript, {
          kind: 'gateway-event',
          createId: crypto.randomUUID(),
          event
        }),
        ...(event.type === 'message.complete' ? { running: false, info: state.info ? { ...state.info, running: false } : null } : {})
      }
    case 'tool.start':
      return { ...state, tools: upsertTool(state.tools, payload, 'running') }
    case 'tool.progress':
      return { ...state, tools: upsertTool(state.tools, payload, 'progress') }
    case 'tool.generating':
      return { ...state, tools: upsertTool(state.tools, payload, 'generating') }
    case 'tool.complete':
      return { ...state, tools: upsertTool(state.tools, payload, 'complete') }
    case 'clarify.request':
    case 'approval.request':
    case 'sudo.request':
    case 'secret.request':
      return { ...state, pendingPrompt: pendingPrompt(event.type, payload) }
    case 'error':
      return { ...state, error: text(payload.message ?? payload.error) || 'Hermes reported an error.', running: false }
    default:
      // Forward compatibility: unknown gateway events are intentionally inert.
      return state
  }
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}

interface SlashCompletionResponse {
  items?: Array<Omit<ChatSuggestion, 'insertText'>>
  replace_from?: number
}

function historyPage(rows: Awaited<ReturnType<SessionRuntime['history']>>): SessionHistoryPage {
  return { hasMore: false, nextOffset: rows.length, offset: 0, rows }
}

export class Conversation {
  private historyLoadRequest = 0
  private reconciliationRequest = 0
  private historyDirty = false
  private selectedIdentity: string | null = null

  private identity(storedSessionId: string | null) {
    return JSON.stringify([draftOwnerKey($draftOwner.get()), currentGatewayScope().profile, storedSessionId])
  }

  suspend(): void {
    this.historyDirty = false
    ++this.historyLoadRequest
    ++this.reconciliationRequest
    const current = $chat.get()
    $chat.set({ ...current, availability: current.availability === 'empty' ? 'empty' : 'cached', pendingPrompt: null, running: false, tools: [], historyLoadingOlder: false,
      transcript: { ...current.transcript, entries: current.transcript.entries.map(entry => 'streaming' in entry ? { ...entry, streaming: false } : entry) } })
  }

  adoptCached(snapshot: CachedConversation): void {
    this.historyDirty = false
    ++this.historyLoadRequest
    ++this.reconciliationRequest
    this.selectedIdentity = this.identity(snapshot.storedSessionId)
    $chat.set({ ...emptyChatState(), availability: 'cached', lastSyncedAt: snapshot.lastSyncedAt, storedSessionId: snapshot.storedSessionId,
      info: { title: snapshot.title, running: false, usage: null }, transcript: { context: { source: snapshot.source, storedSessionId: snapshot.storedSessionId }, entries: snapshot.entries } })
  }

  private requireLive() {
    requireGatewayReady()
    if ($chat.get().availability !== 'live') throw new GatewayError('This conversation is not synchronized. Reconnect before trying this action.', { kind: 'validation', code: 'GATEWAY_UNAVAILABLE', retryable: false })
  }

  constructor(private readonly runtime: SessionRuntime) {}

  /** Install a newly selected runtime session as the open conversation.
   *  When the session carries no rows, the locally cached transcript of the
   *  most recent visit fills the screen immediately; reconcile replaces it. */
  adopt(session: RuntimeSession, source: null | string = null): void {
    this.historyLoadRequest += 1
    this.historyDirty = false
    const context = { source, storedSessionId: session.storedSessionId }
    ++this.reconciliationRequest
    const current = $chat.get()
    const same = this.selectedIdentity === this.identity(session.storedSessionId) && current.storedSessionId === session.storedSessionId
      && (session.storedSessionId !== null || current.runtimeSessionId === session.runtimeSessionId)
    const cached = session.storedSessionId ? transcriptCache.read({ owner: $draftOwner.get(), profile: currentGatewayScope().profile, storedSessionId: session.storedSessionId }) : null
    const transcript = same ? current.transcript : cached ? { context: { ...context, source: source ?? cached.source }, entries: cached.entries } : createTranscript(context, session.rows)
    this.selectedIdentity = this.identity(session.storedSessionId)
    $chat.set({
      ...emptyChatState(),
      availability: 'synchronizing',
      lastSyncedAt: same ? current.lastSyncedAt : cached?.lastSyncedAt ?? null,
      contractVersion: session.contractVersion,
      info: sessionInfoSnapshot(session.info),
      runtimeSessionId: session.runtimeSessionId,
      storedSessionId: session.storedSessionId,
      transcript
    })
  }

  /** Reflect a session-list rename in the open chat header without a round trip. */
  retitleActive(storedSessionId: string, title: string): void {
    const current = $chat.get()
    if (current.storedSessionId === storedSessionId && current.info) {
      $chat.set({ ...current, info: { ...current.info, title } })
    }
  }

  /** Add or clear session-list provenance without letting the controller write `$chat`. */
  setSessionSource(storedSessionId: string, source: null | string): void {
    const current = $chat.get()
    if (current.storedSessionId !== storedSessionId) return
    $chat.set({
      ...current,
      transcript: updateTranscript(current.transcript, {
        kind: 'set-context',
        context: { source, storedSessionId }
      })
    })
  }

  /** Clear the conversation (profile switch, logout, dispose). */
  reset(): void {
    this.historyLoadRequest += 1
    ++this.reconciliationRequest
    this.historyDirty = false
    this.selectedIdentity = null
    $chat.set(emptyChatState())
  }

  /** Keep the PWA's local copy of the most recent session's history fresh
   *  so the next open renders it instantly. */
  private persistTranscript(): void {
    const current = $chat.get()
    if (!current.storedSessionId) return
    if (current.availability !== 'live' || current.lastSyncedAt === null) return
    const session = $sessions.get().find(session => session.id === current.storedSessionId)
    const startedAt = typeof session?.started_at === 'number' && Number.isFinite(session.started_at) ? session.started_at * 1000 : null
    transcriptCache.write({ owner: $draftOwner.get(), profile: currentGatewayScope().profile, storedSessionId: current.storedSessionId }, {
      entries: current.transcript.entries, title: current.info?.title ?? '', source: current.transcript.context.source,
      startedAt, lastSyncedAt: current.lastSyncedAt
    })
  }

  onGatewayEvent(event: GatewayEvent): void {
    const previous = $chat.get()
    if (!previous.runtimeSessionId || !['live', 'synchronizing'].includes(previous.availability) || (event.session_id && event.session_id !== previous.runtimeSessionId)) return
    const next = reduceGatewayEvent(previous, event)
    if (next.storedSessionId !== previous.storedSessionId) this.selectedIdentity = this.identity(next.storedSessionId)
    $chat.set(next)
    if (event.type === 'message.complete') {
      if (previous.availability === 'synchronizing') { this.historyDirty = true; return }
      void this.reconcileHistory().catch(error => {
        const current = $chat.get()
        if (current.runtimeSessionId === event.session_id) {
          $chat.set({ ...current, error: errorMessage(error) })
        }
      })
    }
  }

  async send(text: string): Promise<void | 'accepted' | 'uncertain'> {
    this.requireLive()
    const content = text.trim()
    if (!content) return
    const scope = currentGatewayScope()
    const current = $chat.get()
    if (!current.runtimeSessionId) throw new Error('No active session.')
    if (current.running) {
      const acknowledgement = await this.runtime.rpc('prompt.submit', {
        queued: true,
        session_id: current.runtimeSessionId,
        text: content
      }, { timeoutMs: 1_800_000 })
      return record(acknowledgement).accepted === true ? 'accepted' : 'uncertain'
    }
    $chat.set({
      ...current,
      error: null,
      running: true,
      transcript: updateTranscript(current.transcript, { kind: 'local-user', content, id: crypto.randomUUID() })
    })
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
    try {
      if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== current.runtimeSessionId) {
        throw new GatewayError('The conversation changed before the message was sent.', { kind: 'validation' })
      }
      this.requireLive()
      const acknowledgement = await this.runtime.rpc('prompt.submit', { session_id: current.runtimeSessionId, text: content }, { timeoutMs: 1_800_000 })
      return record(acknowledgement).accepted === true ? 'accepted' : 'uncertain'
    } catch (error) {
      if (!isCurrentGatewayScope(scope)) throw error
      const latest = $chat.get()
      if (latest.runtimeSessionId === current.runtimeSessionId) {
        $chat.set({ ...latest, error: errorMessage(error), running: false })
      }
      throw error
    }
  }

  async interrupt(): Promise<void> {
    this.requireLive()
    const sessionId = $chat.get().runtimeSessionId
    if (sessionId) await this.runtime.rpc('session.interrupt', { session_id: sessionId })
  }

  async steer(text: string): Promise<void> {
    this.requireLive()
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.runtime.rpc('session.steer', { session_id: sessionId, text: content })
  }

  async redirect(text: string): Promise<void> {
    this.requireLive()
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.runtime.rpc('session.redirect', { session_id: sessionId, text: content })
  }

  async retryFrom(rowId: number, text: string): Promise<void | 'accepted' | 'uncertain'> {
    this.requireLive()
    const snapshot = $chat.get()
    const sessionId = snapshot.runtimeSessionId
    if (!sessionId) throw new GatewayError('No active session.', { kind: 'validation' })
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error('A durable message row is required to edit history safely.')
    const target = snapshot.transcript.entries.find(entry => entry.rowId === rowId && 'editTarget' in entry && entry.editTarget)
    const userOrdinal = target && 'editTarget' in target ? target.editTarget?.userOrdinal : undefined
    if (userOrdinal === undefined) throw new Error('The selected message is no longer editable.')
    const content = text.trim()
    if (!content) return
    const acknowledgement = await this.runtime.rpc('prompt.submit', {
      ...(userOrdinal === 0 ? { confirm_empty_truncate: true } : {}),
      confirm_truncate: true,
      session_id: sessionId,
      text: content,
      truncate_before_row_id: rowId,
      truncate_before_user_ordinal: userOrdinal
    }, { timeoutMs: 1_800_000 })
    return record(acknowledgement).accepted === true ? 'accepted' : 'uncertain'
  }

  /** Resolve slash-command suggestions for the composer's current draft. */
  async completeSlash(draft: string): Promise<SlashCompletionPayload> {
    this.requireLive()
    const scope = currentGatewayScope()
    const response = await this.runtime.rpc<SlashCompletionResponse>('complete.slash', { text: draft })
    if (!isCurrentGatewayScope(scope)) throw new DOMException('Gateway scope changed.', 'AbortError')
    return {
      items: response.items ?? [],
      replaceFrom: typeof response.replace_from === 'number' ? response.replace_from : undefined
    }
  }

  async attach(file: File): Promise<string | undefined> {
    this.requireLive()
    const scope = currentGatewayScope()
    const limit = file.type.startsWith('image/') ? 20 * 1_024 * 1_024 : 50 * 1_024 * 1_024
    if (file.size > limit) throw new Error(`This attachment exceeds the ${limit / 1_024 / 1_024} MB mobile upload limit.`)
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) throw new Error('No active session.')
    const dataUrl = await fileToDataURL(file)
    if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return undefined
    this.requireLive()
    const result = file.type.startsWith('image/')
      ? await this.runtime.rpc('image.attach_bytes', { data_url: dataUrl, name: file.name, session_id: sessionId })
      : await this.runtime.rpc('file.attach', { data_url: dataUrl, name: file.name, path: file.name, session_id: sessionId })
    const response = result as { ref_text?: string; text?: string } | undefined
    if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return undefined
    if (!response) return undefined
    return response.ref_text ?? response.text ?? `@file:${file.name}`
  }

  async respond(value: string, choice?: string): Promise<void> {
    this.requireLive()
    const scope = currentGatewayScope()
    const pending = $chat.get().pendingPrompt
    const sessionId = $chat.get().runtimeSessionId
    if (!pending || !sessionId) return
    const fields: Record<string, unknown> = { request_id: pending.requestId, session_id: sessionId }
    const method = `${pending.kind}.respond`
    if (pending.kind === 'clarify') fields.answer = value
    else if (pending.kind === 'approval') fields.choice = choice ?? value
    else if (pending.kind === 'sudo') fields.password = value
    else fields.value = value
    try {
      await this.runtime.rpc(method, fields)
    } catch (error) {
      if (isCurrentGatewayScope(scope)) throw error
      return
    }
    if (!isCurrentGatewayScope(scope)) return
    const current = $chat.get()
    if (current.pendingPrompt?.requestId === pending.requestId) {
      $chat.set({ ...current, pendingPrompt: null })
    }
  }

  async reconcileHistory(scope: CurrentGatewayScope = currentGatewayScope()): Promise<void> {
    const snapshot = $chat.get()
    const sessionId = snapshot.runtimeSessionId
    if (!sessionId || !['live', 'synchronizing'].includes(snapshot.availability)) return
    const request = ++this.reconciliationRequest
    try {
      let page: SessionHistoryPage
      if (snapshot.storedSessionId) {
        try {
          page = await this.runtime.historyPage(snapshot.storedSessionId, scope.profile)
        } catch (error) {
          const classified = classifyGatewayError(error)
          if (!isConfirmedMissingSession(classified)) throw classified
          // A resumed lazy session may not yet have a durable state.db row.
          // Keep its selected runtime and ask for that runtime's history.
          page = historyPage(await this.runtime.history(sessionId))
        }
      } else {
        page = historyPage(await this.runtime.history(sessionId))
      }
      if (request !== this.reconciliationRequest || !isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return
      const current = $chat.get()
      const transcript = current.historyBackfilled
        ? updateTranscript(current.transcript, { kind: 'reconcile-history', rows: page.rows })
        : createTranscript(current.transcript.context, page.rows)
      $chat.set({
        ...current,
        availability: 'live',
        lastSyncedAt: Date.now(),
        historyHasMore: page.hasMore,
        historyNextOffset: page.nextOffset,
        running: current.info?.running ?? false,
        transcript
      })
      this.persistTranscript()
      if (this.historyDirty) {
        this.historyDirty = false
        await this.reconcileHistory(scope)
      }
    } catch (error) {
      if (request === this.reconciliationRequest && isCurrentGatewayScope(scope) && $chat.get().runtimeSessionId === sessionId && snapshot.availability === 'synchronizing') {
        const current = $chat.get()
        $chat.set({ ...current, availability: 'cached', error: errorMessage(error), pendingPrompt: null, running: false, tools: [] })
      }
      throw error
    }
  }

  async loadOlderMessages(): Promise<boolean> {
    this.requireLive()
    const snapshot = $chat.get()
    const sessionId = snapshot.runtimeSessionId
    const storedSessionId = snapshot.storedSessionId
    if (!sessionId || !storedSessionId || !snapshot.historyHasMore || snapshot.historyLoadingOlder) return false
    const scope = currentGatewayScope()
    const request = ++this.historyLoadRequest
    $chat.set({ ...snapshot, historyLoadingOlder: true })
    try {
      const page = await this.runtime.historyPage(storedSessionId, scope.profile, snapshot.historyNextOffset)
      if (!isCurrentGatewayScope(scope) || request !== this.historyLoadRequest) return false
      const current = $chat.get()
      if (current.runtimeSessionId !== sessionId || current.storedSessionId !== storedSessionId) return false
      $chat.set({
        ...current,
        historyBackfilled: true,
        historyHasMore: page.hasMore,
        historyNextOffset: page.nextOffset,
        transcript: updateTranscript(current.transcript, {
          kind: 'prepend-history',
          fallbackOffset: page.offset,
          rows: page.rows
        })
      })
      return true
    } catch (error) {
      const classified = classifyGatewayError(error)
      const current = $chat.get()
      const currentIdentity = current.runtimeSessionId === sessionId && current.storedSessionId === storedSessionId
      if (!isCurrentGatewayScope(scope) || request !== this.historyLoadRequest || !currentIdentity || classified.kind === 'aborted') return false
      throw classified
    } finally {
      if (request === this.historyLoadRequest) {
        const current = $chat.get()
        if (current.historyLoadingOlder) $chat.set({ ...current, historyLoadingOlder: false })
      }
    }
  }
}