import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconExternalLink, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'

import { useStore } from '@nanostores/react'
import { Badge, Button, Input, Skeleton, Switch, Textarea } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { profileKey } from '~/gateway/profile-path'
import { runRemoteAction } from '~/gateway/remote-action'
import { useGateway } from '~/gateway/gateway-context'
import type { MemoryProviderConfig, MemoryProviderField, MemoryProviderOAuthStatus } from '~/lib/types'
import type { SettingsCategory } from '~/navigation/routes'
import { $preferences } from '~/state/store'
import { settingsApi } from './settings-api'
import { SettingsPageShell } from './settings-page-shell'

type MemoryValues = Record<string, unknown>

export function MemorySettings({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const profileSupportsMemoryManagement = profileKey(profile) === 'default'
  const scope = { connectionKey: preferences.remoteURL, profile }
  const statusKey = useMemo(() => gatewayScopeKey(scope, 'settings', 'memory'), [preferences.remoteURL, profile])
  const status = useQuery({
    enabled: profileSupportsMemoryManagement,
    queryFn: ({ signal }) => settingsApi.memoryStatus(gateway, profile, signal),
    queryKey: statusKey
  })
  const [selectedProvider, setSelectedProvider] = useState('')
  const [oauthPending, setOAuthPending] = useState(false)
  const [oauthError, setOAuthError] = useState<string | null>(null)
  const [resetTarget, setResetTarget] = useState<'all' | 'memory' | 'user' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const providers = status.data?.providers ?? []
  const providerKey = profileSupportsMemoryManagement ? selectedProvider || status.data?.active || providers[0]?.name || '' : ''
  const selectedStatus = providers.find(provider => provider.name === providerKey)
  const config = useQuery({
    enabled: Boolean(providerKey),
    queryFn: ({ signal }) => settingsApi.memoryProviderConfig(gateway, profile, providerKey, signal),
    queryKey: [...statusKey, 'provider', providerKey]
  })
  const oauth = useQuery({
    enabled: Boolean(providerKey),
    queryFn: ({ signal }) => settingsApi.memoryOAuthStatus(gateway, profile, providerKey, signal),
    queryKey: [...statusKey, 'oauth', providerKey],
    retry: false
  })

  useEffect(() => {
    setSelectedProvider('')
    setOAuthPending(false)
    setOAuthError(null)
    setError(null)
    setResetTarget(null)
  }, [preferences.remoteURL, profile])

  useEffect(() => {
    if (!selectedProvider && status.data?.active) setSelectedProvider(status.data.active)
  }, [selectedProvider, status.data?.active])

  const selectProvider = useMutation<Awaited<ReturnType<typeof settingsApi.selectMemoryProvider>>, unknown, string, { scope: CurrentGatewayScope }>({
    mutationFn: (provider: string) => settingsApi.selectMemoryProvider(gateway, profile, provider),
    onError: (caught, _provider, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_value, _provider, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setError(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
    }
  })
  const saveProvider = useMutation<Awaited<ReturnType<typeof settingsApi.saveMemoryProviderConfig>>, unknown, MemoryValues, { scope: CurrentGatewayScope }>({
    mutationFn: (values: MemoryValues) => settingsApi.saveMemoryProviderConfig(gateway, profile, providerKey, values),
    onError: (caught, _values, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_value, _values, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setError(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
      void config.refetch()
    }
  })
  const setupProvider = useMutation<Awaited<ReturnType<typeof settingsApi.setupMemoryProvider>>, unknown, void, { scope: CurrentGatewayScope }>({
    mutationFn: () => settingsApi.setupMemoryProvider(gateway, profile, providerKey),
    onError: (caught, _values, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_value, _values, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setError(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
      void config.refetch()
    }
  })
  const reset = useMutation<Awaited<ReturnType<typeof settingsApi.resetMemory>>, unknown, 'all' | 'memory' | 'user', { scope: CurrentGatewayScope }>({
    mutationFn: (target: 'all' | 'memory' | 'user') => settingsApi.resetMemory(gateway, profile, target),
    onError: (caught, _target, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSettled: (_data, _error, _target, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setResetTarget(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
    }
  })

  useEffect(() => {
    if (!oauthPending || !providerKey) return
    const controller = new AbortController()
    const oauthScope = currentGatewayScope()
    void runRemoteAction<MemoryProviderOAuthStatus>({
      gateway,
      getScopeEpoch: () => currentGatewayScope().generation,
      intervalMs: 2_000,
      maxAttempts: 60,
      maxIntervalMs: 10_000,
      poll: async (_transport, signal) => {
        const next = await settingsApi.memoryOAuthStatus(gateway, profile, providerKey, signal)
        return { result: next, status: next.state }
      },
      signal: controller.signal,
      start: async () => ({ result: oauth.data, status: 'pending' }),
      isComplete: state => state.status !== 'pending'
    }).then(state => {
      if (controller.signal.aborted || !isCurrentGatewayScope(oauthScope)) return
      setOAuthPending(false)
      const next = state.result
      if (next?.state === 'error') setOAuthError(next.detail || 'The provider rejected the connection.')
      else {
        setOAuthError(null)
        void queryClient.invalidateQueries({ queryKey: [...statusKey, 'oauth', providerKey] })
        void queryClient.invalidateQueries({ queryKey: statusKey })
      }
    }).catch(caught => {
      if (controller.signal.aborted || !isCurrentGatewayScope(oauthScope)) return
      setOAuthPending(false)
      setOAuthError(classifyGatewayError(caught).message)
    })
    return () => controller.abort()
  }, [gateway, oauth.data, oauthPending, profile, providerKey, queryClient, statusKey])

  const chooseProvider = (name: string) => {
    setSelectedProvider(name)
    setOAuthError(null)
    setError(null)
  }

  const startOAuth = async () => {
    if (!providerKey) return
    const oauthScope = currentGatewayScope()
    setOAuthError(null)
    try {
      const next = await settingsApi.startMemoryOAuth(gateway, profile, providerKey)
      if (!isCurrentGatewayScope(oauthScope)) return
      if (next.state === 'connected') {
        void queryClient.invalidateQueries({ queryKey: statusKey })
        void oauth.refetch()
      } else {
        setOAuthPending(true)
      }
    } catch (caught) {
      if (!isCurrentGatewayScope(oauthScope)) return
      setOAuthError(classifyGatewayError(caught).kind === 'unsupported' ? 'This memory provider does not offer OAuth.' : classifyGatewayError(caught).message)
    }
  }

  return <SettingsPageShell title="Memory & Context" subtitle="Provider configuration and memory files belong to the selected gateway profile. Changes apply to new sessions.">
    <Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!profileSupportsMemoryManagement && <section className="unsupported-card" role="alert"><strong>Memory management is unavailable for this profile.</strong><p>This gateway's memory status, provider selection, reset, and dependency setup routes are process-scoped. Use the default profile or connect to a gateway dedicated to this profile.</p></section>}
    {profileSupportsMemoryManagement && status.error && <MemoryError error={status.error} />}
    {profileSupportsMemoryManagement && status.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /></div>}
    {profileSupportsMemoryManagement && status.data && <>
      <section className="settings-section">
        <header className="page-heading"><h3>Memory provider</h3><Button aria-label="Refresh memory" onClick={() => void status.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button></header>
        <div className="settings-list static">
          {providers.map(provider => <div className="memory-provider-row" key={provider.name}>
            <button className={provider.name === (status.data.active || selectedProvider) ? 'memory-provider-select active' : 'memory-provider-select'} onClick={() => chooseProvider(provider.name)}>
              <span><strong>{provider.name}</strong><small>{provider.description || 'No description'} · {memoryStatusLabel(provider.status, provider.configured)}</small></span>
            </button>
            <span className="button-row"><Badge variant={provider.name === status.data.active ? 'default' : 'muted'}>{provider.name === status.data.active ? 'Active' : memoryStatusLabel(provider.status, provider.configured)}</Badge>{provider.name !== status.data.active && <Button disabled={selectProvider.isPending || provider.status !== 'ready'} onClick={() => selectProvider.mutate(provider.name)} size="sm">Use</Button>}</span>
          </div>)}
          {providers.length === 0 && <div className="empty-panel">This gateway did not advertise any memory providers.</div>}
        </div>
      </section>
      <section className="data-card memory-files">
        <header className="page-heading"><h3>Built-in memory</h3><Badge variant="muted">{profile || 'default'}</Badge></header>
        <p className="muted">Stored memory files are profile-local. Reset only what you select.</p>
        <div className="settings-list static"><div><span><strong>MEMORY.md</strong><small>{formatBytes(status.data.builtin_files.memory)}</small></span><Button onClick={() => setResetTarget('memory')} size="sm" variant="destructive"><IconTrash size={14} /> Reset</Button></div><div><span><strong>USER.md</strong><small>{formatBytes(status.data.builtin_files.user)}</small></span><Button onClick={() => setResetTarget('user')} size="sm" variant="destructive"><IconTrash size={14} /> Reset</Button></div></div>
        <Button className="touch-button" onClick={() => setResetTarget('all')} variant="destructive"><IconTrash size={16} /> Reset all built-in memory</Button>
      </section>
    </>}
    {providerKey && <MemoryProviderEditor config={config.data} error={config.error} key={`${preferences.remoteURL}:${profile || 'default'}:${providerKey}`} loading={config.isPending} onSave={values => saveProvider.mutate(values)} onSetup={() => setupProvider.mutate()} provider={providerKey} providerStatus={selectedStatus} saving={saveProvider.isPending || setupProvider.isPending} />}
    {providerKey && <MemoryOAuthCard error={oauthError} onStart={() => void startOAuth()} pending={oauthPending} status={oauth.data} />}
    {resetTarget && <ConfirmDialog confirmLabel="Reset memory" description={`Reset ${resetTarget === 'all' ? 'all built-in memory files' : `${resetTarget === 'memory' ? 'MEMORY.md' : 'USER.md'} in this profile`}? This cannot be undone.`} onCancel={() => setResetTarget(null)} onConfirm={() => reset.mutate(resetTarget)} title="Reset built-in memory" />}
  </SettingsPageShell>
}

function MemoryProviderEditor({ config, error, loading, onSave, onSetup, provider, providerStatus, saving }: { config?: MemoryProviderConfig; error: unknown; loading: boolean; onSave(values: MemoryValues): void; onSetup(): void; provider: string; providerStatus?: { available?: boolean; configured: boolean; description: string; setup?: { dependencies_installed?: boolean; external_dependencies?: Array<{ name?: string }>; pip_dependencies?: string[] }; status?: string }; saving: boolean }) {
  const [values, setValues] = useState<MemoryValues>({})
  const [savedFor, setSavedFor] = useState('')
  useEffect(() => {
    if (!config || savedFor === provider) return
    setValues(Object.fromEntries(config.fields.map(field => [field.key, field.kind === 'secret' ? '' : field.value])))
    setSavedFor(provider)
  }, [config, provider, savedFor])
  const fields = useMemo(() => config?.fields.filter(field => fieldVisible(field, values)) ?? [], [config, values])
  if (loading) return <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /></div>
  if (error) return <div className="unsupported-card">Provider settings unavailable: {classifyGatewayError(error).message}</div>
  if (!config) return null
  const needsSetup = providerStatus?.status === 'unavailable' || (providerStatus?.status === 'needs_config' && !providerStatus.configured)
  const saveValues = () => {
    const secretKeys = new Set(config.fields.filter(field => field.kind === 'secret').map(field => field.key))
    const submitted = Object.fromEntries(Object.entries(values).filter(([key, value]) => !secretKeys.has(key) || (value !== '' && value != null)))
    onSave(submitted)
    // Secret fields are request input, not an editable draft to retain after
    // an attempt. Non-secret values remain available for correction/retry.
    setValues(current => {
      const next = { ...current }
      secretKeys.forEach(key => { next[key] = '' })
      return next
    })
  }
  return <section className="data-card memory-provider-editor"><header className="page-heading"><div><h3>{config.label || provider}</h3><p className="muted">Only this provider's declared fields are sent to the gateway.</p></div>{config.docs_url && <a aria-label={`Open ${config.label || provider} documentation`} href={config.docs_url} rel="noreferrer" target="_blank"><IconExternalLink size={18} /></a>}</header>{fields.map(field => <MemoryField field={field} key={field.key} onChange={value => setValues(current => ({ ...current, [field.key]: value }))} value={values[field.key]} />)}{fields.length === 0 && <p className="muted">This provider has no mobile-editable configuration.</p>}<div className="button-row">{fields.length > 0 && <Button disabled={saving} onClick={saveValues}>{saving ? 'Saving…' : 'Save provider settings'}</Button>}{needsSetup && <Button disabled={saving} onClick={onSetup} variant="secondary">Install provider dependencies</Button>}</div>{needsSetup && <p className="muted">Setup may install the provider's declared dependencies on the gateway. It never runs on the iOS device.</p>}</section>
}

function MemoryField({ field, onChange, value }: { field: MemoryProviderField; onChange(value: unknown): void; value: unknown }) {
  const kind = field.kind
  if (kind === 'bool' || kind === 'boolean') return <label className="toggle-field"><span><strong>{field.label}</strong><small>{field.description}</small></span><Switch checked={Boolean(value === true || value === 'true')} onCheckedChange={onChange} /></label>
  if (kind === 'select') return <label className="config-field"><span>{field.label}<small>{field.description}</small></span><select onChange={event => onChange(event.target.value)} value={String(value ?? '')}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
  if (kind === 'json' || kind === 'text' && (field.description.length > 100 || String(value ?? '').includes('\n'))) return <label className="config-field"><span>{field.label}<small>{field.description}</small></span><Textarea onChange={event => onChange(event.target.value)} placeholder={field.placeholder} value={String(value ?? '')} /></label>
  return <label className="config-field"><span>{field.label}<small>{field.description}</small></span><Input autoComplete={kind === 'secret' ? 'off' : undefined} min={field.minimum ?? undefined} max={field.maximum ?? undefined} onChange={event => onChange(kind === 'integer' || kind === 'number' ? Number(event.target.value) : event.target.value)} placeholder={field.placeholder} type={kind === 'secret' ? 'password' : kind === 'integer' || kind === 'number' ? 'number' : 'text'} value={String(value ?? '')} /></label>
}

function MemoryOAuthCard({ error, onStart, pending, status }: { error: string | null; onStart(): void; pending: boolean; status?: MemoryProviderOAuthStatus }) {
  if (!status && !error) return null
  return <section className="data-card memory-oauth"><header className="page-heading"><h3>Provider connection</h3>{status?.connected && <Badge>Connected</Badge>}</header><p className="muted">{pending ? 'The gateway is waiting for provider authorization.' : status?.detail || error || 'Connect this provider through its supported OAuth flow.'}</p>{error && <div className="error-banner" role="alert">{error}</div>}<Button disabled={pending} onClick={onStart} variant="secondary"><IconExternalLink size={16} /> {status?.connected ? 'Reconnect' : 'Connect with OAuth'}</Button></section>
}

function MemoryError({ error }: { error: unknown }) {
  const classified = classifyGatewayError(error)
  return <div className={classified.kind === 'unsupported' ? 'unsupported-card' : 'error-banner'} role="alert">{classified.kind === 'unsupported' ? 'Memory management is unavailable on this gateway.' : classified.message}</div>
}

function fieldVisible(field: MemoryProviderField, values: MemoryValues): boolean {
  if (!field.when) return true
  return Object.entries(field.when).every(([key, expected]) => String(values[key] ?? '') === String(expected))
}

function memoryStatusLabel(status: string | undefined, configured: boolean): string {
  if (status === 'ready' || configured) return 'Ready'
  if (status === 'needs_config') return 'Needs configuration'
  if (status === 'unavailable') return 'Dependencies unavailable'
  if (status === 'missing') return 'Missing'
  return 'Not configured'
}

function formatBytes(size: number): string {
  if (!size) return 'Empty'
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}

export const MEMORY_SETTINGS_CATEGORY: SettingsCategory = 'memory'
