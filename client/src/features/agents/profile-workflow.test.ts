import { describe, expect, it, vi } from 'vitest'

import type {
  AgentsApi,
  AgentProfileConfigureInput,
  AgentProfileCreateInput,
  AgentRosterEntry
} from './agents-api'
import {
  createProfileWorkflow,
  duplicateProfileSeed,
  emptyAdvancedProfileState,
  suggestDuplicateProfileName,
  validateProfileName,
  type CreateProfileCommand,
  type EditProfileCommand,
  type ProfileSaveCommand
} from './profile-workflow'

function fakeAgents(overrides: Partial<AgentsApi> = {}): AgentsApi {
  return {
    clearModel: async () => ({ code: 0, ok: true }),
    configure: async payload => ({ applied: Object.fromEntries(Object.keys(payload).filter(key => key !== 'name').map(key => [key, true])), ok: true }),
    create: async input => ({ name: typeof input === 'string' ? input : input.name, ok: true, path: '/profile' }),
    delete: async () => ({ code: 0, ok: true }),
    describe: async name => ({ mcp_servers: [], name, skills: [], soul: '', toolsets: [] }),
    generateAvatar: async () => ({ image_data: 'data:image/png;base64,AA==', success: true }),
    getAsset: async () => ({ found: false }),
    list: async () => ({ entries: [], groups: [] }),
    mcpCatalog: async () => ({ servers: [] }),
    modelOptions: async () => ({ providers: [] }),
    setAsset: async () => ({ ok: true }),
    ...overrides
  }
}

function createCommand(overrides: Partial<CreateProfileCommand> = {}): CreateProfileCommand {
  return {
    advanced: emptyAdvancedProfileState(),
    advancedTouched: false,
    appearance: { color: null, shape: 'blobatar', title: '', touched: false },
    cloneAll: false,
    cloneFrom: '',
    description: '',
    descriptionTouched: false,
    image: null,
    mirrorCredentials: true,
    mirrorCredentialsTouched: false,
    mode: 'create',
    name: 'research',
    noSkills: false,
    shareAuth: true,
    shareAuthTouched: false,
    ...overrides
  }
}

function editCommand(overrides: Partial<EditProfileCommand> = {}): EditProfileCommand {
  return {
    advanced: emptyAdvancedProfileState(),
    appearance: { color: null, created: 123, shape: 'circle', title: 'Work', touched: false },
    avatar: { baseline: { image: null, status: 'known' }, current: null },
    description: '',
    descriptionTouched: false,
    mode: 'edit',
    name: 'work',
    ...overrides
  }
}

const context = { confirmModel: async () => true, isCurrent: () => true }

describe('Profile workflow values', () => {
  it('validates every profile-name boundary', () => {
    expect(validateProfileName('')).toBe('Enter a profile name.')
    expect(validateProfileName('   ')).toBe('Enter a profile name.')
    expect(validateProfileName(` ${'a'.repeat(63)} `)).toBeNull()
    expect(validateProfileName('a'.repeat(64))).toContain('63 characters')
    for (const invalid of ['New Bot', 'bad name', 'bad.name', 'café']) expect(validateProfileName(invalid)).toContain('lowercase')
    for (const reserved of ['default', 'hermes', 'root', 'sudo', 'test', 'tmp']) expect(validateProfileName(reserved)).toContain('reserved')
  })

  it('maps a duplicate seed and searches the exact suffix range', () => {
    const agent: AgentRosterEntry = {
      avatar: 'data:image/png;base64,AA==',
      description: 'Operator',
      isDefault: false,
      meta: { color: '#fff', created: 99, shape: 'circle', title: 'Work' },
      name: 'x'.repeat(63)
    }
    expect(duplicateProfileSeed(agent)).toEqual({
      cloneAll: true,
      cloneFrom: 'x'.repeat(63),
      color: '#fff',
      description: 'Operator',
      image: 'data:image/png;base64,AA==',
      name: `${'x'.repeat(61)}-2`,
      shape: 'circle',
      title: 'Work (copy)'
    })
    expect(suggestDuplicateProfileName('work', ['work-2'])).toBe('work-3')
    const occupied = Array.from({ length: 98 }, (_, index) => `work-${index + 2}`)
    expect(suggestDuplicateProfileName('work', occupied)).toBe('work-2')
  })
})

