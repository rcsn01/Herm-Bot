import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { GatewayEvent } from '~/compat/hermes-shared'
import { atom } from 'nanostores'

import type { SlashCompletionPayload, SubmissionResult } from '~/features/chat/chat-interaction'
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

// Admission acknowledgements, not evidence that a queued prompt has executed.
function promptSubmissionStatus(acknowledgement: unknown): SubmissionResult['status'] {
  const result = record(acknowledgement)
  const accepted = result.accepted === true
    || ['streaming', 'queued', 'steered', 'redirected'].includes(text(result.status))
  return accepted ? 'accepted' : 'uncertain'
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

function historyPage(rows: Awaited<ReturnType<SessionRuntime['history']>>): SessionHistoryPage {
  return { hasMore: false, nextOffset: rows.length, offset: 0, rows }
}

export class Conversation {
  private submissions = new Set<string>()
  private interruptions = new Set<string>()
  private modelCompletions: { key: string; expires: number; request: Promise<unknown> } | null = null
  private commandDisplays = new Map<string, string>()

  private operationKey() { return JSON.stringify([currentGatewayScope(), $chat.get().runtimeSessionId]) }

  private async submitting<T>(perform: () => Promise<T>): Promise<T> {
    const key = this.operationKey()
    if (this.submissions.has(key)) throw new GatewayError('A message submission is already pending.', { kind: 'validation' })
    this.submissions.add(key)
    try { return await perform() } finally { this.submissions.delete(key) }
  }

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

  async send(text: string): Promise<void | SubmissionResult> {
    return this.submitting(() => this.submitPrompt(text))
  }

  private async submitPrompt(text: string, expandedCommand = false, display?: string): Promise<void | SubmissionResult> {
    this.requireLive()
    const content = text.trim()
    if (!content) return
    const scope = currentGatewayScope()
    const current = $chat.get()
    if (!current.runtimeSessionId) throw new Error('No active session.')
    if (!expandedCommand && content.startsWith('/')) return this.submitSlash(content, scope, current.runtimeSessionId)
    if (display) this.commandDisplays.set(JSON.stringify([this.operationKey(), content]), display)
    if (current.running) {
      const acknowledgement = await this.runtime.rpc('prompt.submit', {
        queued: true,
        session_id: current.runtimeSessionId,
        text: content
      }, { timeoutMs: 1_800_000 })
      return { status: promptSubmissionStatus(acknowledgement), mode: 'queue' }
    }
    $chat.set({
      ...current,
      error: null,
      running: true,
      transcript: updateTranscript(current.transcript, { kind: 'local-user', content: display ?? content, id: crypto.randomUUID() })
    })
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
    try {
      if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== current.runtimeSessionId) {
        throw new GatewayError('The conversation changed before the message was sent.', { kind: 'validation' })
      }
      this.requireLive()
      const acknowledgement = await this.runtime.rpc('prompt.submit', { session_id: current.runtimeSessionId, text: content }, { timeoutMs: 1_800_000 })
      return { status: promptSubmissionStatus(acknowledgement), mode: 'send' }
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
    const key = this.operationKey()
    if (!sessionId || this.interruptions.has(key)) return
    this.interruptions.add(key)
    try { await this.runtime.rpc('session.interrupt', { session_id: sessionId }) }
    finally { this.interruptions.delete(key) }
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

  async retryFrom(rowId: number, text: string): Promise<void | SubmissionResult> {
    return this.submitting(() => this.retryPrompt(rowId, text))
  }

  private async retryPrompt(rowId: number, text: string): Promise<void | SubmissionResult> {
    this.requireLive()
    if ($chat.get().running) throw new GatewayError('Wait for this turn to finish before retrying an edited message.', { kind: 'validation' })
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
    return { status: promptSubmissionStatus(acknowledgement), mode: 'retry' }
  }

  private assertSlashContext(scope: CurrentGatewayScope, sessionId: string | null) {
    if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) {
      throw new DOMException('Gateway scope or conversation changed.', 'AbortError')
    }
    this.requireLive()
  }

  /** Commands execute separately from model turns. Never retry a failed exec as a prompt. */
  private async submitSlash(content: string, scope: CurrentGatewayScope, sessionId: string, depth = 0): Promise<void | SubmissionResult> {
    if (depth >= 5) throw new GatewayError('The slash-command alias is recursive.', { kind: 'validation' })
    const parsed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content)
    if (!parsed) throw new GatewayError('Choose a slash command before sending.', { kind: 'validation' })
    const [, name, arg = ''] = parsed
    const command = name.toLowerCase()
    if (['new', 'reset', 'branch', 'fork', 'resume', 'sessions', 'switch'].includes(command)) {
      throw new GatewayError('Use the conversation menu to create, branch, or switch conversations.', { kind: 'validation' })
    }
    const catalog = record(await this.runtime.rpc('commands.catalog', { session_id: sessionId }))
    this.assertSlashContext(scope, sessionId)
    const meta = record(record(catalog.commands)[`/${command}`])
    if (meta.desktop === 'terminal') throw new GatewayError('This command requires the Hermes terminal.', { kind: 'validation' })
    if (command === 'help') {
      const pairs = Array.isArray(catalog.pairs) ? catalog.pairs : []
      return { status: 'accepted', mode: 'command', output: pairs.filter(row => Array.isArray(row) && row.every(value => typeof value === 'string')).map(row => row.join(' · ')).join('\n') || 'No commands available.' }
    }
    this.modelCompletions = null
    let response: unknown
    try {
      response = await this.runtime.rpc('slash.exec', { session_id: sessionId, command: content.slice(1) })
    } catch (error) {
      this.assertSlashContext(scope, sessionId)
      const classified = classifyGatewayError(error)
      // Legacy gateways explicitly redirect skills to dispatch. Other failures
      // may follow side effects and must never trigger a second execution.
      if (classified.code !== 4018 || !/use command\.dispatch/i.test(classified.message)) throw error
      response = await this.runtime.rpc('command.dispatch', { session_id: sessionId, name, arg })
    }
    this.assertSlashContext(scope, sessionId)
    const result = record(response)
    if (result.confirm_required === true) {
      throw new GatewayError('This model change requires confirmation. Review it in the Hermes desktop app or terminal.', { kind: 'validation' })
    }
    if (result.type === 'alias') {
      if (typeof result.target !== 'string' || !result.target.trim()) throw new GatewayError('The command returned an invalid alias.', { kind: 'validation' })
      return this.submitSlash(`/${result.target.replace(/^\/+/, '')}${arg ? ` ${arg}` : ''}`, scope, sessionId, depth + 1)
    }
    if (result.type === 'prefill') {
      if (typeof result.message !== 'string') throw new GatewayError('The command returned invalid draft text.', { kind: 'validation' })
      let output = text(result.notice) || 'Command text is ready to review. Press Send when ready.'
      try { await this.reconcileHistory(scope) }
      catch (error) { output += `\nCommand completed, but history could not be updated: ${errorMessage(error)}` }
      this.assertSlashContext(scope, sessionId)
      return { status: 'accepted', mode: 'command', prefill: result.message, output }
    }
    if (result.type === 'send' || result.type === 'skill') {
      if (typeof result.message !== 'string' || !result.message.trim()) throw new GatewayError('The command returned an invalid prompt.', { kind: 'validation' })
      const outcome = await this.submitPrompt(result.message, true, text(result.display) || content)
      return outcome ? { ...outcome, output: text(result.notice) || undefined } : outcome
    }
    if (result.type && !['exec', 'plugin'].includes(String(result.type))) {
      throw new GatewayError('This command needs an interaction not supported by the PWA. Use the Hermes terminal.', { kind: 'validation' })
    }
    if (typeof result.output !== 'string' && !(result.output == null && ['exec', 'plugin'].includes(String(result.type)))) {
      throw new GatewayError('The gateway returned an invalid command result.', { kind: 'validation' })
    }
    return { status: 'accepted', mode: 'command', output: [text(result.warning), text(result.output)].filter(Boolean).join('\n') || 'Command completed.' }
  }

  /** Resolve command names and arguments in the current session's profile/workspace. */
  async completeSlash(draft: string): Promise<SlashCompletionPayload> {
    this.requireLive()
    const scope = currentGatewayScope()
    const sessionId = $chat.get().runtimeSessionId
    const context = sessionId ? { session_id: sessionId } : { profile: scope.profile ?? 'default' }
    const modelQuery = /^\/model(?:\s+(.*))?$/i.exec(draft)
    if (modelQuery) {
      const query = (modelQuery[1] ?? '').toLowerCase()
      if (query.includes('--')) return { items: [] }
      const key = JSON.stringify([scope, sessionId, $chat.get().info?.model])
      if (!this.modelCompletions || this.modelCompletions.key !== key || this.modelCompletions.expires < Date.now()) {
        const request = this.runtime.rpc('model.options', { ...context, explicit_only: true })
        const entry = { key, expires: Date.now() + 30_000, request }
        this.modelCompletions = entry
        void request.catch(() => { if (this.modelCompletions === entry) this.modelCompletions = null })
      }
      const options = record(await this.modelCompletions.request)
      this.assertSlashContext(scope, sessionId)
      const items: SlashCompletionPayload['items'] = []
      for (const value of Array.isArray(options.providers) ? options.providers : []) {
        const provider = record(value)
        // The backend's model-argument parser splits on whitespace, not shell quoting.
        if (typeof provider.slug !== 'string' || !provider.slug || /\s/.test(provider.slug) || provider.slug.startsWith('-') || provider.authenticated === false || !Array.isArray(provider.models)) continue
        for (const model of provider.models) {
          if (typeof model !== 'string' || !model || /\s/.test(model) || model.startsWith('-') || !`${provider.name} ${provider.slug} ${model}`.toLowerCase().includes(query)) continue
          if (Array.isArray(provider.unavailable_models) && provider.unavailable_models.includes(model)) continue
          items.push({ text: `${draft.includes(' ') ? '' : ' '}${model} --provider ${provider.slug} --session`, display: model,
            meta: `${text(provider.name) || provider.slug}${options.model === model && options.provider === provider.slug ? ' · Current' : ''}`, kind: 'model' })
        }
      }
      return { items, replaceFrom: draft.indexOf(' ') < 0 ? draft.length : draft.indexOf(' ') + 1 }
    }
    const response = record(await this.runtime.rpc('complete.slash', { text: draft, ...context }))
    this.assertSlashContext(scope, sessionId)
    const items: SlashCompletionPayload['items'] = []
    for (const value of Array.isArray(response.items) ? response.items : []) {
      const item = record(value)
      if (typeof item.text !== 'string') continue
      items.push({ text: item.text, ...(typeof item.display === 'string' ? { display: item.display } : {}),
        ...(typeof item.meta === 'string' ? { meta: item.meta } : {}), ...(typeof item.kind === 'string' ? { kind: item.kind } : {}) })
    }
    return { items, replaceFrom: Number.isInteger(response.replace_from) && Number(response.replace_from) >= 0 && Number(response.replace_from) <= draft.length ? Number(response.replace_from) : undefined }
  }

  async attach(file: File, signal?: AbortSignal): Promise<string | undefined> {
    this.requireLive()
    const scope = currentGatewayScope()
    const limit = file.type.startsWith('image/') ? 20 * 1_024 * 1_024 : 50 * 1_024 * 1_024
    if (file.size > limit) throw new Error(`This attachment exceeds the ${limit / 1_024 / 1_024} MB mobile upload limit.`)
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) throw new Error('No active session.')
    const dataUrl = await fileToDataURL(file)
    if (signal?.aborted || !isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return undefined
    this.requireLive()
    const result = file.type.startsWith('image/')
      ? await this.runtime.rpc('image.attach_bytes', { data_url: dataUrl, name: file.name, session_id: sessionId }, { signal })
      : await this.runtime.rpc('file.attach', { data_url: dataUrl, name: file.name, path: file.name, session_id: sessionId }, { signal })
    if (signal?.aborted || !isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return undefined
    const response = record(result)
    const reference = response.ref_text ?? response.text
    return typeof reference === 'string' && reference.trim() ? reference : undefined
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

  private commandHistoryRows(rows: Awaited<ReturnType<SessionRuntime['history']>>) {
    const session = this.operationKey()
    return rows.map(row => {
      const display = row?.role === 'user' && typeof row.content === 'string'
        ? this.commandDisplays.get(JSON.stringify([session, row.content.trim()])) : undefined
      return display ? { ...row, display_content: display } : row
    })
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
      const rows = this.commandHistoryRows(page.rows)
      const transcript = current.historyBackfilled
        ? updateTranscript(current.transcript, { kind: 'reconcile-history', rows })
        : createTranscript(current.transcript.context, rows)
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
          rows: this.commandHistoryRows(page.rows)
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