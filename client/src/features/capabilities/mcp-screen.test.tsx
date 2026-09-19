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

import { McpScreen } from './mcp-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { PlatformActions } from '~/native/platform-actions'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

const originalPreferences = $preferences.get()
const server = {
  args: [],
  auth: 'oauth',
  command: null,
  enabled: true,
  name: 'fixture',
  tools: [],
  transport: 'streamable_http',
  url: 'https://mcp.example'
}

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  $preferences.set(originalPreferences)
})

function wrapperFor(gateway: MemoryGateway) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}><GatewayProvider gateway={gateway}>{children}</GatewayProvider></QueryClientProvider>
  }
}

function renderMcp(gateway: MemoryGateway) {
  render(<McpScreen onBack={() => undefined} onOpenCatalog={() => undefined} onSelect={() => undefined} />, { wrapper: wrapperFor(gateway) })
}

describe('McpScreen OAuth', () => {
  it('starts the scoped flow and opens its authorization URL', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/mcp/servers?profile=default', () => ({ servers: [server] }))
      .handle('/api/mcp/servers/fixture/auth?profile=default', () => ({
        authorization_url: 'https://auth.example/mcp',
        error: null,
        flow_id: 'flow-1',
        server_name: 'fixture',
        status: 'authorization_required'
      }))
      .handle('/api/mcp/oauth/flows/flow-1', () => ({
        authorization_url: 'https://auth.example/mcp',
        error: null,
        flow_id: 'flow-1',
        server_name: 'fixture',
        status: 'authorization_required'
      }))
    const openExternal = vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderMcp(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Authenticate fixture' }))
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://auth.example/mcp'))
    expect(gateway.calls).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ path: '/api/mcp/servers/fixture/auth?profile=default' }) }))
    expect(screen.getByRole('button', { name: 'Open authorization' })).not.toBeNull()
  })

  it('stops local polling before remote cancellation', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/mcp/servers?profile=default', () => ({ servers: [server] }))
      .handle('/api/mcp/servers/fixture/auth?profile=default', () => ({
        authorization_url: 'https://auth.example/mcp',
        error: null,
        flow_id: 'flow-1',
        server_name: 'fixture',
        status: 'authorization_required'
      }))
      .handle('/api/mcp/oauth/flows/flow-1', value => {
        const request = value as { method?: string }
        if (request.method === 'DELETE') return { ok: true, status: 'cancelled' }
        return {
          authorization_url: 'https://auth.example/mcp',
          error: null,
          flow_id: 'flow-1',
          server_name: 'fixture',
          status: 'authorization_required'
        }
      })
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderMcp(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Authenticate fixture' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel authentication' }))
    await waitFor(() => expect(gateway.calls).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ method: 'DELETE', path: '/api/mcp/oauth/flows/flow-1' }) })))
    expect(screen.queryByText('MCP authentication')).toBeNull()
  })

  it('blocks a replacement run while remote cancellation is pending', async () => {
    let resolveCancel!: (value: { ok: boolean; status: string }) => void
    const pendingCancel = new Promise<{ ok: boolean; status: string }>(resolve => { resolveCancel = resolve })
    const gateway = new MemoryGateway()
      .handle('/api/mcp/servers?profile=default', () => ({ servers: [server] }))
      .handle('/api/mcp/servers/fixture/auth?profile=default', () => ({
        authorization_url: 'https://auth.example/mcp',
        error: null,
        flow_id: 'flow-1',
        server_name: 'fixture',
        status: 'authorization_required'
      }))
      .handle('/api/mcp/oauth/flows/flow-1', value => {
        const request = value as { method?: string }
        if (request.method === 'DELETE') return pendingCancel
        return {
          authorization_url: 'https://auth.example/mcp',
          error: null,
          flow_id: 'flow-1',
          server_name: 'fixture',
          status: 'authorization_required'
        }
      })
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderMcp(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Authenticate fixture' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel authentication' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Authenticate fixture' }) as HTMLButtonElement).disabled).toBe(true))
    resolveCancel({ ok: true, status: 'cancelled' })
    await waitFor(() => expect(screen.queryByText('MCP authentication')).toBeNull())
  })

  it('dismisses without sending remote cancellation', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/mcp/servers?profile=default', () => ({ servers: [server] }))
      .handle('/api/mcp/servers/fixture/auth?profile=default', () => ({
        authorization_url: 'https://auth.example/mcp',
        error: null,
        flow_id: 'flow-1',
        server_name: 'fixture',
        status: 'authorization_required'
      }))
      .handle('/api/mcp/oauth/flows/flow-1', () => ({
        authorization_url: 'https://auth.example/mcp',
        error: null,
        flow_id: 'flow-1',
        server_name: 'fixture',
        status: 'authorization_required'
      }))
    vi.spyOn(PlatformActions.prototype, 'openExternal').mockResolvedValue()
    renderMcp(gateway)

    fireEvent.click(await screen.findByRole('button', { name: 'Authenticate fixture' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText('MCP authentication')).toBeNull())
    expect(gateway.calls.some(call => (call.value as { method?: string }).method === 'DELETE')).toBe(false)
  })
})