describe('Profile workflow reads', () => {
  it('loads capabilities while suppressing source model and SOUL outside edit', async () => {
    const workflow = createProfileWorkflow(fakeAgents({
      describe: async () => ({
        mcp_servers: [{ enabled: true, name: 'configured' }],
        model: { default: 'deep', provider: 'fixture' },
        skills: [{ enabled: true, name: 'browser' }],
        soul: 'Source soul',
        toolsets: []
      }),
      mcpCatalog: async () => ({ servers: [{ name: 'configured' }, { installed: true, name: 'catalog' }] })
    }))

    await expect(workflow.loadAdvanced({ mode: 'duplicate', source: 'work' })).resolves.toMatchObject({
      mcp: [{ enabled: true, name: 'configured' }, { enabled: false, fromCatalog: true, installed: true, name: 'catalog' }],
      model: '',
      provider: '',
      soul: ''
    })
    await expect(workflow.loadAdvanced({ mode: 'edit', source: 'work' })).resolves.toMatchObject({ model: 'deep', provider: 'fixture', soul: 'Source soul' })
  })

  it('keeps catalog failure nonfatal while describe remains required', async () => {
    const workflow = createProfileWorkflow(fakeAgents({
      describe: async () => ({ mcp_servers: [{ enabled: true, name: 'configured' }], skills: [], toolsets: [] }),
      mcpCatalog: async () => { throw new Error('catalog unavailable') }
    }))
    await expect(workflow.loadAdvanced({ mode: 'edit', source: 'work' })).resolves.toMatchObject({ mcp: [{ enabled: true, name: 'configured' }] })

    const failed = createProfileWorkflow(fakeAgents({ describe: async () => { throw new Error('describe unavailable') } }))
    await expect(failed.loadAdvanced({ mode: 'edit', source: 'work' })).rejects.toThrow('describe unavailable')
  })

  it('classifies avatar baselines and generated-image failures', async () => {
    const present = createProfileWorkflow(fakeAgents({ getAsset: async () => ({ data: 'image', found: true }) }))
    await expect(present.loadAvatar({ hasAsset: true, inlineImage: null, name: 'work' })).resolves.toEqual({ image: 'image', status: 'known' })
    await expect(present.loadAvatar({ hasAsset: false, inlineImage: null, name: 'work' })).resolves.toEqual({ image: null, status: 'known' })

    const unknown = createProfileWorkflow(fakeAgents({ getAsset: async () => ({ found: true }) }))
    await expect(unknown.loadAvatar({ hasAsset: true, inlineImage: null, name: 'work' })).resolves.toEqual({ status: 'unknown' })

    const malformed = createProfileWorkflow(fakeAgents({ generateAvatar: async () => ({ success: true }) }))
    await expect(malformed.generateAvatar('fox')).rejects.toThrow('The image service returned no image.')
  })
})

