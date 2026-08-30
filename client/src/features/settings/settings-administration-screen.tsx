import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BillingStateResponse, SubscriptionPreviewResponse, SubscriptionStateResponse } from '@hermes/shared/billing'
import { IconChevronLeft, IconChevronRight, IconExternalLink, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { Badge, Button, Input, Skeleton, Switch, Textarea } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { FilesScreen } from '~/components/files-screen'
import { RemoteResourceScreen, type RemoteResourceDefinition } from '~/features/shared/remote-resource'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { runRemoteAction } from '~/gateway/remote-action'
import { useGateway } from '~/gateway/gateway-context'
import { profileKey } from '~/gateway/profile-path'
import { PlatformActions } from '~/native/platform-actions'
import type { SettingsAdministrationPage } from '~/navigation/routes'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'
import { useStore } from '@nanostores/react'
import type { CustomEndpoint, EnvVarInfo, OAuthPollResponse, OAuthProvider, OAuthStartResponse } from '~/lib/types'
import { settingsApi } from './settings-api'
import { SettingsPageShell } from './settings-page-shell'

const platformActions = new PlatformActions()

const PROCESS_SCOPED_ADMIN_MESSAGE = 'This gateway resource reads the process-wide installation and cannot be selected from a named profile. Switch to the default profile or connect to a gateway dedicated to that profile.'

const ADMIN_RESOURCES: Record<string, RemoteResourceDefinition> = {
  agents: { defaultProfileOnly: true, description: 'Current and recent delegated agent work. Transitional diagnostic view.', id: 'agents', path: '/api/agents', profileScoped: false, title: 'Agents', unavailableMessage: PROCESS_SCOPED_ADMIN_MESSAGE },
  billing: { description: 'Plan, balance, and account billing when this gateway advertises it.', id: 'billing', path: '/api/billing', profileScoped: false, title: 'Billing' },
  learning: { description: 'Memory and skill relationships. Transitional diagnostic view.', id: 'learning', path: '/api/learning/graph', title: 'Learning' },
  logs: { defaultProfileOnly: true, description: 'Recent remote gateway logs. Transitional diagnostic view.', id: 'logs', path: '/api/logs', profileScoped: false, title: 'Logs', unavailableMessage: PROCESS_SCOPED_ADMIN_MESSAGE },
  messaging: { description: 'Remote messaging platforms and health. Transitional diagnostic view.', id: 'messaging', path: '/api/messaging/platforms', title: 'Messaging' },
  pairing: { description: 'Pending and approved pairing users. Transitional diagnostic view.', id: 'pairing', path: '/api/pairing', title: 'Pairing' },
  profiles: { description: 'Remote profiles and identity. Transitional diagnostic view.', id: 'profiles', path: '/api/profiles', profileScoped: false, title: 'Profiles' },
  system: { description: 'Gateway health and maintenance availability. Transitional diagnostic view.', id: 'system', path: '/api/status', profileScoped: false, title: 'System' },
  usage: { description: 'Recent activity, tokens, and cost. Transitional diagnostic view.', id: 'usage', path: '/api/analytics/usage', title: 'Usage' },
  webhooks: { defaultProfileOnly: true, description: 'Webhook subscriptions and delivery state. Transitional diagnostic view.', id: 'webhooks', path: '/api/webhooks', profileScoped: false, title: 'Webhooks', unavailableMessage: PROCESS_SCOPED_ADMIN_MESSAGE }
}

export function SettingsAdministrationScreen({ controller, onBack, page }: { controller: GatewayController; onBack(): void; page: SettingsAdministrationPage }) {
  if (page === 'billing') return <BillingSettings onBack={onBack} />
  if (page === 'providers') return <ProvidersSettings onBack={onBack} />
  if (page === 'tools-keys') return <ToolsKeysSettings onBack={onBack} />
  if (page === 'archived-chats') return <ArchivedChatsSettings onBack={onBack} />
  if (page === 'plugins') return <PluginsSettings onBack={onBack} />
  if (page === 'gateway') return <GatewaySettings controller={controller} onBack={onBack} />
  if (page === 'projects') return <SettingsPageShell title="Projects and Files"><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><FilesScreen /></SettingsPageShell>
  const definition = ADMIN_RESOURCES[page as keyof typeof ADMIN_RESOURCES]
  if (definition) return <RemoteResourceScreen definition={definition} onBack={onBack} />
  return <SettingsPageShell title={page}><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><div className="unsupported-card">This administration page is not implemented on this gateway.</div></SettingsPageShell>
}

function BillingSettings({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const queryClient = useQueryClient()
  // Billing belongs to the gateway/account, not the selected Hermes profile.
  // Keep one cache entry and use the process-scoped RPC contract rather than
  // suggesting that an account balance is profile-local.
  const billingKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: null }, 'settings', 'billing')
  const billing = useQuery({ queryFn: ({ signal }) => settingsApi.billingState(gateway, preferences.profile, signal), queryKey: [...billingKey, 'state'] })
  const subscription = useQuery({ queryFn: ({ signal }) => settingsApi.subscriptionState(gateway, preferences.profile, signal), queryKey: [...billingKey, 'subscription'] })
  const [preview, setPreview] = useState<{ response: SubscriptionPreviewResponse; tierId: string } | null>(null)
  const [busyTier, setBusyTier] = useState<string | null>(null)
  const idempotencyKeys = useRef(new Map<string, string>())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setPreview(null); setBusyTier(null); setError(null); idempotencyKeys.current.clear() }, [preferences.profile, preferences.remoteURL])
  const state = billing.data
  const portalURL = state?.portal_url || subscription.data?.portal_url
  const refresh = () => { void billing.refetch(); void subscription.refetch() }
  const openPortal = async () => {
    if (!portalURL) return
    const scope = currentGatewayScope()
    try { await platformActions.openExternal(portalURL) } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  const requestPlanChange = async (tierId: string) => {
    const scope = currentGatewayScope()
    setBusyTier(tierId)
    setError(null)
    try {
      const result = await gateway.rpc<SubscriptionPreviewResponse>('subscription.preview', { subscription_type_id: tierId }, { timeoutMs: 60_000 })
      if (!isCurrentGatewayScope(scope)) return
      if (!result.ok) setError(result.message || result.error || 'The gateway could not preview this plan change.')
      else setPreview({ response: result, tierId })
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) } finally { if (isCurrentGatewayScope(scope)) setBusyTier(null) }
  }
  const applyPlanChange = async () => {
    if (!preview) return
    const scope = currentGatewayScope()
    const pending = preview
    setBusyTier(pending.tierId)
    try {
      const action = pending.response.effect === 'charge_now' ? 'subscription.upgrade' : 'subscription.change'
      const params: Record<string, unknown> = { subscription_type_id: pending.tierId }
      if (action === 'subscription.upgrade') {
        const key = idempotencyKeys.current.get(pending.tierId) || crypto.randomUUID()
        idempotencyKeys.current.set(pending.tierId, key)
        params.idempotency_key = key
      }
      const result = await gateway.rpc<{ error?: string; message?: string; ok: boolean; recovery_url?: string }>(action, params, { timeoutMs: 120_000 })
      if (!isCurrentGatewayScope(scope)) return
      if (!result.ok) { setError(result.message || result.error || 'The gateway rejected this plan change.'); return }
      idempotencyKeys.current.delete(pending.tierId)
      setPreview(null)
      void queryClient.invalidateQueries({ queryKey: billingKey })
      if (result.recovery_url) {
        try { await platformActions.openExternal(result.recovery_url) } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
      }
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) } finally { if (isCurrentGatewayScope(scope)) setBusyTier(null) }
  }
  return <SettingsPageShell title="Billing" subtitle="Billing state and plan changes belong to this gateway account. Hermes Mobile never infers entitlements across profiles."><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><header className="page-heading"><h3>Account</h3><Button aria-label="Refresh billing" onClick={refresh} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button></header>{billing.isPending || subscription.isPending ? <Skeleton className="h-20 w-full" /> : <BillingOverview billing={state} subscription={subscription.data} onOpenPortal={() => void openPortal()} portalURL={portalURL} />}{(billing.error || subscription.error) && <div className="unsupported-card" role="alert">Billing is unavailable: {classifyGatewayError(billing.error || subscription.error).message}</div>}{error && <div className="error-banner" role="alert">{error}</div>}{state?.logged_in && subscription.data?.tiers?.length ? <section className="settings-section"><h3>Plans</h3>{!(subscription.data.can_change_plan ?? state.can_change_plan ?? false) && <p className="muted">Plan changes require billing permissions. Use the official portal for account administration.</p>}<div className="settings-list static">{subscription.data.tiers.filter(tier => !tier.is_current && tier.is_enabled).map(tier => <div key={tier.tier_id}><span><strong>{tier.name}</strong><small>{tier.dollars_per_month_display}{tier.monthly_credits ? ` · ${tier.monthly_credits} credits` : ''}</small></span><Button disabled={busyTier !== null || !(subscription.data?.can_change_plan ?? state.can_change_plan ?? false)} onClick={() => void requestPlanChange(tier.tier_id)} size="sm">{busyTier === tier.tier_id ? 'Checking…' : 'Review'}</Button></div>)}</div></section> : null}{preview && <ConfirmDialog confirmLabel="Confirm plan change" description={planChangeDescription(preview.response)} onCancel={() => setPreview(null)} onConfirm={() => void applyPlanChange()} title="Confirm billing change" />}</SettingsPageShell>
}

