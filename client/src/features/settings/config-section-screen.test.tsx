import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Skeleton: () => <span>Loading</span>,
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange(value: boolean): void }) => <input checked={checked} onChange={event => onCheckedChange(event.target.checked)} type="checkbox" />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />
}))

import { ConfigSectionScreen } from './config-section-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

const originalPreferences = $preferences.get()

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
  vi.restoreAllMocks()
})

function renderSettings(gateway: MemoryGateway, category = 'chat') {
  $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GatewayProvider gateway={gateway}>
        <ConfigSectionScreen category={category} onBack={() => undefined} />
      </GatewayProvider>
    </QueryClientProvider>
  )
}

const schema = {
  fields: {
    'display.personality': { type: 'string', description: 'Personality' },
    'timezone': { type: 'string', description: 'Timezone' },
    'display.show_reasoning': { type: 'boolean', description: 'Show reasoning' },
    'agent.image_input_mode': { type: 'select', description: 'Image input', options: ['auto', 'off'] }
  }
}

describe('ConfigSectionScreen', () => {
  it('saves only the changed nested field in the selected profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => options && (options as { method?: string }).method === 'PUT' ? { ok: true } : { display: { personality: 'default' }, timezone: 'UTC' })
      .handle('/api/config/schema?profile=work', () => schema)

    renderSettings(gateway)
    const input = await screen.findByDisplayValue('default')
    fireEvent.change(input, { target: { value: 'concise' } })
    await waitFor(() => expect(gateway.calls.some(call => call.kind === 'request' && (call.value as { method?: string; path?: string }).path === '/api/config?profile=work' && (call.value as { method?: string }).method === 'PUT')).toBe(true), { timeout: 2_000 })
    const save = gateway.calls.find(call => call.kind === 'request' && (call.value as { method?: string; path?: string }).path === '/api/config?profile=work' && (call.value as { method?: string }).method === 'PUT')
    expect(save?.value).toMatchObject({ body: { config: { display: { personality: 'concise' } } }, path: '/api/config?profile=work' })
  })

  it('rolls back the optimistic value when the gateway rejects a save', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => options && (options as { method?: string }).method === 'PUT' ? Promise.reject(new Error('save rejected')) : { display: { personality: 'default' } })
      .handle('/api/config/schema?profile=work', () => schema)

    renderSettings(gateway)
    const input = await screen.findByDisplayValue('default')
    fireEvent.change(input, { target: { value: 'concise' } })

    expect(await screen.findByText('save rejected')).toBeTruthy()
    await waitFor(() => expect(screen.getByDisplayValue('default')).toBeTruthy())
  })

  it('renders the empty state when a category has no fields in the schema', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', () => ({ terminal: { cwd: '/workspace' } }))
      .handle('/api/config/schema?profile=work', () => ({ fields: {} }))

    renderSettings(gateway, 'workspace')

    expect(await screen.findByText('This gateway does not expose editable fields for this category.')).toBeTruthy()
  })
})
