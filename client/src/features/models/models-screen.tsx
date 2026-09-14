import { useQueryClient } from '@tanstack/react-query'

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@nanostores/react'

import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { PageShell } from '~/components/page-shell'
import { Badge, Button, Skeleton, Switch } from '~/compat/primitives'
import { ContextWindowField, FallbackField } from '~/features/models/config-editors'
import { createModelsApi } from '~/features/models/api'
import {
  REASONING_EFFORT_VALUES,
  getConfigValue,
  isFastTier,
  normalizeEffort
} from '~/features/models/helpers'
import {
  useAuxiliaryModelEditing,
  useMainModelEditing,
  useModelConfigEditing
} from '~/features/models/model-editing'
import { MoaEditor } from '~/features/models/moa-editor'
import { ModelSelect, ensureOption, modelOptions, providerOptions } from '~/features/models/select'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { beginScopedTask, useScopeKey, useScopedQuery, useScopeReset } from '~/gateway/scope-guard'
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
  showBack?: boolean
}

export function ModelsScreen({ onBack: _onBack, showBack: _showBack = true }: ModelsScreenProps) {
  const models = useApi(createModelsApi)
  const queryClient = useQueryClient()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const scopeKey = useScopeKey('models')
  const infoKey = useScopeKey('models', ['info'])
  const optionsKey = useScopeKey('models', ['options'])
  const auxiliaryKey = useScopeKey('models', ['auxiliary'])
  const configKey = useScopeKey('models', ['config'])
  const moaKey = useScopeKey('models', ['moa'])
  const info = useScopedQuery(infoKey, { queryFn: signal => models.getInfo(signal) })
  const options = useScopedQuery(optionsKey, { queryFn: signal => models.getOptions(signal) })
  const auxiliary = useScopedQuery(auxiliaryKey, { queryFn: signal => models.getAuxiliary(signal) })
  const config = useScopedQuery(configKey, { queryFn: signal => models.getConfig(signal) })
  const moa = useScopedQuery(moaKey, { queryFn: signal => models.getMoa(signal) })

  const providers = useMemo<ModelOptionProvider[]>(() => options.data?.providers ?? [], [options.data])
  const mainModel = useMemo(
    () => (info.data ? { model: info.data.model, provider: info.data.provider } : null),
    [info.data]
  )

  // Draft selection: seeded from the applied model, preserved across
  // refetches so an in-progress pick survives a refresh.
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [editingTask, setEditingTask] = useState<null | string>(null)
  const [auxDraft, setAuxDraft] = useState<{ model: string; provider: string }>({ model: '', provider: '' })
  const [moaError, setMoaError] = useState<string | null>(null)
  useEffect(() => {
    if (!info.data) return
    setSelectedProvider(prev => prev || info.data.provider)
    setSelectedModel(prev => prev || info.data.model)
  }, [info.data])

  useScopeReset(() => {
    setSelectedProvider('')
    setSelectedModel('')
    setEditingTask(null)
    setAuxDraft({ model: '', provider: '' })
    setMoaError(null)
  })

  const selectedProviderRow = useMemo(() => providers.find(provider => provider.slug === selectedProvider), [providers, selectedProvider])
  const selectedProviderModels = selectedProviderRow?.models ?? []
  const providerSelectOptions = useMemo(() => ensureOption(providerOptions(providers), selectedProvider), [providers, selectedProvider])

  const mainEditing = useMainModelEditing()
  const auxiliaryEditing = useAuxiliaryModelEditing(providers)
  const configEditing = useModelConfigEditing(config.data)

  // Capabilities of the APPLIED main model gate the profile-default controls.
  const mainCaps = useMemo(
    () => (mainModel ? providers.find(provider => provider.slug === mainModel.provider)?.capabilities?.[mainModel.model] : undefined),
    [providers, mainModel]
  )
  const reasoningSupported = mainCaps?.reasoning ?? true
  const fastSupported = mainCaps?.fast ?? false

  const configData = config.data
  const effortValue = normalizeEffort(getConfigValue(configData, 'agent.reasoning_effort'))
  const fastOn = isFastTier(getConfigValue(configData, 'agent.service_tier'))

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
  const staleWarning = mainEditing.staleAuxiliary.length > 0
    ? mainEditing.staleAuxiliary
    : persistentStaleAux

  async function submitAuxiliary(body: { model: string; provider: string; task: string }) {
    if (await auxiliaryEditing.assign(body)) setEditingTask(null)
  }

  async function resetAuxiliary() {
    if (!mainModel) return
    const reportVersion = mainEditing.staleAuxiliaryVersion
    if (await auxiliaryEditing.resetAll(mainModel)) {
      mainEditing.clearStaleAuxiliary(reportVersion)
    }
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
    <PageShell
      heading={false}
      subtitle={`Current model, assignments, and model capabilities for the ${profile || 'default'} profile.`}
      title="Models"
    >
      {loading && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-20 w-full" /><Skeleton className="mt-3 h-32 w-full" /></div>}
      {loadError && <GatewayErrorBanner error={loadError} subject="Models" />}

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
              disabled={mainEditing.applying}
              onChange={value => { setSelectedProvider(value); setSelectedModel('') }}
              options={providerSelectOptions}
              placeholder="Provider"
              value={selectedProvider}
            />
            <ModelSelect
              ariaLabel="Model"
              disabled={mainEditing.applying || !selectedProvider}
              onChange={setSelectedModel}
              options={ensureOption(modelOptions(selectedProviderModels), selectedModel)}
              placeholder="Model"
              value={selectedModel}
            />
          </div>
          <div className="models-controls">
            <Button
              disabled={!selectedProvider || !selectedModel || mainEditing.applying}
              onClick={() => mainEditing.apply({
                model: selectedModel,
                provider: selectedProvider,
                ...(selectedProviderRow?.api_url ? { base_url: selectedProviderRow.api_url } : {})
              })}
              size="sm"
              variant="default"
            >
              {mainEditing.applying ? 'Applying…' : 'Apply'}
            </Button>
            {mainEditing.declined && !mainEditing.applying && <Badge variant="muted">Model change cancelled</Badge>}
          </div>
          {mainEditing.error && <div className="error-banner" role="alert">{mainEditing.error}</div>}

          {configData && mainModel && (reasoningSupported || fastSupported) && (
            <div className="models-controls" aria-label="Profile defaults">
              {reasoningSupported && (
                <label className="models-field-label">
                  <span>Reasoning</span>
                  <ModelSelect
                    ariaLabel="Default reasoning effort"
                    onChange={configEditing.setReasoningEffort}
                    options={REASONING_OPTIONS}
                    placeholder="Reasoning"
                    value={effortValue}
                  />
                </label>
              )}
              {fastSupported && (
                <label className="models-field-label models-toggle">
                  <span>Fast tier</span>
                  <Switch checked={fastOn} onCheckedChange={configEditing.setFastTier} />
                </label>
              )}
            </div>
          )}
          {configEditing.error && <div className="error-banner" role="alert">{configEditing.error}</div>}
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
            <Button disabled={auxiliaryEditing.applying || !mainModel} onClick={() => void resetAuxiliary()} size="sm" variant="secondary">Reset all to main</Button>
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
                      <Button disabled={!mainModel || auxiliaryEditing.applying} onClick={() => void submitAuxiliary({ model: mainModel!.model, provider: mainModel!.provider, task: key })} size="sm" variant="secondary">Set to main</Button>
                      <Button disabled={!providers.length || auxiliaryEditing.applying} onClick={() => beginAuxiliaryEdit(key)} size="sm" variant="secondary">Change</Button>
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
                    <Button disabled={!auxDraft.provider || !auxDraft.model || auxiliaryEditing.applying} onClick={() => void submitAuxiliary({ model: auxDraft.model, provider: auxDraft.provider, task: key })} size="sm" variant="default">{auxiliaryEditing.applying ? 'Applying…' : 'Apply'}</Button>
                    <Button onClick={() => setEditingTask(null)} size="sm" variant="secondary">Cancel</Button>
                  </div>
                )}
              </div>
            )
          })}
          <div className="models-controls">
            <Button disabled={!mainModel || auxiliaryEditing.applying} onClick={() => void resetAuxiliary()} size="sm" variant="secondary">Reset all to main</Button>
          </div>
          {(auxiliaryEditing.error || moaError) && <div className="error-banner" role="alert">{auxiliaryEditing.error || moaError}</div>}
        </div>
      </section>

      {moa.data && moa.data.presets && (
        <MoaEditor
          connectionKey={preferences.remoteURL}
          moa={moa.data}
          onMoaChange={next => { const task = beginScopedTask(); if (task.isCurrent()) queryClient.setQueryData(moaKey, next) }}
          onError={error => {
            const task = beginScopedTask()
            if (!task.isCurrent()) return
            setMoaError(classifyGatewayError(error).message)
            // Autosaves and preset writes are optimistic. Refetch the
            // authoritative document after a failure instead of leaving a
            // draft that never reached the gateway in the query cache.
            void moa.refetch()
          }}
          onSaved={(saved, savedProfile) => {
            const task = beginScopedTask()
            if (savedProfile === profile && task.isCurrent()) queryClient.setQueryData(moaKey, saved)
          }}
          profile={profile}
          providers={providers}
        />
      )}
      {moa.error && <GatewayErrorBanner error={moa.error} subject="Mixture of Agents" unsupportedText="This gateway does not provide the MoA endpoint. The rest of Models still works." role="status" />}

      {configData && (
        <section className="models-section" aria-label="Context and fallbacks">
          <ContextWindowField
            autoDetected={info.data?.auto_context_length}
            effective={info.data?.effective_context_length}
            onWrite={configEditing.setContextLength}
            value={typeof getConfigValue(configData, 'model_context_length') === 'number' ? Number(getConfigValue(configData, 'model_context_length')) : 0}
          />
          <FallbackField
            onWrite={configEditing.setFallbacks}
            providers={providers}
            value={getConfigValue(configData, 'fallback_providers')}
          />
        </section>
      )}

      {mainEditing.pendingConfirmation !== null && (
        <ConfirmDialog
          confirmLabel="Apply anyway"
          description={mainEditing.pendingConfirmation.message}
          onCancel={mainEditing.decline}
          onConfirm={mainEditing.confirm}
          title="Confirm model change"
        />
      )}
    </PageShell>
  )
}