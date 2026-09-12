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
import { $chat, emptyChatState, type Conversation } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection } from '~/state/store'
import { createTranscript } from '~/transcript/transcript'

const mediaConnectionStub = () => ({
  request: vi.fn(),
  upload: vi.fn()
}) as unknown as ChatMediaConnection

const controllerStub = () => ({
  archiveSession: vi.fn().mockResolvedValue(undefined),
  branchSession: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined),
  request: vi.fn()
}) as unknown as GatewayController

const conversationStub = () => ({
  attach: vi.fn(),
  interrupt: vi.fn(),
  loadOlderMessages: vi.fn().mockResolvedValue(true),
  reconcileHistory: vi.fn().mockResolvedValue(undefined),
  respond: vi.fn(),
  retryFrom: vi.fn(),
  send: vi.fn()
}) as unknown as Conversation

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
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ content: 'Read this', role: 'assistant' }])
    })
    const connection = mediaConnectionStub()
    vi.mocked(connection.request).mockResolvedValue({ body: { data_url: 'data:audio/wav;base64,AA==' }, headers: {}, status: 200 })
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('Audio', class { play = play })

    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} conversation={conversationStub()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))

    await waitFor(() => expect(connection.request).toHaveBeenCalledWith({
      body: { text: 'Read this' }, method: 'POST', path: '/api/audio/speak'
    }))
    await waitFor(() => expect(play).toHaveBeenCalled())
  })

  it('routes transcription through the supplied adapter and renders its draft', async () => {
    const connection = mediaConnectionStub()
    vi.mocked(connection.upload).mockResolvedValue({ body: { transcript: 'Recorded thought' }, headers: {}, status: 200 })
    render(<ChatScreen mediaConnection={connection} controller={controllerStub()} conversation={conversationStub()} />)

    const input = document.querySelector<HTMLInputElement>('input[accept="audio/*"]')!
    fireEvent.change(input, { target: { files: [new File(['voice'], 'note.m4a', { type: 'audio/mp4' })] } })

    await waitFor(() => expect(connection.upload).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'audio/mp4', dataBase64: 'dm9pY2U=', field: 'file', filename: 'note.m4a', path: '/api/audio/transcribe'
    })))
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' }).value).toBe('Recorded thought'))
  })

  it('keeps the interaction live through StrictMode effect cleanup rehearsal', () => {
    const controller = controllerStub()
    const conversation = conversationStub()
    render(<StrictMode><ChatScreen controller={controller} conversation={conversation} /></StrictMode>)
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' })

    fireEvent.change(composer, { target: { value: 'strict mode' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(conversation.send).toHaveBeenCalledWith('strict mode')
  })

  it('forwards composer intent and disables duplicate submission while pending', async () => {
    const controller = controllerStub()
    const conversation = conversationStub()
    let resolveSend!: () => void
    vi.mocked(conversation.send).mockReturnValue(new Promise(resolve => { resolveSend = resolve }))
    render(<ChatScreen controller={controller} conversation={conversation} />)
    const composer = screen.getByRole('textbox', { name: 'Message Hermes' })

    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(conversation.send).toHaveBeenCalledWith('hello')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true)
    resolveSend()
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true))
  })
})

