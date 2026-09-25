import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RosterScreen } from './roster-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $groupChats, createGroupChat } from '~/features/groups/group-engine'
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

function renderRoster(gateway: MemoryGateway) {
  const onOpenAgent = vi.fn()
  const onOpenGroup = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <RosterScreen onOpenAgent={onOpenAgent} onOpenGroup={onOpenGroup} />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return { onOpenAgent, onOpenGroup }
}

describe('agent roster screen with a local room', () => {
  it('lists a newly-created local group before its first message', async () => {
    expect($groupChats.get()).toEqual({})
    const room = createGroupChat('Research team', [{ name: 'default' }, { name: 'work' }], new Set())
    const { onOpenGroup } = renderRoster(new MemoryGateway().handle('profiles.list', () => ({ profiles: [
      { is_default: true, name: 'default' },
      { name: 'work' }
    ] })))

    const group = await screen.findByRole('button', { name: /Research team/ })
    expect(group.textContent).toContain('No messages yet')
    fireEvent.click(group)
    expect(onOpenGroup).toHaveBeenCalledWith(room.key)
  })
})
