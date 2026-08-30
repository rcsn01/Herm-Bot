import { describe, expect, it } from 'vitest'

import { mcpApi } from './mcp-api'
import { MemoryGateway } from '~/test/memory-gateway'

describe('mcpApi', () => {
  it('updates one server without dropping other configuration or secret placeholders', async () => {
    const gateway = new MemoryGateway().handle('/api/config?profile=work', () => ({
      mcp_servers: {
        first: { env: { API_KEY: '<configured>' }, url: 'https://first.example' },
        second: { command: 'npx', args: ['second-server'] }
      }
    })).handle('/api/mcp/servers?profile=work', value => {
      expect(value).toMatchObject({
        body: {
          profile: 'work',
          servers: {
            first: { auth: 'oauth', env: { API_KEY: '<configured>' }, url: 'https://first.example' },
            second: { args: ['second-server'], command: 'npx' }
          }
        },
        method: 'PUT'
      })
      return { ok: true }
    })

    await mcpApi.update(gateway, 'work', 'first', { auth: 'oauth' })
  })

  it('keeps process-scoped OAuth cancellation unscoped', async () => {
    const gateway = new MemoryGateway().handle('/api/mcp/oauth/flows/flow%2F1', value => {
      expect(value).toMatchObject({ method: 'DELETE' })
      return { ok: true, status: 'cancelled' }
    })

    await mcpApi.cancelOAuth(gateway, null, 'flow/1')
  })
})
