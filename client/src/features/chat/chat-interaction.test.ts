import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ChatInteraction,
  type ChatInteractionCommands,
  type ChatMediaConnection
} from '~/features/chat/chat-interaction'

interface Deferred<T> {
  promise: Promise<T>
  reject: (reason?: unknown) => void
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

function commandAdapter() {
  return {
    attach: vi.fn(),
    request: vi.fn(),
    retryFrom: vi.fn(),
    send: vi.fn()
  } as unknown as ChatInteractionCommands
}

function mediaAdapter() {
  return {
    request: vi.fn(),
    upload: vi.fn()
  } as unknown as ChatMediaConnection
}

function interaction() {
  const commands = commandAdapter()
  const media = mediaAdapter()
  const value = new ChatInteraction(commands, media)
  value.setSession('session-1')
  return { commands, interaction: value, media }
}

const response = <T>(body: T) => ({ body, headers: {}, status: 200 })

beforeEach(() => {
  vi.stubGlobal('FileReader', class {
    error = null
    onerror: (() => void) | null = null
    onload: (() => void) | null = null
    result: string | null = null

    readAsDataURL() {
      this.result = 'data:audio/mp4;base64,dm9pY2U='
      queueMicrotask(() => this.onload?.())
    }
  })
})

describe('session state', () => {
  it('preserves typed text and clears session-bound state on a session switch', async () => {
    const { commands, interaction: subject } = interaction()
    vi.mocked(commands.attach).mockResolvedValue({ ref_text: '@file:one' })
    await subject.attach([new File(['one'], 'one.txt')])
    subject.beginEdit({ content: 'original', rowId: 4, userOrdinal: 0 })
    subject.updateDraft('plain draft')

    subject.setSession('session-2')

    expect(subject.$state.get()).toEqual({
      attachmentRefs: [],
      draft: 'plain draft',
      editTarget: null,
      error: null,
      slashItems: [],
      submitting: false
    })
  })

  it('does not reset state when setSession receives the current ID', () => {
    const { interaction: subject } = interaction()
    subject.updateDraft('keep')
    subject.setSession('session-1')
    expect(subject.$state.get().draft).toBe('keep')
  })
})

describe('slash completion', () => {
  it('inserts slash and argument completions using replace_from', async () => {
    const { commands, interaction: subject } = interaction()
    vi.mocked(commands.request)
      .mockResolvedValueOnce({ items: [{ text: '/research' }], replace_from: 1 })
      .mockResolvedValueOnce({ items: [{ text: 'alice' }], replace_from: 13 })

    subject.updateDraft('/')
    await vi.waitFor(() => expect(subject.$state.get().slashItems).toHaveLength(1))
    subject.chooseCompletion(0)
    expect(subject.$state.get().draft).toBe('/research ')

    subject.updateDraft('/personality al')
    await vi.waitFor(() => expect(subject.$state.get().slashItems[0]?.text).toBe('alice'))
    subject.chooseCompletion(0)
    expect(subject.$state.get().draft).toBe('/personality alice ')
  })

  it('keeps newer suggestions when an older request succeeds or fails', async () => {
    const { commands, interaction: subject } = interaction()
    const old = deferred<unknown>()
    vi.mocked(commands.request)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ items: [{ text: '/new' }], replace_from: 1 })

    subject.updateDraft('/')
    subject.updateDraft('/n')
    await vi.waitFor(() => expect(subject.$state.get().slashItems[0]?.text).toBe('/new'))
    old.resolve({ items: [{ text: '/old' }], replace_from: 1 })
    await old.promise
    expect(subject.$state.get().slashItems[0]?.text).toBe('/new')

    const staleFailure = deferred<unknown>()
    vi.mocked(commands.request)
      .mockReturnValueOnce(staleFailure.promise)
      .mockResolvedValueOnce({ items: [{ text: '/latest' }], replace_from: 1 })
    subject.updateDraft('/o')
    subject.updateDraft('/l')
    await vi.waitFor(() => expect(subject.$state.get().slashItems[0]?.text).toBe('/latest'))
    staleFailure.reject(new Error('old failure'))
    await staleFailure.promise.catch(() => undefined)
    expect(subject.$state.get().slashItems[0]?.text).toBe('/latest')
  })

  it('rejects old responses after switching away and back to the same ID', async () => {
    const { commands, interaction: subject } = interaction()
    const pending = deferred<unknown>()
    vi.mocked(commands.request).mockReturnValue(pending.promise)
    subject.updateDraft('/')
    subject.setSession('session-2')
    subject.setSession('session-1')

    pending.resolve({ items: [{ text: '/stale' }], replace_from: 1 })
    await pending.promise
    expect(subject.$state.get().slashItems).toEqual([])
  })
})

