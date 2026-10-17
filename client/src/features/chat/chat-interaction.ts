import { atom } from 'nanostores'
import { ChatPlayback, type PlaybackState } from './chat-playback'

import { classifyGatewayError, errorMessage } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'
import { ChatDrafts, emptyDraft, type DraftAttachment, type DraftContent, type DraftContext } from './chat-drafts'
import type { DraftOwner } from '~/state/draft-owner'

export interface ChatSuggestion {
  display?: string
  insertText: string
  kind?: string
  meta?: string
  text: string
}

export interface EditTarget {
  content: string
  rowId: number
}

export interface SubmissionResult {
  status: 'accepted' | 'uncertain'
  mode: 'send' | 'queue' | 'retry' | 'command'
  output?: string
  prefill?: string
}
export interface AttachmentView {
  id: string
  name: string
  size: number
  status: 'waiting' | 'uploading' | 'ready' | 'failed' | 'reattach'
  preview?: string
  error?: string
}
export interface ChatInteractionState {
  attachments: AttachmentView[]
  uploading: boolean
  transcribing: boolean
  pendingTranscript: string | null
  playback: PlaybackState
  submissionFeedback: string | null
  stopping: boolean
  stopFeedback: string | null
  attachmentRefs: string[]
  draft: string
  editTarget: EditTarget | null
  error: string | null
  slashItems: ChatSuggestion[]
  slashStatus: string | null
  submitting: boolean
}

export interface SlashCompletionPayload {
  items: Array<Omit<ChatSuggestion, 'insertText'>>
  replaceFrom?: number
}

export interface ChatInteractionCommands {
  isAvailable?(): boolean
  isCurrent?(context: DraftContext, runtimeId: string | null): boolean
  isRunning?(): boolean
  interrupt?(): Promise<void>
  attach(file: File, signal?: AbortSignal): Promise<string | undefined>
  completeSlash(draft: string): Promise<SlashCompletionPayload>
  retryFrom(rowId: number, text: string): Promise<void | SubmissionResult>
  send(text: string): Promise<void | SubmissionResult>
}
/** Chat audio rides the GatewayPort directly (installation-wide /api/audio routes, no profile param). */
export type ChatMediaConnection = Pick<GatewayPort, 'request' | 'upload'>

const initialState = (): ChatInteractionState => ({
  attachments: [], uploading: false, transcribing: false, pendingTranscript: null,
  playback: { messageId: null, status: 'idle', error: null },
  submissionFeedback: null, stopping: false, stopFeedback: null,
  attachmentRefs: [],
  draft: '',
  editTarget: null,
  error: null,
  slashItems: [],
  slashStatus: null,
  submitting: false
})

export class ChatInteraction {
  readonly $state = atom<ChatInteractionState>(initialState())

  private gatewayAvailable = true
  private disposed = false
  readonly playback: ChatPlayback
  private unsubscribePlayback: () => void
  private active = true
  private attachmentViews = new WeakMap<DraftAttachment, AttachmentView>()
  private previews = new Set<string>()
  private uploadTask: { controller: AbortController; end: () => void; current?: DraftAttachment; cancelCurrent?: () => void } | null = null
  private transcription: { controller: AbortController; end: () => void } | null = null
  private speechTask: (() => void) | null = null

  setActive(active: boolean) {
    this.active = active
    if (!active) this.playback.stop()
  }

  private retireUploads() {
    this.uploadTask?.controller.abort()
    this.uploadTask?.end()
    this.uploadTask = null
    for (const url of this.previews) URL.revokeObjectURL(url)
    this.previews.clear()
    this.attachmentViews = new WeakMap()
    this.patch({ uploading: false })
  }

  private retireMedia() {
    this.playback.stop()
    this.retireUploads()
    this.cancelTranscription()
  }

  setGatewayAvailable(available: boolean) {
    if (this.gatewayAvailable === available) return
    this.gatewayAvailable = available
    if (!available) {
      this.retireMedia()
      ++this.sessionEpoch
      ++this.draftRevision
      for (const release of this.tasks) release()
      this.tasks.clear()
      this.patch({ slashItems: [], slashStatus: null, pendingTranscript: null, submissionFeedback: null, stopping: false, stopFeedback: null, attachments: this.projectAttachments() })
    }
  }

