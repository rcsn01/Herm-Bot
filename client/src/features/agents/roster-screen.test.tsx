import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { relativeDay, RosterScreen } from './roster-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import type { GatewayStatus } from '~/lib/types'
import { $connection, $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

beforeEach(() => {
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.example', theme: 'system' })
  $connection.set({
    authMode: 'token',
    error: null,
    phase: 'connected',
    status: { auth_required: false, profiles: [{ is_default: true, name: 'default' }, { name: 'work' }] } as unknown as GatewayStatus
  })
})

afterEach(cleanup)

function renderRoster(gateway: MemoryGateway, query = '') {
  const onOpenAgent = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <RosterScreen onOpenAgent={onOpenAgent} query={query} />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return onOpenAgent
}

describe('agent roster screen', () => {
  it('lists gateway profiles with their latest conversation preview', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({
      profiles: [
        { name: 'default', is_default: true, preview: 'Morning briefing sent', last_active: 1_700_000_000 },
        { name: 'work', preview: 'One new Fujitsu stream' }
      ]
    })))

    expect(await screen.findByText('Morning briefing sent')).not.toBeNull()
    expect(screen.getByText('One new Fujitsu stream')).not.toBeNull()
    expect(screen.getByRole('button', { name: /default/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /work/ })).not.toBeNull()
  })

  it('falls back to status profile names when the gateway has no roster data', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})))

    expect(await screen.findByRole('button', { name: /default/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /work/ })).not.toBeNull()
    expect(screen.queryByText('Morning briefing sent')).toBeNull()
  })

  it('keeps profile names when the roster enrichment request fails', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => {
      throw new Error('roster unavailable')
    }))

    expect(await screen.findByRole('button', { name: /default/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /work/ })).not.toBeNull()
  })

  it('opens the default profile unnamed and named profiles by name', async () => {
    const onOpenAgent = renderRoster(new MemoryGateway().handle('profiles.list', () => ({})))

    fireEvent.click(await screen.findByRole('button', { name: /default/ }))
    expect(onOpenAgent).toHaveBeenCalledWith(null)

    fireEvent.click(screen.getByRole('button', { name: /work/ }))
    expect(onOpenAgent).toHaveBeenCalledWith('work')
  })

  it('shows an empty state when the gateway has no profiles', async () => {
    $connection.set({ ...$connection.get(), status: { auth_required: false, profiles: [] } as unknown as GatewayStatus })
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})))

    expect(await screen.findByText('No bot profiles exist on this gateway yet.')).not.toBeNull()
  })

  it('filters the roster by the search query', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})), 'work')

    expect(await screen.findByRole('button', { name: /work/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /default/ })).toBeNull()
  })

  it('shows a no-match state when the search has no hits', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})), 'missing')

    expect(await screen.findByText('No bots match this search.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /work/ })).toBeNull()
  })

  it('labels rows with relative day stamps', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-12T15:00:00'))
      expect(relativeDay(Math.floor(Date.parse('2026-09-12T10:00:00') / 1000))).toBe('Today')
      expect(relativeDay(Math.floor(Date.parse('2026-09-11T10:00:00') / 1000))).toBe('Yesterday')
      expect(relativeDay(Math.floor(Date.parse('2026-08-31T10:00:00') / 1000))).toBe('Aug 31')
    } finally {
      vi.useRealTimers()
    }
  })
})