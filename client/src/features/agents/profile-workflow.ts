import {
  botMetaForProfile,
  isSuccessfulCliResult,
  isSuccessfulProfileConfiguration,
  type AgentsApi,
  type AgentMcpCatalogResult,
  type AgentProfileConfigureInput,
  type AgentProfileCreateInput,
  type AgentProfileDescribeResult,
  type AgentRosterEntry,
  type ProfileCapabilityEntry
} from './agents-api'

export const PROFILE_NAME_MAX_LENGTH = 63

const PROFILE_NAME_PATTERN = /^[a-z0-9_-]+$/
const RESERVED_PROFILE_NAMES = new Set(['default', 'hermes', 'root', 'sudo', 'test', 'tmp'])

export type ProfileWorkflowMode = 'create' | 'duplicate' | 'edit'

export interface ProfileAppearanceDraft {
  color: string | null
  created?: number
  shape: string
  title: string
  touched: boolean
}

export type ProfileAvatarBaseline =
  | { status: 'known'; image: string | null }
  | { status: 'unknown' }

export interface ProfileAvatarDraft {
  baseline: ProfileAvatarBaseline
  current: string | null
}

export interface ProfileCreateSeed {
  cloneAll: boolean
  cloneFrom: string
  color: string | null
  description: string
  image: string | null
  name: string
  shape: string
  title: string
}

export interface ProfileAdvancedState {
  dirtyMcp: boolean
  dirtyModel: boolean
  dirtySkills: boolean
  dirtySoul: boolean
  dirtyToolsets: boolean
  loaded: boolean
  mcp: ProfileCapabilityEntry[]
  model: string
  provider: string
  skills: ProfileCapabilityEntry[]
  soul: string
  source: string
  toolsets: ProfileCapabilityEntry[]
}

export interface CreateProfileCommand {
  mode: 'create' | 'duplicate'
  name: string
  description: string
  descriptionTouched: boolean
  appearance: ProfileAppearanceDraft
  image: string | null
  advanced: ProfileAdvancedState
  advancedTouched: boolean
  cloneFrom: string
  cloneAll: boolean
  noSkills: boolean
  shareAuth: boolean
  shareAuthTouched: boolean
  mirrorCredentials: boolean
  mirrorCredentialsTouched: boolean
}

export interface EditProfileCommand {
  mode: 'edit'
  name: string
  description: string
  descriptionTouched: boolean
  appearance: ProfileAppearanceDraft
  avatar: ProfileAvatarDraft
  advanced: ProfileAdvancedState
}

export type ProfileSaveCommand = CreateProfileCommand | EditProfileCommand

export type ProfileSaveResult =
  | { status: 'saved'; name: string; warning?: string }
  | { status: 'cancelled'; reason: 'model-confirmation-declined' }

export interface ProfileWorkflow {
  loadAdvanced(input: { mode: ProfileWorkflowMode; source: string; signal?: AbortSignal }): Promise<ProfileAdvancedState>
  loadAvatar(input: { hasAsset: boolean; inlineImage: string | null; name: string; signal?: AbortSignal }): Promise<ProfileAvatarBaseline>
  generateAvatar(prompt: string, signal?: AbortSignal): Promise<string>
  save(command: ProfileSaveCommand, context: { confirmModel(message: string): Promise<boolean>; isCurrent(): boolean }): Promise<ProfileSaveResult>
}

type WorkflowAgents = Pick<AgentsApi,
  | 'clearModel'
  | 'configure'
  | 'create'
  | 'describe'
  | 'generateAvatar'
  | 'getAsset'
  | 'mcpCatalog'
  | 'setAsset'
>

class StaleWorkflowError extends Error {
  constructor() {
    super('The Profile operation is stale.')
    this.name = 'AbortError'
  }
}

