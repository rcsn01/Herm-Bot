import { atom } from 'nanostores'

import type { HermesConnectionPlugin } from '~/native/hermes-connection'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'

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
  userOrdinal: number
}

export interface ChatInteractionState {
  attachmentRefs: string[]
  draft: string
  editTarget: EditTarget | null
  error: string | null
  slashItems: ChatSuggestion[]
  submitting: boolean
}

export type ChatInteractionCommands = Pick<GatewayController, 'attach' | 'request' | 'retryFrom' | 'send'>
export type ChatMediaConnection = Pick<HermesConnectionPlugin, 'request' | 'upload'>

interface SlashCompletionResponse {
  items?: Array<Omit<ChatSuggestion, 'insertText'>>
  replace_from?: number
}

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
  private mediaGeneration = 0
  private sessionEpoch = 0
  private sessionId: null | string = null
  private slashCompletionGeneration = 0

  constructor(
    private readonly commands: ChatInteractionCommands,
    private readonly media: ChatMediaConnection
  ) {}

  setSession(sessionId: null | string) {
    if (this.disposed || sessionId === this.sessionId) return
    this.sessionId = sessionId
    this.sessionEpoch += 1
    this.mediaGeneration += 1
    this.slashCompletionGeneration += 1
    const { draft } = this.$state.get()
    this.$state.set({ ...initialState(), draft })
  }

  updateDraft(value: string) {
    if (this.disposed) return
    const epoch = this.sessionEpoch
    const generation = ++this.slashCompletionGeneration
    this.mediaGeneration += 1
    this.patch({ draft: value })
    if (!value.startsWith('/')) {
      this.patch({ slashItems: [] })
      return
    }

    void this.commands.request<SlashCompletionResponse>('complete.slash', { text: value }).then(result => {
      if (!this.isCurrent(epoch) || generation !== this.slashCompletionGeneration) return
      this.patch({
        slashItems: (result.items ?? []).map(item => ({
          ...item,
          insertText: completionInsertion(value, item.text, result.replace_from)
        }))
      })
    }).catch(() => {
      if (this.isCurrent(epoch) && generation === this.slashCompletionGeneration) {
        this.patch({ slashItems: [] })
      }
    })
  }

  chooseCompletion(index: number) {
    if (this.disposed) return
    const item = this.$state.get().slashItems[index]
    if (!item) return
    this.slashCompletionGeneration += 1
    this.mediaGeneration += 1
    this.patch({ draft: `${item.insertText} `, slashItems: [] })
  }

  beginEdit(target: EditTarget) {
    if (this.disposed) return
    this.slashCompletionGeneration += 1
    this.mediaGeneration += 1
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
    this.slashCompletionGeneration += 1
    this.mediaGeneration += 1
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
    this.slashCompletionGeneration += 1
    this.mediaGeneration += 1
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
        await this.commands.retryFrom(snapshot.editTarget.userOrdinal, snapshot.editTarget.rowId, combined)
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
        const result = await this.commands.attach(file) as { ref_text?: string; text?: string }
        if (!this.isCurrent(epoch)) return
        const reference = result.ref_text ?? result.text ?? `@file:${file.name}`
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
    const generation = ++this.mediaGeneration
    this.patch({ error: null })
    try {
      if (file.size > 25 * 1_024 * 1_024) {
        throw new Error('Audio attachments are limited to 25 MB on mobile.')
      }
      const dataBase64 = await fileToBase64(file)
      if (!this.isMediaCurrent(epoch, generation)) return
      const response = await this.media.upload<{ transcript?: string }>({
        contentType: file.type,
        dataBase64,
        field: 'file',
        filename: file.name,
        path: '/api/audio/transcribe'
      })
      if (!this.isMediaCurrent(epoch, generation)) return
      const transcript = response.body.transcript
      if (!transcript) throw new Error('The transcription response did not include a transcript.')
      this.patch({ draft: transcript })
    } catch (caught) {
      if (this.isMediaCurrent(epoch, generation)) this.patch({ error: errorMessage(caught) })
    }
  }

  async speak(text: string) {
    if (this.disposed) return
    const epoch = this.sessionEpoch
    const generation = ++this.mediaGeneration
    this.patch({ error: null })
    try {
      const response = await this.media.request<{ data_url?: string }>({
        body: { text },
        method: 'POST',
        path: '/api/audio/speak'
      })
      if (!this.isMediaCurrent(epoch, generation)) return
      const audioURL = response.body.data_url
      if (!audioURL) throw new Error('The speech response did not include audio.')
      await new Audio(audioURL).play()
    } catch (caught) {
      if (this.isMediaCurrent(epoch, generation)) this.patch({ error: errorMessage(caught) })
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.sessionEpoch += 1
    this.mediaGeneration += 1
    this.slashCompletionGeneration += 1
  }

  private isCurrent(epoch: number) {
    return !this.disposed && epoch === this.sessionEpoch
  }

  private isMediaCurrent(epoch: number, generation: number) {
    return this.isCurrent(epoch) && generation === this.mediaGeneration
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
