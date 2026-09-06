import { describe, expect, it } from 'vitest'

import { createSettingsApi } from './settings-api'
import { createGatewayApi } from '~/gateway/gateway-api'
import { MemoryGateway } from '~/test/memory-gateway'

describe('settingsApi', () => {
  it('translates the local default profile into an explicit request scope', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=default', () => ({ model: {} }))
      .handle('/api/providers/custom-endpoints/endpoint%2Fone/activate?profile=default', () => ({ ok: true, model: 'demo', provider: 'custom' }))
    const settings = createSettingsApi(createGatewayApi(gateway, null))

    await settings.config()
    await settings.activateCustomEndpoint('endpoint/one')

    expect(gateway.calls.map(call => call.value)).toEqual([
      expect.objectContaining({ path: '/api/config?profile=default' }),
      expect.objectContaining({ path: '/api/providers/custom-endpoints/endpoint%2Fone/activate?profile=default' })
    ])
  })

  it('keeps account-wide billing RPCs unscoped', async () => {
    const gateway = new MemoryGateway()
      .handle('billing.state', params => { expect(params).toEqual({}); return { ok: true, logged_in: false } })
      .handle('subscription.state', params => { expect(params).toEqual({}); return { ok: true, logged_in: false } })
    const settings = createSettingsApi(createGatewayApi(gateway, 'work'))

    await settings.billingState()
    await settings.subscriptionState()

    expect(gateway.calls.filter(call => call.kind === 'rpc').map(call => ({ method: call.method, value: call.value }))).toEqual([
      { method: 'billing.state', value: {} },
      { method: 'subscription.state', value: {} }
    ])
  })

  it('includes the selected profile in credential validation without returning the secret in the URL', async () => {
    const gateway = new MemoryGateway().handle('/api/providers/validate?profile=default', options => {
      expect(options).toMatchObject({ body: { api_key: '', key: 'OPENAI_API_KEY', profile: 'default', value: 'secret-value' } })
      expect(String((options as { path: string }).path)).not.toContain('secret-value')
      return { message: '', models: [], ok: true, reachable: true }
    })
    const settings = createSettingsApi(createGatewayApi(gateway, null))

    await settings.validateProvider('OPENAI_API_KEY', 'secret-value')

    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/providers/validate?profile=default' })
  })

  it('uses scoped request paths for endpoint validation and session mutations', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/providers/custom-endpoints/validate?profile=work', () => ({ message: '', models: [], ok: true, reachable: true }))
      .handle('/api/sessions/chat-1?profile=work', () => ({}))
    const settings = createSettingsApi(createGatewayApi(gateway, 'work'))

    await settings.validateCustomEndpoint({ base_url: 'https://example.test', model: 'demo', name: 'Demo' })
    await settings.deleteSession('chat-1')

    expect(gateway.calls.map(call => call.value)).toEqual([
      expect.objectContaining({ path: '/api/providers/custom-endpoints/validate?profile=work' }),
      expect.objectContaining({ path: '/api/sessions/chat-1?profile=work' })
    ])
  })

  it('saves declared memory fields through the config route, not dependency setup', async () => {
    const gateway = new MemoryGateway().handle('/api/memory/providers/honcho/config?surface=declared&profile=work', value => {
      expect(value).toMatchObject({ body: { values: { workspace: 'team' } }, method: 'PUT' })
      return { ok: true }
    })
    const settings = createSettingsApi(createGatewayApi(gateway, 'work'))

    await settings.saveMemoryProviderConfig('honcho', { workspace: 'team' })

    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0].value).toMatchObject({ path: '/api/memory/providers/honcho/config?surface=declared&profile=work' })
  })

  it('keeps machine health unscoped even when a profile is selected', async () => {
    const gateway = new MemoryGateway().handle('/api/status', () => ({ gateway_running: true }))
    const settings = createSettingsApi(createGatewayApi(gateway, 'work'))

    await settings.status()

    expect(gateway.calls).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ path: '/api/status' }) }))
  })

  it('keeps OAuth poll and cancellation handles unscoped', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/providers/oauth/nous/poll/flow-1', () => ({ error_message: null, session_id: 'flow-1', status: 'approved' }))
      .handle('/api/providers/oauth/sessions/flow-1', value => {
        expect(value).toMatchObject({ method: 'DELETE' })
        return { ok: true }
      })
    const settings = createSettingsApi(createGatewayApi(gateway, 'work'))

    await settings.oauthPoll('nous', 'flow-1')
    await settings.oauthCancel('flow-1')

    expect(gateway.calls.map(call => call.value)).toEqual([
      expect.objectContaining({ path: '/api/providers/oauth/nous/poll/flow-1' }),
      expect.objectContaining({ method: 'DELETE', path: '/api/providers/oauth/sessions/flow-1' })
    ])
  })

  it('does not pretend unsupported memory routes are profile-scoped', async () => {
    const gateway = new MemoryGateway()
    const settings = createSettingsApi(createGatewayApi(gateway, 'work'))

    await expect(settings.memoryStatus()).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(settings.selectMemoryProvider('honcho')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(settings.resetMemory('all')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(gateway.calls).toHaveLength(0)
  })

  it('keeps plugin inventory and mutations unavailable for named profiles', async () => {
    const gateway = new MemoryGateway()
    const settings = createSettingsApi(createGatewayApi(gateway, 'work'))

    expect(() => settings.pluginsHub()).toThrow(/only for its default profile/i)
    expect(() => settings.pluginAction('example/plugin', 'enable')).toThrow(/only for its default profile/i)
    expect(() => settings.removePlugin('example/plugin')).toThrow(/only for its default profile/i)
    expect(gateway.calls).toHaveLength(0)
  })

  it('uses the official plugin management routes for the default profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/dashboard/plugins/hub', () => ({ plugins: [] }))
      .handle('/api/dashboard/agent-plugins/example/plugin/enable', () => ({ ok: true }))
      .handle('/api/dashboard/agent-plugins/example/plugin', () => ({ ok: true }))
    const settings = createSettingsApi(createGatewayApi(gateway, null))

    await settings.pluginsHub()
    await settings.pluginAction('example/plugin', 'enable')
    await settings.removePlugin('example/plugin')

    expect(gateway.calls.map(call => call.value)).toEqual([
      expect.objectContaining({ path: '/api/dashboard/plugins/hub' }),
      expect.objectContaining({ method: 'POST', path: '/api/dashboard/agent-plugins/example/plugin/enable' }),
      expect.objectContaining({ method: 'DELETE', path: '/api/dashboard/agent-plugins/example/plugin' })
    ])
  })

  it('uses the official process-scoped memory routes for the default profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/memory', () => ({ active: '', builtin_files: { memory: 0, user: 0 }, providers: [] }))
      .handle('/api/memory/provider', value => {
        expect(value).toMatchObject({ body: { provider: 'honcho' }, method: 'PUT' })
        return { active: 'honcho', ok: true }
      })
      .handle('/api/memory/reset', value => {
        expect(value).toMatchObject({ body: { target: 'memory' }, method: 'POST' })
        return { deleted: [], ok: true }
      })
    const settings = createSettingsApi(createGatewayApi(gateway, null))

    await settings.memoryStatus()
    await settings.selectMemoryProvider('honcho')
    await settings.resetMemory('memory')

    expect(gateway.calls.map(call => call.value)).toEqual([
      expect.objectContaining({ path: '/api/memory' }),
      expect.objectContaining({ path: '/api/memory/provider' }),
      expect.objectContaining({ path: '/api/memory/reset' })
    ])
  })
})