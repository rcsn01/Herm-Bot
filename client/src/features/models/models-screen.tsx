import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useEffect, useMemo, useState, useCallback } from 'react'

import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { Badge, Button, Skeleton, Switch } from '~/compat/primitives'
import { CONFIG_SAVE_DEBOUNCE_MS, ContextWindowField, FallbackField, useDebouncedSave } from '~/features/models/config-editors'
import { modelsApi } from '~/features/models/api'
import {
  REASONING_EFFORT_VALUES,
  getConfigValue,
  isFastTier,
  normalizeEffort,
  setConfigValue,
  type FallbackEntry
} from '~/features/models/helpers'
import { MoaEditor } from '~/features/models/moa-editor'
import { ModelSelect, ensureOption, modelOptions, providerOptions } from '~/features/models/select'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { $preferences } from '~/state/store'
import type { ModelOptionProvider, StaleAuxAssignment } from '~/lib/types'

// Canonical auxiliary task slots shown on mobile — the eight the desktop
// Models page surfaces (the backend exposes a few more specialist slots that
// stay CLI/desktop-managed).
const AUX_TASKS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'vision', label: 'Vision', hint: 'Image understanding' },
  { key: 'compression', label: 'Compression', hint: 'Context summarization' },
  { key: 'skills_hub', label: 'Skills hub', hint: 'Skill maintenance' },
  { key: 'approval', label: 'Approval', hint: 'Approvals advisor' },
  { key: 'mcp', label: 'MCP', hint: 'MCP tool repair' },
  { key: 'title_generation', label: 'Title generation', hint: 'Session titles' },
  { key: 'review', label: 'Review', hint: 'Self review' },
  { key: 'curator', label: 'Curator', hint: 'Skill curation' }
]

const taskLabel = (key: string) => AUX_TASKS.find(task => task.key === key)?.label ?? key

const REASONING_LABELS: Readonly<Record<string, string>> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra'
}

const REASONING_OPTIONS = REASONING_EFFORT_VALUES.map(value => ({ label: REASONING_LABELS[value] ?? value, value }))

// agent.service_tier stores "fast"/"priority"/"on" for fast; anything else is
// normal. isFastTier (helpers) owns the mapping.

interface ModelsScreenProps {
  onBack(): void
}

