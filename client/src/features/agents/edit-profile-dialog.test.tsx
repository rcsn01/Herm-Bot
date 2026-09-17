import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props}>{children}</button>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />
}))

import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

import { EditProfileDialog } from './edit-profile-dialog'

const originalPreferences = $preferences.get()
const bot = {
  description: 'An operator',
  hasAvatar: false,
  isDefault: false,
  meta: { color: '#3b82f6', shape: 'circle', title: 'Work' },
  name: 'work'
}

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
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
        <EditProfileDialog bot={bot} onCancel={onCancel} open />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return onCancel
}

describe('EditProfileDialog', () => {
  it('saves appearance and description to the explicitly named profile', async () => {
    const gateway = new MemoryGateway().handle('profiles.configure', params => {
      if ('description' in (params as object)) expect(params).toMatchObject({ description: 'Updated description', name: 'work' })
      if ('ui_meta' in (params as object)) expect(params).toMatchObject({ name: 'work', ui_meta: { 'hermes-bots': { color: '#3b82f6', shape: 'circle', title: 'Updated' } } })
      return { applied: { description: true, ui_meta: true }, ok: true }
    })
    const onCancel = renderDialog(gateway)

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Updated' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Updated description' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(gateway.calls.map(call => call.method)).toEqual(['profiles.configure', 'profiles.configure'])
    expect(gateway.calls.every(call => call.value && typeof call.value === 'object' && (call.value as { name?: string }).name === 'work')).toBe(true)
  })

  it('uses the verified cli fallback when clearing an inherited model', async () => {
    const gateway = new MemoryGateway()
      .handle('profiles.describe', () => ({
        mcp_servers: [],
        model: { default: 'fixture/deep', provider: 'fixture' },
        skills: [],
        soul: '',
        toolsets: []
      }))
      .handle('mcp.catalog', () => ({ servers: [] }))
      .handle('model.options', () => ({ providers: [{ models: ['fixture/deep'], slug: 'fixture' }] }))
      .handle('cli.exec', params => {
        expect(params).toEqual({ argv: ['--profile', 'work', 'config', 'unset', 'model'] })
        return { code: 0, ok: true }
      })
    renderDialog(gateway)

    fireEvent.click(screen.getByRole('button', { name: 'Advanced profile settings' }))
    await screen.findByRole('textbox', { name: 'SOUL.md' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Profile provider' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(gateway.calls.some(call => call.method === 'cli.exec')).toBe(true))
  })
})
