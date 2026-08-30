import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props}>{children}</button>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Skeleton: () => <span>Loading</span>,
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange(value: boolean): void }) => <input checked={checked} onChange={event => onCheckedChange(event.target.checked)} type="checkbox" />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />
}))

vi.mock('~/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({ confirmLabel, onConfirm }: { confirmLabel: string; onConfirm(): void }) => <button onClick={onConfirm}>{confirmLabel}</button>
}))

import { SettingsAdministrationScreen } from './settings-administration-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import type { GatewayController } from '~/state/gateway-controller'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

const originalPreferences = $preferences.get()
const controller = {} as GatewayController

function renderTools(failSave = false) {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
  let savedBody: unknown
  const gateway = new MemoryGateway().handle('/api/env?profile=default', value => {
    const request = value as { body?: unknown; method?: string }
    if (request.method === 'PUT') {
      savedBody = request.body
      if (failSave) throw new Error('save failed')
      return { ok: true }
    }
    return {
      MOBILE_TEST_KEY: {
        advanced: false,
        category: 'provider',
        description: 'Test key',
        is_password: true,
        is_set: false,
        redacted_value: null,
        tools: [],
        url: null
      }
    }
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <GatewayProvider gateway={gateway}>
        <SettingsAdministrationScreen controller={controller} onBack={() => undefined} page="tools-keys" />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return { gateway, getSavedBody: () => savedBody }
}

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
})

describe('Settings administration profile gates', () => {
  it('does not query process-scoped plugin management for a named profile', async () => {
    $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
    const gateway = new MemoryGateway()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><SettingsAdministrationScreen controller={controller} onBack={() => undefined} page="plugins" /></GatewayProvider></QueryClientProvider>)

    expect(await screen.findByText(/plugin management is unavailable for this profile/i)).not.toBeNull()
    expect(gateway.calls).toHaveLength(0)
  })
})

describe('Tools & Keys', () => {
  it('sends a secret to the selected profile and clears the draft after saving', async () => {
    const { gateway, getSavedBody } = renderTools()
    const input = await screen.findByLabelText('MOBILE_TEST_KEY secret')
    fireEvent.change(input, { target: { value: 'super-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
    expect(getSavedBody()).toEqual({ key: 'MOBILE_TEST_KEY', profile: 'default', value: 'super-secret' })
    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/env?profile=default' })
    expect(JSON.stringify($preferences.get())).not.toContain('super-secret')
    expect(localStorage.getItem('super-secret')).toBeNull()
  })

  it('clears a secret even when the gateway rejects the save', async () => {
    const { getSavedBody } = renderTools(true)
    const input = await screen.findByLabelText('MOBILE_TEST_KEY secret')
    fireEvent.change(input, { target: { value: 'failed-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
    expect(getSavedBody()).toEqual({ key: 'MOBILE_TEST_KEY', profile: 'default', value: 'failed-secret' })
    expect(screen.getByRole('alert').textContent).toContain('save failed')
  })
})