  private remoteAvailable() { return this.gatewayAvailable && (this.commands.isAvailable?.() ?? true) }
  private draftRevision = 0
  private sessionEpoch = 0
  private sessionId: null | string = null
  private key: string | null = null
  private context: DraftContext | null = null
  private attachments: DraftAttachment[] = []
  private normal: DraftContent['normal'] = null
  private tasks = new Set<() => void>()

  constructor(
    private readonly commands: ChatInteractionCommands,
    private readonly media: ChatMediaConnection,
    readonly drafts = new ChatDrafts(null)
  ) {
    this.playback = new ChatPlayback(media)
    this.unsubscribePlayback = this.playback.$state.listen(playback => {
      if (playback.status === 'generating') this.speechTask ??= this.task()
      else { this.speechTask?.(); this.speechTask = null }
      this.patch({ playback })
    })
  }

  setSession(sessionId: null | string) {
    const owner: DraftOwner = { gateway: '', principal: null, generation: 0, locked: false }
    this.setContext({ owner, profile: null, conversation: sessionId ?? 'unselected', provisional: false }, sessionId)
  }

  setContext(context: DraftContext, runtimeId: string | null) {
    if (this.disposed) return
    this.drafts.setOwner(context.owner)
    const next = this.drafts.select(context)
    if (next.key === this.key && runtimeId === this.sessionId && context.owner.generation === this.context?.owner.generation) return
    let promoted = false
    if (this.key && this.context?.provisional && runtimeId === this.sessionId
      && this.context.owner.generation === context.owner.generation && this.context.profile === context.profile && !context.provisional) {
      this.key = this.drafts.promote(this.key, context)
      promoted = true
    } else this.key = next.key
    this.context = context
    if (promoted && JSON.stringify(this.record()?.content) === JSON.stringify(this.content())) return
    this.retireMedia()
    this.$state.set(initialState())
    this.sessionId = runtimeId
    this.sessionEpoch += 1
    this.draftRevision += 1
    for (const release of this.tasks) release()
    this.tasks.clear()
    this.load()
  }

  sync() {
    if (this.disposed) return
    const record = this.record()
    if (record && JSON.stringify(record.content) !== JSON.stringify(this.content())) {
      this.draftRevision += 1
      this.load()
    } else if (record) {
      const submitting = record.recoveries.some(item => item.status === 'pending')
      if (submitting !== this.$state.get().submitting) this.patch({ submitting })
    }
  }

  record() { return this.key ? this.drafts.read(this.key) : null }
  needsReattachment() { return this.attachments.some(item => !item.ref || item.runtimeId === null || item.runtimeId !== this.sessionId) }
  unsaved() { return this.key ? this.drafts.hasUnsaved(this.key) : false }
  saved() { return this.key ? this.drafts.isSaved(this.key) : false }

  recover(id: string) {
    if (!this.key) return
    this.drafts.restore(this.key, id)
    this.draftRevision += 1
    this.load()
  }

  discard(id?: string) {
    if (!this.key) return
    this.drafts.discard(this.key, id)
    this.draftRevision += 1
    this.load()
  }

  private load() {
    this.retireUploads()
    const record = this.record()
    const value = record?.content ?? emptyDraft()
    this.attachments = value.attachments
    this.normal = value.normal
    this.$state.set({ ...this.$state.get(), error: null, slashItems: [], slashStatus: null, draft: value.text,
      attachmentRefs: value.attachments.map(item => item.ref), attachments: this.projectAttachments(), editTarget: value.edit,
      submitting: Boolean(record?.recoveries.some(item => item.status === 'pending')) })
  }

  private content(): DraftContent {
    const value = this.$state.get()
    return { text: value.draft, attachments: this.attachments, edit: value.editTarget, normal: this.normal }
  }

  private save() { if (this.key) this.drafts.write(this.key, this.content()) }

  private task() {
    const release = this.key ? this.drafts.task(this.key) : () => undefined
    let ended = false
    const end = () => { if (ended) return; ended = true; release(); this.tasks.delete(end) }
    this.tasks.add(end)
    return end
  }