describe('Profile workflow saves', () => {
  it('preserves fresh and duplicate create payload rules', async () => {
    const payloads: AgentProfileCreateInput[] = []
    const configure: AgentProfileConfigureInput[] = []
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'))
    const workflow = createProfileWorkflow(fakeAgents({
      create: async input => { payloads.push(input as AgentProfileCreateInput); return { name: (input as AgentProfileCreateInput).name, ok: true, path: '/profile' } },
      configure: async payload => { configure.push(payload); return {} }
    }))
    const advanced = { ...emptyAdvancedProfileState(), dirtyModel: true, dirtySoul: true, model: 'deep', provider: 'fixture', soul: '' }

    await workflow.save(createCommand({ advanced, advancedTouched: true, appearance: { color: null, shape: 'circle', title: 'Fresh', touched: true }, cloneAll: true, cloneFrom: 'work', description: ' ', descriptionTouched: true }), context)
    await workflow.save({ ...createCommand({ advancedTouched: true, cloneAll: true, cloneFrom: 'work', description: 'Copy', descriptionTouched: true, mode: 'create' }), mode: 'duplicate' }, context)

    expect(payloads).toEqual([
      { clone_all: true, clone_from: 'work', description: '', model: 'deep', name: 'research', provider: 'fixture', share_auth: true, soul: '' },
      { clone_all: true, clone_from: 'work', description: 'Copy', name: 'research' }
    ])
    expect(configure[0]?.ui_meta).toMatchObject({ 'hermes-bots': { created: Date.now(), title: 'Fresh' } })
    vi.useRealTimers()
  })

  it('rejects explicit create failure but accepts omitted legacy status', async () => {
    const rejected = createProfileWorkflow(fakeAgents({ create: async () => ({ name: 'research', ok: false, path: '/profile' }) }))
    await expect(rejected.save(createCommand(), context)).rejects.toThrow('did not create')

    const compatible = createProfileWorkflow(fakeAgents({ create: async () => ({ name: 'research' }) as never }))
    await expect(compatible.save(createCommand(), context)).resolves.toEqual({ name: 'research', status: 'saved' })
  })

  it('continues best-effort create steps and keeps warning order', async () => {
    const calls: string[] = []
    const workflow = createProfileWorkflow(fakeAgents({
      configure: async payload => {
        if ('disabled_skills' in payload) { calls.push('advanced'); throw new Error('no') }
        calls.push('appearance')
        return { applied: { ui_meta: false }, ok: true }
      },
      setAsset: async () => { calls.push('avatar'); return { ok: false } }
    }))
    const advanced = { ...emptyAdvancedProfileState(), dirtySkills: true, skills: [{ enabled: false, name: 'browser' }] }
    const result = await workflow.save(createCommand({ advanced, appearance: { color: null, shape: 'circle', title: 'A', touched: true }, image: 'image' }), context)

    expect(calls).toEqual(['advanced', 'appearance', 'avatar'])
    expect(result).toEqual({ name: 'research', status: 'saved', warning: 'Profile created, but advanced settings and appearance and avatar image could not be saved.' })
  })

  it('validates a partial model before remote work and verifies model clearing', async () => {
    const create = vi.fn(async () => ({ name: 'research', ok: true, path: '/profile' }))
    const partial = createProfileWorkflow(fakeAgents({ create }))
    await expect(partial.save(createCommand({ advanced: { ...emptyAdvancedProfileState(), dirtyModel: true, provider: 'fixture' } }), context)).rejects.toThrow('Choose both')
    expect(create).not.toHaveBeenCalled()

    const clearModel = vi.fn(async () => ({ ok: true }))
    const clearing = createProfileWorkflow(fakeAgents({ clearModel }))
    await expect(clearing.save(editCommand({ advanced: { ...emptyAdvancedProfileState(), dirtyModel: true } }), context)).rejects.toThrow('inherited model')
    expect(clearModel).toHaveBeenCalledWith('work')
  })

  it('maps empty text, skills, MCP, and toolsets in one edit configuration', async () => {
    const configurations: AgentProfileConfigureInput[] = []
    const workflow = createProfileWorkflow(fakeAgents({ configure: async payload => { configurations.push(payload); return {} } }))
    await workflow.save(editCommand({
      advanced: {
        ...emptyAdvancedProfileState(),
        dirtyMcp: true,
        dirtySkills: true,
        dirtySoul: true,
        dirtyToolsets: true,
        mcp: [{ enabled: true, name: 'kept' }, { enabled: false, name: 'off' }],
        skills: [{ enabled: true, name: 'kept' }, { enabled: false, name: 'off' }],
        soul: '',
        toolsets: [{ enabled: true, name: 'web' }, { enabled: false, name: 'browser' }]
      },
      description: '',
      descriptionTouched: true
    }), context)
    expect(configurations).toEqual([{
      description: '',
      disabled_skills: ['off'],
      enabled_mcp_servers: ['kept'],
      enabled_toolsets: ['web'],
      name: 'work',
      soul: ''
    }])
  })

  it('normalizes all, none, and partial toolset selections', async () => {
    const configurations: AgentProfileConfigureInput[] = []
    const workflow = createProfileWorkflow(fakeAgents({ configure: async payload => { configurations.push(payload); return {} } }))
    for (const toolsets of [
      [{ enabled: true, name: 'web' }, { enabled: true, name: 'browser' }],
      [{ enabled: false, name: 'web' }, { enabled: false, name: 'browser' }],
      [{ enabled: true, name: 'web' }, { enabled: false, name: 'browser' }]
    ]) {
      await workflow.save(editCommand({ advanced: { ...emptyAdvancedProfileState(), dirtyToolsets: true, toolsets } }), context)
    }
    expect(configurations.map(value => value.enabled_toolsets)).toEqual([[], [], ['web']])
  })

  it('orders edit configuration, confirmation, appearance, and avatar against the explicit name', async () => {
    const calls: AgentProfileConfigureInput[] = []
    const assets: unknown[] = []
    const workflow = createProfileWorkflow(fakeAgents({
      configure: async payload => {
        calls.push(payload)
        if (payload.model && !payload.confirm_expensive_model) return { confirm_message: 'Costs more', confirm_required: true, ok: false }
        return {}
      },
      setAsset: async (name, input) => { assets.push({ input, name }); return {} }
    }))
    const advanced = { ...emptyAdvancedProfileState(), dirtyModel: true, model: 'deep', provider: 'fixture' }
    const result = await workflow.save(editCommand({
      advanced,
      appearance: { color: '#fff', created: 123, shape: 'circle', title: 'Updated', touched: true },
      avatar: { baseline: { image: 'old', status: 'known' }, current: 'new' },
      description: 'Updated',
      descriptionTouched: true
    }), context)

    expect(result).toEqual({ name: 'work', status: 'saved' })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({ description: 'Updated', model: 'deep', name: 'work', provider: 'fixture' })
    expect(calls[1]).toEqual({ ...calls[0], confirm_expensive_model: true })
    expect(calls[2]).toMatchObject({ name: 'work', ui_meta: { 'hermes-bots': { created: 123, title: 'Updated' } } })
    expect(assets).toEqual([{ input: { data: 'new' }, name: 'work' }])
  })

  it('declining model confirmation stops appearance and avatar work', async () => {
    const configure = vi.fn(async () => ({ confirm_message: 'Costs more', confirm_required: true, ok: false }))
    const setAsset = vi.fn(async () => ({ ok: true }))
    const workflow = createProfileWorkflow(fakeAgents({ configure, setAsset }))
    const result = await workflow.save(editCommand({
      advanced: { ...emptyAdvancedProfileState(), dirtyModel: true, model: 'deep', provider: 'fixture' },
      appearance: { color: null, shape: 'circle', title: 'Changed', touched: true },
      avatar: { baseline: { image: 'old', status: 'known' }, current: 'new' }
    }), { confirmModel: async () => false, isCurrent: () => true })
    expect(result).toEqual({ reason: 'model-confirmation-declined', status: 'cancelled' })
    expect(configure).toHaveBeenCalledTimes(1)
    expect(setAsset).not.toHaveBeenCalled()
  })

  it('does not clear unknown or known-absent avatars and clears explicit known images', async () => {
    const assets: unknown[] = []
    const workflow = createProfileWorkflow(fakeAgents({ setAsset: async (name, input) => { assets.push({ input, name }); return {} } }))
    await workflow.save(editCommand({ appearance: { color: null, shape: 'circle', title: 'Changed', touched: true }, avatar: { baseline: { status: 'unknown' }, current: null } }), context)
    await workflow.save(editCommand({ avatar: { baseline: { image: null, status: 'known' }, current: null } }), context)
    await workflow.save(editCommand({ avatar: { baseline: { image: 'old', status: 'known' }, current: null } }), context)
    expect(assets).toEqual([{ input: { clear: true }, name: 'work' }])
  })

  it('stops before later work when currentness changes', async () => {
    let current = true
    const calls: string[] = []
    const workflow = createProfileWorkflow(fakeAgents({
      create: async input => { calls.push('create'); current = false; return { name: (input as AgentProfileCreateInput).name, ok: true, path: '/profile' } },
      configure: async () => { calls.push('configure'); return {} }
    }))
    await expect(workflow.save(createCommand({ appearance: { color: null, shape: 'circle', title: 'A', touched: true } }), { ...context, isCurrent: () => current })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual(['create'])
  })
})
