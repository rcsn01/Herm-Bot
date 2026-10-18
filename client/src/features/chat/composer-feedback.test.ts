import { beforeEach, expect, it, vi } from 'vitest'
import { ChatInteraction, type ChatInteractionCommands, type ChatMediaConnection, type SubmissionResult } from './chat-interaction'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const response = <T>(body: T) => ({ body, headers: {}, status: 200 })
function subject() {
  const commands = { attach: vi.fn(), completeSlash: vi.fn(), send: vi.fn(), retryFrom: vi.fn(), interrupt: vi.fn(), isRunning: vi.fn(() => false) } satisfies ChatInteractionCommands
  const media = { request: vi.fn<ChatMediaConnection['request']>(), upload: vi.fn<ChatMediaConnection['upload']>() }
  const interaction = new ChatInteraction(commands, media as ChatMediaConnection)
  interaction.setSession('a')
  return { interaction, commands, media }
}
beforeEach(() => {
  vi.stubGlobal('FileReader', class {
    onload: (() => void) | null = null
    result = 'data:audio/wav;base64,AA=='
    readAsDataURL() { queueMicrotask(() => this.onload?.()) }
  })
  vi.stubGlobal('Audio', class { play = vi.fn().mockResolvedValue(undefined); pause = vi.fn() })
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:local-preview'); static revokeObjectURL = vi.fn() })
})

it('projects waiting/uploading states, blocks overlapping batches, and preserves stable IDs', async () => {
  const { interaction, commands } = subject()
  const upload = deferred<string>()
  commands.attach.mockReturnValueOnce(upload.promise).mockResolvedValueOnce('@file:two')
  const first = interaction.attach([new File(['1'], 'one.txt'), new File(['2'], 'two.txt')])
  const [one, two] = interaction.$state.get().attachments
  expect([one.status, two.status]).toEqual(['uploading', 'waiting'])
  expect(interaction.drafts.hasActiveWork()).toBe(true)
  await interaction.attach([new File(['duplicate'], 'duplicate.txt')])
  expect(commands.attach).toHaveBeenCalledOnce()
  upload.resolve('@file:one'); await first
  expect(interaction.$state.get().attachments.map(file => [file.id, file.status])).toEqual([[one.id, 'ready'], [two.id, 'ready']])
  expect(interaction.drafts.hasActiveWork()).toBe(false)
})

it('removing a pending file prevents resurrection while later files still upload', async () => {
  const { interaction, commands } = subject()
  const upload = deferred<string>()
  commands.attach.mockReturnValueOnce(upload.promise).mockResolvedValueOnce('@file:two')
  const pending = interaction.attach([new File(['1'], 'one.txt'), new File(['2'], 'two.txt')])
  interaction.removeAttachment(interaction.$state.get().attachments[0].id)
  await pending
  expect(commands.attach).toHaveBeenCalledTimes(2)
  upload.resolve('@file:removed')
  await Promise.resolve()
  expect(interaction.$state.get().attachments.map(file => file.name)).toEqual(['two.txt'])
  expect(interaction.$state.get().attachmentRefs).toEqual(['@file:two'])
})

it('removing the last pending file aborts and releases the task without waiting for the gateway', async () => {
  const { interaction, commands } = subject()
  const upload = deferred<string>()
  commands.attach.mockReturnValue(upload.promise)
  const pending = interaction.attach([new File(['1'], 'one.txt')])
  interaction.removeAttachment(interaction.$state.get().attachments[0].id)
  expect(interaction.$state.get().uploading).toBe(false)
  expect(interaction.drafts.hasActiveWork()).toBe(false)
  upload.resolve('@file:removed'); await pending
  expect(interaction.$state.get().attachments).toEqual([])
})

it('a decode failure while uploading cannot restore a revoked preview at completion', async () => {
  const { interaction, commands } = subject()
  const upload = deferred<string>()
  commands.attach.mockReturnValue(upload.promise)
  const pending = interaction.attach([new File(['image'], 'one.png', { type: 'image/png' })])
  interaction.previewFailed(interaction.$state.get().attachments[0].id)
  upload.resolve('@image:one'); await pending
  expect(interaction.$state.get().attachments[0]).toMatchObject({ status: 'ready' })
  expect(interaction.$state.get().attachments[0].preview).toBeUndefined()
})

it.each(['remove', 'submit', 'switch', 'dispose', 'decode'] as const)('releases local preview on %s without persisting the URL', async action => {
  const { interaction, commands } = subject()
  commands.attach.mockResolvedValue('@image:one')
  await interaction.attach([new File(['image'], 'one.png', { type: 'image/png' })])
  const file = interaction.$state.get().attachments[0]
  expect(file.preview).toBe('blob:local-preview')
  expect(JSON.stringify(interaction.record())).not.toContain('blob:')
  if (action === 'remove') interaction.removeAttachment(file.id)
  if (action === 'submit') await interaction.submit()
  if (action === 'switch') interaction.setSession('b')
  if (action === 'dispose') interaction.dispose()
  if (action === 'decode') interaction.previewFailed(file.id)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview')
})

