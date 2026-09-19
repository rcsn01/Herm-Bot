import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
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
import { PlatformActions } from '~/native/platform-actions'
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
  vi.restoreAllMocks()
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

describe('Tools & keys', () => {
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

describe('Provider OAuth', () => {
  function provider(flow: 'device_code' | 'pkce') {
    return {
      cli_command: 'hermes auth',
      docs_url: 'https://docs.example/provider',
      flow,
      id: 'nous',
      name: 'Nous',
      status: { logged_in: false }
    }
  }

  function renderProviders(gateway: MemoryGateway) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><SettingsAdministrationScreen controller={controller} onBack={() => undefined} page="providers" /></GatewayProvider></QueryClientProvider>)
  }

  function baseGateway(flow: 'device_code' | 'pkce') {
    return new MemoryGateway()
      .handle('/api/providers/oauth?profile=default', () => ({ providers: [provider(flow)] }))
      .handle('/api/providers/custom-endpoints?profile=default', () => ({ endpoints: [] }))
  }

  it('opens a provider URL through the platform action and waits for polling', async () => {
    const gateway = baseGateway('pkce')
      .handle('/api/providers/oauth/nous/start?profile=default', () => ({ auth_url: 'https://auth.example/provider', expires_in: 300, flow: 'pkce', session_id: 'provider-flow' }))
      .handle('/api/providers/oauth/nous/poll/provider-flow', () => ({ error_message: null, session_id: 'provider-flow', status: 'pending' }))
    const openExternal = vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderProviders(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://auth.example/provider'))
    expect(screen.getByRole('button', { name: 'Open provider' })).not.toBeNull()
  })

  it('closes and refetches the provider list after poll approval', async () => {
    const gateway = baseGateway('pkce')
      .handle('/api/providers/oauth/nous/start?profile=default', () => ({ auth_url: 'https://auth.example/provider', expires_in: 300, flow: 'pkce', session_id: 'provider-flow' }))
      .handle('/api/providers/oauth/nous/poll/provider-flow', () => ({ error_message: null, session_id: 'provider-flow', status: 'approved' }))
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderProviders(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Connect Nous' })).toBeNull(), { timeout: 3_000 })
    expect(gateway.calls.filter(call => (call.value as { path?: string }).path === '/api/providers/oauth/nous/poll/provider-flow')).toHaveLength(1)
  })

  it('submits a device code through the call-site policy and clears the flow', async () => {
    let submitBody: unknown
    const gateway = baseGateway('device_code')
      .handle('/api/providers/oauth/nous/start?profile=default', () => ({ expires_in: 300, flow: 'device_code', poll_interval: 5, session_id: 'device-flow', user_code: 'ABCD', verification_url: 'https://auth.example/device' }))
      .handle('/api/providers/oauth/nous/poll/device-flow', () => ({ error_message: null, session_id: 'device-flow', status: 'pending' }))
      .handle('/api/providers/oauth/nous/submit?profile=default', value => {
        submitBody = value
        return { message: 'Approved.', ok: true, status: 'approved' }
      })
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderProviders(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    const input = await screen.findByPlaceholderText('Code')
    fireEvent.change(input, { target: { value: 'ABCD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Connect Nous' })).toBeNull())
    expect(submitBody).toMatchObject({ body: { code: 'ABCD', session_id: 'device-flow' }, method: 'POST' })
  })

  it('stops local polling before provider cancellation', async () => {
    const gateway = baseGateway('pkce')
      .handle('/api/providers/oauth/nous/start?profile=default', () => ({ auth_url: 'https://auth.example/provider', expires_in: 300, flow: 'pkce', session_id: 'provider-flow' }))
      .handle('/api/providers/oauth/nous/poll/provider-flow', () => ({ error_message: null, session_id: 'provider-flow', status: 'pending' }))
      .handle('/api/providers/oauth/sessions/provider-flow', value => {
        expect(value).toMatchObject({ method: 'DELETE' })
        return { ok: true }
      })
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderProviders(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Connect Nous' })).toBeNull())
    expect(gateway.calls).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ method: 'DELETE', path: '/api/providers/oauth/sessions/provider-flow' }) }))
  })

  it('keeps the provider cancellation handle available when remote cancellation fails', async () => {
    let cancelAttempts = 0
    const gateway = baseGateway('pkce')
      .handle('/api/providers/oauth/nous/start?profile=default', () => ({ auth_url: 'https://auth.example/provider', expires_in: 300, flow: 'pkce', session_id: 'provider-flow' }))
      .handle('/api/providers/oauth/nous/poll/provider-flow', () => ({ error_message: null, session_id: 'provider-flow', status: 'pending' }))
      .handle('/api/providers/oauth/sessions/provider-flow', () => {
        cancelAttempts += 1
        if (cancelAttempts === 1) throw new Error('cancel failed')
        return { ok: true }
      })
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderProviders(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await screen.findByRole('button', { name: 'Open provider' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cancel failed'))
    expect(screen.getByRole('heading', { name: 'Connect Nous' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Connect Nous' })).toBeNull())
    expect(cancelAttempts).toBe(2)
  })

  it('does not let a device-code submit complete after cancellation starts', async () => {
    let resolveSubmit!: (value: { message: string; ok: boolean; status: 'approved' | 'error' }) => void
    let resolveCancel!: (value: { ok: boolean }) => void
    let providerCalls = 0
    const pendingSubmit = new Promise<{ message: string; ok: boolean; status: 'approved' | 'error' }>(resolve => { resolveSubmit = resolve })
    const pendingCancel = new Promise<{ ok: boolean }>(resolve => { resolveCancel = resolve })
    const gateway = new MemoryGateway()
      .handle('/api/providers/oauth?profile=default', () => {
        providerCalls += 1
        return { providers: [provider('device_code')] }
      })
      .handle('/api/providers/custom-endpoints?profile=default', () => ({ endpoints: [] }))
      .handle('/api/providers/oauth/nous/start?profile=default', () => ({ expires_in: 300, flow: 'device_code', poll_interval: 5, session_id: 'device-flow', user_code: 'ABCD', verification_url: 'https://auth.example/device' }))
      .handle('/api/providers/oauth/nous/poll/device-flow', () => ({ error_message: null, session_id: 'device-flow', status: 'pending' }))
      .handle('/api/providers/oauth/nous/submit?profile=default', () => pendingSubmit)
      .handle('/api/providers/oauth/sessions/device-flow', value => {
        expect(value).toMatchObject({ method: 'DELETE' })
        return pendingCancel
      })
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderProviders(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    const input = await screen.findByPlaceholderText('Code')
    fireEvent.change(input, { target: { value: 'ABCD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(gateway.calls).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ method: 'DELETE', path: '/api/providers/oauth/sessions/device-flow' }) })))

    await act(async () => {
      resolveSubmit({ message: 'Approved.', ok: true, status: 'approved' })
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connect Nous' })).not.toBeNull())
    expect(providerCalls).toBe(1)

    resolveCancel({ ok: true })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Connect Nous' })).toBeNull())
  })
})
