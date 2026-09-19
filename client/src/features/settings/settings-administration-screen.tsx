import { useQueryClient } from '@tanstack/react-query'
import type { BillingStateResponse, SubscriptionPreviewResponse, SubscriptionStateResponse } from '~/compat/hermes-shared/billing'
import { IconChevronLeft, IconChevronRight, IconExternalLink, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { Badge, Button, Input, Skeleton, Switch, Textarea } from '~/compat/primitives'
import { PageList, PageListButton } from '~/components/page-list'
import { PageHeading } from '~/components/page-shell'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { FilesScreen } from '~/components/files-screen'
import { RemoteResourceScreen, type RemoteResourceDefinition } from '~/features/shared/remote-resource'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { beginScopedTask, useScopeKey, useScopedQuery, useScopeReset, useScopedTask, type ScopedTask } from '~/gateway/scope-guard'
import { useOAuthFlow } from '~/gateway/oauth-flow'
import { useApi, useGatewayApi } from '~/gateway/gateway-api-hooks'
import { profileKey } from '~/gateway/profile-path'
import { isNativeIOS } from '~/native/hermes-connection'
import { PlatformActions } from '~/native/platform-actions'
import type { SettingsAdministrationPage } from '~/navigation/routes'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'
import { useStore } from '@nanostores/react'
import type { CustomEndpoint, EnvVarInfo, OAuthProvider } from '~/lib/types'
import { createProviderOAuthAdapter } from './oauth-sources'
import { createSettingsApi } from './settings-api'
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
  if (page === 'projects') return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title="Projects and files"><FilesScreen embedded /></SettingsPageShell>
  const definition = ADMIN_RESOURCES[page as keyof typeof ADMIN_RESOURCES]
  if (definition) return <RemoteResourceScreen definition={definition} onBack={onBack} />
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title={page}><div className="unsupported-card">This administration page is not implemented on this gateway.</div></SettingsPageShell>
}

