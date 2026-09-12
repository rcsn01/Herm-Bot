import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>
}))

import { BotScreen } from '~/features/bots/bot-screen'
import { $preferences } from '~/state/store'

function renderBot() {
  const handlers = {
    onBack: vi.fn(),
    onOpenCapabilities: vi.fn(),
    onOpenCronJobs: vi.fn(),
    onOpenModel: vi.fn()
  }
  render(<BotScreen {...handlers} />)
  return handlers
}

beforeEach(() => {
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
})

afterEach(cleanup)

describe('BotScreen', () => {
  it('shows the active bot identity and its per-bot destinations', () => {
    renderBot()

    expect(screen.getByRole('heading', { name: 'default' })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Model/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Capabilities/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Cron Jobs/ })).not.toBeNull()
  })

  it('opens capabilities, cron jobs, and model selection through its handlers', () => {
    const handlers = renderBot()

    fireEvent.click(screen.getByRole('button', { name: /Capabilities/ }))
    fireEvent.click(screen.getByRole('button', { name: /Cron Jobs/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model/ }))

    expect(handlers.onOpenCapabilities).toHaveBeenCalledOnce()
    expect(handlers.onOpenCronJobs).toHaveBeenCalledOnce()
    expect(handlers.onOpenModel).toHaveBeenCalledOnce()
  })

  it('returns to the chat with the back control', () => {
    const handlers = renderBot()

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(handlers.onBack).toHaveBeenCalledOnce()
  })
})