export function validateProfileName(value: string): string | null {
  const name = value.trim()
  if (!name) return 'Enter a profile name.'
  if (name.length > PROFILE_NAME_MAX_LENGTH) return `Profile names must be ${PROFILE_NAME_MAX_LENGTH} characters or fewer.`
  if (!PROFILE_NAME_PATTERN.test(name)) return 'Use lowercase letters, numbers, hyphens, and underscores only.'
  if (RESERVED_PROFILE_NAMES.has(name)) return 'That profile name is reserved. Choose another name.'
  return null
}

export function suggestDuplicateProfileName(sourceName: string, existingNames: Iterable<string> = []): string {
  const existing = new Set(existingNames)
  for (let number = 2; number < 100; number += 1) {
    const suffix = `-${number}`
    const candidate = `${sourceName.slice(0, Math.max(1, PROFILE_NAME_MAX_LENGTH - suffix.length))}${suffix}`
    if (!existing.has(candidate)) return candidate
  }
  const suffix = '-2'
  return `${sourceName.slice(0, Math.max(1, PROFILE_NAME_MAX_LENGTH - suffix.length))}${suffix}`
}

export function duplicateProfileSeed(agent: AgentRosterEntry): ProfileCreateSeed {
  if (!agent.name) throw new Error('A duplicate source is required.')
  return {
    cloneAll: true,
    cloneFrom: agent.name,
    color: agent.meta?.color ?? null,
    description: agent.description ?? '',
    image: agent.meta?.image ?? agent.avatar ?? null,
    name: suggestDuplicateProfileName(agent.name),
    shape: agent.meta?.shape ?? 'blobatar',
    title: agent.meta?.title ? `${agent.meta.title} (copy)` : ''
  }
}

export function emptyAdvancedProfileState(): ProfileAdvancedState {
  return {
    dirtyMcp: false,
    dirtyModel: false,
    dirtySkills: false,
    dirtySoul: false,
    dirtyToolsets: false,
    loaded: false,
    mcp: [],
    model: '',
    provider: '',
    skills: [],
    soul: '',
    source: '',
    toolsets: []
  }
}

function enabledToolsetNames(items: ProfileCapabilityEntry[]): string[] {
  const enabled = items.filter(item => item.enabled !== false)
  return enabled.length === items.length || enabled.length === 0 ? [] : enabled.map(item => item.name)
}

export function advancedStateFromDescribe(
  response: AgentProfileDescribeResult,
  catalog: AgentMcpCatalogResult | null,
  source: string,
  includeEditFields = true
): ProfileAdvancedState {
  const configured = response.mcp_servers ?? []
  const configuredNames = new Set(configured.map(entry => entry.name))
  const catalogEntries = (catalog?.servers ?? [])
    .filter(entry => !configuredNames.has(entry.name))
    .map(entry => ({ ...entry, enabled: false, fromCatalog: true }))
  return {
    ...emptyAdvancedProfileState(),
    loaded: true,
    mcp: [...configured.map(entry => ({ ...entry, enabled: entry.enabled !== false })), ...catalogEntries],
    model: includeEditFields ? response.model?.default ?? '' : '',
    provider: includeEditFields ? response.model?.provider ?? '' : '',
    skills: response.skills ?? [],
    soul: includeEditFields ? response.soul ?? '' : '',
    source,
    toolsets: response.toolsets ?? []
  }
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new StaleWorkflowError()
}

function assertModelPair(state: ProfileAdvancedState): void {
  if (state.dirtyModel && Boolean(state.provider) !== Boolean(state.model)) {
    throw new Error('Choose both a model provider and model, or leave both empty to inherit.')
  }
}

function advancedConfiguration(name: string, advanced: ProfileAdvancedState): AgentProfileConfigureInput {
  const payload: AgentProfileConfigureInput = { name }
  if (advanced.dirtySkills) payload.disabled_skills = advanced.skills.filter(item => item.enabled === false).map(item => item.name)
  if (advanced.dirtyToolsets) payload.enabled_toolsets = enabledToolsetNames(advanced.toolsets)
  if (advanced.dirtyMcp) payload.enabled_mcp_servers = advanced.mcp.filter(item => item.enabled !== false).map(item => item.name)
  return payload
}

function isAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export function createProfileWorkflow(agents: WorkflowAgents): ProfileWorkflow {
  const loadAdvanced: ProfileWorkflow['loadAdvanced'] = async input => {
    const catalogPromise = agents.mcpCatalog(input.source, input.signal).catch(error => {
      if (isAbort(input.signal)) throw error
      return null
    })
    const [described, catalog] = await Promise.all([
      agents.describe(input.source, input.signal),
      catalogPromise
    ])
    return advancedStateFromDescribe(described, catalog, input.source, input.mode === 'edit')
  }

  const loadAvatar: ProfileWorkflow['loadAvatar'] = async input => {
    if (input.inlineImage) return { image: input.inlineImage, status: 'known' }
    if (!input.hasAsset) return { image: null, status: 'known' }
    try {
      const result = await agents.getAsset(input.name, input.signal)
      if (result.found === false) return { image: null, status: 'known' }
      if (result.found === true && result.data) return { image: result.data, status: 'known' }
      return { status: 'unknown' }
    } catch (error) {
      if (isAbort(input.signal)) throw error
      return { status: 'unknown' }
    }
  }

  const generateAvatar: ProfileWorkflow['generateAvatar'] = async (prompt, signal) => {
    const result = await agents.generateAvatar(prompt, signal)
    if (result.success === false) throw new Error(result.error || 'The image service rejected the request.')
    const image = result.image_data || result.image
    if (!image) throw new Error('The image service returned no image.')
    return image
  }

  const saveCreate = async (
    command: CreateProfileCommand,
    saveContext: Parameters<ProfileWorkflow['save']>[1]
  ): Promise<ProfileSaveResult> => {
    const validation = validateProfileName(command.name)
    if (validation) throw new Error(validation)
    assertModelPair(command.advanced)
    const name = command.name.trim()
    const payload: AgentProfileCreateInput = { name }
    if (command.descriptionTouched || command.description.trim()) payload.description = command.description.trim()
    if (command.advancedTouched) {
      if (command.cloneFrom) payload.clone_from = command.cloneFrom
      if (command.cloneFrom && command.cloneAll) payload.clone_all = true
      if (command.noSkills) payload.no_skills = true
      if (command.shareAuthTouched || command.mode === 'create') payload.share_auth = command.shareAuth
      if (command.mirrorCredentialsTouched) payload.mirror_credentials = command.mirrorCredentials
      if (command.advanced.dirtyModel && command.advanced.provider && command.advanced.model) {
        payload.provider = command.advanced.provider.trim()
        payload.model = command.advanced.model.trim()
      }
      if (command.advanced.dirtySoul) payload.soul = command.advanced.soul
    }

    assertCurrent(saveContext.isCurrent)
    const created = await agents.create(payload)
    assertCurrent(saveContext.isCurrent)
    if (created.ok === false) throw new Error('The gateway did not create the profile.')

    const warnings: string[] = []
    const bestEffort = async (label: string, operation: () => Promise<{ applied?: Record<string, unknown>; ok?: boolean }>) => {
      assertCurrent(saveContext.isCurrent)
      try {
        const result = await operation()
        assertCurrent(saveContext.isCurrent)
        if (!isSuccessfulProfileConfiguration(result)) warnings.push(label)
      } catch (error) {
        assertCurrent(saveContext.isCurrent)
        warnings.push(label)
      }
    }

    const configuration = advancedConfiguration(name, command.advanced)
    if (Object.keys(configuration).length > 1) await bestEffort('advanced settings', () => agents.configure(configuration))
    if (command.appearance.touched) {
      await bestEffort('appearance', () => agents.configure({
        name,
        ui_meta: {
          'hermes-bots': botMetaForProfile({
            color: command.appearance.color,
            created: command.mode === 'create' ? Date.now() : undefined,
            image: command.image,
            shape: command.appearance.shape,
            title: command.appearance.title
          })
        }
      }))
    }
    const image = command.image
    if (image) await bestEffort('avatar image', () => agents.setAsset(name, { data: image }))
    assertCurrent(saveContext.isCurrent)
    return {
      name,
      status: 'saved',
      ...(warnings.length > 0 ? { warning: `Profile created, but ${warnings.join(' and ')} could not be saved.` } : {})
    }
  }

  const saveEdit = async (
    command: EditProfileCommand,
    saveContext: Parameters<ProfileWorkflow['save']>[1]
  ): Promise<ProfileSaveResult> => {
    assertModelPair(command.advanced)
    const name = command.name
    const configuration = advancedConfiguration(name, command.advanced)
    if (command.descriptionTouched) configuration.description = command.description.trim()
    if (command.advanced.dirtySoul) configuration.soul = command.advanced.soul
    if (command.advanced.dirtyModel && command.advanced.provider && command.advanced.model) {
      configuration.provider = command.advanced.provider.trim()
      configuration.model = command.advanced.model.trim()
    }

    if (command.advanced.dirtyModel && !command.advanced.provider && !command.advanced.model) {
      assertCurrent(saveContext.isCurrent)
      const result = await agents.clearModel(name)
      assertCurrent(saveContext.isCurrent)
      if (!isSuccessfulCliResult(result)) throw new Error(result.hint || 'The inherited model could not be restored.')
    }

    if (Object.keys(configuration).length > 1) {
      assertCurrent(saveContext.isCurrent)
      let result = await agents.configure(configuration)
      assertCurrent(saveContext.isCurrent)
      if (result.confirm_required) {
        const approved = await saveContext.confirmModel(result.confirm_message || 'This model may use paid or external resources. Continue?')
        assertCurrent(saveContext.isCurrent)
        if (!approved) return { reason: 'model-confirmation-declined', status: 'cancelled' }
        result = await agents.configure({ ...configuration, confirm_expensive_model: true })
        assertCurrent(saveContext.isCurrent)
      }
      if (!isSuccessfulProfileConfiguration(result)) throw new Error('The gateway did not save the profile configuration.')
    }

    if (command.appearance.touched) {
      assertCurrent(saveContext.isCurrent)
      const result = await agents.configure({
        name,
        ui_meta: {
          'hermes-bots': botMetaForProfile({
            color: command.appearance.color,
            created: command.appearance.created,
            image: command.avatar.current,
            shape: command.appearance.shape,
            title: command.appearance.title
          })
        }
      })
      assertCurrent(saveContext.isCurrent)
      if (!isSuccessfulProfileConfiguration(result)) throw new Error('The profile appearance could not be saved.')
    }

    if (command.avatar.current) {
      const initial = command.avatar.baseline.status === 'known' ? command.avatar.baseline.image : null
      if (command.avatar.baseline.status === 'unknown' || command.avatar.current !== initial) {
        assertCurrent(saveContext.isCurrent)
        const result = await agents.setAsset(name, { data: command.avatar.current })
        assertCurrent(saveContext.isCurrent)
        if (result.ok === false) throw new Error('The avatar image could not be saved.')
      }
    } else if (command.avatar.baseline.status === 'known' && command.avatar.baseline.image) {
      assertCurrent(saveContext.isCurrent)
      const result = await agents.setAsset(name, { clear: true })
      assertCurrent(saveContext.isCurrent)
      if (result.ok === false) throw new Error('The avatar image could not be removed.')
    }

    assertCurrent(saveContext.isCurrent)
    return { name, status: 'saved' }
  }

  return {
    generateAvatar,
    loadAdvanced,
    loadAvatar,
    save: (command, saveContext) => command.mode === 'edit' ? saveEdit(command, saveContext) : saveCreate(command, saveContext)
  }
}
