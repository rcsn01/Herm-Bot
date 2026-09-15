import { describe, expect, it } from 'vitest'

import { createAgentsApi, mergeAgentRoster, parseAgentRoster } from '~/features/agents/agents-api'
import { createGatewayApi } from '~/gateway/gateway-api'
import { MemoryGateway } from '~/test/memory-gateway'

describe('agent profiles API', () => {
  it('creates a profile through the unscoped profiles.create RPC', async () => {
    const gateway = new MemoryGateway().handle('profiles.create', params => {
      expect(params).toEqual({ name: 'new-bot' })
      return { name: 'new-bot', ok: true, path: '/profiles/new-bot' }
    })
    const api = createAgentsApi(createGatewayApi(gateway, 'work'))

    await expect(api.create('new-bot')).resolves.toEqual({ name: 'new-bot', ok: true, path: '/profiles/new-bot' })
    expect(gateway.calls).toEqual([{ kind: 'rpc', method: 'profiles.create', value: { name: 'new-bot' } }])
  })

  it('keeps profile mutations explicitly named and routes large avatars through asset RPCs', async () => {
    const gateway = new MemoryGateway()
      .handle('profiles.create', params => params)
      .handle('profiles.describe', () => ({ name: 'work', model: { default: 'fixture/deep', provider: 'fixture' } }))
      .handle('profiles.configure', params => ({ applied: Object.fromEntries(Object.keys(params as object).map(key => [key, true])), ok: true }))
      .handle('profiles.get_asset', () => ({ asset: 'avatar', data: 'data:image/png;base64,AA==', found: true, size: 2 }))
      .handle('profiles.set_asset', params => ({ ...(params as Record<string, unknown>), ok: true }))
      .handle('model.options', () => ({ providers: [{ models: ['fixture/deep'], slug: 'fixture' }] }))
      .handle('mcp.catalog', () => ({ servers: [] }))
      .handle('image.generate', () => ({ image_data: 'data:image/png;base64,AA==', success: true }))
      .handle('cli.exec', () => ({ code: 0, ok: true }))
    const api = createAgentsApi(createGatewayApi(gateway, 'work'))

    await api.create({ clone_all: true, clone_from: 'default', description: 'An operator', name: 'new-bot', no_skills: true, provider: 'fixture', model: 'fixture/deep' })
    await api.describe('work')
    await api.configure({ description: 'Updated', name: 'work', ui_meta: { 'hermes-bots': { title: 'Work' } } })
    await api.getAsset('work')
    await api.setAsset('work', { data: 'data:image/png;base64,AA==' })
    await api.clearModel('work')
    await api.delete('work')
    await api.modelOptions()
    await api.mcpCatalog('work')
    await api.generateAvatar('A fox')

    expect(gateway.calls.map(call => call.method)).toEqual([
      'profiles.create', 'profiles.describe', 'profiles.configure', 'profiles.get_asset', 'profiles.set_asset',
      'cli.exec', 'cli.exec', 'model.options', 'mcp.catalog', 'image.generate'
    ])
    expect(gateway.calls[0]?.value).toEqual({ clone_all: true, clone_from: 'default', description: 'An operator', name: 'new-bot', no_skills: true, provider: 'fixture', model: 'fixture/deep' })
    expect(gateway.calls[5]?.value).toEqual({ argv: ['--profile', 'work', 'config', 'unset', 'model'] })
    expect(gateway.calls[6]?.value).toEqual({ argv: ['profile', 'delete', 'work', '--yes'] })
    expect(gateway.calls[8]?.value).toEqual({ profile: 'work' })
  })

  it('hydrates a server-side avatar when profiles.list only advertises has_avatar', async () => {
    const gateway = new MemoryGateway()
      .handle('profiles.list', () => ({ profiles: [{ has_avatar: true, name: 'work' }] }))
      .handle('profiles.get_asset', params => ({ asset: 'avatar', data: `data:image/png;base64,${(params as { name: string }).name}`, found: true }))
    const api = createAgentsApi(createGatewayApi(gateway, null))

    await expect(api.list()).resolves.toMatchObject({ entries: [{ avatar: 'data:image/png;base64,work', hasAvatar: true, name: 'work' }] })
    expect(gateway.calls.map(call => call.method)).toEqual(['profiles.list', 'profiles.get_asset'])
  })
})