describe('submission', () => {
  it('submits edit-and-retry snapshots and blocks rapid duplicates', async () => {
    const { commands, interaction: subject } = interaction()
    const pending = deferred<void>()
    vi.mocked(commands.retryFrom).mockReturnValue(pending.promise)
    subject.beginEdit({ content: 'original', rowId: 41, userOrdinal: 2 })
    subject.updateDraft('edited')

    const first = subject.submit()
    const duplicate = subject.submit()
    expect(commands.retryFrom).toHaveBeenCalledTimes(1)
    expect(commands.retryFrom).toHaveBeenCalledWith(2, 41, 'edited')
    expect(subject.$state.get()).toMatchObject({ draft: '', submitting: true })

    pending.resolve()
    await Promise.all([first, duplicate])
    expect(subject.$state.get()).toMatchObject({ editTarget: null, submitting: false })
  })

  it('restores the exact draft, references, and edit target after failure', async () => {
    const { commands, interaction: subject } = interaction()
    vi.mocked(commands.attach).mockResolvedValue({ ref_text: '@file:one' })
    vi.mocked(commands.retryFrom).mockRejectedValue(new Error('rewind refused'))
    await subject.attach([new File(['one'], 'one.txt')])
    const target = { content: 'original', rowId: 41, userOrdinal: 0 }
    subject.beginEdit(target)
    await subject.attach([new File(['one'], 'one.txt')])
    subject.updateDraft('  edited exactly  ')

    await subject.submit()

    expect(subject.$state.get()).toMatchObject({
      attachmentRefs: ['@file:one'],
      draft: '  edited exactly  ',
      editTarget: target,
      error: 'rewind refused',
      submitting: false
    })
    expect(commands.retryFrom).toHaveBeenCalledWith(0, 41, 'edited exactly\n@file:one')
  })

  it.each(['resolve', 'reject'] as const)('ignores stale submission %s after switching away and back', async outcome => {
    const { commands, interaction: subject } = interaction()
    const pending = deferred<void>()
    vi.mocked(commands.send).mockReturnValue(pending.promise)
    subject.updateDraft('old draft')
    const submitted = subject.submit()
    subject.setSession('session-2')
    subject.updateDraft('new session draft')
    subject.setSession('session-1')
    subject.updateDraft('successor draft')

    if (outcome === 'resolve') pending.resolve()
    else pending.reject(new Error('old failure'))
    await submitted

    expect(subject.$state.get()).toMatchObject({
      draft: 'successor draft',
      error: null,
      submitting: false
    })
  })
})

describe('attachments', () => {
  it('uploads sequentially, preserves successful order, and continues after failures', async () => {
    const { commands, interaction: subject } = interaction()
    const first = deferred<unknown>()
    vi.mocked(commands.attach)
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('second failed'))
      .mockResolvedValueOnce({ text: '@file:third' })
    const files = [new File(['1'], 'one.txt'), new File(['2'], 'two.txt'), new File(['3'], 'three.txt')]

    const attaching = subject.attach(files)
    expect(commands.attach).toHaveBeenCalledTimes(1)
    first.resolve({ ref_text: '@file:first' })
    await attaching

    expect(commands.attach).toHaveBeenCalledTimes(3)
    expect(subject.$state.get()).toMatchObject({
      attachmentRefs: ['@file:first', '@file:third'],
      error: 'second failed'
    })
  })

  it.each(['resolve', 'reject'] as const)('discards a stale first upload %s and never starts the next file', async outcome => {
    const { commands, interaction: subject } = interaction()
    const first = deferred<unknown>()
    vi.mocked(commands.attach).mockReturnValue(first.promise)
    const attaching = subject.attach([new File(['1'], 'one.txt'), new File(['2'], 'two.txt')])
    subject.setSession('session-2')
    subject.setSession('session-1')

    if (outcome === 'resolve') first.resolve({ ref_text: '@file:stale' })
    else first.reject(new Error('stale failure'))
    await attaching

    expect(commands.attach).toHaveBeenCalledTimes(1)
    expect(subject.$state.get()).toMatchObject({ attachmentRefs: [], error: null })
  })
})