function BillingSettings({ onBack }: { onBack(): void }) {
  const api = useGatewayApi()
  const settings = useApi(createSettingsApi)
  const queryClient = useQueryClient()
  // Billing belongs to the gateway/account, not the selected Hermes profile.
  // Keep one cache entry and use the process-scoped RPC contract rather than
  // suggesting that an account balance is profile-local.
  const billingKey = useScopeKey('settings', ['billing'], { unscoped: true })
  const billingStateKey = useScopeKey('settings', ['billing', 'state'], { unscoped: true })
  const subscriptionKey = useScopeKey('settings', ['billing', 'subscription'], { unscoped: true })
  const action = useScopedTask()
  const billing = useScopedQuery(billingStateKey, { queryFn: signal => settings.billingState(signal) })
  const subscription = useScopedQuery(subscriptionKey, { queryFn: signal => settings.subscriptionState(signal) })
  const [preview, setPreview] = useState<{ response: SubscriptionPreviewResponse; tierId: string } | null>(null)
  const [busyTier, setBusyTier] = useState<string | null>(null)
  const idempotencyKeys = useRef(new Map<string, string>())
  const [error, setError] = useState<string | null>(null)
  useScopeReset(() => { setPreview(null); setBusyTier(null); setError(null); idempotencyKeys.current.clear() })
  const state = billing.data
  const portalURL = state?.portal_url || subscription.data?.portal_url
  const refresh = () => { void billing.refetch(); void subscription.refetch() }
  const openPortal = async () => {
    if (!portalURL) return
    await action.run(() => platformActions.openExternal(portalURL), { onError: error => setError(error.message) })
  }
  const requestPlanChange = async (tierId: string) => {
    await action.run(async task => {
      setError(null)
      const result = await api.rpc<SubscriptionPreviewResponse>('subscription.preview', { subscription_type_id: tierId }, { timeoutMs: 60_000 })
      if (!task.isCurrent()) return
      if (!result.ok) setError(result.message || result.error || 'The gateway could not preview this plan change.')
      else setPreview({ response: result, tierId })
    }, { onBusy: busy => setBusyTier(busy ? tierId : null), onError: error => setError(error.message) })
  }
  const applyPlanChange = async () => {
    if (!preview) return
    const pending = preview
    await action.run(async task => {
      const rpcAction = pending.response.effect === 'charge_now' ? 'subscription.upgrade' : 'subscription.change'
      const params: Record<string, unknown> = { subscription_type_id: pending.tierId }
      if (rpcAction === 'subscription.upgrade') {
        const key = idempotencyKeys.current.get(pending.tierId) || crypto.randomUUID()
        idempotencyKeys.current.set(pending.tierId, key)
        params.idempotency_key = key
      }
      const result = await api.rpc<{ error?: string; message?: string; ok: boolean; recovery_url?: string }>(rpcAction, params, { timeoutMs: 120_000 })
      if (!task.isCurrent()) return
      if (!result.ok) { setError(result.message || result.error || 'The gateway rejected this plan change.'); return }
      idempotencyKeys.current.delete(pending.tierId)
      setPreview(null)
      void queryClient.invalidateQueries({ queryKey: billingKey })
      const recoveryURL = result.recovery_url
      if (recoveryURL) {
        await action.run(() => platformActions.openExternal(recoveryURL), { onError: error => setError(error.message) })
      }
    }, { onBusy: busy => setBusyTier(busy ? pending.tierId : null), onError: error => setError(error.message) })
  }
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="Billing state and plan changes belong to this gateway account. Hermes Mobile never infers entitlements across profiles." title="Billing"><PageHeading actions={<Button aria-label="Refresh billing" onClick={refresh} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>} level={3} title="Account" />{billing.isPending || subscription.isPending ? <Skeleton className="h-20 w-full" /> : <BillingOverview billing={state} subscription={subscription.data} onOpenPortal={() => void openPortal()} portalURL={portalURL} />}{(billing.error || subscription.error) && <GatewayErrorBanner error={billing.error ?? subscription.error} unavailablePhrase="Billing is unavailable" />}{error && <div className="error-banner" role="alert">{error}</div>}{state?.logged_in && subscription.data?.tiers?.length ? <section className="settings-section"><h3>Plans</h3>{!(subscription.data.can_change_plan ?? state.can_change_plan ?? false) && <p className="muted">Plan changes require billing permissions. Use the official portal for account administration.</p>}<div className="settings-list static">{subscription.data.tiers.filter(tier => !tier.is_current && tier.is_enabled).map(tier => <div key={tier.tier_id}><span><strong>{tier.name}</strong><small>{tier.dollars_per_month_display}{tier.monthly_credits ? ` · ${tier.monthly_credits} credits` : ''}</small></span><Button disabled={busyTier !== null || !(subscription.data?.can_change_plan ?? state.can_change_plan ?? false)} onClick={() => void requestPlanChange(tier.tier_id)} size="sm">{busyTier === tier.tier_id ? 'Checking…' : 'Review'}</Button></div>)}</div></section> : null}{preview && <ConfirmDialog confirmLabel="Confirm plan change" description={planChangeDescription(preview.response)} onCancel={() => setPreview(null)} onConfirm={() => void applyPlanChange()} title="Confirm billing change" />}</SettingsPageShell>
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
  const settings = useApi(createSettingsApi)
  const preferences = useStore($preferences)
  const connection = useStore($connection)
  const native = isNativeIOS()
  const status = useScopedQuery(useScopeKey('settings', ['gateway'], { unscoped: true }), { queryFn: signal => settings.status(signal) })
  const [subpage, setSubpage] = useState<keyof typeof ADMIN_RESOURCES | null>(null)
  const [remoteURL, setRemoteURL] = useState(preferences.remoteURL)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useScopeReset(() => {
    setRemoteURL(preferences.remoteURL)
    setToken('')
    setSubpage(null)
    setError(null)
    setBusy(false)
  })
  if (subpage) return <RemoteResourceScreen definition={ADMIN_RESOURCES[subpage]} onBack={() => setSubpage(null)} />
  const adminLinks: Array<{ id: keyof typeof ADMIN_RESOURCES; label: string }> = [{ id: 'profiles', label: 'Profiles' }, { id: 'messaging', label: 'Messaging' }, { id: 'pairing', label: 'Pairing' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'agents', label: 'Agents' }, { id: 'learning', label: 'Learning' }, { id: 'system', label: 'System' }, { id: 'logs', label: 'Logs' }, { id: 'usage', label: 'Usage' }]
  const action = useScopedTask()
  const reconnect = async () => {
    await action.run(async () => {
      setError(null)
      await controller.connect()
    }, { onBusy: setBusy, onError: error => setError(error.message) })
  }
  const changeGateway = async (event: FormEvent) => {
    event.preventDefault()
    if (!remoteURL.trim()) return
    await action.run(async () => {
      setError(null)
      await controller.configure(remoteURL.trim(), token || undefined)
    }, { onBusy: setBusy, onError: error => setError(error.message) })
    // The token field is request input, never a retained secret: clear it
    // unconditionally, exactly as the previous unguarded finally did.
    setToken('')
  }
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="Mobile connects to one remote gateway at a time. Local runtimes, SSH registries, and Electron controls are intentionally not shown." title="Gateways"><div className="data-card"><PageHeading actions={<Badge>{connection.authMode}</Badge>} level={3} title="Active gateway" /><p>{preferences.remoteURL}</p><p className="muted">Profile: {preferences.profile || 'default'} · Connection: {connection.phase}</p>{status.data && <p className="muted">Backend {String(status.data.version ?? 'unknown')} · {status.data.gateway_running ? 'Running' : 'Not running'}</p>}{status.error && <p className="muted">Health details unavailable: {classifyGatewayError(status.error).message}</p>}<Button disabled={busy} onClick={() => void reconnect()} variant="secondary"><IconRefresh size={16} /> Reconnect</Button></div>{error && <div className="error-banner" role="alert">{error}</div>}{native ? <form className="data-card panel-stack" onSubmit={changeGateway}><h3>Change gateway</h3><p className="muted">Use the Hermes URL reachable by this iOS app.</p><label className="config-field"><span>Remote URL</span><Input onChange={event => setRemoteURL(event.target.value)} type="url" value={remoteURL} /></label><label className="config-field"><span>Token (optional)</span><Input autoComplete="off" onChange={event => setToken(event.target.value)} type="password" value={token} /></label><Button disabled={busy || !remoteURL.trim()} type="submit">Connect to gateway</Button></form> : <div className="data-card"><h3>Docker gateway proxy</h3><p className="muted">The browser stays on this PWA origin. Set HERMES_GATEWAY or HERMES_URL in the Docker .env, then recreate the mobile container to change the upstream.</p></div>}<section><h3>Gateway administration</h3><PageList className="capability-list">{adminLinks.map(link => <PageListButton key={link.id} onClick={() => setSubpage(link.id)} title={link.label} description="Limited remote preview" trailing={<IconChevronRight size={18} />} />)}</PageList></section></SettingsPageShell>
}