function BillingOverview({ billing, onOpenPortal, portalURL, subscription }: { billing?: BillingStateResponse; onOpenPortal(): void; portalURL?: string | null; subscription?: SubscriptionStateResponse }) {
  if (!billing || billing.logged_in === false) return <div className="unsupported-card"><strong>Billing is not connected</strong><p>Sign in to the provider account or manage billing in the official portal.</p>{portalURL && <Button onClick={onOpenPortal}>Open billing portal</Button>}</div>
  const usage = billing.usage
  return <section className="data-card billing-overview"><div className="settings-list static"><div><span><strong>Balance</strong><small>{billing.balance_display || 'Not reported'}</small></span><Badge variant="muted">{billing.org_name || 'Account'}</Badge></div><div><span><strong>Plan</strong><small>{subscription?.current?.tier_name || usage?.plan_name || 'Free'}</small></span><Badge>{subscription?.context || 'personal'}</Badge></div>{subscription?.current?.cycle_ends_at && <div><span><strong>Renews</strong><small>{subscription.current.cycle_ends_at}</small></span></div>}{usage?.total_spendable_display && <div><span><strong>Spendable usage</strong><small>{usage.total_spendable_display}</small></span></div>}</div>{billing.error && <p className="muted">{billing.error}</p>}{portalURL && <Button onClick={onOpenPortal} variant="secondary"><IconExternalLink size={16} /> Manage billing in official portal</Button>}</section>
}

