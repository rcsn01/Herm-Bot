import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const onOpenGroup = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <RosterScreen onOpenAgent={onOpenAgent} onOpenGroup={onOpenGroup} query={query} />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return { container, onOpenAgent, onOpenGroup }
}

describe('agent roster screen', () => {
  it('shows at most three member faces as the group icon, stacked with offsets', async () => {
    const { container } = renderRoster(new MemoryGateway().handle('profiles.list', () => ({
      profiles: [{
        name: 'default',
        is_default: true,
        ui_meta: {
          'hermes-bots-groups': {
            version: 3,
            rooms: {
              'id:r-crew': {
                name: 'Research crew',
                roomId: 'r-crew',
                revision: 3,
                members: [{ name: 'codex' }, { name: 'scout' }, { name: 'forge' }, { name: 'atlas' }],
                log: [{ at: 1_700_000_000_000, from: { kind: 'member', name: 'Codex' }, text: 'Working' }]
              }
            }
          }
        }
      }]
    })))

    await screen.findByRole('button', { name: /Research crew/ })
    const stack = container.querySelector('.group-faces')!
    expect(stack).not.toBeNull()
    const faces = stack.querySelectorAll('.group-face')
    expect(faces).toHaveLength(3)
    expect(faces[0].querySelectorAll('svg')).toHaveLength(1)
    expect(stack.querySelector('.group-face:nth-child(2)')).not.toBeNull()

    // Each face is drawn at the chip's pixel size — a full-size roster face
    // inside the clipped chip would only show its blank top-left corner.
    const face = faces[0].querySelector('.bot-face') as HTMLElement | SVGSVGElement
    const inlineWidth = face instanceof SVGSVGElement ? face.getAttribute('width') : face.style.width
    expect(inlineWidth === '32' || inlineWidth === '32px').toBe(true)
  })

  it('prefers the room image over the stacked member faces', async () => {
    const { container } = renderRoster(new MemoryGateway().handle('profiles.list', () => ({
      profiles: [{
        name: 'default',
        is_default: true,
        ui_meta: {
          'hermes-bots-groups': {
            version: 3,
            rooms: {
              'id:r-pic': {
                name: 'Pictured',
                roomId: 'r-pic',
                revision: 1,
                image: 'data:image/png;base64,AA==',
                members: [{ name: 'codex' }],
                log: [{ at: 1_700_000_000_000, from: { kind: 'member', name: 'Codex' }, text: 'Hi' }]
              }
            }
          }
        }
      }]
    })))

    await screen.findByRole('button', { name: /Pictured/ })
    expect(container.querySelector('.group-faces')).toBeNull()
    expect(container.querySelector('.agent-avatar img')).not.toBeNull()
  })

  it('lists desktop group chats beneath the bots and opens them', async () => {
    const { onOpenGroup } = renderRoster(new MemoryGateway().handle('profiles.list', () => ({
      profiles: [{
        name: 'default',
        is_default: true,
        ui_meta: {
          'hermes-bots-groups': {
            version: 3,
            rooms: {
              'id:r-crew': {
                name: 'Research crew',
                roomId: 'r-crew',
                revision: 3,
                members: [{ name: 'codex' }, { name: 'scout' }],
                log: [
                  { at: 1_700_000_000_000, from: { kind: 'user', name: 'You' }, text: 'Find the specs' },
                  { at: 1_700_000_060_000, from: { kind: 'member', name: 'Codex' }, text: 'Two candidates so far' }
                ]
              }
            }
          }
        }
      }]
    })))

    const row = await screen.findByRole('button', { name: /Research crew/ })
    expect(row.textContent).toContain('2 bots')
    expect(row.textContent).toContain('Codex: Two candidates so far')
    fireEvent.click(row)
    expect(onOpenGroup).toHaveBeenCalledWith('id:r-crew')
  })

  it('lists gateway profiles with their latest conversation preview', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({
      profiles: [
        { name: 'default', is_default: true, preview: 'Morning briefing sent', last_active: 1_700_000_000 },
        { name: 'work', preview: 'One new Fujitsu stream' }
      ]
    })))

    expect(await screen.findByText('Morning briefing sent')).not.toBeNull()
    expect(screen.getByText('One new Fujitsu stream')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Hermes/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Work/ })).not.toBeNull()
  })

  it('falls back to status profile names when the gateway has no roster data', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})))

    expect(await screen.findByRole('button', { name: /Hermes/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Work/ })).not.toBeNull()
    expect(screen.queryByText('Morning briefing sent')).toBeNull()
  })

  it('keeps profile names when the roster enrichment request fails', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => {
      throw new Error('roster unavailable')
    }))

    expect(await screen.findByRole('button', { name: /Hermes/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Work/ })).not.toBeNull()
  })

  it('renders a deterministic blob face for bots without a custom avatar', async () => {
    const { container } = renderRoster(new MemoryGateway().handle('profiles.list', () => ({})))

    expect(await screen.findByRole('button', { name: /Hermes/ })).not.toBeNull()
    expect(container.querySelectorAll('.agent-avatar svg').length).toBe(2)
  })

  it('renders the bot custom avatar image when the gateway provides one', async () => {
    const { container } = renderRoster(new MemoryGateway().handle('profiles.list', () => ({
      profiles: [{ name: 'work', avatar: 'data:image/png;base64,AAA' }]
    })))

    expect(await screen.findByRole('button', { name: /Work/ })).not.toBeNull()
    await waitFor(() => expect(container.querySelector('img.agent-avatar-img')).not.toBeNull())
  })

  it('opens the default profile unnamed and named profiles by name', async () => {
    const { onOpenAgent } = renderRoster(new MemoryGateway().handle('profiles.list', () => ({})))

    fireEvent.click(await screen.findByRole('button', { name: /Hermes/ }))
    expect(onOpenAgent).toHaveBeenCalledWith(null)

    fireEvent.click(screen.getByRole('button', { name: /Work/ }))
    expect(onOpenAgent).toHaveBeenCalledWith('work')
  })

  it('shows an empty state when the gateway has no profiles', async () => {
    $connection.set({ ...$connection.get(), status: { auth_required: false, profiles: [] } as unknown as GatewayStatus })
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})))

    expect(await screen.findByText('No bot profiles exist on this gateway yet.')).not.toBeNull()
  })

  it('filters the roster by the search query', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})), 'work')

    expect(await screen.findByRole('button', { name: /Work/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Hermes/ })).toBeNull()
  })

  it('shows a no-match state when the search has no hits', async () => {
    renderRoster(new MemoryGateway().handle('profiles.list', () => ({})), 'missing')

    expect(await screen.findByText('No bots match this search.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Work/ })).toBeNull()
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