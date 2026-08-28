import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
  Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />
}))

import { ChatScreen } from '~/components/chat-screen'
import type { HermesConnectionPlugin } from '~/native/hermes-connection'
import type { GatewayController } from '~/state/gateway-controller'
import { emptyChatState } from '~/state/event-reducer'
import { $chat, $connection, $queuedPrompts } from '~/state/store'

type MediaConnection = Pick<HermesConnectionPlugin, 'request' | 'upload'>

const mediaConnectionStub = () => ({
  request: vi.fn(),
  upload: vi.fn()
}) as unknown as MediaConnection

const controllerStub = () => ({
  archiveSession: vi.fn().mockResolvedValue(undefined),
  attach: vi.fn(),
  branchSession: vi.fn().mockResolvedValue(undefined),
  interrupt: vi.fn(),
  renameSession: vi.fn().mockResolvedValue(undefined),
  request: vi.fn(),
  respond: vi.fn(),
  retryFrom: vi.fn(),
  send: vi.fn()
}) as unknown as GatewayController

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
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
  $chat.set(emptyChatState())
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: null })
  $queuedPrompts.set([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('chat media', () => {
  it('routes speech through the supplied connection adapter', async () => {
    $chat.set({
      ...emptyChatState(),
      messages: [{ content: 'Read this', id: 'assistant-1', role: 'assistant' }]
    })
    const connection = mediaConnectionStub()
    vi.mocked(connection.request).mockResolvedValue({ body: { data_url: 'data:audio/wav;base64,AA==' }, headers: {}, status: 200 })
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('Audio', class { play = play })

    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))

    await waitFor(() => expect(connection.request).toHaveBeenCalledWith({
      body: { text: 'Read this' }, method: 'POST', path: '/api/audio/speak'
    }))
    await waitFor(() => expect(play).toHaveBeenCalled())
  })

  it('routes transcription through the supplied adapter and updates the draft', async () => {
    const connection = mediaConnectionStub()
    vi.mocked(connection.upload).mockResolvedValue({ body: { transcript: 'Recorded thought' }, headers: {}, status: 200 })
    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} />)
    const file = new File(['voice'], 'note.m4a', { type: 'audio/mp4' })

    const input = document.querySelector<HTMLInputElement>('input[accept="audio/*"]')!
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(connection.upload).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'audio/mp4', dataBase64: 'dm9pY2U=', field: 'file', filename: 'note.m4a', path: '/api/audio/transcribe'
    })))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement).value).toBe('Recorded thought'))
  })

  it('rejects oversized audio before crossing the connection seam', async () => {
    const connection = mediaConnectionStub()
    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} />)
    const input = document.querySelector<HTMLInputElement>('input[accept="audio/*"]')!
    const file = new File(['voice'], 'huge.m4a', { type: 'audio/mp4' })
    Object.defineProperty(file, 'size', { value: 25 * 1_024 * 1_024 + 1 })

    fireEvent.change(input, { target: { files: [file] } })

    expect((await screen.findByRole('alert')).textContent).toContain('limited to 25 MB')
    expect(connection.upload).not.toHaveBeenCalled()
  })

  it('surfaces adapter transcription failures without changing the draft', async () => {
    const connection = mediaConnectionStub()
    vi.mocked(connection.upload).mockRejectedValue(new Error('Transcription unavailable'))
    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} />)
    const input = document.querySelector<HTMLInputElement>('input[accept="audio/*"]')!

    fireEvent.change(input, { target: { files: [new File(['voice'], 'note.m4a', { type: 'audio/mp4' })] } })

    expect((await screen.findByRole('alert')).textContent).toContain('Transcription unavailable')
    expect((screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement).value).toBe('')
  })

  it('does not let a pending transcription overwrite newer typed text', async () => {
    const connection = mediaConnectionStub()
    let resolveUpload!: (value: unknown) => void
    vi.mocked(connection.upload).mockImplementationOnce(() => new Promise(resolve => { resolveUpload = resolve }) as never)
    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} />)
    const input = document.querySelector<HTMLInputElement>('input[accept="audio/*"]')!
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement

    fireEvent.change(input, { target: { files: [new File(['voice'], 'note.m4a', { type: 'audio/mp4' })] } })
    await waitFor(() => expect(connection.upload).toHaveBeenCalledTimes(1))
    fireEvent.change(composer, { target: { value: 'Keep my typed text' } })
    await act(async () => resolveUpload({ body: { transcript: 'Stale recording' }, headers: {}, status: 200 }))

    expect(composer.value).toBe('Keep my typed text')
  })

  it('does not let an older transcription replace a newer result', async () => {
    const connection = mediaConnectionStub()
    let resolveOld!: (value: unknown) => void
    vi.mocked(connection.upload)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }) as never)
      .mockResolvedValueOnce({ body: { transcript: 'Newest' }, headers: {}, status: 200 })
    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} />)
    const input = document.querySelector<HTMLInputElement>('input[accept="audio/*"]')!

    fireEvent.change(input, { target: { files: [new File(['one'], 'one.m4a', { type: 'audio/mp4' })] } })
    await waitFor(() => expect(connection.upload).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { files: [new File(['two'], 'two.m4a', { type: 'audio/mp4' })] } })
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement).value).toBe('Newest'))

    await act(async () => resolveOld({ body: { transcript: 'Stale' }, headers: {}, status: 200 }))
    expect((screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement).value).toBe('Newest')
  })
})

