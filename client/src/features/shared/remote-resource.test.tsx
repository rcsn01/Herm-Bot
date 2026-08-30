import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteResourceScreen, type RemoteResourceDefinition } from '~/features/shared/remote-resource'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Skeleton: () => <span>Loading</span>
}))

const originalPreferences = $preferences.get()

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
})

function renderDefinition(definition: RemoteResourceDefinition, body: unknown) {
  $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
  const requestPath = definition.profileScoped === false ? definition.path : `${definition.path}?profile=work`
  const gateway = new MemoryGateway().handle(requestPath, () => body)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <GatewayProvider gateway={gateway}>
        <RemoteResourceScreen definition={definition} onBack={() => undefined} />
      </GatewayProvider>
    </QueryClientProvider>
  )
  return gateway
}

function renderResource(id: 'credentials' | 'models' | 'providers', body: unknown) {
  const definitions: Record<typeof id, RemoteResourceDefinition> = {
    credentials: { description: 'Redacted credentials.', id: 'credentials', path: '/api/env', presentation: 'credentials', title: 'Credentials' },
    models: { description: 'Model information.', id: 'models', path: '/api/model/info', presentation: 'models', title: 'Models' },
    providers: { description: 'Provider information.', id: 'providers', path: '/api/model/info', presentation: 'providers', title: 'Providers' }
  }
  return renderDefinition(definitions[id], body)
}

describe('RemoteResourceScreen', () => {
  it('projects provider meaning from shared model information', async () => {
    const gateway = renderResource('providers', {
      available_providers: ['openrouter', 'anthropic'],
      context_length: 128_000,
      model: 'openrouter/example',
      provider: 'openrouter'
    })

    expect(await screen.findByText('Available Providers')).toBeTruthy()
    expect(screen.getByText('openrouter, anthropic')).toBeTruthy()
    expect(screen.getByText('Provider')).toBeTruthy()
    expect(screen.queryByText('Model')).toBeNull()
    expect(screen.queryByText('Context Length')).toBeNull()
    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/model/info?profile=work' })
  })

  it('projects model meaning without repeating provider status', async () => {
    renderResource('models', {
      available_providers: ['openrouter', 'anthropic'],
      context_length: 128_000,
      model: 'openrouter/example',
      provider: 'openrouter'
    })

    expect(await screen.findByText('Model')).toBeTruthy()
    expect(screen.getByText('Context Length')).toBeTruthy()
    expect(screen.queryByText('Provider')).toBeNull()
    expect(screen.queryByText('Available Providers')).toBeNull()
  })

  it('keeps credentials on the redacted environment route', async () => {
    const gateway = renderResource('credentials', { OPENROUTER_API_KEY: 'Configured' })

    expect(await screen.findByText('OPENROUTER API KEY')).toBeTruthy()
    expect(screen.getByText('Configured')).toBeTruthy()
    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/env?profile=work' })
  })

  it.each([{ model: 'openrouter/example' }, [], ''])('reports an honest empty state when a provider response has no matching data', async body => {
    renderResource('providers', body)

    expect(await screen.findByText('No details')).toBeTruthy()
    expect(screen.getByText('The gateway returned no provider information.')).toBeTruthy()
    expect(screen.queryByText('0 items')).toBeNull()
  })

  it('renders nested generic resources as read-only data', async () => {
    renderDefinition({
      description: 'Current delegated work.',
      id: 'agents',
      path: '/api/agents',
      title: 'Agents'
    }, [{ id: 'agent-1', state: { label: 'running' } }])

    expect(await screen.findByText('agent-1')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.queryByText(/inspect or manage/i)).toBeNull()
  })

  it('labels nested empty JSON values instead of leaving blank rows', async () => {
    renderDefinition({
      description: 'Gateway state.',
      id: 'state',
      path: '/api/state',
      title: 'State'
    }, { list: [], record: {}, value: '' })

    expect(await screen.findByText('Empty list')).toBeTruthy()
    expect(screen.getByText('Empty record')).toBeTruthy()
    expect(screen.getByText('Empty value')).toBeTruthy()
  })

  it('does not request default-profile-only resources for named profiles', async () => {
    const gateway = renderDefinition({
      defaultProfileOnly: true,
      description: 'Gateway logs.',
      id: 'logs',
      path: '/api/logs',
      profileScoped: false,
      title: 'Logs'
    }, { lines: ['secret process output'] })

    expect(await screen.findByText('Unavailable for this profile')).toBeTruthy()
    expect(screen.getByText(/only available from the default profile/i)).toBeTruthy()
    expect(gateway.calls).toHaveLength(0)
  })

  it('leaves installation-wide resources unscoped', async () => {
    const gateway = renderDefinition({
      description: 'Gateway health.',
      id: 'system',
      path: '/api/status',
      profileScoped: false,
      title: 'System'
    }, { gateway_running: true, version: '6' })

    expect(await screen.findByText('Gateway Running')).toBeTruthy()
    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/status' })
  })
})
