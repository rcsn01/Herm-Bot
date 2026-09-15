import { useMemo, useState } from 'react'

import { Input } from '~/compat/primitives'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'

import type {
  AgentsApi,
  AgentMcpCatalogResult,
  AgentModelOptionProvider,
  AgentProfileDescribeResult,
  ProfileCapabilityEntry
} from './agents-api'

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

/** Hermes treats an all-enabled or all-disabled toolset list as the
 * unpinned/default state; only a partial selection is persisted explicitly. */
export function enabledToolsetNames(items: ProfileCapabilityEntry[]): string[] {
  const enabled = items.filter(item => item.enabled !== false)
  return enabled.length === items.length || enabled.length === 0 ? [] : enabled.map(item => item.name)
}

export function advancedStateFromDescribe(
  response: AgentProfileDescribeResult,
  catalog: AgentMcpCatalogResult | null,
  source: string,
  includeModel = true
): ProfileAdvancedState {
  const configured = response.mcp_servers ?? []
  const configuredNames = new Set(configured.map(entry => entry.name))
  const catalogEntries = (catalog?.servers ?? [])
    .filter(entry => !configuredNames.has(entry.name))
    .map(entry => ({
      ...entry,
      enabled: false,
      fromCatalog: true
    }))
  return {
    ...emptyAdvancedProfileState(),
    loaded: true,
    mcp: [...configured.map(entry => ({ ...entry, enabled: entry.enabled !== false })), ...catalogEntries],
    model: includeModel ? response.model?.default ?? '' : '',
    provider: includeModel ? response.model?.provider ?? '' : '',
    skills: response.skills ?? [],
    soul: includeModel ? response.soul ?? '' : '',
    source,
    toolsets: response.toolsets ?? []
  }
}

interface ProfileAdvancedFieldsProps {
  api: Pick<AgentsApi, 'modelOptions'>
  disabledSkills?: boolean
  error?: string | null
  loading?: boolean
  onChange(update: (previous: ProfileAdvancedState) => ProfileAdvancedState): void
  state: ProfileAdvancedState
}

function providerModels(provider: AgentModelOptionProvider | undefined): string[] {
  return (provider?.models ?? []).map(model => typeof model === 'string' ? model : model.id || model.name || '').filter(Boolean)
}

function providerLabel(provider: AgentModelOptionProvider): string {
  return provider.name?.trim() || provider.slug
}

function CapabilityList({
  items,
  onToggle,
  searchPlaceholder,
  title
}: {
  items: ProfileCapabilityEntry[]
  onToggle(name: string, enabled: boolean): void
  searchPlaceholder: string
  title: string
}) {
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle ? items.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(needle)) : items
  }, [filter, items])
  return (
    <fieldset className="profile-capability-fieldset">
      <legend>{title}</legend>
      <Input aria-label={`${title} filter`} onChange={event => setFilter(event.target.value)} placeholder={searchPlaceholder} value={filter} />
      <div className="profile-capability-list">
        {visible.map(item => (
          <label className="profile-capability-item" key={item.name} title={item.description || item.name}>
            <input checked={item.enabled !== false} onChange={event => onToggle(item.name, event.target.checked)} type="checkbox" />
            <span>
              <strong>{item.name}</strong>
              {(item.description || item.tool_count !== undefined) && <small>{item.description || `${item.tool_count ?? 0} tools`}</small>}
            </span>
          </label>
        ))}
        {visible.length === 0 && <p className="dialog-help">No matching entries.</p>}
      </div>
    </fieldset>
  )
}