it('does not preview SVG and restores metadata without preview resources', async () => {
  const { interaction, commands } = subject()
  commands.attach.mockResolvedValue('@file:vector')
  await interaction.attach([new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' })])
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  interaction.setSession('b'); interaction.setSession('a')
  expect(interaction.$state.get().attachments[0]).toMatchObject({ name: 'vector.svg', status: 'ready' })
  expect(interaction.$state.get().attachments[0].preview).toBeUndefined()
})

it('retains a late transcript for explicit append, and guards duplicates and submission during transcription', async () => {
  const { interaction, commands, media } = subject()
  const result = deferred<ReturnType<typeof response<{ transcript: string }>>>()
  media.upload.mockReturnValue(result.promise)
  interaction.updateDraft('original')
  const pending = interaction.transcribe(new File(['audio'], 'voice.wav'))
  await vi.waitFor(() => expect(media.upload).toHaveBeenCalledOnce())
  await interaction.transcribe(new File(['again'], 'again.wav'))
  await interaction.submit()
  expect(commands.send).not.toHaveBeenCalled()
  interaction.updateDraft('new typing')
  result.resolve(response({ transcript: 'spoken words' })); await pending
  expect(media.upload).toHaveBeenCalledOnce()
  expect(interaction.$state.get()).toMatchObject({ draft: 'new typing', transcribing: false, pendingTranscript: 'spoken words' })
  interaction.useTranscript()
  expect(interaction.$state.get()).toMatchObject({ draft: 'new typing\nspoken words', pendingTranscript: null })
  expect(interaction.record()?.content.text).toBe('new typing\nspoken words')
})

it('local transcription Cancel releases work immediately and ignores late data', async () => {
  const { interaction, media } = subject()
  const result = deferred<ReturnType<typeof response<{ transcript: string }>>>()
  media.upload.mockReturnValue(result.promise)
  const pending = interaction.transcribe(new File(['audio'], 'voice.wav'))
  await vi.waitFor(() => expect(media.upload).toHaveBeenCalledOnce())
  const signal = media.upload.mock.calls[0][0].signal as AbortSignal
  interaction.cancelTranscription()
  expect(signal.aborted).toBe(true)
  expect(interaction.drafts.hasActiveWork()).toBe(false)
  result.resolve(response({ transcript: 'cancelled' })); await pending
  expect(interaction.$state.get()).toMatchObject({ draft: '', pendingTranscript: null, transcribing: false })
})

it('keeps accepted queues quiet and Stop independently guarded', async () => {
  const { interaction, commands } = subject()
  const sent = deferred<SubmissionResult>()
  const stopped = deferred<void>()
  commands.isRunning.mockReturnValue(true)
  commands.send.mockReturnValue(sent.promise)
  commands.interrupt.mockReturnValue(stopped.promise)
  interaction.updateDraft('next task')
  const submitting = interaction.submit()
  const stopping = interaction.interrupt()
  await interaction.interrupt(); await interaction.submit()
  expect(commands.send).toHaveBeenCalledOnce()
  expect(commands.interrupt).toHaveBeenCalledOnce()
  interaction.updateDraft('new typing')
  commands.isRunning.mockReturnValue(false)
  sent.resolve({ status: 'accepted', mode: 'queue' }); await submitting
  expect(interaction.$state.get()).toMatchObject({ draft: 'new typing', submissionFeedback: null, stopping: true })
  stopped.resolve(); await stopping
  expect(interaction.$state.get().stopFeedback).toContain('Queued prompts may still run')
})

it('keeps files selected for the next message while an edited retry is awaiting acknowledgement', async () => {
  const { interaction, commands } = subject()
  const retry = deferred<SubmissionResult>()
  commands.retryFrom.mockReturnValue(retry.promise)
  commands.attach.mockResolvedValue('@file:next')
  interaction.updateDraft('normal draft')
  interaction.beginEdit({ rowId: 1, content: 'edited message' })
  const pending = interaction.submit()
  await interaction.attach([new File(['next'], 'next.txt')])
  retry.resolve({ status: 'accepted', mode: 'retry' }); await pending
  expect(interaction.$state.get().attachmentRefs).toEqual(['@file:next'])
  expect(interaction.$state.get().draft).toBe('')
})

it('rejects edit-and-retry during a turn even through a direct method call', async () => {
  const { interaction, commands } = subject()
  interaction.beginEdit({ rowId: 1, content: 'old' })
  commands.isRunning.mockReturnValue(true)
  await interaction.submit()
  expect(commands.retryFrom).not.toHaveBeenCalled()
  expect(interaction.$state.get().draft).toBe('old')
})

it('typing does not invalidate speech; hidden workspace stops generation and releases tasks', async () => {
  const { interaction, media } = subject()
  const audio = deferred<ReturnType<typeof response<{ data_url: string }>>>()
  media.request.mockReturnValue(audio.promise)
  const pending = interaction.speak('spoken answer', 'message-1')
  interaction.updateDraft('new typing')
  audio.resolve(response({ data_url: 'data:audio/wav;base64,AA==' })); await pending
  expect(interaction.$state.get().playback.status).toBe('playing')
  interaction.setActive(false)
  expect(interaction.$state.get().playback.status).toBe('idle')
  interaction.setActive(true)
  const next = deferred<ReturnType<typeof response<{ data_url: string }>>>()
  media.request.mockReturnValue(next.promise)
  const generating = interaction.speak('another', 'message-2')
  expect(interaction.drafts.hasActiveWork()).toBe(true)
  interaction.setActive(false)
  expect(interaction.drafts.hasActiveWork()).toBe(false)
  next.resolve(response({ data_url: 'data:audio/wav;base64,AA==' })); await generating
  expect(interaction.$state.get().playback.status).toBe('idle')
})
