import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props}>{children}</button>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Skeleton: () => <span>Loading</span>,
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange(value: boolean): void }) => <input checked={checked} onChange={event => onCheckedChange(event.target.checked)} type="checkbox" />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />
}))

import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'
import { MemorySettings } from './memory-settings'

function memoryProviderConfig() {
  return {
    docs_url: '',
    fields: [{
      description: 'Workspace identifier',
      group: 'Connection',
      inline: true,
      is_set: true,
      key: 'workspace',
      kind: 'text',
      label: 'Workspace',
      options: [],
      placeholder: '',
      value: 'old-workspace'
    }, {
      description: 'Provider token',
      group: 'Connection',
      inline: true,
      is_set: true,
      key: 'token',
      kind: 'secret',
      label: 'Token',
      options: [],
      placeholder: '',
      value: '<configured>'
    }],
    label: 'Honcho',
    name: 'honcho'
  }
}

function renderMemorySettings(gateway: MemoryGateway) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><MemorySettings onBack={() => undefined} /></GatewayProvider></QueryClientProvider>)
}

beforeEach(() => {
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.example', theme: 'system' })
})

afterEach(() => cleanup())

describe('MemorySettings', () => {
  it('saves provider fields through the declared config endpoint', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/memory', () => ({
        active: 'honcho',
        builtin_files: { memory: 0, user: 0 },
        providers: [{ configured: true, description: 'Remote memory', name: 'honcho', status: 'ready' }]
      }))
      .handle('/api/memory/providers/honcho/config?surface=declared&profile=default', value => {
        const options = value as { body?: { values?: Record<string, unknown> }; method?: string }
        if (options.method === 'PUT') {
          expect(options).toMatchObject({ body: { values: { token: 'new-secret', workspace: 'new-workspace' } }, method: 'PUT' })
          return { ok: true }
        }
        return memoryProviderConfig()
      })
      .handle('/api/memory/providers/honcho/oauth/status?profile=default', () => ({ auth: null, connected: false, detail: '', state: 'idle' }))

    renderMemorySettings(gateway)

    const input = await screen.findByDisplayValue('old-workspace')
    const secret = screen.getByLabelText(/Token/)
    fireEvent.change(input, { target: { value: 'new-workspace' } })
    fireEvent.change(secret, { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save provider settings' }))

    await waitFor(() => expect(gateway.calls.some(call => (call.value as { method?: string }).method === 'PUT')).toBe(true))
    expect(gateway.calls.find(call => (call.value as { method?: string }).method === 'PUT')?.value).toMatchObject({ body: { values: { token: 'new-secret', workspace: 'new-workspace' } }, method: 'PUT' })
    expect((secret as HTMLInputElement).value).toBe('')
    expect(gateway.calls.some(call => (call.value as { path?: string }).path?.includes('/setup'))).toBe(false)
  })

  it('omits blank secret fields so configured values are preserved', async () => {
    let savedBody: unknown
    const gateway = new MemoryGateway()
      .handle('/api/memory', () => ({
        active: 'honcho',
        builtin_files: { memory: 0, user: 0 },
        providers: [{ configured: true, description: 'Remote memory', name: 'honcho', status: 'ready' }]
      }))
      .handle('/api/memory/providers/honcho/config?surface=declared&profile=default', value => {
        const options = value as { body?: unknown; method?: string }
        if (options.method === 'PUT') {
          savedBody = options.body
          return { ok: true }
        }
        return memoryProviderConfig()
      })
      .handle('/api/memory/providers/honcho/oauth/status?profile=default', () => ({ auth: null, connected: false, detail: '', state: 'idle' }))

    renderMemorySettings(gateway)
    const input = await screen.findByDisplayValue('old-workspace')
    fireEvent.change(input, { target: { value: 'updated-without-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save provider settings' }))

    await waitFor(() => expect(savedBody).toEqual({ values: { workspace: 'updated-without-secret' } }))
  })

  it('does not offer process-scoped memory operations for a named profile', async () => {
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    const gateway = new MemoryGateway()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><MemorySettings onBack={() => undefined} /></GatewayProvider></QueryClientProvider>)

    expect(await screen.findByText(/memory management is unavailable for this profile/i)).not.toBeNull()
    expect(gateway.calls).toHaveLength(0)
  })
})
