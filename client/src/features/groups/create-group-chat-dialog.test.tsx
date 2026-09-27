import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayProvider } from '~/gateway/gateway-context'
import { $connection } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

import { $groupChats } from './group-engine'
import { CreateGroupChatDialog } from './create-group-chat-dialog'
import { $groupChats as $groupChatsState } from './group-store'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: null })
  $groupChatsState.set({})
})

function renderDialog(gateway = new MemoryGateway().handle('profiles.list', () => ({ profiles: [
  { is_default: true, name: 'default' },
  { description: 'A second bot', name: 'work' },
  { name: 'scout' }
] }))) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <CreateGroupChatDialog onCancel={vi.fn()} onCreated={vi.fn()} open />
      </GatewayProvider>
    </QueryClientProvider>
  )
}

describe('create group chat dialog', () => {
  it('selects existing bots, creates a local room, and reports it', async () => {
    const onCancel = vi.fn()
    const onCreated = vi.fn()
    const gateway = new MemoryGateway().handle('profiles.list', () => ({ profiles: [
      { is_default: true, name: 'default' },
      { name: 'work' }
    ] }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <GatewayProvider gateway={gateway}>
          <CreateGroupChatDialog onCancel={onCancel} onCreated={onCreated} open />
        </GatewayProvider>
      </QueryClientProvider>
    )

    await screen.findByRole('checkbox', { name: 'Hermes' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermes' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Work' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: 'Research team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group chat (2)' }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()
    const room = onCreated.mock.calls[0][0]
    expect(room).toEqual(expect.objectContaining({ key: expect.stringMatching(/^id:r/), members: [{ name: 'default' }, { name: 'work' }], name: 'Research team' }))
    expect($groupChats.get()[room.key]).toEqual(expect.objectContaining({ members: [{ name: 'default' }, { name: 'work' }], roomId: room.roomId }))
    expect(JSON.parse(localStorage.getItem('hermes.group-chats.v4') || '{}')[room.key]).toEqual(expect.objectContaining({ members: [{ name: 'default' }, { name: 'work' }], roomId: room.roomId }))
  })

  it('requires at least two selected bots', async () => {
    renderDialog()

    await screen.findByRole('checkbox', { name: 'Hermes' })
    const create = screen.getByRole('button', { name: 'Create group chat' })
    expect((create as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermes' }))
    expect((screen.getByRole('button', { name: 'Create group chat (1)' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