export function ProfileAdvancedFields({ api, disabledSkills = false, error, loading = false, onChange, state }: ProfileAdvancedFieldsProps) {
  const optionsKey = useScopeKey('agents', ['model-options'], { unscoped: true })
  const options = useScopedQuery(optionsKey, { queryFn: signal => api.modelOptions(signal), retry: false })
  const providers = options.data?.providers ?? []
  const selectedProvider = providers.find(provider => provider.slug === state.provider)
  const models = providerModels(selectedProvider)
  const providerChoices = state.provider && !providers.some(provider => provider.slug === state.provider)
    ? [{ slug: state.provider, name: state.provider, models: state.model ? [state.model] : [] }, ...providers]
    : providers

  const updateModel = (provider: string, model: string) => onChange(previous => ({
    ...previous,
    dirtyModel: true,
    model,
    provider
  }))
  const updateCapability = (kind: 'mcp' | 'skills' | 'toolsets', name: string, enabled: boolean) => onChange(previous => ({
    ...previous,
    [kind === 'mcp' ? 'dirtyMcp' : kind === 'skills' ? 'dirtySkills' : 'dirtyToolsets']: true,
    [kind]: previous[kind].map(entry => entry.name === name ? { ...entry, enabled } : entry)
  }))

  if (loading) return <p className="dialog-help" role="status">Loading profile configuration…</p>
  if (error) return <p className="dialog-field-error" role="alert">{error}</p>
  if (!state.loaded) return <p className="dialog-help" role="status">Profile configuration is unavailable.</p>

  return (
    <div className="profile-advanced-fields">
      <section className="profile-advanced-section" aria-label="Model">
        <h4>Model</h4>
        {providers.length > 0 ? (
          <div className="profile-model-grid">
            <label>
              <span>Provider</span>
              <select aria-label="Profile provider" onChange={event => updateModel(event.target.value, '')} value={state.provider}>
                <option value="">Inherit launch profile</option>
                {providerChoices.map(provider => <option key={provider.slug} value={provider.slug}>{providerLabel(provider)}</option>)}
              </select>
            </label>
            <label>
              <span>Model</span>
              <select aria-label="Profile model" disabled={!state.provider} onChange={event => updateModel(state.provider, event.target.value)} value={state.model}>
                <option value="">Choose a model</option>
                {state.model && !models.includes(state.model) && <option value={state.model}>{state.model}</option>}
                {models.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
            </label>
          </div>
        ) : (
          <div className="profile-model-grid">
            <label>
              <span>Provider</span>
              <Input aria-label="Profile provider" onChange={event => updateModel(event.target.value, '')} placeholder="Inherit launch profile" value={state.provider} />
            </label>
            <label>
              <span>Model</span>
              <Input aria-label="Profile model" onChange={event => updateModel(state.provider, event.target.value)} placeholder="Model name" value={state.model} />
            </label>
          </div>
        )}
        {options.error && <p className="dialog-help">Model catalog unavailable; enter a provider and model manually.</p>}
        <p className="dialog-help">Leave both fields empty to inherit the launch profile. A saved explicit model applies to new sessions.</p>
      </section>

      <section className="profile-advanced-section" aria-label="Skills">
        <h4>Skills</h4>
        {disabledSkills
          ? <p className="dialog-help">Create empty is enabled, so bundled skills will not be installed.</p>
          : <CapabilityList items={state.skills} onToggle={(name, enabled) => updateCapability('skills', name, enabled)} searchPlaceholder="Filter skills" title={`Skills (${state.skills.filter(item => item.enabled !== false).length}/${state.skills.length} enabled)`} />}
      </section>

      <section className="profile-advanced-section" aria-label="Toolsets">
        <h4>Toolsets</h4>
        <CapabilityList items={state.toolsets} onToggle={(name, enabled) => updateCapability('toolsets', name, enabled)} searchPlaceholder="Filter toolsets" title={`Toolsets (${state.toolsets.filter(item => item.enabled !== false).length}/${state.toolsets.length} enabled)`} />
        <p className="dialog-help">All or none checked restores the gateway's default toolset behavior.</p>
      </section>

      <section className="profile-advanced-section" aria-label="MCP servers">
        <h4>MCP servers</h4>
        {state.mcp.length === 0
          ? <p className="dialog-help">No MCP servers are configured or available.</p>
          : <div className="profile-capability-list">{state.mcp.map(item => (
              <label className="profile-capability-item" key={item.name} title={item.description || item.name}>
                <input checked={item.enabled !== false} disabled={item.fromCatalog && item.installed === false && Boolean(item.requires?.length || item.auth)} onChange={event => updateCapability('mcp', item.name, event.target.checked)} type="checkbox" />
                <span><strong>{item.name}</strong><small>{item.description || (item.fromCatalog ? 'Catalog server' : item.transport || 'Configured server')}</small></span>
              </label>
            ))}</div>}
      </section>

      <section className="profile-advanced-section" aria-label="SOUL.md">
        <h4>SOUL.md</h4>
        <textarea aria-label="SOUL.md" className="profile-soul-input" onChange={event => onChange(previous => ({ ...previous, dirtySoul: true, soul: event.target.value }))} placeholder="Persona and behavior instructions…" value={state.soul} />
        <p className="dialog-help">This replaces the profile's full SOUL.md file.</p>
      </section>
    </div>
  )
}
