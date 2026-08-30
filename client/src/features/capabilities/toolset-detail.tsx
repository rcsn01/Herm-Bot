import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import type { ToolsetInfo } from '~/lib/types'
import { runToolsetAction, toolsetsApi } from './toolsets-api'

export function ToolsetDetail({ toolset, onBack }: { onBack(): void; toolset: ToolsetInfo }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const scopeKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'tools', toolset.name)
  const config = useQuery({ queryFn: ({ signal }) => toolsetsApi.config(gateway, profile, toolset.name, signal), queryKey: [...scopeKey, 'config'] })
  const [env, setEnv] = useState<Record<string, string>>({})
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const providers = config.data?.providers ?? []
  const activeProvider = providers.find(provider => provider.is_active)
  const models = useQuery({
    enabled: Boolean(selectedProvider),
    queryFn: ({ signal }) => toolsetsApi.models(gateway, profile, toolset.name, selectedProvider, signal),
    queryKey: [...scopeKey, 'models', selectedProvider]
  })

  useEffect(() => {
    if (!selectedProvider && activeProvider) setSelectedProvider(activeProvider.name)
  }, [activeProvider, selectedProvider])

  const toggle = useMutation<unknown, unknown, boolean, { scope: CurrentGatewayScope }>({
    mutationFn: (enabled: boolean) => toolsetsApi.toggle(gateway, profile, toolset.name, enabled),
    onError: (caught, _enabled, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_data, _enabled, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setError(null)
      void queryClient.invalidateQueries({ queryKey: gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'tools') })
    }
  })
  const selectProvider = useMutation<Awaited<ReturnType<typeof toolsetsApi.selectProvider>>, unknown, string, { scope: CurrentGatewayScope }>({
    mutationFn: (provider: string) => toolsetsApi.selectProvider(gateway, profile, toolset.name, provider),
    onError: (caught, _provider, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (response, _provider, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setError(response.needs_nous_auth ? 'Sign in to Nous Portal before this provider can be used.' : null)
      void config.refetch()
    }
  })
  const saveEnv = useMutation<Awaited<ReturnType<typeof toolsetsApi.saveEnv>>, unknown, Record<string, string>, { scope: CurrentGatewayScope }>({
    mutationFn: values => toolsetsApi.saveEnv(gateway, profile, toolset.name, values),
    onError: (caught, _values, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_data, _values, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setError(null)
      void config.refetch()
    },
    // Credential values are one-shot input, including when the gateway rejects
    // the request or the selected scope changes during it.
    onSettled: () => setEnv({})
  })
  const setup = useMutation<Awaited<ReturnType<typeof runToolsetAction>>, unknown, string, { scope: CurrentGatewayScope }>({
    mutationFn: (key: string) => runToolsetAction(gateway, profile, signal => toolsetsApi.postSetup(gateway, profile, toolset.name, key, signal), undefined, () => currentGatewayScope().generation),
    onError: (caught, _key, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_value, _key, context) => { if (context && isCurrentGatewayScope(context.scope)) setSetupMessage('Setup completed on the gateway.') }
  })
  const selectModel = useMutation<Awaited<ReturnType<typeof toolsetsApi.selectModel>>, unknown, string, { previous: string; scope: CurrentGatewayScope }>({
    mutationFn: model => toolsetsApi.selectModel(gateway, profile, toolset.name, model, selectedProvider),
    onError: (caught, _model, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setSelectedModel(context.previous)
      setError(classifyGatewayError(caught).message)
    },
    onMutate: () => ({ previous: selectedModel, scope: currentGatewayScope() }),
    onSuccess: (_value, model, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setSelectedModel(model)
      setError(null)
      void models.refetch()
    }
  })

  useEffect(() => {
    setEnv({})
    setSelectedProvider('')
    setSelectedModel('')
    setError(null)
    setSetupMessage(null)
  }, [preferences.remoteURL, profile, toolset.name])

  return (
    <section className="screen page-screen">
      <header className="page-heading"><Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><Button aria-label="Refresh toolset" onClick={() => void config.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button></header>
      <div className="page-heading"><div><p className="eyebrow">Tools</p><h2>{toolset.label || toolset.name}</h2></div><Badge variant={toolset.enabled ? 'default' : 'muted'}>{toolset.enabled ? 'Enabled' : 'Disabled'}</Badge></div>
      <p className="muted">{toolset.description || 'Toolset configuration applies to new sessions.'}</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {setupMessage && <div className="success-banner" role="status">{setupMessage}</div>}
      <div className="button-row"><Button disabled={toggle.isPending} onClick={() => toggle.mutate(!toolset.enabled)}>{toolset.enabled ? 'Disable toolset' : 'Enable toolset'}</Button></div>
      {config.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-24 w-full" /></div>}
      {config.error && <div className={classifyGatewayError(config.error).kind === 'unsupported' ? 'unsupported-card' : 'error-banner'} role="alert">{classifyGatewayError(config.error).kind === 'unsupported' ? 'Toolset setup is unavailable on this gateway.' : classifyGatewayError(config.error).message}</div>}
      {config.data?.has_category && <section className="data-card"><h3>Providers</h3><div className="provider-list">{providers.map(provider => <article className="provider-card" key={provider.name}><div><strong>{provider.name}</strong><small>{provider.badge || provider.tag || provider.status || 'Provider'}</small><small>{provider.status === 'ready' ? 'Ready' : provider.status === 'needs_auth' ? 'Authentication required' : provider.status === 'needs_keys' ? 'Credentials required' : provider.status === 'needs_setup' ? 'Setup required' : 'Status unavailable'}</small></div><Button disabled={selectProvider.isPending} onClick={() => selectProvider.mutate(provider.name)} size="sm" variant={provider.is_active ? 'default' : 'secondary'}>{provider.is_active ? 'Selected' : 'Select'}</Button></article>)}</div></section>}
      {selectedProvider && <section className="data-card"><h3>Provider model</h3><select aria-label="Toolset model" disabled={!models.data?.has_models || selectModel.isPending} onChange={event => { if (event.target.value) selectModel.mutate(event.target.value) }} value={selectedModel || models.data?.current || ''}><option value="">Provider default</option>{models.data?.models.map(model => <option key={model.id} value={model.id}>{model.display || model.id}</option>)}</select>{models.error && <p className="muted">Model selection is unavailable: {classifyGatewayError(models.error).message}</p>}</section>}
      {providers.some(provider => provider.env_vars.length > 0) && <section className="data-card"><h3>Credentials</h3><p className="muted">Values are sent directly to the gateway and are cleared after saving.</p>{providers.flatMap(provider => provider.env_vars).filter((item, index, rows) => rows.findIndex(candidate => candidate.key === item.key) === index).map(item => <label className="config-field" key={item.key}><span>{item.prompt || item.key}{item.is_set ? ' · configured' : ''}</span><Input autoComplete="off" onChange={event => setEnv(current => ({ ...current, [item.key]: event.target.value }))} placeholder={item.is_set ? 'Replace saved credential' : 'Enter credential'} type="password" value={env[item.key] ?? ''} /></label>)}<Button disabled={saveEnv.isPending || Object.values(env).every(value => !value.trim())} onClick={() => saveEnv.mutate(Object.fromEntries(Object.entries(env).filter(([, value]) => value.trim())))}>Save credentials</Button></section>}
      {providers.filter(provider => provider.post_setup).map(provider => <Button key={provider.name} disabled={setup.isPending} onClick={() => void setup.mutateAsync(provider.post_setup!)} variant="secondary">Run setup for {provider.name}</Button>)}
    </section>
  )
}