  updateDraft(value: string) {
    if (this.disposed) return
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    this.patch({ draft: value, slashItems: [], slashStatus: null })
    if (!value.startsWith('/') || !this.remoteAvailable()) return
    this.patch({ slashStatus: 'Loading suggestions…' })
    void this.commands.completeSlash(value).then(payload => {
      if (!this.isRevisionCurrent(epoch, revision)) return
      this.patch({
        slashStatus: payload.items.length ? null : 'No suggestions. You can continue typing.',
        slashItems: payload.items.map(item => ({
          ...item,
          insertText: completionInsertion(value, item.text, payload.replaceFrom)
        }))
      })
    }).catch(() => {
      if (this.isRevisionCurrent(epoch, revision)) {
        this.patch({ slashItems: [], slashStatus: 'Suggestions unavailable. Check your connection or try typing again.' })
      }
    })
  }

  dismissCompletions() {
    ++this.draftRevision
    this.patch({ slashItems: [], slashStatus: null })
  }

  chooseCompletion(index: number) {
    if (this.disposed) return
    const item = this.$state.get().slashItems[index]
    if (!item) return
    if (item.kind === 'model') {
      this.dismissCompletions()
      this.patch({ draft: `${item.insertText.trimEnd()} ` })
    } else {
      // Selecting a command immediately discovers its arguments/subcommands.
      this.updateDraft(`${item.insertText.trimEnd()} `)
    }
  }

  beginEdit(target: EditTarget) {
    if (this.disposed || this.commands.isRunning?.()) return
    this.retireUploads()
    this.draftRevision += 1
    if (!this.$state.get().editTarget) {
      const { normal: _normal, ...payload } = this.content()
      this.normal = payload
    }
    this.attachments = []
    this.patch({
      attachmentRefs: [],
      draft: target.content,
      editTarget: target,
      error: null,
      slashItems: [], slashStatus: null
    })
  }

  cancelEdit() {
    if (this.disposed) return
    this.retireUploads()
    this.draftRevision += 1
    const value = this.normal
    this.normal = null
    this.attachments = value?.attachments ?? []
    this.patch({ draft: value?.text ?? '', attachmentRefs: this.attachments.map(item => item.ref), editTarget: null, error: null, slashItems: [], slashStatus: null })
  }

  removeAttachment(id: string | number) {
    if (this.disposed) return
    const index = typeof id === 'number' ? id : this.attachments.findIndex(item => this.attachmentViews.get(item)?.id === id)
    const removed = this.attachments[index]
    if (!removed) return
    this.draftRevision += 1
    const view = removed && this.attachmentViews.get(removed)
    if (removed && this.uploadTask?.current === removed) this.uploadTask.cancelCurrent?.()
    if (view?.preview) { URL.revokeObjectURL(view.preview); this.previews.delete(view.preview) }
    this.attachments = this.attachments.filter((_, itemIndex) => itemIndex !== index)
    if (this.uploadTask && !this.attachments.some(item => ['waiting', 'uploading'].includes(this.attachmentViews.get(item)?.status ?? ''))) {
      this.uploadTask.controller.abort()
      this.uploadTask.end()
      this.uploadTask = null
      this.patch({ uploading: false })
    }
    this.patch({ attachmentRefs: this.attachments.map(item => item.ref) })
  }

  private projectAttachments(): AttachmentView[] {
    return this.attachments.map(item => {
      let view = this.attachmentViews.get(item)
      if (!view) {
        view = { id: crypto.randomUUID(), name: item.name, size: item.size,
          status: item.ref && item.runtimeId === this.sessionId ? 'ready' : 'reattach' }
        this.attachmentViews.set(item, view)
      }
      return view
    })
  }

  previewFailed(id: string) {
    const view = this.$state.get().attachments.find(item => item.id === id)
    if (!view?.preview) return
    URL.revokeObjectURL(view.preview); this.previews.delete(view.preview)
    delete view.preview
    this.patch({ attachments: this.projectAttachments() })
  }

