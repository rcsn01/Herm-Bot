import { atom } from 'nanostores'

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

export interface ChatInteractionState {
  attachmentRefs: string[]
  draft: string
  editTarget: EditTarget | null
  error: string | null
  slashItems: ChatSuggestion[]
  submitting: boolean
}

export interface SlashCompletionPayload {
  items: Array<Omit<ChatSuggestion, 'insertText'>>
  replaceFrom?: number
}

export interface ChatInteractionCommands {
  isAvailable?(): boolean
  isCurrent?(context: DraftContext, runtimeId: string | null): boolean
  attach(file: File): Promise<string | undefined>
  completeSlash(draft: string): Promise<SlashCompletionPayload>
  retryFrom(rowId: number, text: string): Promise<void | 'accepted' | 'uncertain'>
  send(text: string): Promise<void | 'accepted' | 'uncertain'>
}
/** Chat audio rides the GatewayPort directly (installation-wide /api/audio routes, no profile param). */
export type ChatMediaConnection = Pick<GatewayPort, 'request' | 'upload'>

const initialState = (): ChatInteractionState => ({
  attachmentRefs: [],
  draft: '',
  editTarget: null,
  error: null,
  slashItems: [],
  submitting: false
})

export class ChatInteraction {
  readonly $state = atom<ChatInteractionState>(initialState())

  private gatewayAvailable = true
  private disposed = false

  setGatewayAvailable(available: boolean) {
    if (this.gatewayAvailable === available) return
    this.gatewayAvailable = available
    if (!available) {
      ++this.sessionEpoch
      ++this.draftRevision
      for (const release of this.tasks) release()
      this.tasks.clear()
      this.patch({ slashItems: [] })
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
  ) {}

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
    const record = this.record()
    const value = record?.content ?? emptyDraft()
    this.attachments = value.attachments
    this.normal = value.normal
    this.$state.set({ ...initialState(), draft: value.text, attachmentRefs: value.attachments.map(item => item.ref), editTarget: value.edit,
      submitting: Boolean(record?.recoveries.some(item => item.status === 'pending')) })
  }

  private content(): DraftContent {
    const value = this.$state.get()
    return { text: value.draft, attachments: this.attachments, edit: value.editTarget, normal: this.normal }
  }

  private save() { if (this.key) this.drafts.write(this.key, this.content()) }

  private task() {
    const release = this.key ? this.drafts.task(this.key) : () => undefined
    const end = () => { release(); this.tasks.delete(end) }
    this.tasks.add(end)
    return end
  }

  updateDraft(value: string) {
    if (this.disposed) return
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    this.patch({ draft: value })
    if (!value.startsWith('/') || !this.remoteAvailable()) {
      this.patch({ slashItems: [] })
      return
    }

    void this.commands.completeSlash(value).then(payload => {
      if (!this.isRevisionCurrent(epoch, revision)) return
      this.patch({
        slashItems: payload.items.map(item => ({
          ...item,
          insertText: completionInsertion(value, item.text, payload.replaceFrom)
        }))
      })
    }).catch(() => {
      if (this.isRevisionCurrent(epoch, revision)) {
        this.patch({ slashItems: [] })
      }
    })
  }

  chooseCompletion(index: number) {
    if (this.disposed) return
    const item = this.$state.get().slashItems[index]
    if (!item) return
    this.draftRevision += 1
    this.patch({ draft: `${item.insertText} `, slashItems: [] })
  }