export function ModelsScreen({ onBack }: ModelsScreenProps) {
  const gateway = useGateway()
  const queryClient = useQueryClient()
  const preferences = $preferences.get()
  const profile = preferences.profile
  const scopeKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'models')
  const keyFor = (domain: string) => [...scopeKey, domain]
  const invalidateAll = () => queryClient.invalidateQueries({ queryKey: scopeKey })

  const info = useQuery({ queryFn: () => modelsApi.getInfo(gateway, profile), queryKey: keyFor('info') })
  const options = useQuery({ queryFn: () => modelsApi.getOptions(gateway, profile), queryKey: keyFor('options') })
  const auxiliary = useQuery({ queryFn: () => modelsApi.getAuxiliary(gateway, profile), queryKey: keyFor('auxiliary') })
  const config = useQuery({ queryFn: () => modelsApi.getConfig(gateway, profile), queryKey: keyFor('config') })
  const moa = useQuery({ queryFn: () => modelsApi.getMoa(gateway, profile), queryKey: keyFor('moa') })

  const providers = useMemo<ModelOptionProvider[]>(() => options.data?.providers ?? [], [options.data])
  const mainModel = useMemo(
    () => (info.data ? { model: info.data.model, provider: info.data.provider } : null),
    [info.data]
  )

  // Draft selection: seeded from the applied model, preserved across
  // refetches so an in-progress pick survives a refresh.
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  useEffect(() => {
    if (!info.data) return
    setSelectedProvider(prev => prev || info.data.provider)
    setSelectedModel(prev => prev || info.data.model)
  }, [info.data])

  const selectedProviderRow = useMemo(() => providers.find(provider => provider.slug === selectedProvider), [providers, selectedProvider])
  const selectedProviderModels = selectedProviderRow?.models ?? []
  const providerSelectOptions = useMemo(() => ensureOption(providerOptions(providers), selectedProvider), [providers, selectedProvider])

  // Apply main model — with the backend's expensive-model confirmation loop:
  // the first POST answers confirm_required instead of persisting; the dialog
  // acks and the retry carries confirm_expensive_model.
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<null | string>(null)
  const [declined, setDeclined] = useState(false)
  const [staleAux, setStaleAux] = useState<StaleAuxAssignment[]>([])

  async function applyMain(confirm = false) {
    if (!selectedProvider || !selectedModel) return
    setApplying(true)
    setApplyError(null)
    try {
      const result = await modelsApi.setAssignment(gateway, profile, {
        model: selectedModel,
        provider: selectedProvider,
        scope: 'main',
        // Carry a custom provider's endpoint so switching does not discard it.
        ...(selectedProviderRow?.api_url ? { base_url: selectedProviderRow.api_url } : {}),
        ...(confirm ? { confirm_expensive_model: true } : {})
      })
      if (result.confirm_required) {
        if (confirm) {
          // Already acked — fail closed instead of recursing.
          setApplyError(result.confirm_message?.trim() || 'The gateway still refuses this model.')
          return
        }
        setPendingConfirm(result.confirm_message?.trim() || 'This model may be expensive to run. Apply anyway?')
        return
      }
      if (result.ok !== true) {
        setApplyError(result.confirm_message?.trim() || 'The model assignment was not applied.')
        return
      }
      setPendingConfirm(null)
      setDeclined(false)
      setStaleAux(result.stale_aux ?? [])
      await invalidateAll()
    } catch (error) {
      setApplyError(classifyGatewayError(error).message)
    } finally {
      setApplying(false)
    }
  }

  // Capabilities of the APPLIED main model — gates the profile-default
  // reasoning/speed controls (reasoning defaults on, fast defaults off when
  // unreported).
  const mainCaps = useMemo(
    () => (mainModel ? providers.find(provider => provider.slug === mainModel.provider)?.capabilities?.[mainModel.model] : undefined),
    [providers, mainModel]
  )
  const reasoningSupported = mainCaps?.reasoning ?? true
  const fastSupported = mainCaps?.fast ?? false

  const configData = config.data
  const effortValue = normalizeEffort(getConfigValue(configData, 'agent.reasoning_effort'))
  const fastOn = isFastTier(getConfigValue(configData, 'agent.service_tier'))

  const [configError, setConfigError] = useState<string | null>(null)

  // agent.* defaults and model_context_length / fallback_providers ride
  // partial /api/config updates: the backend deep-merges the PUT body over
  // the on-disk document, so unrelated profile configuration stays untouched.
  const writePartialConfig = useCallback(
    async (partial: Record<string, unknown>) => {
      await modelsApi.saveConfig(gateway, profile, partial)
    },
    [gateway, profile]
  )
  const writeAgentDefault = (key: string, value: string) => {
    if (!configData) return
    const previous = configData
    queryClient.setQueryData(keyFor('config'), setConfigValue(previous, key, value))
    void writePartialConfig(setConfigValue({}, key, value)).catch(error => {
      queryClient.setQueryData(keyFor('config'), previous)
      setConfigError(classifyGatewayError(error).message)
    })
  }

  const saveContext = useDebouncedSave(
    async (contextLength: number) => {
      if (configData) queryClient.setQueryData(keyFor('config'), setConfigValue(configData, 'model_context_length', contextLength))
      await writePartialConfig(setConfigValue({}, 'model_context_length', contextLength))
    },
    CONFIG_SAVE_DEBOUNCE_MS,
    error => setConfigError(classifyGatewayError(error).message)
  )
  const saveFallbacks = useDebouncedSave(
    async (entries: FallbackEntry[]) => {
      if (configData) queryClient.setQueryData(keyFor('config'), setConfigValue(configData, 'fallback_providers', entries))
      await writePartialConfig(setConfigValue({}, 'fallback_providers', entries))
    },
    CONFIG_SAVE_DEBOUNCE_MS,
    error => setConfigError(classifyGatewayError(error).message)
  )

  // Auxiliary: draft edit state + actions.
  const [editingTask, setEditingTask] = useState<null | string>(null)
  const [auxDraft, setAuxDraft] = useState<{ model: string; provider: string }>({ model: '', provider: '' })
  const [auxError, setAuxError] = useState<string | null>(null)
  const [auxApplying, setAuxApplying] = useState(false)

  const auxDraftProviderModels = useMemo(
    () => providers.find(provider => provider.slug === auxDraft.provider)?.models ?? [],
    [auxDraft.provider, providers]
  )

  // Persistent mismatch: any aux slot pinned to a provider different from the
  // current main. Catches the "pinned months ago and forgot, now it bills a
  // dead provider" case; the switch-time report (result.stale_aux) takes
  // precedence until the next switch or reset.
  const persistentStaleAux = useMemo<StaleAuxAssignment[]>(() => {
    const mainProvider = (mainModel?.provider ?? '').toLowerCase()
    if (!mainProvider || !auxiliary.data) return []
    return auxiliary.data.tasks
      .filter(entry => {
        const provider = (entry.provider ?? '').toLowerCase()
        return provider && provider !== 'auto' && provider !== mainProvider
      })
      .map(entry => ({ model: entry.model, provider: entry.provider, task: entry.task }))
  }, [auxiliary.data, mainModel])
  const staleWarning = staleAux.length > 0 ? staleAux : persistentStaleAux

  const endpointForProvider = (provider: string) => {
    const row = providers.find(entry => entry.slug === provider)
    return row?.api_url ? { base_url: row.api_url } : {}
  }

  async function submitAuxiliary(body: { model: string; provider: string; task: string }) {
    setAuxApplying(true)
    setAuxError(null)
    try {
      await modelsApi.setAssignment(gateway, profile, { scope: 'auxiliary', ...body, ...endpointForProvider(body.provider) })
      setEditingTask(null)
      await invalidateAll()
    } catch (error) {
      setAuxError(classifyGatewayError(error).message)
    } finally {
      setAuxApplying(false)
    }
  }

  async function resetAuxiliary() {
    if (!mainModel) return
    await submitAuxiliary({ model: mainModel.model, provider: mainModel.provider, task: '__reset__' })
    setStaleAux([])
  }

  function beginAuxiliaryEdit(task: string) {
    const current = auxiliary.data?.tasks.find(entry => entry.task === task)
    setAuxDraft({
      model: current?.model || mainModel?.model || '',
      provider: current?.provider && current.provider !== 'auto' ? current.provider : (mainModel?.provider ?? '')
    })
    setEditingTask(task)
  }

  const loading = info.isPending || options.isPending
  const loadError = info.error ?? options.error ?? auxiliary.error ?? config.error

  return (
    <section className="screen page-screen">
      <header className="page-heading">
        <Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>
        <Button
          aria-label="Refresh models"
          onClick={() => void Promise.all([info.refetch(), options.refetch(), auxiliary.refetch(), config.refetch(), moa.refetch()])}
          size="icon-sm"
          variant="ghost"
        ><IconRefresh size={18} /></Button>
      </header>
      <p className="eyebrow">Remote gateway</p>
      <h2>Models</h2>
      <p className="muted">Current model, assignments, and model capabilities for the {profile || 'default'} profile.</p>

      {loading && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-20 w-full" /><Skeleton className="mt-3 h-32 w-full" /></div>}
      {loadError && <div className="error-banner" role="alert"><strong>Could not load models</strong><p>{classifyGatewayError(loadError).message}</p></div>}

      <section className="models-section" aria-label="Main model">
        <h3>Main model</h3>
        <div className="models-card">
          <p className="models-meta">
            {mainModel ? (
              <>Applied: <span className="models-mono">{mainModel.provider || 'unknown'} · {mainModel.model || 'unknown'}</span></>
            ) : (
              'No model applied yet.'
            )}
          </p>
          <div className="models-controls">
            <ModelSelect
              ariaLabel="Provider"
              onChange={value => { setSelectedProvider(value); setSelectedModel('') }}
              options={providerSelectOptions}
              placeholder="Provider"
              value={selectedProvider}
            />
            <ModelSelect
              ariaLabel="Model"
              disabled={!selectedProvider}
              onChange={setSelectedModel}
              options={ensureOption(modelOptions(selectedProviderModels), selectedModel)}
              placeholder="Model"
              value={selectedModel}
            />
          </div>
          <div className="models-controls">
            <Button disabled={!selectedProvider || !selectedModel || applying} onClick={() => void applyMain()} size="sm" variant="default">
              {applying ? 'Applying…' : 'Apply'}
            </Button>
            {declined && !applying && <Badge variant="muted">Model change cancelled</Badge>}
          </div>
          {applyError && <div className="error-banner" role="alert">{applyError}</div>}

          {configData && mainModel && (reasoningSupported || fastSupported) && (
            <div className="models-controls" aria-label="Profile defaults">
              {reasoningSupported && (
                <label className="models-field-label">
                  <span>Reasoning</span>
                  <ModelSelect
                    ariaLabel="Default reasoning effort"
                    onChange={value => writeAgentDefault('agent.reasoning_effort', value)}
                    options={REASONING_OPTIONS}
                    placeholder="Reasoning"
                    value={effortValue}
                  />
                </label>
              )}
              {fastSupported && (
                <label className="models-field-label models-toggle">
                  <span>Fast tier</span>
                  <Switch checked={fastOn} onCheckedChange={checked => writeAgentDefault('agent.service_tier', checked ? 'fast' : 'normal')} />
                </label>
              )}
            </div>
          )}
          {configError && <div className="error-banner" role="alert">{configError}</div>}
        </div>
      </section>

      <section className="models-section" aria-label="Auxiliary models">
        <h3>Auxiliary models</h3>
        <p className="muted">Helper tasks run on their own model when pinned, otherwise on the main model.</p>
        {staleWarning.length > 0 && (
          <div className="warning-banner" role="status">
            <p>
              {staleWarning.length} auxiliary task{staleWarning.length === 1 ? '' : 's'} (
              {staleWarning.map(entry => taskLabel(entry.task)).join(', ')}) still run on{' '}
              <span className="models-mono">{staleWarning.every(entry => entry.provider === staleWarning[0].provider) ? staleWarning[0].provider : 'other providers'}</span>,
              not your main model.
            </p>
            <Button disabled={auxApplying || !mainModel} onClick={() => void resetAuxiliary()} size="sm" variant="secondary">Reset all to main</Button>
          </div>
        )}
        <div className="models-card">
          {AUX_TASKS.map(({ key, label, hint }) => {
            const current = auxiliary.data?.tasks.find(entry => entry.task === key)
            const isAuto = !current || !current.provider || current.provider === 'auto'
            const isEditing = editingTask === key
            return (
              <div className="models-slot" key={key} aria-label={`Auxiliary ${label}`}>
                <div className="models-controls">
                  <span className="models-slot-title">{label}</span>
                  {!isEditing && (
                    <>
                      <Button disabled={!mainModel || auxApplying} onClick={() => void submitAuxiliary({ model: mainModel!.model, provider: mainModel!.provider, task: key })} size="sm" variant="secondary">Set to main</Button>
                      <Button disabled={!providers.length || auxApplying} onClick={() => beginAuxiliaryEdit(key)} size="sm" variant="secondary">Change</Button>
                    </>
                  )}
                </div>
                <p className="models-meta">{isAuto ? 'Uses the main model' : `${current!.provider} · ${current!.model || 'provider default'}`}{!isAuto && ` — ${hint}`}</p>
                {isEditing && (
                  <div className="models-controls">
                    <ModelSelect
                      ariaLabel={`Provider for ${label}`}
                      onChange={value => setAuxDraft(prev => ({ model: '', provider: value }))}
                      options={ensureOption(providerOptions(providers), auxDraft.provider)}
                      placeholder="Provider"
                      value={auxDraft.provider}
                    />
                    <ModelSelect
                      ariaLabel={`Model for ${label}`}
                      onChange={value => setAuxDraft(prev => ({ ...prev, model: value }))}
                      options={modelOptions(auxDraftProviderModels)}
                      placeholder="Model"
                      value={auxDraft.model}
                    />
                    <Button disabled={!auxDraft.provider || !auxDraft.model || auxApplying} onClick={() => void submitAuxiliary({ model: auxDraft.model, provider: auxDraft.provider, task: key })} size="sm" variant="default">{auxApplying ? 'Applying…' : 'Apply'}</Button>
                    <Button onClick={() => setEditingTask(null)} size="sm" variant="secondary">Cancel</Button>
                  </div>
                )}
              </div>
            )
          })}
          <div className="models-controls">
            <Button disabled={!mainModel || auxApplying} onClick={() => void resetAuxiliary()} size="sm" variant="secondary">Reset all to main</Button>
          </div>
          {auxError && <div className="error-banner" role="alert">{auxError}</div>}
        </div>
      </section>

      {moa.data && moa.data.presets && (
        <MoaEditor
          gateway={gateway}
          moa={moa.data}
          onMoaChange={next => queryClient.setQueryData(keyFor('moa'), next)}
          onError={error => setAuxError(classifyGatewayError(error).message)}
          onSaved={(saved, savedProfile) => {
            if (savedProfile === profile) queryClient.setQueryData(keyFor('moa'), saved)
          }}
          profile={profile}
          providers={providers}
        />
      )}
      {moa.error && (() => {
        const error = classifyGatewayError(moa.error)
        return (
          <div className={error.kind === 'unsupported' ? 'unsupported-card' : 'error-banner'} role="status">
            <strong>{error.kind === 'unsupported' ? 'Mixture of Agents unavailable' : 'Could not load Mixture of Agents'}</strong>
            <p>{error.kind === 'unsupported' ? 'This gateway does not provide the MoA endpoint. The rest of Models still works.' : error.message}</p>
          </div>
        )
      })()}

      {configData && (
        <section className="models-section" aria-label="Context and fallbacks">
          <ContextWindowField
            autoDetected={info.data?.auto_context_length}
            effective={info.data?.effective_context_length}
            onWrite={saveContext}
            value={typeof getConfigValue(configData, 'model_context_length') === 'number' ? Number(getConfigValue(configData, 'model_context_length')) : 0}
          />
          <FallbackField
            onWrite={saveFallbacks}
            providers={providers}
            value={getConfigValue(configData, 'fallback_providers')}
          />
        </section>
      )}

      {pendingConfirm !== null && (
        <ConfirmDialog
          confirmLabel="Apply anyway"
          description={pendingConfirm}
          onCancel={() => { setPendingConfirm(null); setDeclined(true) }}
          onConfirm={() => { setPendingConfirm(null); void applyMain(true) }}
          title="Confirm model change"
        />
      )}
    </section>
  )
}