  async submit() {
    if (this.disposed || this.$state.get().submitting) return
    if (!this.remoteAvailable()) { this.patch({ error: 'Reconnect and update this conversation before sending. Your draft has not been sent.' }); return }
    if (!this.contextCurrent()) { this.patch({ error: 'The conversation changed. Review your draft before sending.' }); return }
    if (this.$state.get().transcribing) { this.patch({ error: 'Wait for transcription or cancel it before sending.' }); return }
    if (this.$state.get().editTarget && this.commands.isRunning?.()) { this.patch({ error: 'Wait for this turn to finish before retrying an edited message.' }); return }
    if (this.needsReattachment()) { this.patch({ error: 'Select the attached files again or remove them before sending.' }); return }
    const snapshot = this.$state.get()
    if (/^\/model\s*$/i.test(snapshot.draft)) { this.updateDraft('/model '); return }
    if (snapshot.draft.trimStart().startsWith('/') && (snapshot.attachmentRefs.length || snapshot.editTarget)) {
      this.patch({ error: 'Run slash commands without attachments or an edited message.' }); return
    }
    const combined = [snapshot.draft.trim(), ...snapshot.attachmentRefs].filter(Boolean).join('\n')
    if (!combined) return
    const key = this.key
    const recoveryId = key ? this.drafts.beginSubmission(key) : null
    if (key && !recoveryId) { this.patch({ error: 'Draft recovery is locked. Reconnect before sending.' }); return }
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    this.retireUploads()
    this.attachments = []
    const normal = this.normal
    this.normal = null
    this.$state.set({ ...snapshot, uploading: false, attachments: [], attachmentRefs: [], draft: '', error: null, slashItems: [], slashStatus: null, editTarget: null, submitting: true,
      submissionFeedback: this.commands.isRunning?.() ? 'Submitting queued prompt…' : 'Sending…' })
    try {
      const outcome = snapshot.editTarget
        ? await this.commands.retryFrom(snapshot.editTarget.rowId, combined)
        : await this.commands.send(combined)
      if (outcome?.status === 'uncertain') {
        if (key && recoveryId) this.drafts.settleSubmission(key, recoveryId, 'uncertain')
        if (this.isCurrent(epoch)) this.patch({ submitting: false, submissionFeedback: null, error: 'Delivery not confirmed. Check the conversation before sending again.' })
        return
      }
      if (key && recoveryId) this.drafts.settleSubmission(key, recoveryId, 'success')
      if (!this.isCurrent(epoch)) {
        if (!this.disposed && this.key === key) this.patch({ submitting: Boolean(this.record()?.recoveries.some(item => item.status === 'pending')) })
        return
      }
      if (snapshot.editTarget && this.draftRevision === revision && normal) {
        this.normal = normal
        this.cancelEdit()
      }
      let feedback = outcome?.output || (outcome?.mode === 'command' ? 'Command completed.' : outcome?.mode === 'queue' ? 'Gateway accepted your queued prompt. Execution has not been confirmed.' : 'Gateway accepted your message.')
      if (outcome?.prefill !== undefined) {
        if (this.draftRevision === revision) this.patch({ draft: outcome.prefill })
        else feedback += `\nYour draft changed. Command text to copy:\n${outcome.prefill}`
      }
      this.patch({ submitting: false, submissionFeedback: feedback })
    } catch (caught) {
      const kind = classifyGatewayError(caught).kind
      const uncertain = kind === 'network' || kind === 'aborted'
      if (key && recoveryId) this.drafts.settleSubmission(key, recoveryId, uncertain ? 'uncertain' : 'failed')
      if (!this.isCurrent(epoch)) {
        if (!this.disposed && this.key === key) this.patch({ submitting: Boolean(this.record()?.recoveries.some(item => item.status === 'pending')) })
        return
      }
      if (!uncertain && this.draftRevision === revision && key && recoveryId) {
        this.drafts.restore(key, recoveryId)
        this.load()
      }
      this.patch({ error: uncertain ? 'Delivery not confirmed. Check the conversation before sending again.' : errorMessage(caught), submitting: false, submissionFeedback: null })
    }
  }