  beginEdit(target: EditTarget) {
    if (this.disposed) return
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
      slashItems: []
    })
  }

  cancelEdit() {
    if (this.disposed) return
    this.draftRevision += 1
    const value = this.normal
    this.normal = null
    this.attachments = value?.attachments ?? []
    this.patch({ draft: value?.text ?? '', attachmentRefs: this.attachments.map(item => item.ref), editTarget: null, error: null, slashItems: [] })
  }

  removeAttachment(index: number) {
    if (this.disposed) return
    this.attachments = this.attachments.filter((_, itemIndex) => itemIndex !== index)
    this.patch({ attachmentRefs: this.attachments.map(item => item.ref) })
  }

  async submit() {
    if (this.disposed || this.$state.get().submitting) return
    if (!this.remoteAvailable()) { this.patch({ error: 'Reconnect and update this conversation before sending. Your draft has not been sent.' }); return }
    if (!this.contextCurrent()) { this.patch({ error: 'The conversation changed. Review your draft before sending.' }); return }
    if (this.needsReattachment()) { this.patch({ error: 'Select the attached files again or remove them before sending.' }); return }
    const snapshot = this.$state.get()
    const combined = [snapshot.draft.trim(), ...snapshot.attachmentRefs].filter(Boolean).join('\n')
    if (!combined) return
    const key = this.key
    const recoveryId = key ? this.drafts.beginSubmission(key) : null
    if (key && !recoveryId) { this.patch({ error: 'Draft recovery is locked. Reconnect before sending.' }); return }
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    this.attachments = []
    const normal = this.normal
    this.normal = null
    this.$state.set({ ...snapshot, attachmentRefs: [], draft: '', error: null, slashItems: [], editTarget: null, submitting: true })
    try {
      const outcome = snapshot.editTarget
        ? await this.commands.retryFrom(snapshot.editTarget.rowId, combined)
        : await this.commands.send(combined)
      if (outcome === 'uncertain') {
        if (key && recoveryId) this.drafts.settleSubmission(key, recoveryId, 'uncertain')
        if (this.isCurrent(epoch)) this.patch({ submitting: false, error: 'Delivery not confirmed. Check the conversation before sending again.' })
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
      this.patch({ submitting: false })
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
      this.patch({ error: uncertain ? 'Delivery not confirmed. Check the conversation before sending again.' : errorMessage(caught), submitting: false })
    }
  }

  async attach(files: FileList | readonly File[] | null) {
    if (this.disposed || !files || !this.remoteAvailable()) return
    if (!this.contextCurrent()) { this.patch({ error: 'The conversation changed. Select the files again.' }); return }
    const epoch = this.sessionEpoch
    const selected = Array.from(files)
    this.attachments = this.attachments.filter(item => !(item.runtimeId !== this.sessionId || !item.ref)
      || !selected.some(file => file.name === item.name && file.type === item.type && file.size === item.size))
    const pending = selected.map(file => ({ ref: '', name: file.name, type: file.type, size: file.size, runtimeId: null } as DraftAttachment))
    this.attachments = [...this.attachments, ...pending]
    this.patch({ error: null, attachmentRefs: this.attachments.map(item => item.ref) })
    const end = this.task()
    try {
      for (const [index, file] of selected.entries()) {
        if (!this.isCurrent(epoch)) return
        try {
          const reference = await this.commands.attach(file)
          if (!this.isCurrent(epoch)) return
          if (reference === undefined) { this.patch({ error: 'Upload was not confirmed. Select this file again or remove it.' }); return }
          const position = this.attachments.indexOf(pending[index])
          if (position < 0) continue
          this.attachments = this.attachments.map((item, itemIndex) => itemIndex === position ? { ...item, ref: reference, runtimeId: this.sessionId } : item)
          this.patch({ attachmentRefs: this.attachments.map(item => item.ref) })
        } catch (caught) {
          if (!this.isCurrent(epoch)) return
          this.patch({ error: errorMessage(caught) })
        }
      }
    } finally { end() }
  }

  async transcribe(file: File | undefined) {
    if (this.disposed || !file || !this.remoteAvailable()) return
    if (!this.contextCurrent()) { this.patch({ error: 'The conversation changed. Select the recording again.' }); return }
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    const end = this.task()
    this.patch({ error: null })
    try {
      if (file.size > 25 * 1_024 * 1_024) {
        throw new Error('Audio attachments are limited to 25 MB on mobile.')
      }
      const dataBase64 = await fileToBase64(file)
      if (!this.isRevisionCurrent(epoch, revision)) return
      const response = await this.media.upload<{ transcript?: string }>({
        contentType: file.type,
        dataBase64,
        field: 'file',
        filename: file.name,
        path: '/api/audio/transcribe'
      })
      if (!this.isRevisionCurrent(epoch, revision)) return
      const transcript = response.body.transcript
      if (!transcript) throw new Error('The transcription response did not include a transcript.')
      this.patch({ draft: transcript })
    } catch (caught) {
      if (this.isRevisionCurrent(epoch, revision)) this.patch({ error: errorMessage(caught) })
    } finally { end() }
  }

  async speak(text: string) {
    if (this.disposed || !this.remoteAvailable()) return
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    this.patch({ error: null })
    try {
      const response = await this.media.request<{ data_url?: string }>({
        body: { text },
        method: 'POST',
        path: '/api/audio/speak'
      })
      if (!this.isRevisionCurrent(epoch, revision)) return
      const audioURL = response.body.data_url
      if (!audioURL) throw new Error('The speech response did not include audio.')
      await new Audio(audioURL).play()
    } catch (caught) {
      if (this.isRevisionCurrent(epoch, revision)) this.patch({ error: errorMessage(caught) })
    }
  }

  dispose() {
    if (this.disposed) return
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
      this.$state.set({ ...this.$state.get(), ...patch })
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
