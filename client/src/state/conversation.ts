import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { GatewayEvent } from '~/compat/hermes-shared'
import { atom } from 'nanostores'

import { classifyGatewayError, errorMessage } from '~/gateway/gateway-error'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { isConfirmedMissingSession, toTranscript, type RuntimeSession, type SessionRuntime, type TranscriptPage } from '~/gateway/session-runtime'
import type { ChatState, PendingPrompt, ToolActivity, TranscriptMessage } from '~/lib/types'

/**
 * The Conversation is the deep module between the UI and the GatewaySession's
 * chat surface (see the repository's CONTEXT.md). It owns the active session's chat
 * state end to end — the `$chat` atom (this module is its sole writer),
 * gateway-event reduction, prompt submission (send / queue / interrupt /
 * steer / redirect / retry-from), interactive-prompt responses, attachments,
 * and transcript history (reconcile + paging, including the
 * reconcile-on-`message.complete` policy). The GatewayController constructs
 * it, forwards runtime events into it, and owns session *selection*; the
 * Conversation owns session *content*.
 */
export const emptyChatState = (): ChatState => ({
  contractVersion: null,
  error: null,
  historyBackfilled: false,
  historyHasMore: false,
  historyLoadingOlder: false,
  historyNextOffset: 0,
  info: null,
  messages: [],
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

function updateLastAssistant(messages: TranscriptMessage[], delta: string, streaming = true) {
  const result = [...messages]
  const last = result.at(-1)
  if (last?.role === 'assistant') {
    result[result.length - 1] = { ...last, content: `${last.content}${delta}`, streaming }
  } else {
    result.push({ content: delta, id: crypto.randomUUID(), role: 'assistant', streaming })
  }
  return result
}

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
      return {
        ...state,
        contractVersion,
        info: payload as unknown as ChatState['info'],
        running: Boolean(payload.running),
        storedSessionId: text(payload.stored_session_id) || state.storedSessionId
      }
    }
    case 'message.start':
      return { ...state, error: null, running: true }
    case 'message.delta':
      return { ...state, messages: updateLastAssistant(state.messages, text(payload.delta ?? payload.text)) }
    case 'thinking.delta':
    case 'reasoning.delta': {
      const messages = updateLastAssistant(state.messages, '', true)
      const last = messages.at(-1)
      if (last) messages[messages.length - 1] = { ...last, reasoning: `${last.reasoning ?? ''}${text(payload.delta ?? payload.text)}` }
      return { ...state, messages }
    }
    case 'message.complete': {
      const messages = updateLastAssistant(state.messages, text(payload.delta), false)
      return { ...state, messages, running: false }
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

function transcriptPage(messages: ReturnType<typeof toTranscript>): TranscriptPage {
  return { hasMore: false, messages, nextOffset: messages.length }
}

function messageIdentity(message: ReturnType<typeof toTranscript>[number]): string {
  return message.rowId === undefined ? message.id : `row:${message.rowId}`
}

function prependOlderTranscript(older: ReturnType<typeof toTranscript>, current: ReturnType<typeof toTranscript>) {
  const existing = new Set(current.map(messageIdentity))
  const fresh = older.filter(message => !existing.has(messageIdentity(message)))
  return fresh.length ? [...fresh, ...current] : current
}

function graftLatestTranscript(latest: ReturnType<typeof toTranscript>, current: ReturnType<typeof toTranscript>) {
  const first = latest[0]
  if (!first) return latest
  const identity = messageIdentity(first)
  const anchor = current.findIndex(message => messageIdentity(message) === identity)
  return anchor > 0 ? [...current.slice(0, anchor), ...latest] : latest
}

export class Conversation {
  constructor(private readonly runtime: SessionRuntime) {}

  /** Install a newly selected runtime session as the open conversation. */
  adopt(session: RuntimeSession): void {
    $chat.set({
      ...emptyChatState(),
      contractVersion: session.contractVersion,
      info: session.info,
      messages: session.messages,
      runtimeSessionId: session.runtimeSessionId,
      storedSessionId: session.storedSessionId
    })
  }

  /** Reflect a session-list rename in the open chat header without a round trip. */
  retitleActive(storedSessionId: string, title: string): void {
    const current = $chat.get()
    if (current.storedSessionId === storedSessionId && current.info) {
      $chat.set({ ...current, info: { ...current.info, title } as typeof current.info })
    }
  }

  /** Clear the conversation (profile switch, logout, dispose). */
  reset(): void {
    $chat.set(emptyChatState())
  }

  onGatewayEvent(event: GatewayEvent): void {
    const previous = $chat.get()
    const next = reduceGatewayEvent(previous, event)
    $chat.set(next)
    if (event.type === 'message.complete') {
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
      messages: [...current.messages, { content, id: crypto.randomUUID(), role: 'user' }],
      running: true
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

  async retryFrom(userOrdinal: number, rowId: number, text: string): Promise<void> {
    const scope = currentGatewayScope()
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) return
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error('A durable message row is required to edit history safely.')
    if (!Number.isInteger(userOrdinal) || userOrdinal < 0) throw new Error('A valid user-message position is required to edit history safely.')
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
    let page: TranscriptPage
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
        page = transcriptPage(await this.runtime.history(sessionId))
      }
    } else {
      page = transcriptPage(await this.runtime.history(sessionId))
    }
    if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return
    const current = $chat.get()
    const messages = current.historyBackfilled
      ? graftLatestTranscript(page.messages, current.messages)
      : page.messages
    $chat.set({
      ...current,
      historyHasMore: page.hasMore,
      historyNextOffset: page.nextOffset,
      messages,
      running: Boolean(current.info?.running)
    })
  }

  async loadOlderMessages(): Promise<void> {
    const snapshot = $chat.get()
    const sessionId = snapshot.runtimeSessionId
    const storedSessionId = snapshot.storedSessionId
    if (!sessionId || !storedSessionId || !snapshot.historyHasMore || snapshot.historyLoadingOlder) return
    const scope = currentGatewayScope()
    $chat.set({ ...snapshot, historyLoadingOlder: true })
    try {
      const page = await this.runtime.historyPage(storedSessionId, scope.profile, snapshot.historyNextOffset)
      if (!isCurrentGatewayScope(scope)) return
      const current = $chat.get()
      if (current.runtimeSessionId !== sessionId || current.storedSessionId !== storedSessionId) return
      $chat.set({
        ...current,
        historyBackfilled: true,
        historyHasMore: page.hasMore,
        historyLoadingOlder: false,
        historyNextOffset: page.nextOffset,
        messages: prependOlderTranscript(page.messages, current.messages)
      })
    } catch (error) {
      const current = $chat.get()
      if (isCurrentGatewayScope(scope) && current.runtimeSessionId === sessionId) {
        $chat.set({ ...current, historyLoadingOlder: false })
      }
      throw error
    }
  }
}