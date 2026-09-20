import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { GatewayEvent } from '~/compat/hermes-shared'
import { atom } from 'nanostores'

import { classifyGatewayError, errorMessage } from '~/gateway/gateway-error'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { isConfirmedMissingSession, type RuntimeSession, type SessionHistoryPage, type SessionRuntime } from '~/gateway/session-runtime'
import type { ChatState, PendingPrompt, ToolActivity } from '~/lib/types'
import { loadCachedTranscript, saveCachedTranscript } from '~/state/transcript-cache'
import { createTranscript, updateTranscript } from '~/transcript/transcript'

/**
 * The Conversation is the deep module between the UI and the GatewaySession's
 * chat surface (see the repository's CONTEXT.md). It owns the active session's chat
 * state end to end — the `$chat` atom (this module is its sole writer),
 * gateway-event reduction, prompt submission (send / queue / interrupt /
 * steer / redirect / retry-from), interactive-prompt responses, attachments,
 * and transcript history (reconcile + paging, including the
 * reconcile-on-`message.complete` policy). The GatewayController constructs
 * it and forwards runtime events into it. The Session selection module owns
 * *which* session is live; the Conversation owns session *content*.
 */
export const emptyChatState = (): ChatState => ({
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

function pendingPrompt(type: string, payload: Record<string, unknown>): PendingPrompt {
  return {
    kind: type.split('.')[0] as PendingPrompt['kind'],
    payload,
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
        info: payload as unknown as ChatState['info'],
        running: Boolean(payload.running),
        storedSessionId,
        transcript: updateTranscript(state.transcript, { kind: 'set-context', context })
      }
    }
    case 'message.start':
      return { ...state, error: null, running: true }
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
        ...(event.type === 'message.complete' ? { running: false } : {})
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

function historyPage(rows: Awaited<ReturnType<SessionRuntime['history']>>): SessionHistoryPage {
  return { hasMore: false, nextOffset: rows.length, offset: 0, rows }
}

export class Conversation {
  private historyLoadRequest = 0

  constructor(private readonly runtime: SessionRuntime) {}

  /** Install a newly selected runtime session as the open conversation.
   *  When the session carries no rows, the locally cached transcript of the
   *  most recent visit fills the screen immediately; reconcile replaces it. */
  adopt(session: RuntimeSession, source: null | string = null): void {
    this.historyLoadRequest += 1
    const context = { source, storedSessionId: session.storedSessionId }
    const cached = !session.rows?.length && session.storedSessionId
      ? loadCachedTranscript(currentGatewayScope().profile)
      : null
    const transcript = cached && cached.storedSessionId === session.storedSessionId
      ? { context, entries: cached.entries }
      : createTranscript(context, session.rows)
    $chat.set({
      ...emptyChatState(),
      contractVersion: session.contractVersion,
      info: session.info,
      runtimeSessionId: session.runtimeSessionId,
      storedSessionId: session.storedSessionId,
      transcript
    })
  }

  /** Reflect a session-list rename in the open chat header without a round trip. */
  retitleActive(storedSessionId: string, title: string): void {
    const current = $chat.get()
    if (current.storedSessionId === storedSessionId && current.info) {
      $chat.set({ ...current, info: { ...current.info, title } as typeof current.info })
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
    $chat.set(emptyChatState())
  }

  /** Keep the PWA's local copy of the most recent session's history fresh
   *  so the next open renders it instantly. */
  private persistTranscript(): void {
    const current = $chat.get()
    if (!current.storedSessionId) return
    saveCachedTranscript(currentGatewayScope().profile, {
      entries: current.transcript.entries,
      storedSessionId: current.storedSessionId
    })
  }

  onGatewayEvent(event: GatewayEvent): void {
    const previous = $chat.get()
    if (event.session_id && event.session_id !== previous.runtimeSessionId) return
    const next = reduceGatewayEvent(previous, event)
    $chat.set(next)
    if (event.type === 'message.complete') {
      this.persistTranscript()
      void this.reconcileHistory().catch(error => {
        const current = $chat.get()
        if (current.runtimeSessionId === event.session_id) {
          $chat.set({ ...current, error: errorMessage(error) })
        }
      })
    }
  }

  async send(text: string): Promise<void> {
    const content = text.trim()
    if (!content) return
    const scope = currentGatewayScope()
    const current = $chat.get()
    if (!current.runtimeSessionId) throw new Error('No active session.')
    if (current.running) {
      try {
        await this.runtime.rpc('prompt.submit', {
          queued: true,
          session_id: current.runtimeSessionId,
          text: content
        }, { timeoutMs: 1_800_000 })
      } catch (error) {
        if (isCurrentGatewayScope(scope)) throw error
      }
      return
    }
    $chat.set({
      ...current,
      error: null,
      running: true,
      transcript: updateTranscript(current.transcript, { kind: 'local-user', content, id: crypto.randomUUID() })
    })
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
    try {
      await this.runtime.rpc('prompt.submit', { session_id: current.runtimeSessionId, text: content }, { timeoutMs: 1_800_000 })
    } catch (error) {
      if (!isCurrentGatewayScope(scope)) return
      const latest = $chat.get()
      if (latest.runtimeSessionId === current.runtimeSessionId) {
        $chat.set({ ...latest, error: errorMessage(error), running: false })
      }
      throw error
    }
  }

  async interrupt(): Promise<void> {
    const sessionId = $chat.get().runtimeSessionId
    if (sessionId) await this.runtime.rpc('session.interrupt', { session_id: sessionId })
  }

  async steer(text: string): Promise<void> {
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.runtime.rpc('session.steer', { session_id: sessionId, text: content })
  }

  async redirect(text: string): Promise<void> {
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.runtime.rpc('session.redirect', { session_id: sessionId, text: content })
  }

  async retryFrom(rowId: number, text: string): Promise<void> {
    const scope = currentGatewayScope()
    const snapshot = $chat.get()
    const sessionId = snapshot.runtimeSessionId
    if (!sessionId) return
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error('A durable message row is required to edit history safely.')
    const target = snapshot.transcript.entries.find(entry => entry.rowId === rowId && 'editTarget' in entry && entry.editTarget)
    const userOrdinal = target && 'editTarget' in target ? target.editTarget?.userOrdinal : undefined
    if (userOrdinal === undefined) throw new Error('The selected message is no longer editable.')
    const content = text.trim()
    if (!content) return
    try {
      await this.runtime.rpc('prompt.submit', {
        ...(userOrdinal === 0 ? { confirm_empty_truncate: true } : {}),
        confirm_truncate: true,
        session_id: sessionId,
        text: content,
        truncate_before_row_id: rowId,
        truncate_before_user_ordinal: userOrdinal
      }, { timeoutMs: 1_800_000 })
    } catch (error) {
      if (isCurrentGatewayScope(scope)) throw error
    }
  }

  async attach(file: File): Promise<unknown> {
    const scope = currentGatewayScope()
    const limit = file.type.startsWith('image/') ? 20 * 1_024 * 1_024 : 50 * 1_024 * 1_024
    if (file.size > limit) throw new Error(`This attachment exceeds the ${limit / 1_024 / 1_024} MB mobile upload limit.`)
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) throw new Error('No active session.')
    const dataUrl = await fileToDataURL(file)
    if (!isCurrentGatewayScope(scope)) return undefined
    if (file.type.startsWith('image/')) {
      return this.runtime.rpc('image.attach_bytes', { data_url: dataUrl, name: file.name, session_id: sessionId })
    }
    return this.runtime.rpc('file.attach', { data_url: dataUrl, name: file.name, path: file.name, session_id: sessionId })
  }

  async respond(value: string, choice?: string): Promise<void> {
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
    if (!sessionId) return
    let page: SessionHistoryPage
    if (snapshot.storedSessionId) {
      try {
        page = await this.runtime.historyPage(snapshot.storedSessionId, scope.profile)
      } catch (error) {
        const classified = classifyGatewayError(error)
        if (!isConfirmedMissingSession(classified)) throw classified
        // A resumed live/lazy session can be attached before it has a durable
        // state.db row, and older gateways may not expose its durable identity
        // consistently. Keep the resumed runtime and hydrate over JSON-RPC
        // rather than misreporting this transcript 404 as an old gateway.
        page = historyPage(await this.runtime.history(sessionId))
      }
    } else {
      page = historyPage(await this.runtime.history(sessionId))
    }
    if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return
    const current = $chat.get()
    const transcript = current.historyBackfilled
      ? updateTranscript(current.transcript, { kind: 'reconcile-history', rows: page.rows })
      : createTranscript(current.transcript.context, page.rows)
    $chat.set({
      ...current,
      historyHasMore: page.hasMore,
      historyNextOffset: page.nextOffset,
      running: Boolean(current.info?.running),
      transcript
    })
    this.persistTranscript()
  }

  async loadOlderMessages(): Promise<boolean> {
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