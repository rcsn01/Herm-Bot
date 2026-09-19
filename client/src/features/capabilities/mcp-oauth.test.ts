import { describe, expect, it, vi } from 'vitest'

import { createMcpOAuthAdapter } from './mcp-oauth'
import type { McpOAuthFlow } from './mcp-api'
import { MemoryGateway } from '~/test/memory-gateway'

const gateway = new MemoryGateway()

function flow(status: McpOAuthFlow['status'], overrides: Partial<McpOAuthFlow> = {}): McpOAuthFlow {
  return {
    authorization_url: status === 'authorization_required' ? 'https://auth.example/mcp' : null,
    error: status === 'error' ? 'MCP rejected authorization.' : null,
    flow_id: 'mcp-flow-1',
    server_name: 'fixture',
    status,
    ...overrides
  }
}

describe('MCP OAuth adapter', () => {
  it('maps authorization-required start data to a waiting snapshot', async () => {
    const mcp = { auth: vi.fn(async () => flow('authorization_required')), oauthStatus: vi.fn() }
    const source = createMcpOAuthAdapter(mcp, gateway, 'fixture')

    await expect(source.start(new AbortController().signal)).resolves.toEqual({
      authorizationURL: 'https://auth.example/mcp',
      flowId: 'mcp-flow-1',
      phase: 'waiting'
    })
    expect(mcp.auth).toHaveBeenCalledWith('fixture', expect.any(AbortSignal))
  })

  it('does not poll when the start response is already approved', async () => {
    const mcp = { auth: vi.fn(async () => flow('approved')), oauthStatus: vi.fn() }
    const source = createMcpOAuthAdapter(mcp, gateway, 'fixture')

    await expect(source.start(new AbortController().signal)).resolves.toMatchObject({ flowId: 'mcp-flow-1', phase: 'approved' })
    expect(mcp.oauthStatus).not.toHaveBeenCalled()
  })

  it('maps poll errors and preserves the opaque flow id', async () => {
    const mcp = { auth: vi.fn(), oauthStatus: vi.fn(async () => flow('error')) }
    const source = createMcpOAuthAdapter(mcp, gateway, 'fixture')

    await expect(source.poll({ flowId: 'mcp-flow-1', phase: 'waiting' }, new AbortController().signal)).resolves.toEqual({
      flowId: 'mcp-flow-1',
      message: 'MCP rejected authorization.',
      phase: 'error'
    })
    expect(mcp.oauthStatus).toHaveBeenCalledWith('mcp-flow-1', expect.any(AbortSignal))
  })

  it('rejects an MCP response without a flow id', async () => {
    const mcp = { auth: vi.fn(async () => flow('starting', { flow_id: '' })), oauthStatus: vi.fn() }
    const source = createMcpOAuthAdapter(mcp, gateway, 'fixture')

    await expect(source.start(new AbortController().signal)).rejects.toThrow(/invalid MCP OAuth flow/i)
  })
})
