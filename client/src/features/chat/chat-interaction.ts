import { atom } from 'nanostores'

import { errorMessage } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'

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
  attach(file: File): Promise<string | undefined>
  completeSlash(draft: string): Promise<SlashCompletionPayload>
  retryFrom(rowId: number, text: string): Promise<void>
  send(text: string): Promise<void>
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

  private disposed = false
  private draftRevision = 0
  private sessionEpoch = 0
  private sessionId: null | string = null

  constructor(
    private readonly commands: ChatInteractionCommands,
    private readonly media: ChatMediaConnection
  ) {}

  setSession(sessionId: null | string) {
    if (this.disposed || sessionId === this.sessionId) return
    this.sessionId = sessionId
    this.sessionEpoch += 1
    this.draftRevision += 1
    const { draft } = this.$state.get()
    this.$state.set({ ...initialState(), draft })
  }

  updateDraft(value: string) {
    if (this.disposed) return
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
    this.patch({ draft: value })
    if (!value.startsWith('/')) {
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
    this.patch({ draft: '', editTarget: null, error: null, slashItems: [] })
  }

  removeAttachment(index: number) {
    if (this.disposed) return
    this.patch({ attachmentRefs: this.$state.get().attachmentRefs.filter((_, itemIndex) => itemIndex !== index) })
  }

  async submit() {
    if (this.disposed || this.$state.get().submitting) return
    const snapshot = this.$state.get()
    const combined = [snapshot.draft.trim(), ...snapshot.attachmentRefs].filter(Boolean).join('\n')
    if (!combined) return

    const epoch = this.sessionEpoch
    this.draftRevision += 1
    this.$state.set({
      ...snapshot,
      attachmentRefs: [],
      draft: '',
      error: null,
      slashItems: [],
      submitting: true
    })

    try {
      if (snapshot.editTarget) {
        await this.commands.retryFrom(snapshot.editTarget.rowId, combined)
      } else {
        await this.commands.send(combined)
      }
      if (!this.isCurrent(epoch)) return
      this.patch({ editTarget: null, submitting: false })
    } catch (caught) {
      if (!this.isCurrent(epoch)) return
      this.$state.set({
        attachmentRefs: [...snapshot.attachmentRefs],
        draft: snapshot.draft,
        editTarget: snapshot.editTarget,
        error: errorMessage(caught),
        slashItems: [...snapshot.slashItems],
        submitting: false
      })
    }
  }

  async attach(files: FileList | readonly File[] | null) {
    if (this.disposed || !files) return
    const epoch = this.sessionEpoch
    this.patch({ error: null })
    for (const file of Array.from(files)) {
      if (!this.isCurrent(epoch)) return
      try {
        const reference = await this.commands.attach(file)
        if (!this.isCurrent(epoch) || reference === undefined) return
        this.patch({ attachmentRefs: [...this.$state.get().attachmentRefs, reference] })
      } catch (caught) {
        if (!this.isCurrent(epoch)) return
        this.patch({ error: errorMessage(caught) })
      }
    }
  }

  async transcribe(file: File | undefined) {
    if (this.disposed || !file) return
    const epoch = this.sessionEpoch
    const revision = ++this.draftRevision
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
    }
  }

  async speak(text: string) {
    if (this.disposed) return
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
    this.disposed = true
    this.sessionEpoch += 1
    this.draftRevision += 1
  }

  private isCurrent(epoch: number) {
    return !this.disposed && epoch === this.sessionEpoch
  }

  private isRevisionCurrent(epoch: number, revision: number) {
    return this.isCurrent(epoch) && revision === this.draftRevision
  }

  private patch(patch: Partial<ChatInteractionState>) {
    if (!this.disposed) this.$state.set({ ...this.$state.get(), ...patch })
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