describe('transcript rendering and durable edits', () => {
  it('keeps external Markdown links secure and renders context usage below the composer', () => {
    $chat.set({
      ...emptyChatState(),
      info: { usage: { context_limit: 100, total: 25 } } as never,
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ content: '<script>unsafe()</script>\n\n[Hermes](https://example.com)', role: 'assistant' }])
    })

    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    const link = screen.getByRole<HTMLAnchorElement>('link', { name: 'Hermes' })
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
    expect(document.querySelector('script')).toBeNull()
    expect(screen.queryByText('unsafe()')).toBeNull()
    const contextUsage = screen.getByText('25 / 100').closest('.context-usage')
    expect(contextUsage).not.toBeNull()
    expect(contextUsage?.closest('.composer-meta')?.previousElementSibling?.classList.contains('composer')).toBe(true)
  })

  it('shows whether the current session is working', () => {
    const controller = controllerStub()
    const conversation = conversationStub()
    const { rerender } = render(<ChatScreen controller={controller} conversation={conversation} />)

    expect(screen.getByRole('status').textContent).toBe('Ready')

    $chat.set({ ...$chat.get(), running: true })
    rerender(<ChatScreen controller={controller} conversation={conversation} />)

    expect(screen.getByRole('status').textContent).toBe('Hermes is working')
    expect(screen.getByRole('button', { name: 'Interrupt' })).not.toBeNull()
  })

  it('collapses stored tool output until requested', () => {
    $chat.set({
      ...emptyChatState(),
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ content: '{"output":"a long result"}', role: 'tool' }])
    })

    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    const summary = screen.getByText('Tool output')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(details.closest('article')?.classList.contains('collapsed-message')).toBe(true)

    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })

  it('collapses the generated instruction block only for cron sessions', () => {
    const instructions = '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: send the final result.]'
    $chat.set({
      ...emptyChatState(),
      storedSessionId: 'scheduled-1',
      transcript: createTranscript({ source: 'cron', storedSessionId: 'scheduled-1' }, [{ content: instructions, role: 'user' }])
    })

    const { rerender } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    expect(screen.getByText('Cron job instructions').closest('details')?.open).toBe(false)

    $chat.set({
      ...$chat.get(),
      storedSessionId: 'ordinary-1',
      transcript: createTranscript({ source: 'mobile', storedSessionId: 'ordinary-1' }, [{ content: instructions, role: 'user' }])
    })
    rerender(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    expect(screen.queryByText('Cron job instructions')).toBeNull()
    expect(screen.getByText(instructions)).toBeTruthy()
  })

  it('labels internal timeline events as activity rather than user messages', () => {
    $chat.set({
      ...emptyChatState(),
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ content: 'payload', display_kind: 'async_delegation_complete', display_metadata: { task_count: 3 } as never, role: 'user' }])
    })

    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    const event = screen.getByText('3 background agents finished').closest('article')!
    expect(event.classList.contains('timeline-event')).toBe(true)
    expect(event.textContent).toContain('Activity')
    expect(event.textContent).not.toContain('User')
  })

  it('preserves reasoning, streaming, and author actions for unknown activity kinds', () => {
    $chat.set({
      ...emptyChatState(),
      transcript: createTranscript({ source: null, storedSessionId: null }, [{
        content: 'future event', display_kind: 'future_kind', reasoning: 'because', role: 'assistant', row_id: 10
      }])
    })
    $chat.set({
      ...$chat.get(),
      transcript: {
        ...$chat.get().transcript,
        entries: $chat.get().transcript.entries.map(entry => entry.kind === 'activity' ? { ...entry, streaming: true } : entry)
      }
    })

    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    expect(screen.getByText('because')).not.toBeNull()
    expect(screen.getByText('Streaming')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Read aloud' })).not.toBeNull()
  })

  it('disables destructive edits for optimistic messages and while running', () => {
    $chat.set({
      ...emptyChatState(),
      runtimeSessionId: 'runtime-1',
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ content: 'optimistic', role: 'user' }])
    })
    const controller = controllerStub()
    const conversation = conversationStub()
    const { rerender } = render(<ChatScreen controller={controller} conversation={conversation} />)

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit & retry' }).disabled).toBe(true)

    $chat.set({
      ...$chat.get(),
      running: true,
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ content: 'durable', role: 'user', row_id: 41 }])
    })
    rerender(<ChatScreen controller={controller} conversation={conversation} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit & retry' }).disabled).toBe(true)
  })

  it('forwards edit and cancel intent to the interaction module', () => {
    $chat.set({
      ...emptyChatState(),
      runtimeSessionId: 'runtime-1',
      transcript: createTranscript({ source: null, storedSessionId: null }, [{ content: 'original', role: 'user', row_id: 41 }])
    })
    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit & retry' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' }).value).toBe('original')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' }).value).toBe('')
  })
})

describe('viewport wiring', () => {
  it('invokes the supplied older-history action from the visible button', async () => {
    const conversation = conversationStub()
    $chat.set({
      ...emptyChatState(),
      historyHasMore: true,
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1'
    })
    render(<ChatScreen controller={controllerStub()} conversation={conversation} />)

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))

    await waitFor(() => expect(conversation.loadOlderMessages).toHaveBeenCalledOnce())
  })

  it('shows the older-history error in the screen error banner', async () => {
    const error = new Error('history unavailable')
    const conversation = conversationStub()
    vi.mocked(conversation.loadOlderMessages).mockRejectedValue(error)
    $chat.set({
      ...emptyChatState(),
      historyHasMore: true,
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1'
    })
    render(<ChatScreen controller={controllerStub()} conversation={conversation} />)

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('history unavailable'))
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
    render(<ChatScreen controller={controller} conversation={conversationStub()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    expect(screen.getByRole('button', { name: 'Archive' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Branch' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'Renamed session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(controller.renameSession).toHaveBeenCalledWith('session-1', 'Renamed session'))
  })

  it('clears session dialogs and their errors when either session identity changes', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'session-1' })
    const controller = controllerStub()
    const conversation = conversationStub()
    vi.mocked(controller.branchSession).mockRejectedValue(new Error('branch failed'))
    const { rerender } = render(<ChatScreen controller={controller} conversation={conversation} />)
    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    expect((await screen.findByRole('alert')).textContent).toContain('branch failed')

    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'session-2' })
    rerender(<ChatScreen controller={controller} conversation={conversation} />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Branch' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    expect((await screen.findByRole('alert')).textContent).toContain('branch failed')

    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-2', storedSessionId: 'session-2' })
    rerender(<ChatScreen controller={controller} conversation={conversation} />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Branch' })).toBeNull()
  })

  it('keeps approval prompts wired to the conversation', () => {
    $chat.set({
      ...emptyChatState(),
      pendingPrompt: { kind: 'approval', payload: { command: 'rm file' }, requestId: 'approval-1' }
    })
    const conversation = conversationStub()
    render(<ChatScreen controller={controllerStub()} conversation={conversation} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(conversation.respond).toHaveBeenCalledWith('allow', 'allow')
  })
})