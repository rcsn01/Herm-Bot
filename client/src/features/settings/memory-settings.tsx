import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconExternalLink, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useStore } from '@nanostores/react'
import { Badge, Button, Input, Skeleton, Switch, Textarea } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { useScopeKey, useScopedMutation, useScopedQuery, useScopeReset } from '~/gateway/scope-guard'
import { useOAuthFlow } from '~/gateway/oauth-flow'
import { profileKey } from '~/gateway/profile-path'
import { useApi, useGatewayApi } from '~/gateway/gateway-api-hooks'
import type { MemoryProviderConfig, MemoryProviderField, MemoryProviderOAuthStatus } from '~/lib/types'
import type { SettingsCategory } from '~/navigation/routes'
import { $preferences } from '~/state/store'
import { createMemoryOAuthAdapter } from './oauth-sources'
import { createSettingsApi } from './settings-api'
import { PageHeading } from '~/components/page-shell'
import { SettingsPageShell } from './settings-page-shell'

type MemoryValues = Record<string, unknown>

export function MemorySettings({ onBack }: { onBack(): void }) {
  const api = useGatewayApi()
  const settings = useApi(createSettingsApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const profileSupportsMemoryManagement = profileKey(profile) === 'default'
  const statusKey = useScopeKey('settings', ['memory'])
  const status = useScopedQuery(statusKey, {
    enabled: profileSupportsMemoryManagement,
    queryFn: signal => settings.memoryStatus(signal)
  })
  const [selectedProvider, setSelectedProvider] = useState('')
  const [resetTarget, setResetTarget] = useState<'all' | 'memory' | 'user' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const oauthProviderRef = useRef('')
  const oauth = useOAuthFlow({})

  const providers = status.data?.providers ?? []
  const providerKey = profileSupportsMemoryManagement ? selectedProvider || status.data?.active || providers[0]?.name || '' : ''
  const selectedStatus = providers.find(provider => provider.name === providerKey)
  const config = useScopedQuery(useScopeKey('settings', ['memory', 'provider', providerKey]), {
    enabled: Boolean(providerKey),
    queryFn: signal => settings.memoryProviderConfig(providerKey, signal)
  })
  const oauthStatus = useScopedQuery(useScopeKey('settings', ['memory', 'oauth', providerKey]), {
    enabled: Boolean(providerKey),
    queryFn: signal => settings.memoryOAuthStatus(providerKey, signal),
    retry: false
  })

  useScopeReset(() => {
    setSelectedProvider('')
    oauthProviderRef.current = ''
    oauth.stop()
    setError(null)
    setResetTarget(null)
  })

  useEffect(() => {
    if (!selectedProvider && status.data?.active) setSelectedProvider(status.data.active)
  }, [selectedProvider, status.data?.active])

  const selectProvider = useScopedMutation<Awaited<ReturnType<typeof settings.selectMemoryProvider>>, string>({
    mutationFn: provider => settings.selectMemoryProvider(provider),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
    }
  })
  const saveProvider = useScopedMutation<Awaited<ReturnType<typeof settings.saveMemoryProviderConfig>>, MemoryValues>({
    mutationFn: values => settings.saveMemoryProviderConfig(providerKey, values),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
      void config.refetch()
    }
  })
  const setupProvider = useScopedMutation<Awaited<ReturnType<typeof settings.setupMemoryProvider>>, void>({
    mutationFn: () => settings.setupMemoryProvider(providerKey),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
      void config.refetch()
    }
  })
  const reset = useScopedMutation<Awaited<ReturnType<typeof settings.resetMemory>>, 'all' | 'memory' | 'user'>({
    mutationFn: target => settings.resetMemory(target),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSettled: () => {
      setResetTarget(null)
      void queryClient.invalidateQueries({ queryKey: statusKey })
    }
  })

  useEffect(() => {
    return () => {
      if (oauthProviderRef.current === providerKey) oauthProviderRef.current = ''
      oauth.stop()
    }
  }, [oauth.stop, providerKey])

  useEffect(() => {
    if (oauth.snapshot?.phase !== 'approved' || oauthProviderRef.current !== providerKey) return
    void queryClient.invalidateQueries({ queryKey: [...statusKey, 'oauth', providerKey] })
    void queryClient.invalidateQueries({ queryKey: statusKey })
    void oauthStatus.refetch()
  }, [oauth.snapshot?.phase, oauthStatus.refetch, providerKey, queryClient])

  const chooseProvider = (name: string) => {
    setSelectedProvider(name)
    oauthProviderRef.current = ''
    oauth.stop()
    setError(null)
  }

  const startOAuth = () => {
    if (!providerKey) return
    setError(null)
    oauthProviderRef.current = providerKey
    oauth.start(createMemoryOAuthAdapter(settings, api.gateway, providerKey))
  }
  const memoryOAuthError = oauth.error?.kind === 'unsupported' ? 'This memory provider does not offer OAuth.' : oauth.error?.message || null

  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="Provider configuration and memory files belong to the selected gateway profile. Changes apply to new sessions." title="Memory & context">
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!profileSupportsMemoryManagement && <section className="unsupported-card" role="alert"><strong>Memory management is unavailable for this profile.</strong><p>This gateway's memory status, provider selection, reset, and dependency setup routes are process-scoped. Use the default profile or connect to a gateway dedicated to this profile.</p></section>}
    {profileSupportsMemoryManagement && status.error && <GatewayErrorBanner error={status.error} unsupportedText="Memory management is unavailable on this gateway." />}
    {profileSupportsMemoryManagement && status.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /></div>}
    {profileSupportsMemoryManagement && status.data && <>
      <section className="settings-section">
        <PageHeading actions={<Button aria-label="Refresh memory" onClick={() => void status.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>} level={3} title="Memory provider" />
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
        <PageHeading actions={<Badge variant="muted">{profile || 'default'}</Badge>} level={3} title="Built-in memory" />
        <p className="muted">Stored memory files are profile-local. Reset only what you select.</p>
        <div className="settings-list static"><div><span><strong>MEMORY.md</strong><small>{formatBytes(status.data.builtin_files.memory)}</small></span><Button onClick={() => setResetTarget('memory')} size="sm" variant="destructive"><IconTrash size={14} /> Reset</Button></div><div><span><strong>USER.md</strong><small>{formatBytes(status.data.builtin_files.user)}</small></span><Button onClick={() => setResetTarget('user')} size="sm" variant="destructive"><IconTrash size={14} /> Reset</Button></div></div>
        <Button className="touch-button" onClick={() => setResetTarget('all')} variant="destructive"><IconTrash size={16} /> Reset all built-in memory</Button>
      </section>
    </>}
    {providerKey && <MemoryProviderEditor config={config.data} error={config.error} key={`${preferences.remoteURL}:${profile || 'default'}:${providerKey}`} loading={config.isPending} onSave={values => saveProvider.mutate(values)} onSetup={() => setupProvider.mutate()} provider={providerKey} providerStatus={selectedStatus} saving={saveProvider.isPending || setupProvider.isPending} />}
    {providerKey && <MemoryOAuthCard error={oauth.snapshot?.message || memoryOAuthError} onStart={startOAuth} pending={oauth.busy} status={oauthStatus.data} />}
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
  if (error) return <GatewayErrorBanner error={error} unavailablePhrase="Provider settings unavailable" />
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
  return <section className="data-card memory-provider-editor"><PageHeading actions={config.docs_url && <a aria-label={`Open ${config.label || provider} documentation`} href={config.docs_url} rel="noreferrer" target="_blank"><IconExternalLink size={18} /></a>} level={3} title={config.label || provider} /><p className="muted">Only this provider's declared fields are sent to the gateway.</p>{fields.map(field => <MemoryField field={field} key={field.key} onChange={value => setValues(current => ({ ...current, [field.key]: value }))} value={values[field.key]} />)}{fields.length === 0 && <p className="muted">This provider has no mobile-editable configuration.</p>}<div className="button-row">{fields.length > 0 && <Button disabled={saving} onClick={saveValues}>{saving ? 'Saving…' : 'Save provider settings'}</Button>}{needsSetup && <Button disabled={saving} onClick={onSetup} variant="secondary">Install provider dependencies</Button>}</div>{needsSetup && <p className="muted">Setup may install the provider's declared dependencies on the gateway. It never runs on the iOS device.</p>}</section>
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
  return <section className="data-card memory-oauth"><PageHeading actions={status?.connected && <Badge>Connected</Badge>} level={3} title="Provider connection" /><p className="muted">{pending ? 'The gateway is waiting for provider authorization.' : status?.detail || error || 'Connect this provider through its supported OAuth flow.'}</p>{error && <div className="error-banner" role="alert">{error}</div>}<Button disabled={pending} onClick={onStart} variant="secondary"><IconExternalLink size={16} /> {status?.connected ? 'Reconnect' : 'Connect with OAuth'}</Button></section>
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