function planChangeDescription(preview: SubscriptionPreviewResponse): string {
  if (preview.effect === 'charge_now') return `Upgrade to ${preview.target_tier_name || 'the selected plan'} now${preview.amount_due_now_cents ? ` for ${(preview.amount_due_now_cents / 100).toFixed(2)} in your billing currency` : ''}.`
  if (preview.effect === 'scheduled') return `Schedule the change to ${preview.target_tier_name || 'the selected plan'} for ${preview.effective_at || 'the next billing cycle'}.`
  return preview.reason || 'Apply this plan change?'
}

function GatewaySettings({ controller, onBack }: { controller: GatewayController; onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const connection = useStore($connection)
  const status = useQuery({ queryFn: ({ signal }) => settingsApi.status(gateway, preferences.profile, signal), queryKey: gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: null }, 'settings', 'gateway') })
  const [subpage, setSubpage] = useState<keyof typeof ADMIN_RESOURCES | null>(null)
  const [remoteURL, setRemoteURL] = useState(preferences.remoteURL)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setRemoteURL(preferences.remoteURL)
    setToken('')
    setSubpage(null)
    setError(null)
    setBusy(false)
  }, [preferences.profile, preferences.remoteURL])
  if (subpage) return <RemoteResourceScreen definition={ADMIN_RESOURCES[subpage]} onBack={() => setSubpage(null)} />
  const adminLinks: Array<{ id: keyof typeof ADMIN_RESOURCES; label: string }> = [{ id: 'profiles', label: 'Profiles' }, { id: 'messaging', label: 'Messaging' }, { id: 'pairing', label: 'Pairing' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'agents', label: 'Agents' }, { id: 'learning', label: 'Learning' }, { id: 'system', label: 'System' }, { id: 'logs', label: 'Logs' }, { id: 'usage', label: 'Usage' }]
  const reconnect = async () => {
    const scope = currentGatewayScope()
    setBusy(true)
    setError(null)
    try { await controller.connect() } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) } finally { if (isCurrentGatewayScope(scope)) setBusy(false) }
  }
  const changeGateway = async (event: FormEvent) => {
    event.preventDefault()
    if (!remoteURL.trim()) return
    const scope = currentGatewayScope()
    setBusy(true)
    setError(null)
    try { await controller.configure(remoteURL.trim(), token || undefined); setToken('') } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) } finally { setToken(''); if (isCurrentGatewayScope(scope)) setBusy(false) }
  }
  return <SettingsPageShell title="Gateways" subtitle="Mobile connects to one remote gateway at a time. Local runtimes, SSH registries, and Electron controls are intentionally not shown."><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><div className="data-card"><header className="page-heading"><h3>Active gateway</h3><Badge>{connection.authMode}</Badge></header><p>{preferences.remoteURL}</p><p className="muted">Profile: {preferences.profile || 'default'} · Connection: {connection.phase}</p>{status.data && <p className="muted">Backend {String(status.data.version ?? 'unknown')} · {status.data.gateway_running ? 'Running' : 'Not running'}</p>}{status.error && <p className="muted">Health details unavailable: {classifyGatewayError(status.error).message}</p>}<Button disabled={busy} onClick={() => void reconnect()} variant="secondary"><IconRefresh size={16} /> Reconnect</Button></div>{error && <div className="error-banner" role="alert">{error}</div>}<form className="data-card panel-stack" onSubmit={changeGateway}><h3>Change gateway</h3><label className="config-field"><span>Remote URL</span><Input onChange={event => setRemoteURL(event.target.value)} type="url" value={remoteURL} /></label><label className="config-field"><span>Token (optional)</span><Input autoComplete="off" onChange={event => setToken(event.target.value)} type="password" value={token} /></label><Button disabled={busy || !remoteURL.trim()} type="submit">Connect to gateway</Button></form><section><h3>Gateway administration</h3><div className="settings-list capability-list">{adminLinks.map(link => <button key={link.id} onClick={() => setSubpage(link.id)}><span><strong>{link.label}</strong><small>Limited remote preview</small></span><IconChevronRight size={18} /></button>)}</div></section></SettingsPageShell>
}

