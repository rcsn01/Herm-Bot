import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { SessionsScreen } from '~/components/sessions-screen'
import type { GatewayController } from '~/state/gateway-controller'
import { emptyChatState } from '~/state/event-reducer'
import { $chat, $sessions } from '~/state/store'

const controller = {
  archiveSession: vi.fn(),
  branchSession: vi.fn(),
  deleteSession: vi.fn(),
  newSession: vi.fn(),
  renameSession: vi.fn(),
  resumeSession: vi.fn()
} as unknown as GatewayController

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

describe('sessions list', () => {
  it('shows only name and date, revealing delete after a left swipe', () => {
    render(<SessionsScreen controller={controller} onOpenChat={() => undefined} />)

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
})
