import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />
}))

import { ChatScreen } from '~/components/chat-screen'
import type { GatewayController } from '~/state/gateway-controller'
import { emptyChatState } from '~/state/event-reducer'
import { $chat, $connection, $queuedPrompts } from '~/state/store'

const controllerStub = () => ({
  attach: vi.fn(),
  interrupt: vi.fn(),
  request: vi.fn(),
  respond: vi.fn(),
  retryFrom: vi.fn(),
  send: vi.fn()
}) as unknown as GatewayController

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  $chat.set(emptyChatState())
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: null })
  $queuedPrompts.set([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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
