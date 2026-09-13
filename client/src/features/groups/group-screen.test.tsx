import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GroupChatScreen } from './group-screen'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GatewayProvider } from '~/gateway/gateway-context'
import { MemoryGateway } from '~/test/memory-gateway'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
  Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />
}))

const snapshot = {
  version: 3,
  rooms: {
    'id:r-crew': {
      name: 'Research crew',
      roomId: 'r-crew',
      revision: 3,
      members: [{ name: 'codex' }, { name: 'scout' }],
      log: [
        { at: 1_700_000_000_000, from: { kind: 'user', name: 'You' }, text: 'Find the specs' },
        { at: 1_700_000_060_000, from: { kind: 'member', name: 'Codex' }, text: 'Two candidates so far' },
        { at: 1_700_000_120_000, from: { kind: 'member', name: 'Scout', source: 'h-lap02' }, text: 'Adding a third' }
      ]
    }
  }
}

function renderGroup(gateway: MemoryGateway, roomId = 'id:r-crew') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <GroupChatScreen roomId={roomId} />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return { container }
}

afterEach(cleanup)

describe('group chat screen', () => {
  it('renders the mirrored room log with member captions and user bubbles', async () => {
    const { container } = renderGroup(new MemoryGateway().handle('profiles.list', () => ({ profiles: [{ name: 'default', is_default: true, ui_meta: { 'hermes-bots-groups': snapshot } }] })))

    expect(await screen.findByText('Two candidates so far')).not.toBeNull()
    const bubbles = Array.from(container.querySelectorAll('article.message'))
    expect(bubbles).toHaveLength(3)
    expect(bubbles[0].classList.contains('user')).toBe(true)
    expect(bubbles[0].querySelector('.message-meta')).toBeNull()
    expect(bubbles[1].querySelector('.message-meta')?.textContent).toBe('Codex')
    expect(bubbles[2].querySelector('.message-meta')?.textContent).toContain('Scout')
    expect(bubbles[2].textContent).toContain('h-lap02')
    expect(container.textContent).toContain('2 bots')
  })

  it('states when a room is missing from the gateway snapshot', async () => {
    renderGroup(new MemoryGateway().handle('profiles.list', () => ({ profiles: [{ name: 'default', is_default: true, ui_meta: { 'hermes-bots-groups': snapshot } }] })), 'id:r-gone')

    expect(await screen.findByText('This group chat is not available on this gateway yet.')).not.toBeNull()
  })
})