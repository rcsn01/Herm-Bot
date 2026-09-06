import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'
import { ToolsetsScreen } from './toolsets-screen'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
  Skeleton: () => <span>Loading</span>
}))

vi.mock('~/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({ confirmLabel, onCancel, onConfirm, title }: { confirmLabel: string; onCancel(): void; onConfirm(): void; title: string }) => (
    <div role="dialog"><h2>{title}</h2><button onClick={onConfirm}>{confirmLabel}</button><button onClick={onCancel}>Cancel</button></div>
  )
}))

const originalPreferences = $preferences.get()
const toolset = {
  configured: false,
  description: 'Search tools',
  enabled: false,
  label: 'Search',
  name: 'search',
  tools: ['web_search']
}

function renderToolsets(gateway: MemoryGateway) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <ToolsetsScreen onBack={() => undefined} />
      </GatewayProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
})

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
})

describe('ToolsetsScreen', () => {
  it('optimistically toggles, rolls back failures, and invalidates successful toggles', async () => {
    let listCalls = 0
    let mutationCalls = 0
    let fail!: (reason?: unknown) => void
    const failed = new Promise<never>((_, reject) => { fail = reject })
    const gateway = new MemoryGateway()
      .handle('/api/tools/toolsets?profile=default', () => {
        listCalls += 1
        return [{ ...toolset, enabled: mutationCalls > 1 }]
      })
      .handle('/api/tools/toolsets/search?profile=default', value => {
        const request = value as { method?: string }
        if (request.method !== 'PUT') return { ...toolset }
        mutationCalls += 1
        if (mutationCalls === 1) return failed
        return { enabled: true, name: 'search', ok: true }
      })

    renderToolsets(gateway)
    const checkbox = await screen.findByRole('checkbox', { name: 'Enable Search' }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox.checked).toBe(true))
    fail(new Error('toggle failed'))
    await waitFor(() => expect(checkbox.checked).toBe(false))
    expect((await screen.findByRole('alert')).textContent).toContain('toggle failed')

    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox.checked).toBe(true))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await waitFor(() => expect(listCalls).toBeGreaterThan(1))
    expect(mutationCalls).toBe(2)
  })
})
