import { cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayProvider } from '~/gateway/gateway-context'
import type { GatewayPort } from '~/gateway/gateway-port'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
  Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />
}))

import { ChatScreen } from '~/components/chat-screen'
import type { ChatMediaConnection } from '~/features/chat/chat-interaction'
import { $chat, emptyChatState, reduceGatewayEvent, type Conversation } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'
import { createTranscript } from '~/transcript/transcript'
import { act } from 'react'

const mediaConnectionStub = () => ({
  request: vi.fn(),
  upload: vi.fn()
}) as unknown as ChatMediaConnection

const controllerStub = () => ({
  archiveSession: vi.fn().mockResolvedValue(undefined),
  branchSession: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined)
}) as unknown as GatewayController

const conversationStub = () => ({
  attach: vi.fn(),
  completeSlash: vi.fn(),
  interrupt: vi.fn(),
  loadOlderMessages: vi.fn().mockResolvedValue(true),
  reconcileHistory: vi.fn().mockResolvedValue(undefined),
  respond: vi.fn(),
  retryFrom: vi.fn(),
  send: vi.fn()
}) as unknown as Conversation

function render(ui: React.ReactElement, profiles: unknown[] = []) {
  const gateway = {
    close: vi.fn(),
    connect: vi.fn(),
    request: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ profiles }),
    subscribe: vi.fn(),
    subscribeState: vi.fn(),
    upload: vi.fn()
  } as unknown as GatewayPort
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return testingRender(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}><GatewayProvider gateway={gateway}>{children}</GatewayProvider></QueryClientProvider>
  })
}

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
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('chat interaction wiring', () => {
  it('shows an inline connecting state in the empty transcript while a switch connects', () => {
    act(() => {
      $connection.set({ authMode: 'token', error: null, phase: 'connecting', status: null })
    })

    const { container } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    expect(container.querySelector('.empty-chat')?.textContent).toContain('Connecting')
    expect(container.querySelector('.empty-chat h2')?.textContent).not.toContain('What can Hermes do')
  })

  it('shows the active profile character and greeting without gateway version details', async () => {
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    $connection.set({ authMode: 'token', error: null, phase: 'connected', status: { version: '0.20.5' } as never })

    const { container } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />, [{
      name: 'work',
      ui_meta: { 'hermes-bots': { color: '#123456', shape: 'circle', title: 'Configured Work' } }
    }])

    expect(screen.getByRole('heading', { name: 'What can Work do for you?' })).not.toBeNull()
    await waitFor(() => expect(container.querySelector('.empty-chat-avatar svg path')?.getAttribute('fill')).toBe('#123456'))
    expect(container.querySelector('.empty-chat')?.textContent).not.toContain('This conversation runs on')
    expect(container.querySelector('.empty-chat')?.textContent).not.toContain('0.20.5')
  })

  it('labels bubbles by position, not by a speaker caption', () => {
    $chat.set({
      ...emptyChatState(),
      transcript: createTranscript({ source: null, storedSessionId: null }, [
        { content: 'Hello there', role: 'user' },
        { content: 'General greeting', role: 'assistant' }
      ])
    })

    const { container } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    const bubbles = Array.from(container.querySelectorAll('article.message'))
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0].classList.contains('user')).toBe(true)
    expect(bubbles[1].classList.contains('assistant')).toBe(true)
    expect(container.querySelector('.message-meta')).toBeNull()
  })

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

describe('session footer metadata', () => {
  it('shows session model and effort before status, updates live, and preserves context usage', () => {
    $chat.set(reduceGatewayEvent({ ...emptyChatState(), runtimeSessionId: 'runtime-1' }, {
      type: 'session.info', session_id: 'runtime-1', payload: { model: 'provider/first', reasoning_effort: 'high', usage: { total: 25, context_limit: 100 } }
    }))
    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)
    const model = screen.getByRole('group', { name: 'Session model and effort' })
    expect(model.textContent).toBe('provider/first·high')
    expect(model.nextElementSibling).toBe(screen.getByRole('status'))
    expect(screen.getByRole('status').textContent).toBe('Ready')
    expect(screen.getByText('25 / 100')).not.toBeNull()
    act(() => {
      $chat.set(reduceGatewayEvent($chat.get(), {
        type: 'session.info', session_id: 'runtime-1', payload: { model: 'provider/second', reasoning_effort: 'low', running: true, usage: { total: 50, context_limit: 100 } }
      }))
    })
    expect(model.textContent).toBe('provider/second·low')
    expect(screen.getByRole('status').textContent).toBe('Hermes is working')
    expect(screen.getByText('50 / 100')).not.toBeNull()
  })

  it('marks missing session metadata unavailable instead of guessing', () => {
    $chat.set({ ...emptyChatState(), info: { title: '', running: false, usage: null } })
    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)
    expect(screen.getByRole('group', { name: 'Session model and effort' }).textContent).toBe('Model unavailable·Effort unavailable')
  })

  it('does not display session metadata before a session is loaded', () => {
    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)
    expect(screen.queryByRole('group', { name: 'Session model and effort' })).toBeNull()
  })
})