function ProvidersSettings({ onBack }: { onBack(): void }) {
  const settings = useApi(createSettingsApi)
  const queryClient = useQueryClient()
  const key = useScopeKey('settings', ['providers'])
  const oauthKey = useScopeKey('settings', ['providers', 'oauth'])
  const endpointsKey = useScopeKey('settings', ['providers', 'endpoints'])
  const providers = useScopedQuery(oauthKey, { queryFn: signal => settings.oauthProviders(signal) })
  const endpoints = useScopedQuery(endpointsKey, { queryFn: signal => settings.customEndpoints(signal) })
  const [oauthProvider, setOAuthProvider] = useState<OAuthProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<CustomEndpoint | null>(null)
  const [removeEndpoint, setRemoveEndpoint] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [oauthCode, setOAuthCode] = useState('')
  const action = useScopedTask()
  useScopeReset(() => {
    // OAuth sessions and endpoint drafts belong to one gateway/profile.
    setOAuthProvider(null)
    setOAuthCode('')
    setEndpoint(null)
    setRemoveEndpoint(null)
    setShowForm(false)
    setError(null)
  })
  const startOAuth = (provider: OAuthProvider) => {
    setError(null)
    setOAuthCode('')
    setOAuthProvider(provider)
  }
  const activateEndpoint = async (id: string) => {
    await action.run(async task => {
      await settings.activateCustomEndpoint(id)
      if (!task.isCurrent()) return
      await queryClient.invalidateQueries({ queryKey: endpointsKey })
      if (task.isCurrent()) setError(null)
    }, { onError: error => setError(error.message) })
  }
  const remove = async () => {
    if (!removeEndpoint) return
    await action.run(async task => {
      await settings.deleteCustomEndpoint(removeEndpoint)
      if (!task.isCurrent()) return
      setRemoveEndpoint(null)
      await endpoints.refetch()
    }, { onError: error => setError(error.message) })
  }
  const finishOAuth = () => {
    setOAuthProvider(null)
    setOAuthCode('')
    setError(null)
    void providers.refetch()
  }
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="Provider accounts and custom endpoints are stored by the selected gateway profile. Secrets stay in component-local drafts." title="Providers">{error && <div className="error-banner" role="alert">{error}</div>}<section className="settings-section"><h3>OAuth accounts</h3>{providers.isPending && <Skeleton className="h-16 w-full" />}{providers.error && <GatewayErrorBanner error={providers.error} unavailablePhrase="OAuth providers are unavailable" />}<div className="settings-list static">{providers.data?.providers.map(provider => <div key={provider.id}><span><strong>{provider.name}</strong><small>{provider.status.logged_in ? provider.status.token_preview || 'Connected' : provider.flow === 'device_code' ? 'Device code' : 'Not connected'}</small></span>{provider.status.logged_in ? <Badge>Connected</Badge> : <Button disabled={oauthProvider !== null} onClick={() => startOAuth(provider)} size="sm">Connect</Button>}</div>)}</div></section>{oauthProvider && <ProviderOAuthFlow code={oauthCode} key={oauthProvider.id} onCancel={() => { setOAuthProvider(null); setOAuthCode('') }} onCode={setOAuthCode} onDone={finishOAuth} provider={oauthProvider} setError={setError} />}<section className="settings-section"><PageHeading actions={<Button onClick={() => { setEndpoint(null); setShowForm(true) }} size="sm">Add</Button>} level={3} title="Custom endpoints" />{endpoints.error && <GatewayErrorBanner error={endpoints.error} />}<div className="settings-list static">{endpoints.data?.endpoints.map(item => <div key={item.id}><span><strong>{item.name}</strong><small>{item.base_url} · {item.model} {item.is_current ? '· Active' : ''}</small></span><div className="button-row">{!item.is_current && <Button onClick={() => void activateEndpoint(item.id)} size="sm">Use</Button>}<Button onClick={() => { setEndpoint(item); setShowForm(true) }} size="sm" variant="secondary">Edit</Button><Button onClick={() => setRemoveEndpoint(item.id)} size="sm" variant="destructive">Delete</Button></div></div>)}{endpoints.data?.endpoints.length === 0 && <p className="muted">No custom endpoints.</p>}</div></section>{showForm && <CustomEndpointForm endpoint={endpoint} onCancel={() => setShowForm(false)} onSaved={() => { setShowForm(false); void endpoints.refetch() }} setError={setError} />}{removeEndpoint && <ConfirmDialog confirmLabel="Delete endpoint" description="Remove this custom endpoint and detach it from the profile if it is active?" onCancel={() => setRemoveEndpoint(null)} onConfirm={() => void remove()} title="Delete custom endpoint" />}</SettingsPageShell>
}

