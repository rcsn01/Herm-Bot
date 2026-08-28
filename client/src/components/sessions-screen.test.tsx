import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

vi.mock('~/components/chat-screen', () => ({
  ChatScreen: () => <div data-testid="mounted-chat">Active conversation</div>
}))

import { SessionsScreen } from '~/components/sessions-screen'
import type { GatewayController } from '~/state/gateway-controller'
import { emptyChatState } from '~/state/event-reducer'
import { $chat, $sessions } from '~/state/store'

function controllerStub() {
  return {
    archiveSession: vi.fn(),
    branchSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn(),
    resumeSession: vi.fn().mockResolvedValue(undefined)
  } as unknown as GatewayController
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  $chat.set(emptyChatState())
  $sessions.set([{
    id: 'session-1',
    message_count: 4,
    preview: 'Hidden task description',
    source: 'ios',
    started_at: 1_777_374_000,
    title: 'Planning session'
  }])
})

describe('Sessions workspace', () => {
  it('switches between List and Chat through the supplied navigation actions', () => {
    const onShowChat = vi.fn()
    const onShowList = vi.fn()
    const { rerender } = render(<SessionsScreen controller={controllerStub()} onShowChat={onShowChat} onShowList={onShowList} view="list" />)

    expect(screen.getByRole('tab', { name: 'List' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(onShowChat).toHaveBeenCalledOnce()

    rerender(<SessionsScreen controller={controllerStub()} onShowChat={onShowChat} onShowList={onShowList} view="chat" />)
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'List' }))
    expect(onShowList).toHaveBeenCalledOnce()
  })

  it('keeps the same Chat instance mounted while switching subviews', () => {
    const controller = controllerStub()
    const { rerender } = render(<SessionsScreen controller={controller} onShowChat={() => undefined} onShowList={() => undefined} view="list" />)
    const chat = screen.getByTestId('mounted-chat')
    expect(chat.closest('[aria-hidden="true"]')).not.toBeNull()

    rerender(<SessionsScreen controller={controller} onShowChat={() => undefined} onShowList={() => undefined} view="chat" />)

    expect(screen.getByTestId('mounted-chat')).toBe(chat)
    expect(chat.closest('[aria-hidden="false"]')).not.toBeNull()
  })

  it('preserves list input while Chat is selected', () => {
    const controller = controllerStub()
    const { rerender } = render(<SessionsScreen controller={controller} onShowChat={() => undefined} onShowList={() => undefined} view="list" />)
    fireEvent.change(screen.getByPlaceholderText('Search sessions'), { target: { value: 'planning' } })

    rerender(<SessionsScreen controller={controller} onShowChat={() => undefined} onShowList={() => undefined} view="chat" />)
    rerender(<SessionsScreen controller={controller} onShowChat={() => undefined} onShowList={() => undefined} view="list" />)

    expect(screen.getByPlaceholderText<HTMLInputElement>('Search sessions').value).toBe('planning')
  })
})

describe('Sessions list', () => {
  it('shows only name and date, revealing delete after a left swipe', () => {
    render(<SessionsScreen controller={controllerStub()} onShowChat={() => undefined} onShowList={() => undefined} view="list" />)

    expect(screen.getByText('Planning session')).not.toBeNull()
    expect(document.querySelector('time')?.getAttribute('dateTime')).toBe('2026-04-28T11:00:00.000Z')
    expect(screen.queryByText('Hidden task description')).toBeNull()
    expect(screen.queryByText(/ios/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()

    const row = screen.getByText('Planning session').closest('article')!
    const remove = row.querySelector<HTMLButtonElement>('[aria-label="Delete Planning session"]')!
    expect(remove.getAttribute('aria-hidden')).toBe('true')
    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 20 }] })
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 24 }] })
    expect(remove.getAttribute('aria-hidden')).toBe('false')
  })

  it('opens Chat only after a session resumes successfully', async () => {
    const controller = controllerStub()
    const onShowChat = vi.fn()
    render(<SessionsScreen controller={controller} onShowChat={onShowChat} onShowList={() => undefined} view="list" />)

    fireEvent.click(screen.getByRole('button', { name: /Planning session/ }))

    await waitFor(() => expect(controller.resumeSession).toHaveBeenCalledWith('session-1'))
    await waitFor(() => expect(onShowChat).toHaveBeenCalledOnce())
  })

  it('keeps the list visible when resume or creation fails', async () => {
    const controller = controllerStub()
    vi.mocked(controller.resumeSession).mockRejectedValue(new Error('resume failed'))
    vi.mocked(controller.newSession).mockRejectedValue(new Error('creation failed'))
    const onShowChat = vi.fn()
    render(<SessionsScreen controller={controller} onShowChat={onShowChat} onShowList={() => undefined} view="list" />)

    fireEvent.click(screen.getByRole('button', { name: /Planning session/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('resume failed')
    expect(onShowChat).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('creation failed'))
    expect(onShowChat).not.toHaveBeenCalled()
  })

  it('opens Chat after creating a session successfully', async () => {
    const controller = controllerStub()
    const onShowChat = vi.fn()
    render(<SessionsScreen controller={controller} onShowChat={onShowChat} onShowList={() => undefined} view="list" />)

    fireEvent.click(screen.getByRole('button', { name: 'New' }))

    await waitFor(() => expect(controller.newSession).toHaveBeenCalledOnce())
    await waitFor(() => expect(onShowChat).toHaveBeenCalledOnce())
  })
})