describe('transcription', () => {
  it('rejects oversized audio before calling the media adapter', async () => {
    const { interaction: subject, media } = interaction()
    const file = new File(['voice'], 'huge.m4a', { type: 'audio/mp4' })
    Object.defineProperty(file, 'size', { value: 25 * 1_024 * 1_024 + 1 })

    await subject.transcribe(file)

    expect(media.upload).not.toHaveBeenCalled()
    expect(subject.$state.get().error).toContain('limited to 25 MB')
  })

  it('projects missing and failed transcription responses into interaction errors', async () => {
    const { interaction: subject, media } = interaction()
    vi.mocked(media.upload)
      .mockResolvedValueOnce(response({}))
      .mockRejectedValueOnce(new Error('transcription unavailable'))
    const file = new File(['voice'], 'note.m4a', { type: 'audio/mp4' })

    await subject.transcribe(file)
    expect(subject.$state.get().error).toContain('did not include a transcript')
    await subject.transcribe(file)
    expect(subject.$state.get().error).toBe('transcription unavailable')
  })

  it('lets typed text and newer transcription invalidate pending transcription', async () => {
    const { interaction: subject, media } = interaction()
    const old = deferred<ReturnType<typeof response<{ transcript: string }>>>()
    vi.mocked(media.upload)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response({ transcript: 'newest transcript' }))
    const file = new File(['voice'], 'note.m4a', { type: 'audio/mp4' })

    const first = subject.transcribe(file)
    await vi.waitFor(() => expect(media.upload).toHaveBeenCalledTimes(1))
    subject.updateDraft('typed text')
    old.resolve(response({ transcript: 'stale transcript' }))
    await first
    expect(subject.$state.get().draft).toBe('typed text')

    vi.mocked(media.upload).mockReset()
    const stale = deferred<ReturnType<typeof response<{ transcript: string }>>>()
    vi.mocked(media.upload)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response({ transcript: 'latest' }))
    const older = subject.transcribe(file)
    await vi.waitFor(() => expect(media.upload).toHaveBeenCalledTimes(1))
    await subject.transcribe(file)
    stale.resolve(response({ transcript: 'older' }))
    await older
    expect(subject.$state.get().draft).toBe('latest')
  })

  it.each(['resolve', 'reject'] as const)('ignores stale transcription %s across a session epoch', async outcome => {
    const { interaction: subject, media } = interaction()
    const pending = deferred<ReturnType<typeof response<{ transcript: string }>>>()
    vi.mocked(media.upload).mockReturnValue(pending.promise)
    const transcribing = subject.transcribe(new File(['voice'], 'note.m4a', { type: 'audio/mp4' }))
    await vi.waitFor(() => expect(media.upload).toHaveBeenCalled())
    subject.setSession('session-2')
    subject.setSession('session-1')
    subject.updateDraft('successor')

    if (outcome === 'resolve') pending.resolve(response({ transcript: 'stale' }))
    else pending.reject(new Error('stale failure'))
    await transcribing
    expect(subject.$state.get()).toMatchObject({ draft: 'successor', error: null })
  })
})

describe('speech', () => {
  it('plays returned audio and reports missing response fields', async () => {
    const { interaction: subject, media } = interaction()
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('Audio', class { play = play })
    vi.mocked(media.request)
      .mockResolvedValueOnce(response({ data_url: 'data:audio/wav;base64,AA==' }))
      .mockResolvedValueOnce(response({}))

    await subject.speak('read this')
    expect(media.request).toHaveBeenCalledWith({ body: { text: 'read this' }, method: 'POST', path: '/api/audio/speak' })
    expect(play).toHaveBeenCalled()
    await subject.speak('missing')
    expect(subject.$state.get().error).toContain('did not include audio')
  })

  it.each(['response success', 'response failure', 'playback failure'] as const)('ignores stale %s in a successor session', async outcome => {
    const { interaction: subject, media } = interaction()
    const pending = deferred<ReturnType<typeof response<{ data_url: string }>>>()
    const play = deferred<void>()
    vi.stubGlobal('Audio', class { play = () => play.promise })
    vi.mocked(media.request).mockReturnValue(pending.promise)
    const speaking = subject.speak('old')

    if (outcome === 'playback failure') {
      pending.resolve(response({ data_url: 'data:audio/wav;base64,AA==' }))
      await vi.waitFor(() => expect(media.request).toHaveBeenCalled())
      await Promise.resolve()
    }
    subject.setSession('session-2')
    subject.setSession('session-1')
    if (outcome === 'response success') pending.resolve(response({ data_url: 'data:audio/wav;base64,AA==' }))
    if (outcome === 'response failure') pending.reject(new Error('stale response failure'))
    if (outcome === 'playback failure') play.reject(new Error('stale playback failure'))
    await speaking

    expect(subject.$state.get().error).toBeNull()
  })
})

describe('disposal', () => {
  it('makes pending callbacks inert', async () => {
    const { commands, interaction: subject } = interaction()
    const pending = deferred<unknown>()
    vi.mocked(commands.request).mockReturnValue(pending.promise)
    subject.updateDraft('/')
    subject.dispose()
    pending.resolve({ items: [{ text: '/stale' }], replace_from: 1 })
    await pending.promise

    expect(subject.$state.get().slashItems).toEqual([])
    subject.updateDraft('ignored')
    expect(subject.$state.get().draft).toBe('/')
  })
})
