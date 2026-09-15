import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props}>{children}</button>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />
}))

import { GatewayProvider } from '~/gateway/gateway-context'
import type { GatewayStatus } from '~/lib/types'
import { $connection, $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

import { CreateProfileDialog, validateProfileName } from './create-profile-dialog'
import { RosterScreen } from './roster-screen'

const originalPreferences = $preferences.get()

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
  $connection.set({
    authMode: 'token',
    error: null,
    phase: 'connected',
    status: { auth_required: false, profiles: [{ is_default: true, name: 'default' }] } as unknown as GatewayStatus
  })
})

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
})

function renderDialog(gateway: MemoryGateway, onCancel = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <CreateProfileDialog onCancel={onCancel} open />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return onCancel
}

describe('profile name validation', () => {
  it('accepts a trimmed lowercase profile slug', () => {
    expect(validateProfileName('  research-bot_2  ')).toBeNull()
  })

  it.each([
    ['New Bot', /lowercase/],
    ['default', /reserved/],
    ['a'.repeat(64), /63 characters/],
    ['bad name', /lowercase/]
  ])('rejects %s', (value, message) => {
    expect(validateProfileName(value)).toMatch(message)
  })
})

describe('CreateProfileDialog', () => {
  it('persists optional metadata and advanced SOUL settings after creation', async () => {
    const gateway = new MemoryGateway()
      .handle('profiles.list', () => ({ profiles: [{ is_default: true, name: 'default' }] }))
      .handle('profiles.describe', () => ({ mcp_servers: [], skills: [], soul: '', toolsets: [] }))
      .handle('mcp.catalog', () => ({ servers: [] }))
      .handle('model.options', () => ({ providers: [] }))
      .handle('profiles.create', params => {
        expect(params).toEqual({ description: 'Operator profile', name: 'research', share_auth: true, soul: 'Be concise.' })
        return { name: 'research', ok: true, path: '/profiles/research' }
      })
      .handle('profiles.configure', params => {
        expect(params).toMatchObject({ name: 'research', ui_meta: { 'hermes-bots': { title: 'Research' } } })
        return { applied: { ui_meta: true }, ok: true }
      })
    const onCancel = renderDialog(gateway)

    fireEvent.change(screen.getByRole('textbox', { name: 'Profile name' }), { target: { value: 'research' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Research' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Operator profile' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced profile settings' }))
    await screen.findByRole('textbox', { name: 'SOUL.md' })
    fireEvent.change(screen.getByRole('textbox', { name: 'SOUL.md' }), { target: { value: 'Be concise.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  it('exposes an accessible form and explains invalid names', () => {
    renderDialog(new MemoryGateway())

    expect(screen.getByRole('dialog', { name: 'Create profile' })).not.toBeNull()
    const input = screen.getByRole('textbox', { name: 'Profile name' })
    expect(input.getAttribute('maxlength')).toBe('63')
    expect((screen.getByRole('button', { name: 'Create profile' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'New Bot' } })

    expect(screen.getByRole('alert').textContent).toContain('lowercase')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByRole('button', { name: 'Create profile' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a busy state while the gateway creates a profile', async () => {
    let release: (() => void) | undefined
    const gateway = new MemoryGateway().handle('profiles.create', () => new Promise(resolve => {
      release = () => resolve({ name: 'research', ok: true, path: '/profiles/research' })
    }))
    renderDialog(gateway)
    const input = screen.getByRole('textbox', { name: 'Profile name' })

    fireEvent.change(input, { target: { value: 'research' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))

    expect((await screen.findByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    release!()
    await waitFor(() => expect(gateway.calls.at(-1)?.method).toBe('profiles.create'))
  })

  it('shows gateway errors without closing the dialog', async () => {
    const onCancel = renderDialog(new MemoryGateway().handle('profiles.create', () => {
      throw new Error('Profile already exists')
    }))
    const input = screen.getByRole('textbox', { name: 'Profile name' })

    fireEvent.change(input, { target: { value: 'research' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Profile already exists')
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Create profile' })).not.toBeNull()
  })

  it('refreshes the unscoped roster after a successful creation', async () => {
    const profiles = ['default']
    const gateway = new MemoryGateway()
      .handle('profiles.list', () => ({ profiles: profiles.map(name => ({ is_default: name === 'default', name })) }))
      .handle('profiles.create', params => {
        profiles.push((params as { name: string }).name)
        return { name: 'research', ok: true, path: '/profiles/research' }
      })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const onCancel = vi.fn()
    render(
      <QueryClientProvider client={client}>
        <GatewayProvider gateway={gateway}>
          <RosterScreen onOpenAgent={() => undefined} onOpenGroup={() => undefined} />
          <CreateProfileDialog onCancel={onCancel} open />
        </GatewayProvider>
      </QueryClientProvider>
    )

    await screen.findByRole('button', { name: 'Hermes' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Profile name' }), { target: { value: 'research' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Research' })).not.toBeNull()
    expect(gateway.calls.filter(call => call.kind === 'rpc' && call.method === 'profiles.list').length).toBeGreaterThanOrEqual(2)
  })
})