function ProvidersSettings({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const queryClient = useQueryClient()
  const key = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: preferences.profile }, 'settings', 'providers')
  const providers = useQuery({ queryFn: ({ signal }) => settingsApi.oauthProviders(gateway, preferences.profile, signal), queryKey: [...key, 'oauth'] })
  const endpoints = useQuery({ queryFn: ({ signal }) => settingsApi.customEndpoints(gateway, preferences.profile, signal), queryKey: [...key, 'endpoints'] })
  const [oauth, setOAuth] = useState<{ provider: OAuthProvider; response: OAuthStartResponse } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<CustomEndpoint | null>(null)
  const [removeEndpoint, setRemoveEndpoint] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [oauthBusy, setOAuthBusy] = useState(false)
  const [oauthCode, setOAuthCode] = useState('')
  useEffect(() => {
    // OAuth sessions and endpoint drafts belong to one gateway/profile.
    setOAuth(null)
    setOAuthCode('')
    setEndpoint(null)
    setRemoveEndpoint(null)
    setShowForm(false)
    setOAuthBusy(false)
    setError(null)
  }, [preferences.profile, preferences.remoteURL])
  const startOAuth = async (provider: OAuthProvider) => {
    const scope = currentGatewayScope()
    setOAuthBusy(true)
    setError(null)
    try {
      const response = await settingsApi.oauthStart(gateway, preferences.profile, provider.id)
      if (!isCurrentGatewayScope(scope)) return
      setOAuth({ provider, response })
      const url = 'auth_url' in response ? response.auth_url : response.verification_url
      try { await platformActions.openExternal(url) } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) } finally { if (isCurrentGatewayScope(scope)) setOAuthBusy(false) }
  }
  const cancelOAuth = async () => {
    if (!oauth) {
      setOAuthCode('')
      return
    }
    const scope = currentGatewayScope()
    const sessionId = oauth.response.session_id
    // A device code is a credential-like one-shot value. Clear the controlled
    // input before and after the cancellation attempt, including when the
    // gateway rejects the request or the scope changes while it is in flight.
    setOAuthCode('')
    try { await settingsApi.oauthCancel(gateway, preferences.profile, sessionId); if (isCurrentGatewayScope(scope)) setOAuth(null) } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) } finally { setOAuthCode('') }
  }
  const activateEndpoint = async (id: string) => {
    const scope = currentGatewayScope()
    try {
      await settingsApi.activateCustomEndpoint(gateway, preferences.profile, id)
      if (!isCurrentGatewayScope(scope)) return
      await queryClient.invalidateQueries({ queryKey: [...key, 'endpoints'] })
      if (isCurrentGatewayScope(scope)) setError(null)
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  const remove = async () => {
    if (!removeEndpoint) return
    const scope = currentGatewayScope()
    try {
      await settingsApi.deleteCustomEndpoint(gateway, preferences.profile, removeEndpoint)
      if (!isCurrentGatewayScope(scope)) return
      setRemoveEndpoint(null)
      await endpoints.refetch()
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  const finishOAuth = () => {
    setOAuth(null)
    setOAuthCode('')
    void providers.refetch()
  }
  return <SettingsPageShell title="Providers" subtitle="Provider accounts and custom endpoints are stored by the selected gateway profile. Secrets stay in component-local drafts."><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>{error && <div className="error-banner" role="alert">{error}</div>}<section className="settings-section"><h3>OAuth accounts</h3>{providers.isPending && <Skeleton className="h-16 w-full" />}{providers.error && <div className="unsupported-card">OAuth providers are unavailable: {classifyGatewayError(providers.error).message}</div>}<div className="settings-list static">{providers.data?.providers.map(provider => <div key={provider.id}><span><strong>{provider.name}</strong><small>{provider.status.logged_in ? provider.status.token_preview || 'Connected' : provider.flow === 'device_code' ? 'Device code' : 'Not connected'}</small></span>{provider.status.logged_in ? <Badge>Connected</Badge> : <Button disabled={oauthBusy} onClick={() => void startOAuth(provider)} size="sm">Connect</Button>}</div>)}</div></section>{oauth && <ProviderOAuthFlow code={oauthCode} onCancel={() => void cancelOAuth()} onCode={setOAuthCode} onDone={finishOAuth} provider={oauth.provider} response={oauth.response} setError={setError} />}<section className="settings-section"><header className="page-heading"><h3>Custom endpoints</h3><Button onClick={() => { setEndpoint(null); setShowForm(true) }} size="sm">Add</Button></header>{endpoints.error && <div className="error-banner" role="alert">{classifyGatewayError(endpoints.error).message}</div>}<div className="settings-list static">{endpoints.data?.endpoints.map(item => <div key={item.id}><span><strong>{item.name}</strong><small>{item.base_url} · {item.model} {item.is_current ? '· Active' : ''}</small></span><div className="button-row">{!item.is_current && <Button onClick={() => void activateEndpoint(item.id)} size="sm">Use</Button>}<Button onClick={() => { setEndpoint(item); setShowForm(true) }} size="sm" variant="secondary">Edit</Button><Button onClick={() => setRemoveEndpoint(item.id)} size="sm" variant="destructive">Delete</Button></div></div>)}{endpoints.data?.endpoints.length === 0 && <p className="muted">No custom endpoints.</p>}</div></section>{showForm && <CustomEndpointForm endpoint={endpoint} onCancel={() => setShowForm(false)} onSaved={() => { setShowForm(false); void endpoints.refetch() }} setError={setError} />}{removeEndpoint && <ConfirmDialog confirmLabel="Delete endpoint" description="Remove this custom endpoint and detach it from the profile if it is active?" onCancel={() => setRemoveEndpoint(null)} onConfirm={() => void remove()} title="Delete custom endpoint" />}</SettingsPageShell>
}

function ProviderOAuthFlow({ code, onCancel, onCode, onDone, provider, response, setError }: { code: string; onCancel(): void; onCode(value: string): void; onDone(): void; provider: OAuthProvider; response: OAuthStartResponse; setError(value: string | null): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const [status, setStatus] = useState<OAuthPollResponse['status']>('pending')
  const [submitting, setSubmitting] = useState(false)
  const pollAbort = useRef<AbortController | null>(null)
  const onDoneRef = useRef(onDone)
  const setErrorRef = useRef(setError)
  const codeRef = useRef(code)
  const mountedRef = useRef(true)
  onDoneRef.current = onDone
  codeRef.current = code
  setErrorRef.current = setError

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const scope = currentGatewayScope()
    const pollController = new AbortController()
    pollAbort.current = pollController
    setStatus('pending')
    setSubmitting(false)
    void runRemoteAction<OAuthPollResponse>({
      gateway,
      getScopeEpoch: () => currentGatewayScope().generation,
      intervalMs: 1_000,
      maxAttempts: 60,
      maxIntervalMs: 5_000,
      poll: async (_transport, signal) => {
        const next = await settingsApi.oauthPoll(gateway, preferences.profile, provider.id, response.session_id, signal)
        if (isCurrentGatewayScope(scope)) setStatus(next.status)
        return { result: next, status: next.status }
      },
      signal: pollController.signal,
      start: async () => ({ status: 'pending' }),
      isComplete: state => ['approved', 'denied', 'error', 'expired'].includes(state.status)
    }).then(state => {
      if (pollController.signal.aborted || !mountedRef.current || !isCurrentGatewayScope(scope)) return
      if (state.result?.status === 'approved') onDoneRef.current()
      else if (state.result && state.result.status !== 'pending') setErrorRef.current(state.result.error_message || `Provider authorization ${state.result.status}.`)
    }).catch(caught => {
      if (!pollController.signal.aborted && mountedRef.current && isCurrentGatewayScope(scope)) setErrorRef.current(classifyGatewayError(caught).message)
    })
    return () => {
      pollController.abort()
      if (pollAbort.current === pollController) pollAbort.current = null
    }
  }, [gateway, preferences.profile, preferences.remoteURL, provider.id, response.session_id])

  const submit = async () => {
    const submittedCode = code.trim()
    if (!submittedCode || !('flow' in response && response.flow === 'device_code')) return
    const scope = currentGatewayScope()
    setSubmitting(true)
    try {
      const result = await settingsApi.oauthSubmit(gateway, preferences.profile, provider.id, response.session_id, submittedCode)
      if (!mountedRef.current || !isCurrentGatewayScope(scope)) return
      setStatus(result.status)
      if (result.ok && result.status === 'approved') onDoneRef.current()
      else if (!result.ok) setErrorRef.current(result.message || 'The provider rejected the code.')
    } catch (caught) { if (mountedRef.current && isCurrentGatewayScope(scope)) setErrorRef.current(classifyGatewayError(caught).message) } finally {
      if (mountedRef.current && codeRef.current === submittedCode) onCode('')
      if (isCurrentGatewayScope(scope)) setSubmitting(false)
    }
  }
  const openProvider = async () => {
    const scope = currentGatewayScope()
    try { await platformActions.openExternal('auth_url' in response ? response.auth_url : response.verification_url) } catch (caught) { if (isCurrentGatewayScope(scope)) setErrorRef.current(classifyGatewayError(caught).message) }
  }
  return <section className="data-card"><h3>Connect {provider.name}</h3>{'user_code' in response && <p>Enter code <strong>{response.user_code}</strong> at the verification page.</p>}<Button onClick={() => void openProvider()} variant="secondary"><IconExternalLink size={16} /> Open provider</Button>{'user_code' in response && <div className="button-row"><Input autoComplete="off" onChange={event => onCode(event.target.value)} placeholder="Code" value={code} /><Button disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit'}</Button></div>}<p className="muted">Status: {status}. Polling stops after a bounded number of attempts.</p><Button onClick={() => { pollAbort.current?.abort(); onCancel() }} variant="destructive">Cancel</Button></section>
}

function CustomEndpointForm({ endpoint, onCancel, onSaved, setError }: { endpoint: CustomEndpoint | null; onCancel(): void; onSaved(): void; setError(value: string | null): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const [name, setName] = useState(endpoint?.name ?? '')
  const [baseURL, setBaseURL] = useState(endpoint?.base_url ?? '')
  const [model, setModel] = useState(endpoint?.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<string | null>(null)
  useEffect(() => {
    setName(endpoint?.name ?? '')
    setBaseURL(endpoint?.base_url ?? '')
    setModel(endpoint?.model ?? '')
    setApiKey('')
    setValidation(null)
    setSaving(false)
    setValidating(false)
  }, [endpoint?.id, preferences.profile, preferences.remoteURL])
  const validate = async () => {
    const scope = currentGatewayScope()
    setValidation(null)
    setValidating(true)
    try {
      const result = await settingsApi.validateCustomEndpoint(gateway, preferences.profile, { api_key: apiKey || undefined, base_url: baseURL.trim(), model: model.trim(), name: name.trim() })
      if (!isCurrentGatewayScope(scope)) return
      setValidation(result.ok ? `Reachable${result.models.length ? ` · ${result.models.length} models found` : ''}.` : result.message)
    } catch (caught) { if (isCurrentGatewayScope(scope)) setValidation(classifyGatewayError(caught).message) }
    finally {
      setApiKey('')
      if (isCurrentGatewayScope(scope)) setValidating(false)
    }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const scope = currentGatewayScope()
    setSaving(true)
    setError(null)
    try {
      await settingsApi.saveCustomEndpoint(gateway, preferences.profile, { api_key: apiKey || undefined, base_url: baseURL.trim(), id: endpoint?.id, model: model.trim(), name: name.trim() })
      if (!isCurrentGatewayScope(scope)) return
      setApiKey('')
      onSaved()
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) } finally { setApiKey(''); if (isCurrentGatewayScope(scope)) setSaving(false) }
  }
  return <form className="data-card panel-stack" onSubmit={save}><h3>{endpoint ? 'Edit endpoint' : 'Add endpoint'}</h3><label className="config-field"><span>Name</span><Input onChange={event => setName(event.target.value)} value={name} /></label><label className="config-field"><span>Base URL</span><Input onChange={event => setBaseURL(event.target.value)} type="url" value={baseURL} /></label><label className="config-field"><span>Model</span><Input onChange={event => setModel(event.target.value)} value={model} /></label><label className="config-field"><span>API key (optional)</span><Input autoComplete="off" onChange={event => setApiKey(event.target.value)} type="password" value={apiKey} /></label>{validation && <p className="muted" role="status">{validation}</p>}<div className="button-row"><Button disabled={saving || validating || !baseURL.trim()} onClick={() => void validate()} type="button" variant="secondary">Validate endpoint</Button><Button disabled={saving || validating || !name.trim() || !baseURL.trim() || !model.trim()} type="submit">Save endpoint</Button><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button></div></form>
}

function ToolsKeysSettings({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const connection = useStore($connection)
  const queryClient = useQueryClient()
  const key = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: preferences.profile }, 'settings', 'env')
  const variables = useQuery({ queryFn: ({ signal }) => settingsApi.env(gateway, preferences.profile, signal), queryKey: key })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [remove, setRemove] = useState<{ name: string; variable: EnvVarInfo } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const revealTimers = useRef(new Map<string, number>())
  const draftRevisions = useRef(new Map<string, number>())
  useEffect(() => {
    setDrafts({})
    draftRevisions.current.clear()
    setRevealed({})
    setRemove(null)
    setError(null)
    return () => {
      revealTimers.current.forEach(timer => window.clearTimeout(timer))
      revealTimers.current.clear()
    }
  }, [connection.phase, preferences.profile, preferences.remoteURL])
  const updateDraft = (name: string, value: string) => {
    draftRevisions.current.set(name, (draftRevisions.current.get(name) ?? 0) + 1)
    setDrafts(current => ({ ...current, [name]: value }))
  }
  const clearDraft = (name: string, revision: number, scope: ReturnType<typeof currentGatewayScope>) => {
    if (draftRevisions.current.get(name) !== revision || !isCurrentGatewayScope(scope)) return
    draftRevisions.current.delete(name)
    setDrafts(current => {
      if (!(name in current)) return current
      const next = { ...current }
      delete next[name]
      return next
    })
  }
  const save = async (name: string) => {
    const value = drafts[name] ?? ''
    if (!value) return
    const scope = currentGatewayScope()
    const revision = draftRevisions.current.get(name) ?? 0
    try {
      await settingsApi.setEnv(gateway, preferences.profile, name, value)
      if (!isCurrentGatewayScope(scope)) return
      void queryClient.invalidateQueries({ queryKey: key })
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
    finally { clearDraft(name, revision, scope) }
  }
  const reveal = async (name: string) => {
    const scope = currentGatewayScope()
    try {
      const response = await settingsApi.revealEnv(gateway, preferences.profile, name)
      if (!isCurrentGatewayScope(scope)) return
      const previous = revealTimers.current.get(name)
      if (previous !== undefined) window.clearTimeout(previous)
      setRevealed(current => ({ ...current, [name]: response.value }))
      const timer = window.setTimeout(() => {
        revealTimers.current.delete(name)
        if (!isCurrentGatewayScope(scope)) return
        setRevealed(current => { const next = { ...current }; delete next[name]; return next })
      }, 30_000)
      revealTimers.current.set(name, timer)
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  const validate = async (name: string) => {
    const value = drafts[name] ?? ''
    if (!value) return
    const scope = currentGatewayScope()
    const revision = draftRevisions.current.get(name) ?? 0
    try {
      const result = await settingsApi.validateProvider(gateway, preferences.profile, name, value)
      if (isCurrentGatewayScope(scope)) setError(result.ok ? `${name} was accepted by the provider.` : result.message || `${name} could not be validated.`)
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
    finally { clearDraft(name, revision, scope) }
  }
  const removeVariable = async () => {
    if (!remove) return
    const scope = currentGatewayScope()
    try {
      await settingsApi.deleteEnv(gateway, preferences.profile, remove.name)
      if (!isCurrentGatewayScope(scope)) return
      setRemove(null)
      void queryClient.invalidateQueries({ queryKey: key })
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  const rows = Object.entries(variables.data ?? {}).filter(([, value]) => !value.channel_managed)
  return <SettingsPageShell title="Tools & Keys" subtitle="Only redacted status is fetched. Secret drafts never enter stores, persistence, or logs."><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>{error && <div className="error-banner" role="alert">{error}</div>}{variables.isPending && <Skeleton className="h-20 w-full" />}{variables.error && <div className="unsupported-card">Credential management is unavailable: {classifyGatewayError(variables.error).message}</div>}<div className="settings-list static">{rows.map(([keyName, variable]) => <CredentialRow key={keyName} name={keyName} onDelete={() => setRemove({ name: keyName, variable })} onDraft={value => updateDraft(keyName, value)} onReveal={() => void reveal(keyName)} onSave={() => void save(keyName)} onValidate={variable.category === 'provider' ? () => void validate(keyName) : undefined} revealed={revealed[keyName]} value={drafts[keyName] ?? ''} variable={variable} />)}</div>{rows.length === 0 && variables.data && <div className="empty-panel">No non-channel credentials are exposed by this gateway.</div>}{remove && <ConfirmDialog confirmLabel="Delete" description={`Delete the ${remove.name} credential from this profile?`} onCancel={() => setRemove(null)} onConfirm={() => void removeVariable()} title="Delete credential" />}</SettingsPageShell>
}

function CredentialRow({ name, onDelete, onDraft, onReveal, onSave, onValidate, revealed, value, variable }: { name: string; onDelete(): void; onDraft(value: string): void; onReveal(): void; onSave(): void; onValidate?: () => void; revealed?: string; value: string; variable: EnvVarInfo }) {
  return <div className="credential-row"><span><strong>{name}</strong><small>{revealed ?? variable.redacted_value ?? (variable.is_set ? 'Configured' : 'Not set')}</small></span><Input aria-label={`${name} secret`} autoComplete="off" onChange={event => onDraft(event.target.value)} placeholder={variable.is_set ? 'Replace value' : 'Enter value'} type="password" value={value} /><div className="button-row"><Button disabled={!value} onClick={onSave} size="sm">Save</Button>{onValidate && <Button disabled={!value} onClick={onValidate} size="sm" variant="secondary">Validate</Button>}{variable.is_set && <Button onClick={onReveal} size="sm" variant="secondary">Reveal</Button>}{variable.is_set && <Button onClick={onDelete} size="sm" variant="destructive"><IconTrash size={14} /></Button>}</div></div>
}


function ArchivedChatsSettings({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const queryClient = useQueryClient()
  const key = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: preferences.profile }, 'settings', 'archived-chats')
  const sessions = useQuery({ queryFn: ({ signal }) => settingsApi.sessions(gateway, preferences.profile, signal), queryKey: key })
  const [remove, setRemove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setRemove(null); setError(null) }, [preferences.profile, preferences.remoteURL])
  const restore = async (id: string) => {
    const scope = currentGatewayScope()
    try {
      await settingsApi.restoreSession(gateway, preferences.profile, id)
      if (isCurrentGatewayScope(scope)) void queryClient.invalidateQueries({ queryKey: key })
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  const destroy = async () => {
    if (!remove) return
    const scope = currentGatewayScope()
    try {
      await settingsApi.deleteSession(gateway, preferences.profile, remove)
      if (!isCurrentGatewayScope(scope)) return
      setRemove(null)
      void queryClient.invalidateQueries({ queryKey: key })
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  return <SettingsPageShell title="Archived Chats" subtitle="Only archived sessions from the selected profile are listed."><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>{error && <div className="error-banner" role="alert">{error}</div>}{sessions.error && <div className="error-banner" role="alert">{classifyGatewayError(sessions.error).message}</div>}{sessions.isPending && <Skeleton className="h-20 w-full" />}<div className="settings-list static">{sessions.data?.sessions.map(session => <div key={session.id}><span><strong>{session.title || 'Untitled chat'}</strong><small>{session.preview || 'No preview'} · {session.message_count ?? 0} messages</small></span><div className="button-row"><Button onClick={() => void restore(session.id)} size="sm">Restore</Button><Button onClick={() => setRemove(session.id)} size="sm" variant="destructive"><IconTrash size={14} /></Button></div></div>)}</div>{sessions.data?.sessions.length === 0 && <div className="empty-panel">No archived chats.</div>}{remove && <ConfirmDialog confirmLabel="Delete permanently" description="Permanently delete this archived chat? This cannot be undone." onCancel={() => setRemove(null)} onConfirm={() => void destroy()} title="Delete archived chat" />}</SettingsPageShell>
}

function PluginsSettings({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const queryClient = useQueryClient()
  const key = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: null }, 'settings', 'plugins')
  const supportsPluginManagement = profileKey(preferences.profile) === 'default'
  const plugins = useQuery({ enabled: supportsPluginManagement, queryFn: ({ signal }) => settingsApi.pluginsHub(gateway, preferences.profile, signal), queryKey: key })
  const [remove, setRemove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setRemove(null); setError(null) }, [preferences.profile, preferences.remoteURL])
  const toggle = async (name: string, action: 'disable' | 'enable') => {
    const scope = currentGatewayScope()
    try {
      await settingsApi.pluginAction(gateway, preferences.profile, name, action)
      if (isCurrentGatewayScope(scope)) void queryClient.invalidateQueries({ queryKey: key })
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  const destroy = async () => {
    if (!remove) return
    const scope = currentGatewayScope()
    try {
      await settingsApi.removePlugin(gateway, preferences.profile, remove)
      if (!isCurrentGatewayScope(scope)) return
      setRemove(null)
      void queryClient.invalidateQueries({ queryKey: key })
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message) }
  }
  return <SettingsPageShell title="Plugins" subtitle="Only official plugin inventory and supported enable, disable, and removal actions are exposed on mobile."><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>{!supportsPluginManagement && <div className="unsupported-card" role="alert"><strong>Plugin management is unavailable for this profile.</strong><p>Plugin discovery and mutations are process-scoped on this gateway. Switch to the default profile or connect to a gateway dedicated to this profile.</p></div>}{supportsPluginManagement && error && <div className="error-banner" role="alert">{error}</div>}{supportsPluginManagement && plugins.error && <div className="unsupported-card">Plugin management is unavailable: {classifyGatewayError(plugins.error).message}</div>}{supportsPluginManagement && plugins.isPending && <Skeleton className="h-20 w-full" />}<div className="settings-list static">{supportsPluginManagement && plugins.data?.plugins.map(plugin => { const enabled = plugin.runtime_status === 'enabled'; return <div key={plugin.name}><span><strong>{plugin.name}</strong><small>{plugin.description || 'No description'} · {plugin.source || 'unknown'} {plugin.version || ''}</small></span><div className="button-row"><Button onClick={() => void toggle(plugin.name, enabled ? 'disable' : 'enable')} size="sm">{enabled ? 'Disable' : 'Enable'}</Button>{plugin.can_remove && <Button onClick={() => setRemove(plugin.name)} size="sm" variant="destructive"><IconTrash size={14} /></Button>}</div></div>})}</div>{supportsPluginManagement && plugins.data?.plugins.length === 0 && <div className="empty-panel">No plugins are available.</div>}{remove && supportsPluginManagement && <ConfirmDialog confirmLabel="Remove" description={`Remove plugin ${remove}? This only removes user-installed plugins.`} onCancel={() => setRemove(null)} onConfirm={() => void destroy()} title="Remove plugin" />}</SettingsPageShell>
}