describe('agent roster parsing', () => {
  it('normalizes rich profiles.list items from an array body', () => {
    expect(parseAgentRoster([
      { name: 'work', display_name: '  Ops Bot  ', preview: 'One new Fujitsu stream', last_active: 1_700_000_000, session_id: 'bot-chat' },
      'default',
      { title: 'Searcher', last_active: '2026-09-10T09:30:00Z' },
      null,
      7
    ])).toEqual([
      { displayName: 'Ops Bot', isDefault: false, name: 'work', preview: 'One new Fujitsu stream', sessionId: 'bot-chat', startedAt: 1_700_000_000, title: undefined },
      { displayName: undefined, isDefault: true, name: 'default', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined },
      { displayName: undefined, isDefault: false, name: 'Searcher', preview: undefined, sessionId: undefined, startedAt: Math.floor(Date.parse('2026-09-10T09:30:00Z') / 1000), title: undefined }
    ])
  })

  it('reads the Bot Mode meta from ui_meta and never mistakes the session title for the bot name', () => {
    const entries = parseAgentRoster([
      {
        // The wire's top-level title is the latest human session's title
        // (tui_gateway/methods_profiles.py roster enrichment) — not the bot's name.
        name: 'default',
        title: 'My weekend plans',
        ui_meta: {
          'hermes-bots': {
            color: '#8b5cf6',
            custom: true,
            image: 'data:image/png;base64,AAA',
            imageKind: 'photo',
            shape: 'blobatar:7:cat',
            title: '  Hermes  '
          }
        }
      },
      { name: 'scout', ui_meta: { unrelated: true } },
      { name: 'forge', ui_meta: { 'hermes-bots': { title: '   ' } } }
    ])

    expect(entries[0]).toMatchObject({
      meta: { color: '#8b5cf6', custom: true, image: 'data:image/png;base64,AAA', imageKind: 'photo', shape: 'blobatar:7:cat', title: 'Hermes' },
      title: 'Hermes'
    })
    expect(entries[1]?.meta).toBeUndefined()
    expect(entries[1]?.title).toBeUndefined()
    expect(entries[2]?.meta).toBeUndefined()
    expect(entries[2]?.title).toBeUndefined()
  })

  it('unwraps a profiles object body and drops unusable entries', () => {
    expect(parseAgentRoster({ profiles: [{ name: 'work', preview: 'Daily digest' }, { preview: 'no name' }, 42] })).toEqual([
      { isDefault: false, name: 'work', preview: 'Daily digest', sessionId: undefined, startedAt: undefined, title: undefined }
    ])
    expect(parseAgentRoster({})).toEqual([])
    expect(parseAgentRoster(null)).toEqual([])
  })

  it('keeps usable avatar references and drops unusable ones', () => {
    const entries = parseAgentRoster([
      { name: 'a', avatar: 'data:image/png;base64,AAA' },
      { name: 'b', avatar: 'https://gateway.example/avatar.png' },
      { name: 'c', avatar: 'javascript:alert(1)' },
      { name: 'd', avatar: 42 }
    ])

    expect(entries[0]?.avatar).toBe('data:image/png;base64,AAA')
    expect(entries[1]?.avatar).toBe('https://gateway.example/avatar.png')
    expect(entries[2]?.avatar).toBeUndefined()
    expect(entries[3]?.avatar).toBeUndefined()
  })

  it('normalizes millisecond and ISO last-active stamps into epoch seconds', () => {
    const entries = parseAgentRoster([{ name: 'a', last_active: 1_700_000_000_000 }, { name: 'b', last_active: '2026-09-10T09:30:00Z' }])
    expect(entries[0]?.startedAt).toBe(1_700_000_000)
    expect(entries[1]?.startedAt).toBe(Math.floor(Date.parse('2026-09-10T09:30:00Z') / 1000))
  })
})

describe('agent roster merge', () => {
  it('keeps status order, overlays enrichment, and appends extras', () => {
    const merged = mergeAgentRoster(
      [{ name: 'default', is_default: true }, { name: 'work' }],
      [
        { isDefault: false, name: 'work', preview: 'Daily digest', startedAt: 1_700_000_000 },
        { isDefault: true, name: 'default' },
        { isDefault: false, name: 'extra' }
      ]
    )

    expect(merged).toEqual([
      { isDefault: true, name: 'default', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined },
      { isDefault: false, name: 'work', preview: 'Daily digest', sessionId: undefined, startedAt: 1_700_000_000, title: undefined },
      { isDefault: false, name: 'extra', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined }
    ])
  })

  it('falls back to bare status names without enrichment', () => {
    expect(mergeAgentRoster(['default', { name: 'work' }], [])).toEqual([
      { isDefault: true, name: 'default', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined },
      { isDefault: false, name: 'work', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined }
    ])
    expect(mergeAgentRoster(undefined, [{ isDefault: false, name: 'work' }])).toEqual([
      { isDefault: false, name: 'work', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined }
    ])
  })
})