function ProviderOAuthFlow({ code, onCancel, onCode, onDone, provider, setError }: { code: string; onCancel(): void; onCode(value: string): void; onDone(): void; provider: OAuthProvider; setError(value: string | null): void }) {
  const api = useGatewayApi()
  const settings = useApi(createSettingsApi)
  const source = useMemo(() => createProviderOAuthAdapter(settings, api.gateway, provider.id), [api.gateway, provider.id, settings])
  const openExternal = useCallback((url: string) => platformActions.openExternal(url), [])
  const { busy, error: oauthError, openAuthorization, snapshot, start, stop } = useOAuthFlow({ openExternal })
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelFlowId, setCancelFlowId] = useState<string | null>(null)
  const action = useScopedTask()
  const onDoneRef = useRef(onDone)
  const setErrorRef = useRef(setError)
  const codeRef = useRef(code)
  const mountedRef = useRef(true)
  const completedRef = useRef(false)
  const cancelledRef = useRef(false)
  onDoneRef.current = onDone
  codeRef.current = code
  setErrorRef.current = setError

  useEffect(() => {
    mountedRef.current = true
    cancelledRef.current = false
    completedRef.current = false
    setCancelling(false)
    setCancelFlowId(null)
    start(source)
    return () => {
      mountedRef.current = false
      stop()
    }
  }, [source, start, stop])

  useEffect(() => {
    if (snapshot?.phase !== 'approved' || completedRef.current || cancelledRef.current || !mountedRef.current) return
    completedRef.current = true
    stop()
    onDoneRef.current()
  }, [snapshot?.phase, stop])

  const submit = async () => {
    const submittedCode = code.trim()
    const flowId = snapshot?.flowId
    if (cancelledRef.current || !submittedCode || !flowId || snapshot?.userCode === undefined) return
    await action.run(async task => {
      const result = await settings.oauthSubmit(provider.id, flowId, submittedCode)
      if (!mountedRef.current || cancelledRef.current || !task.isCurrent()) return
      if (result.ok && result.status === 'approved') {
        stop()
        if (!completedRef.current) {
          completedRef.current = true
          onDoneRef.current()
        }
      } else if (!result.ok) setErrorRef.current(result.message || 'The provider rejected the code.')
    }, {
      onBusy: setSubmitting,
      onError: error => { if (mountedRef.current) setErrorRef.current(error.message) }
    })
    // The one-shot code is request input: clear it whenever this submit ran
    // to completion and the field still holds exactly that code.
    if (mountedRef.current && codeRef.current === submittedCode) onCode('')
  }

  const cancel = async () => {
    const flowId = snapshot?.flowId ?? cancelFlowId
    cancelledRef.current = true
    setErrorRef.current(null)
    onCode('')
    stop()
    if (!flowId) {
      if (mountedRef.current) onCancel()
      return
    }
    setCancelFlowId(flowId)
    await action.run(async task => {
      await settings.oauthCancel(flowId)
      if (mountedRef.current && task.isCurrent()) {
        setCancelFlowId(null)
        onCancel()
      }
    }, { onBusy: value => { if (mountedRef.current) setCancelling(value) }, onError: error => { if (mountedRef.current) setErrorRef.current(error.message) } })
    if (mountedRef.current) onCode('')
  }

  const flow = snapshot
  const status = flow?.phase ?? (busy ? 'starting' : 'idle')
  const canSubmit = flow?.userCode !== undefined && flow.flowId !== undefined
  return <section className="data-card"><h3>Connect {provider.name}</h3>{flow?.userCode !== undefined && <p>Enter code <strong>{flow.userCode}</strong> at the verification page.</p>}{flow?.authorizationURL && <Button onClick={() => void openAuthorization()} variant="secondary"><IconExternalLink size={16} /> Open provider</Button>}{canSubmit && <div className="button-row"><Input autoComplete="off" onChange={event => onCode(event.target.value)} placeholder="Code" value={code} /><Button disabled={submitting || !code.trim()} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit'}</Button></div>}{oauthError && <div className="error-banner" role="alert">{oauthError.message}</div>}<p className="muted">Status: {flow?.message || status}. Polling stops after a bounded number of attempts.</p><Button disabled={cancelling} onClick={() => void cancel()} variant="destructive">{cancelling ? 'Cancelling…' : 'Cancel'}</Button></section>
}