  async attach(files: FileList | readonly File[] | null) {
    if (this.disposed || !files?.length || this.uploadTask || !this.remoteAvailable()) return
    if (!this.contextCurrent()) { this.patch({ error: 'The conversation changed. Select the files again.' }); return }
    const epoch = this.sessionEpoch
    const selected = Array.from(files)
    this.draftRevision += 1
    this.attachments = this.attachments.filter(item => !(item.runtimeId !== this.sessionId || !item.ref)
      || !selected.some(file => file.name === item.name && file.type === item.type && file.size === item.size))
    // Reselection replaces only unresolved placeholders, never a ready file.
    for (const url of this.previews) {
      if (!this.attachments.some(item => this.attachmentViews.get(item)?.preview === url)) { URL.revokeObjectURL(url); this.previews.delete(url) }
    }
    const pending = selected.map(file => ({ ref: '', name: file.name, type: file.type, size: file.size, runtimeId: null } as DraftAttachment))
    pending.forEach((item, index) => {
      const file = selected[index]
      const view: AttachmentView = { id: crypto.randomUUID(), name: file.name, size: file.size, status: 'waiting' }
      if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(file.type) && file.size <= 20 * 1_024 * 1_024) {
        view.preview = URL.createObjectURL(file)
        this.previews.add(view.preview)
      }
      this.attachmentViews.set(item, view)
    })
    this.attachments = [...this.attachments, ...pending]
    const task: NonNullable<ChatInteraction['uploadTask']> = { controller: new AbortController(), end: this.task() }
    this.uploadTask = task
    this.patch({ error: null, uploading: true, attachmentRefs: this.attachments.map(item => item.ref) })
    try {
      for (const [index, file] of selected.entries()) {
        if (!this.isCurrent(epoch) || this.uploadTask !== task) return
        const item = pending[index]
        if (!this.attachments.includes(item)) continue
        const view = this.attachmentViews.get(item)!
        this.attachmentViews.set(item, { ...view, status: 'uploading' })
        this.patch({ attachments: this.projectAttachments() })
        const controller = new AbortController()
        let retire!: (value: undefined) => void
        const retired = new Promise<undefined>(resolve => { retire = resolve })
        // Removing a file retires local waiting even if a native adapter cannot cancel remote work.
        const cancel = () => { controller.abort(); retire(undefined) }
        task.current = item
        task.cancelCurrent = cancel
        task.controller.signal.addEventListener('abort', cancel, { once: true })
        try {
          const reference = await Promise.race([this.commands.attach(file, controller.signal), retired])
          if (!this.isCurrent(epoch) || this.uploadTask !== task) return
          if (!this.attachments.includes(item)) continue
          if (typeof reference !== 'string' || !reference.trim()) throw new Error('Upload was not confirmed. Select this file again or remove it.')
          const completed = { ...item, ref: reference, runtimeId: this.sessionId }
          this.attachmentViews.set(completed, { ...this.attachmentViews.get(item)!, status: 'ready' })
          this.attachments = this.attachments.map(value => value === item ? completed : value)
          this.patch({ attachmentRefs: this.attachments.map(item => item.ref) })
        } catch (caught) {
          if (!this.isCurrent(epoch) || this.uploadTask !== task) return
          if (!this.attachments.includes(item)) continue
          const error = errorMessage(caught)
          this.attachmentViews.set(item, { ...this.attachmentViews.get(item)!, status: 'failed', error })
          this.patch({ attachments: this.projectAttachments(), error: `${file.name}: ${error}` })
        } finally {
          task.controller.signal.removeEventListener('abort', cancel)
          if (task.current === item) { task.current = undefined; task.cancelCurrent = undefined }
        }
      }
    } finally {
      task.end()
      if (this.uploadTask === task) { this.uploadTask = null; this.patch({ uploading: false }) }
    }
  }

  async transcribe(file: File | undefined) {
    if (this.disposed || !file || this.transcription || !this.remoteAvailable()) return
    if (!this.contextCurrent()) { this.patch({ error: 'The conversation changed. Select the recording again.' }); return }
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    const task = { controller: new AbortController(), end: this.task() }
    this.transcription = task
    const current = () => this.isCurrent(epoch) && this.transcription === task
    this.patch({ error: null, transcribing: true, pendingTranscript: null, slashItems: [], slashStatus: null })
    try {
      if (file.size > 25 * 1_024 * 1_024) {
        throw new Error('Audio attachments are limited to 25 MB on mobile.')
      }
      const dataBase64 = await fileToBase64(file)
      if (!current()) return
      const response = await this.media.upload<{ transcript?: unknown }>({
        contentType: file.type,
        dataBase64,
        field: 'file',
        filename: file.name,
        path: '/api/audio/transcribe', signal: task.controller.signal
      })
      if (!current()) return
      const transcript = response.body?.transcript
      if (typeof transcript !== 'string' || !transcript.trim()) throw new Error('The transcription response did not include a transcript.')
      if (this.draftRevision === revision) this.updateDraft(transcript)
      else this.patch({ pendingTranscript: transcript })
    } catch (caught) {
      if (current()) this.patch({ error: errorMessage(caught) })
    } finally {
      task.end()
      if (this.transcription === task) { this.transcription = null; this.patch({ transcribing: false }) }
    }
  }

  cancelTranscription() {
    this.transcription?.controller.abort()
    this.transcription?.end()
    this.transcription = null
    this.patch({ transcribing: false })
  }

  useTranscript() {
    const transcript = this.$state.get().pendingTranscript
    if (!transcript || this.disposed || !this.contextCurrent()) return
    const draft = this.$state.get().draft
    this.updateDraft(draft ? `${draft}\n${transcript}` : transcript)
    this.dismissTranscript()
  }
  dismissTranscript() { this.patch({ pendingTranscript: null }) }

  async interrupt() {
    if (this.disposed || this.$state.get().stopping || !this.remoteAvailable() || !this.contextCurrent() || !this.commands.interrupt) return
    const epoch = this.sessionEpoch
    this.patch({ stopping: true, stopFeedback: 'Requesting stop…' })
    try {
      await this.commands.interrupt()
      if (this.isCurrent(epoch)) this.patch({ stopFeedback: 'Stop requested. Queued prompts may still run.' })
    } catch (error) {
      if (this.isCurrent(epoch)) this.patch({ stopFeedback: null, error: `Stop was not confirmed: ${errorMessage(error)}` })
    } finally { if (this.isCurrent(epoch)) this.patch({ stopping: false }) }
  }

  async speak(text: string, messageId = text) {
    if (this.disposed || !this.active || !this.remoteAvailable() || !this.contextCurrent()) return
    const epoch = this.sessionEpoch
    await this.playback.speak(messageId, text, () => this.isCurrent(epoch) && this.active)
  }

  dispose() {
    if (this.disposed) return
    this.retireMedia()
    this.unsubscribePlayback()
    this.drafts.flush()
    for (const release of this.tasks) release()
    this.tasks.clear()
    this.disposed = true
    this.sessionEpoch += 1
    this.draftRevision += 1
  }

  private contextCurrent() {
    return !this.context || (!this.context.owner.locked && (this.commands.isCurrent?.(this.context, this.sessionId) ?? true))
  }

  private isCurrent(epoch: number) {
    return !this.disposed && epoch === this.sessionEpoch && this.contextCurrent()
  }

  private isRevisionCurrent(epoch: number, revision: number) {
    return this.isCurrent(epoch) && revision === this.draftRevision
  }

  private patch(patch: Partial<ChatInteractionState>) {
    if (!this.disposed) {
      this.$state.set({ ...this.$state.get(), ...patch, ...('attachmentRefs' in patch ? { attachments: this.projectAttachments() } : {}) })
      if ('draft' in patch || 'attachmentRefs' in patch || 'editTarget' in patch) this.save()
    }
  }
}

function completionInsertion(draft: string, text: string, replaceFrom: number | undefined) {
  if (typeof replaceFrom === 'number' && replaceFrom > 1 && replaceFrom <= draft.length) {
    return `${draft.slice(0, replaceFrom)}${text}`
  }
  return text.startsWith('/') ? text : `/${text}`
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
