import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
  Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />
}))

import { ChatScreen } from '~/components/chat-screen'
import type { ChatMediaConnection } from '~/features/chat/chat-interaction'
import type { GatewayController } from '~/state/gateway-controller'
import { emptyChatState } from '~/state/event-reducer'
import { $chat, $connection, $queuedPrompts } from '~/state/store'

const mediaConnectionStub = () => ({
  request: vi.fn(),
  upload: vi.fn()
}) as unknown as ChatMediaConnection

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

describe('chat interaction wiring', () => {
  it('routes speech through the supplied media adapter', async () => {
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

  it('routes transcription through the supplied adapter and renders its draft', async () => {
    const connection = mediaConnectionStub()
    vi.mocked(connection.upload).mockResolvedValue({ body: { transcript: 'Recorded thought' }, headers: {}, status: 200 })
    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} />)

    const input = document.querySelector<HTMLInputElement>('input[accept="audio/*"]')!
    fireEvent.change(input, { target: { files: [new File(['voice'], 'note.m4a', { type: 'audio/mp4' })] } })

    await waitFor(() => expect(connection.upload).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'audio/mp4', dataBase64: 'dm9pY2U=', field: 'file', filename: 'note.m4a', path: '/api/audio/transcribe'
    })))
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' }).value).toBe('Recorded thought'))
  })

  it('keeps the interaction live through StrictMode effect cleanup rehearsal', () => {
    const controller = controllerStub()
    render(<StrictMode><ChatScreen controller={controller} /></StrictMode>)
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' })

    fireEvent.change(composer, { target: { value: 'strict mode' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(controller.send).toHaveBeenCalledWith('strict mode')
  })

  it('forwards composer intent and disables duplicate submission while pending', async () => {
    const controller = controllerStub()
    let resolveSend!: () => void
    vi.mocked(controller.send).mockReturnValue(new Promise(resolve => { resolveSend = resolve }))
    render(<ChatScreen controller={controller} />)
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' })

    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(controller.send).toHaveBeenCalledWith('hello')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true)
    resolveSend()
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true))
  })
})

describe('transcript rendering and durable edits', () => {
  it('keeps external Markdown links secure and renders context usage', () => {
    $chat.set({
      ...emptyChatState(),
      info: { usage: { context_limit: 100, total: 25 } } as never,
      messages: [{ content: '[Hermes](https://example.com)', id: 'assistant-1', role: 'assistant' }]
    })

    render(<ChatScreen controller={controllerStub()} />)

    const link = screen.getByRole<HTMLAnchorElement>('link', { name: 'Hermes' })
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
    expect(screen.getByText('25 / 100')).not.toBeNull()
  })

  it('labels internal timeline events as activity rather than user messages', () => {
    $chat.set({
      ...emptyChatState(),
      messages: [{ content: '3 background agents finished', displayKind: 'async_delegation_complete', id: 'event-1', role: 'system' }]
    })

    render(<ChatScreen controller={controllerStub()} />)

    const event = screen.getByText('3 background agents finished').closest('article')!
    expect(event.classList.contains('timeline-event')).toBe(true)
    expect(event.textContent).toContain('Activity')
    expect(event.textContent).not.toContain('User')
  })

  it('disables destructive edits for optimistic messages and while running', () => {
    $chat.set({
      ...emptyChatState(),
      messages: [{ content: 'optimistic', id: 'local-1', role: 'user' }],
      runtimeSessionId: 'runtime-1'
    })
    const controller = controllerStub()
    const { rerender } = render(<ChatScreen controller={controller} />)

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit & retry' }).disabled).toBe(true)

    $chat.set({
      ...$chat.get(),
      messages: [{ content: 'durable', id: 'history-row-41', role: 'user', rowId: 41 }],
      running: true
    })
    rerender(<ChatScreen controller={controller} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit & retry' }).disabled).toBe(true)
  })

  it('forwards edit and cancel intent to the interaction module', () => {
    $chat.set({
      ...emptyChatState(),
      messages: [{ content: 'original', id: 'history-row-41', role: 'user', rowId: 41 }],
      runtimeSessionId: 'runtime-1'
    })
    render(<ChatScreen controller={controllerStub()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit & retry' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' }).value).toBe('original')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' }).value).toBe('')
  })
})

describe('session management and prompts', () => {
  it('offers stored-session actions and forwards rename intent', async () => {
    $chat.set({
      ...emptyChatState(),
      info: { title: 'Planning session' } as never,
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'session-1'
    })
    const controller = controllerStub()
    render(<ChatScreen controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    expect(screen.getByRole('button', { name: 'Archive' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Branch' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'Renamed session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(controller.renameSession).toHaveBeenCalledWith('session-1', 'Renamed session'))
  })

  it('clears session dialogs and their errors when the runtime session changes', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'session-1' })
    const controller = controllerStub()
    vi.mocked(controller.branchSession).mockRejectedValue(new Error('branch failed'))
    const { rerender } = render(<ChatScreen controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    expect((await screen.findByRole('alert')).textContent).toContain('branch failed')

    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-2', storedSessionId: 'session-2' })
    rerender(<ChatScreen controller={controller} />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Branch' })).toBeNull()
  })

  it('keeps approval prompts wired to the controller', () => {
    $chat.set({
      ...emptyChatState(),
      pendingPrompt: { kind: 'approval', payload: { command: 'rm file' }, requestId: 'approval-1' }
    })
    const controller = controllerStub()
    render(<ChatScreen controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(controller.respond).toHaveBeenCalledWith('allow', 'allow')
  })
})