function CustomEndpointForm({ endpoint, onCancel, onSaved, setError }: { endpoint: CustomEndpoint | null; onCancel(): void; onSaved(): void; setError(value: string | null): void }) {
  const settings = useApi(createSettingsApi)
  const [name, setName] = useState(endpoint?.name ?? '')
  const [baseURL, setBaseURL] = useState(endpoint?.base_url ?? '')
  const [model, setModel] = useState(endpoint?.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<string | null>(null)
  const action = useScopedTask()
  useScopeReset(() => {
    setName(endpoint?.name ?? '')
    setBaseURL(endpoint?.base_url ?? '')
    setModel(endpoint?.model ?? '')
    setApiKey('')
    setValidation(null)
    setSaving(false)
    setValidating(false)
  }, endpoint?.id)
  const validate = async () => {
    setValidation(null)
    await action.run(async task => {
      const result = await settings.validateCustomEndpoint({ api_key: apiKey || undefined, base_url: baseURL.trim(), model: model.trim(), name: name.trim() })
      if (!task.isCurrent()) return
      setValidation(result.ok ? `Reachable${result.models.length ? ` · ${result.models.length} models found` : ''}.` : result.message)
    }, { onBusy: setValidating, onError: error => setValidation(error.message) })
    // The API key is request input, never a retained secret: clear it
    // unconditionally, exactly as the previous unguarded finally did.
    setApiKey('')
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    await action.run(async task => {
      setError(null)
      await settings.saveCustomEndpoint({ api_key: apiKey || undefined, base_url: baseURL.trim(), id: endpoint?.id, model: model.trim(), name: name.trim() })
      if (!task.isCurrent()) return
      onSaved()
    }, { onBusy: setSaving, onError: error => setError(error.message) })
    // Same credential-hygiene clear as `validate` — unconditional.
    setApiKey('')
  }
  return <form className="data-card panel-stack" onSubmit={save}><h3>{endpoint ? 'Edit endpoint' : 'Add endpoint'}</h3><label className="config-field"><span>Name</span><Input onChange={event => setName(event.target.value)} value={name} /></label><label className="config-field"><span>Base URL</span><Input onChange={event => setBaseURL(event.target.value)} type="url" value={baseURL} /></label><label className="config-field"><span>Model</span><Input onChange={event => setModel(event.target.value)} value={model} /></label><label className="config-field"><span>API key (optional)</span><Input autoComplete="off" onChange={event => setApiKey(event.target.value)} type="password" value={apiKey} /></label>{validation && <p className="muted" role="status">{validation}</p>}<div className="button-row"><Button disabled={saving || validating || !baseURL.trim()} onClick={() => void validate()} type="button" variant="secondary">Validate endpoint</Button><Button disabled={saving || validating || !name.trim() || !baseURL.trim() || !model.trim()} type="submit">Save endpoint</Button><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button></div></form>
}

function ToolsKeysSettings({ onBack }: { onBack(): void }) {
  const settings = useApi(createSettingsApi)
  const connection = useStore($connection)
  const queryClient = useQueryClient()
  const key = useScopeKey('settings', ['env'])
  const variables = useScopedQuery(key, { queryFn: signal => settings.env(signal) })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [remove, setRemove] = useState<{ name: string; variable: EnvVarInfo } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const revealTimers = useRef(new Map<string, number>())
  const draftRevisions = useRef(new Map<string, number>())
  const action = useScopedTask()
  useScopeReset(() => {
    setDrafts({})
    draftRevisions.current.clear()
    setRevealed({})
    setRemove(null)
    setError(null)
    return () => {
      revealTimers.current.forEach(timer => window.clearTimeout(timer))
      revealTimers.current.clear()
    }
  }, connection.phase)
  const updateDraft = (name: string, value: string) => {
    draftRevisions.current.set(name, (draftRevisions.current.get(name) ?? 0) + 1)
    setDrafts(current => ({ ...current, [name]: value }))
  }
  const clearDraft = (name: string, revision: number, task: ScopedTask) => {
    if (draftRevisions.current.get(name) !== revision || !task.isCurrent()) return
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
    const revision = draftRevisions.current.get(name) ?? 0
    await action.run(async task => {
      try {
        await settings.setEnv(name, value)
        if (!task.isCurrent()) return
        void queryClient.invalidateQueries({ queryKey: key })
      } finally {
        clearDraft(name, revision, task)
      }
    }, { onError: error => setError(error.message) })
  }
  const reveal = async (name: string) => {
    await action.run(async task => {
      const response = await settings.revealEnv(name)
      if (!task.isCurrent()) return
      const previous = revealTimers.current.get(name)
      if (previous !== undefined) window.clearTimeout(previous)
      setRevealed(current => ({ ...current, [name]: response.value }))
      const timer = window.setTimeout(() => {
        revealTimers.current.delete(name)
        if (!task.isCurrent()) return
        setRevealed(current => { const next = { ...current }; delete next[name]; return next })
      }, 30_000)
      revealTimers.current.set(name, timer)
    }, { onError: error => setError(error.message) })
  }
  const validate = async (name: string) => {
    const value = drafts[name] ?? ''
    if (!value) return
    const revision = draftRevisions.current.get(name) ?? 0
    await action.run(async task => {
      try {
        const result = await settings.validateProvider(name, value)
        if (task.isCurrent()) setError(result.ok ? `${name} was accepted by the provider.` : result.message || `${name} could not be validated.`)
      } finally {
        clearDraft(name, revision, task)
      }
    }, { onError: error => setError(error.message) })
  }
  const removeVariable = async () => {
    if (!remove) return
    await action.run(async task => {
      await settings.deleteEnv(remove.name)
      if (!task.isCurrent()) return
      setRemove(null)
      void queryClient.invalidateQueries({ queryKey: key })
    }, { onError: error => setError(error.message) })
  }
  const rows = Object.entries(variables.data ?? {}).filter(([, value]) => !value.channel_managed)
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="Only redacted status is fetched. Secret drafts never enter stores, persistence, or logs." title="Tools & keys">{error && <div className="error-banner" role="alert">{error}</div>}{variables.isPending && <Skeleton className="h-20 w-full" />}{variables.error && <GatewayErrorBanner error={variables.error} unavailablePhrase="Credential management is unavailable" />}<div className="settings-list static">{rows.map(([keyName, variable]) => <CredentialRow key={keyName} name={keyName} onDelete={() => setRemove({ name: keyName, variable })} onDraft={value => updateDraft(keyName, value)} onReveal={() => void reveal(keyName)} onSave={() => void save(keyName)} onValidate={variable.category === 'provider' ? () => void validate(keyName) : undefined} revealed={revealed[keyName]} value={drafts[keyName] ?? ''} variable={variable} />)}</div>{rows.length === 0 && variables.data && <div className="empty-panel">No non-channel credentials are exposed by this gateway.</div>}{remove && <ConfirmDialog confirmLabel="Delete" description={`Delete the ${remove.name} credential from this profile?`} onCancel={() => setRemove(null)} onConfirm={() => void removeVariable()} title="Delete credential" />}</SettingsPageShell>
}

function CredentialRow({ name, onDelete, onDraft, onReveal, onSave, onValidate, revealed, value, variable }: { name: string; onDelete(): void; onDraft(value: string): void; onReveal(): void; onSave(): void; onValidate?: () => void; revealed?: string; value: string; variable: EnvVarInfo }) {
  return <div className="credential-row"><span><strong>{name}</strong><small>{revealed ?? variable.redacted_value ?? (variable.is_set ? 'Configured' : 'Not set')}</small></span><Input aria-label={`${name} secret`} autoComplete="off" onChange={event => onDraft(event.target.value)} placeholder={variable.is_set ? 'Replace value' : 'Enter value'} type="password" value={value} /><div className="button-row"><Button disabled={!value} onClick={onSave} size="sm">Save</Button>{onValidate && <Button disabled={!value} onClick={onValidate} size="sm" variant="secondary">Validate</Button>}{variable.is_set && <Button onClick={onReveal} size="sm" variant="secondary">Reveal</Button>}{variable.is_set && <Button onClick={onDelete} size="sm" variant="destructive"><IconTrash size={14} /></Button>}</div></div>
}


function ArchivedChatsSettings({ onBack }: { onBack(): void }) {
  const settings = useApi(createSettingsApi)
  const queryClient = useQueryClient()
  const key = useScopeKey('settings', ['archived-chats'])
  const sessions = useScopedQuery(key, { queryFn: signal => settings.sessions(signal) })
  const [remove, setRemove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const action = useScopedTask()
  useScopeReset(() => { setRemove(null); setError(null) })
  const restore = async (id: string) => {
    await action.run(async task => {
      await settings.restoreSession(id)
      if (task.isCurrent()) void queryClient.invalidateQueries({ queryKey: key })
    }, { onError: error => setError(error.message) })
  }
  const destroy = async () => {
    if (!remove) return
    await action.run(async task => {
      await settings.deleteSession(remove)
      if (!task.isCurrent()) return
      setRemove(null)
      void queryClient.invalidateQueries({ queryKey: key })
    }, { onError: error => setError(error.message) })
  }
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="Only archived sessions from the selected profile are listed." title="Archived chats">{error && <div className="error-banner" role="alert">{error}</div>}{sessions.error && <GatewayErrorBanner error={sessions.error} />}{sessions.isPending && <Skeleton className="h-20 w-full" />}<div className="settings-list static">{sessions.data?.sessions.map(session => <div key={session.id}><span><strong>{session.title || 'Untitled chat'}</strong><small>{session.preview || 'No preview'} · {session.message_count ?? 0} messages</small></span><div className="button-row"><Button onClick={() => void restore(session.id)} size="sm">Restore</Button><Button onClick={() => setRemove(session.id)} size="sm" variant="destructive"><IconTrash size={14} /></Button></div></div>)}</div>{sessions.data?.sessions.length === 0 && <div className="empty-panel">No archived chats.</div>}{remove && <ConfirmDialog confirmLabel="Delete permanently" description="Permanently delete this archived chat? This cannot be undone." onCancel={() => setRemove(null)} onConfirm={() => void destroy()} title="Delete archived chat" />}</SettingsPageShell>
}

function PluginsSettings({ onBack }: { onBack(): void }) {
  const settings = useApi(createSettingsApi)
  const preferences = useStore($preferences)
  const queryClient = useQueryClient()
  const key = useScopeKey('settings', ['plugins'], { unscoped: true })
  const supportsPluginManagement = profileKey(preferences.profile) === 'default'
  const plugins = useScopedQuery(key, { enabled: supportsPluginManagement, queryFn: signal => settings.pluginsHub(signal) })
  const [remove, setRemove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const action = useScopedTask()
  useScopeReset(() => { setRemove(null); setError(null) })
  const toggle = async (name: string, next: 'disable' | 'enable') => {
    await action.run(async task => {
      await settings.pluginAction(name, next)
      if (task.isCurrent()) void queryClient.invalidateQueries({ queryKey: key })
    }, { onError: error => setError(error.message) })
  }
  const destroy = async () => {
    if (!remove) return
    await action.run(async task => {
      await settings.removePlugin(remove)
      if (!task.isCurrent()) return
      setRemove(null)
      void queryClient.invalidateQueries({ queryKey: key })
    }, { onError: error => setError(error.message) })
  }
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="Only official plugin inventory and supported enable, disable, and removal actions are exposed on mobile." title="Plugins">{!supportsPluginManagement && <div className="unsupported-card" role="alert"><strong>Plugin management is unavailable for this profile.</strong><p>Plugin discovery and mutations are process-scoped on this gateway. Switch to the default profile or connect to a gateway dedicated to this profile.</p></div>}{supportsPluginManagement && error && <div className="error-banner" role="alert">{error}</div>}{supportsPluginManagement && plugins.error && <GatewayErrorBanner error={plugins.error} unavailablePhrase="Plugin management is unavailable" />}{supportsPluginManagement && plugins.isPending && <Skeleton className="h-20 w-full" />}<div className="settings-list static">{supportsPluginManagement && plugins.data?.plugins.map(plugin => { const enabled = plugin.runtime_status === 'enabled'; return <div key={plugin.name}><span><strong>{plugin.name}</strong><small>{plugin.description || 'No description'} · {plugin.source || 'unknown'} {plugin.version || ''}</small></span><div className="button-row"><Button onClick={() => void toggle(plugin.name, enabled ? 'disable' : 'enable')} size="sm">{enabled ? 'Disable' : 'Enable'}</Button>{plugin.can_remove && <Button onClick={() => setRemove(plugin.name)} size="sm" variant="destructive"><IconTrash size={14} /></Button>}</div></div>})}</div>{supportsPluginManagement && plugins.data?.plugins.length === 0 && <div className="empty-panel">No plugins are available.</div>}{remove && supportsPluginManagement && <ConfirmDialog confirmLabel="Remove" description={`Remove plugin ${remove}? This only removes user-installed plugins.`} onCancel={() => setRemove(null)} onConfirm={() => void destroy()} title="Remove plugin" />}</SettingsPageShell>
}