describe('transcript rendering and durable edits', () => {
  it('keeps external Markdown links secure and renders context usage below the composer', () => {
    $chat.set({
      ...emptyChatState(),
      info: { running: false, title: '', usage: { limit: 100, used: 25 } },
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

  it.each([
    { name: 'total only', payload: { usage: { total: 25 } }, label: '25', max: 25 },
    { name: 'limit only', payload: { usage: { context_limit: 100 } }, label: '0 / 100', max: 100 },
    { name: 'absent usage', payload: {}, label: null, max: null },
    { name: 'empty usage', payload: { usage: {} }, label: null, max: null },
    { name: 'all-zero usage', payload: { usage: { total: 0, context_limit: 0 } }, label: null, max: null },
    { name: 'NaN with a valid limit', payload: { usage: { total: 'bad', context_limit: 100 } }, label: 'NaN / 100', max: 100 }
  ])('renders the projected context usage: $name', ({ payload, label, max }) => {
    const state = reduceGatewayEvent({ ...emptyChatState(), runtimeSessionId: 'runtime-1' }, {
      type: 'session.info', session_id: 'runtime-1', payload
    })
    $chat.set(state)
    const { container } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    const contextUsage = container.querySelector('.context-usage')
    if (label === null) {
      expect(contextUsage).toBeNull()
    } else {
      expect(contextUsage?.textContent).toContain(label)
      expect(contextUsage?.querySelector('progress')?.max).toBe(max)
    }
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

    const card = screen.getByText('Agent activity').closest('details')!
    expect(card.open).toBe(false)
    fireEvent.click(screen.getByText('Agent activity'))
    const summary = screen.getByText('Tool output')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(card.contains(details)).toBe(true)

    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })

  it('compacts consecutive technical entries while preserving normal messages and activity events', () => {
    $chat.set({
      ...emptyChatState(),
      transcript: {
        context: { source: null, storedSessionId: null },
        entries: [
          { id: 'u', kind: 'message', author: 'user', content: 'Check the files', streaming: false },
          { id: 'r1', kind: 'message', author: 'assistant', content: '', reasoning: 'Plan the check', streaming: false },
          { id: 't1', kind: 'tool-output', content: 'File contents' },
          { id: 'r2', kind: 'message', author: 'assistant', content: 'The checks passed', reasoning: 'Review the result', streaming: false },
          { id: 'e', kind: 'activity', activityKind: 'error', author: 'system', content: 'Visible activity event', streaming: false }
        ]
      }
    })
    const { container } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)
    expect(container.querySelectorAll('.agent-activity-card')).toHaveLength(1)
    expect(screen.getByText('2 reasoning blocks · 1 tool output')).not.toBeNull()
    expect(container.querySelectorAll('article.message')).toHaveLength(3)
    expect(screen.getByText('The checks passed').closest('article')!.querySelector('details')).toBeNull()
    expect(screen.getByText('Visible activity event').closest('.agent-activity-card')).toBeNull()
    expect(screen.getByText('Check the files')).not.toBeNull()
  })

  it('keeps an expanded group mounted when streamed reasoning becomes an answer', () => {
    const entry = { id: 'stream', kind: 'message' as const, author: 'assistant' as const, content: '', reasoning: 'Thinking now', streaming: true }
    $chat.set({ ...emptyChatState(), transcript: { context: { source: null, storedSessionId: null }, entries: [entry] } })
    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)
    const card = screen.getByText('Agent activity').closest('details')!
    fireEvent.click(screen.getByText('Agent activity'))
    act(() => {
      $chat.set({ ...$chat.get(), transcript: { ...$chat.get().transcript, entries: [{ ...entry, content: 'Final answer', streaming: false }] } })
    })
    expect(screen.getByText('Agent activity').closest('details')).toBe(card)
    expect(card.open).toBe(true)
    expect(screen.getByText('Final answer')).not.toBeNull()
  })

  it('keeps session errors and approval prompts outside compact tool activity', () => {
    $chat.set({
      ...emptyChatState(),
      error: 'Tool connection failed',
      pendingPrompt: { kind: 'clarify', question: 'Choose the next step', requestId: 'approval' },
      tools: [{ id: 'terminal', name: 'Terminal', status: 'running' }]
    })
    const { container } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)
    expect(screen.getByText('Session error')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Tool connection failed')
    expect(screen.getByText('Choose the next step').closest('.agent-activity-card')).toBeNull()
    expect(container.querySelector('.tool-timeline')).toBeNull()
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
      info: { running: false, title: 'Planning session', usage: null },
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'session-1'
    })
    const controller = controllerStub()
    render(<ChatScreen controller={controller} conversation={conversationStub()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    expect(screen.getByRole('button', { name: 'Archive' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Branch' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    expect(screen.getByLabelText<HTMLInputElement>('Session title').value).toBe('Planning session')
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'Renamed session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(controller.renameSession).toHaveBeenCalledWith('session-1', 'Renamed session'))
  })

  it.each([
    { name: 'empty', title: '' },
    { name: 'non-string', title: 42 }
  ])('starts the rename dialog with an empty value for a $name title', ({ title }) => {
    const state = reduceGatewayEvent({
      ...emptyChatState(), runtimeSessionId: 'runtime-1', storedSessionId: 'session-1'
    }, {
      type: 'session.info', session_id: 'runtime-1', payload: { title }
    })
    $chat.set(state)
    render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    expect(screen.getByLabelText<HTMLInputElement>('Session title').value).toBe('')
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
      pendingPrompt: { kind: 'approval', question: 'rm file', requestId: 'approval-1' }
    })
    const conversation = conversationStub()
    render(<ChatScreen controller={controllerStub()} conversation={conversation} />)

    expect(screen.getByText('rm file').tagName).toBe('P')
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(conversation.respond).toHaveBeenCalledWith('allow', 'allow')
  })

  it('does not render a question paragraph for an empty resolved question', () => {
    const state = reduceGatewayEvent(emptyChatState(), {
      type: 'clarify.request', payload: { request_id: 'clarify-1', question: null, message: '' }
    })
    $chat.set(state)
    const { container } = render(<ChatScreen controller={controllerStub()} conversation={conversationStub()} />)

    expect(container.querySelector('.prompt-card p')).toBeNull()
  })
})