describe('edit and retry', () => {
  it('waits for an edited submit before requesting a durable rewind', async () => {
    $chat.set({
      ...emptyChatState(),
      messages: [
        { content: 'original', id: 'history-row-41', role: 'user', rowId: 41 },
        { content: 'answer', id: 'history-row-42', role: 'assistant', rowId: 42 }
      ],
      runtimeSessionId: 'runtime-1'
    })
    const controller = controllerStub()
    render(<ChatScreen controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit & retry' }))
    expect(controller.retryFrom).not.toHaveBeenCalled()

    const composer = screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement
    expect(composer.value).toBe('original')
    fireEvent.change(composer, { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(controller.retryFrom).toHaveBeenCalledWith(0, 41, 'edited'))
    expect(controller.send).not.toHaveBeenCalled()
    expect(composer.value).toBe('')
  })

  it('retains the edited draft and rewind target when submission fails', async () => {
    $chat.set({
      ...emptyChatState(),
      messages: [{ content: 'original', id: 'history-row-41', role: 'user', rowId: 41 }],
      runtimeSessionId: 'runtime-1'
    })
    const controller = controllerStub()
    vi.mocked(controller.retryFrom).mockRejectedValue(new Error('rewind refused'))
    render(<ChatScreen controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit & retry' }))
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByRole('alert')
    expect(composer.value).toBe('edited')
    expect(screen.getByRole('button', { name: 'Cancel edit' })).toBeTruthy()
  })

  it('does not allow a destructive edit without an idle durable message', () => {
    $chat.set({
      ...emptyChatState(),
      messages: [{ content: 'optimistic', id: 'local-1', role: 'user' }],
      runtimeSessionId: 'runtime-1'
    })
    const controller = controllerStub()
    const { rerender } = render(<ChatScreen controller={controller} />)

    expect((screen.getByRole('button', { name: 'Edit & retry' }) as HTMLButtonElement).disabled).toBe(true)

    $chat.set({
      ...$chat.get(),
      messages: [{ content: 'durable', id: 'history-row-41', role: 'user', rowId: 41 }],
      running: true
    })
    rerender(<ChatScreen controller={controller} />)
    expect((screen.getByRole('button', { name: 'Edit & retry' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('session management', () => {
  it('offers rename and archive only from inside a stored session', async () => {
    $chat.set({
      ...emptyChatState(),
      info: { title: 'Planning session' } as never,
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'session-1'
    })
    const controller = controllerStub()
    render(<ChatScreen controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    expect(screen.getByRole('button', { name: 'Edit name' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Archive' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Branch' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'Renamed session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(controller.renameSession).toHaveBeenCalledWith('session-1', 'Renamed session'))
  })
})

describe('slash completion', () => {
  it('requests current gateway completions and inserts a skill without duplicating its slash', async () => {
    const controller = controllerStub()
    vi.mocked(controller.request).mockResolvedValue({
      items: [{ display: '/research', kind: 'skill', meta: 'Research a topic', text: '/research' }],
      replace_from: 1
    })
    render(<ChatScreen controller={controller} />)
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/' } })
    const completion = await screen.findByRole('button', { name: /research/i })

    expect(controller.request).toHaveBeenCalledWith('complete.slash', { text: '/' })
    fireEvent.click(completion)
    expect(composer.value).toBe('/research ')
  })

  it('discards a stale completion response after the draft advances', async () => {
    const controller = controllerStub()
    let resolveOld!: (value: unknown) => void
    vi.mocked(controller.request)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({
        items: [{ display: '/research', kind: 'skill', meta: 'Research', text: '/research' }],
        replace_from: 1
      })
    render(<ChatScreen controller={controller} />)
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' })

    fireEvent.change(composer, { target: { value: '/' } })
    fireEvent.change(composer, { target: { value: '/re' } })
    await screen.findByRole('button', { name: /research/i })

    await act(async () => resolveOld({
      items: [{ display: '/old', kind: 'command', meta: 'Stale', text: '/old' }],
      replace_from: 1
    }))

    expect(screen.queryByRole('button', { name: /old/i })).toBeNull()
    expect(screen.getByRole('button', { name: /research/i })).toBeTruthy()
  })

  it('honors replace_from for command argument completions', async () => {
    const controller = controllerStub()
    vi.mocked(controller.request).mockResolvedValue({
      items: [{ display: 'alice', kind: 'command', meta: 'Personality', text: 'alice' }],
      replace_from: 13
    })
    render(<ChatScreen controller={controller} />)
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' }) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/personality al' } })
    fireEvent.click(await screen.findByRole('button', { name: /alice/i }))

    expect(controller.request).toHaveBeenCalledWith('complete.slash', { text: '/personality al' })
    expect(composer.value).toBe('/personality alice ')
  })
})
