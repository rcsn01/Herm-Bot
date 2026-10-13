import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConnectionBanner } from './connection-banner'
import { $connection } from '~/state/store'
import { $networkStatus } from '~/state/network-status'
import { $chat, emptyChatState } from '~/state/conversation'
afterEach(cleanup)
it('uses evidence-based wording and offers Retry after failure', () => {
  $chat.set({ ...emptyChatState(), availability: 'cached' })
  $connection.set({ ...$connection.get(), phase: 'error', errorKind: 'network' })
  const retry = vi.fn()
  render(<ConnectionBanner onRetry={retry} />)
  expect(screen.getByRole('status').textContent).toBe('Cannot reach Hermes.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalledOnce()
})
it('explicit offline evidence never claims the server failed', () => {
  $networkStatus.set({ status: 'offline' })
  render(<ConnectionBanner onRetry={vi.fn()} />)
  expect(screen.getByRole('status').textContent).toContain('Device offline.')
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})
