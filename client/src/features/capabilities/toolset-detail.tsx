import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { PageShell } from '~/components/page-shell'
import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi, useGatewayApi } from '~/gateway/gateway-api-hooks'
import { runGatewayAction, type GatewayActionState } from '~/gateway/remote-action'
import { beginScopedTask, useScopeKey, useScopeReset, useScopedMutation, useScopedQuery } from '~/gateway/scope-guard'
import type { ToolsetInfo } from '~/lib/types'
import { createToolsetsApi } from './toolsets-api'

export function ToolsetDetail({ toolset, onBack }: { onBack(): void; toolset: ToolsetInfo }) {
  const api = useGatewayApi()
  const toolsetsApi = useApi(createToolsetsApi)
  const queryClient = useQueryClient()
  const scopeKey = useScopeKey('tools')
  const configKey = useScopeKey('tools', [toolset.name, 'config'])
  const config = useScopedQuery(configKey, { queryFn: signal => toolsetsApi.config(toolset.name, signal) })
  const [env, setEnv] = useState<Record<string, string>>({})
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const providers = config.data?.providers ?? []
  const activeProvider = providers.find(provider => provider.is_active)
  const modelsKey = useScopeKey('tools', [toolset.name, 'models', selectedProvider])
  const models = useScopedQuery(modelsKey, {
    enabled: Boolean(selectedProvider),
    queryFn: signal => toolsetsApi.models(toolset.name, selectedProvider, signal)
  })

  useEffect(() => {
    if (!selectedProvider && activeProvider) setSelectedProvider(activeProvider.name)
  }, [activeProvider, selectedProvider])

  const toggle = useScopedMutation<unknown, boolean>({
    mutationFn: enabled => toolsetsApi.toggle(toolset.name, enabled),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: scopeKey })
    }
  })
  const selectProvider = useScopedMutation<Awaited<ReturnType<typeof toolsetsApi.selectProvider>>, string>({
    mutationFn: provider => toolsetsApi.selectProvider(toolset.name, provider),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: response => {
      setError(response.needs_nous_auth ? 'Sign in to Nous Portal before this provider can be used.' : null)
      void config.refetch()
    }
  })
  const saveEnv = useScopedMutation<Awaited<ReturnType<typeof toolsetsApi.saveEnv>>, Record<string, string>>({
    mutationFn: values => toolsetsApi.saveEnv(toolset.name, values),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setError(null)
      void config.refetch()
    }
  })
  const setup = useScopedMutation<GatewayActionState, string>({
    mutationFn: key => {
      const task = beginScopedTask()
      return runGatewayAction(api, {
        isCurrentScope: () => task.isCurrent(),
        start: signal => toolsetsApi.postSetup(toolset.name, key, signal)
      })
    },
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => setSetupMessage('Setup completed on the gateway.')
  })
  type SelectModelVariables = { model: string; previous: string }
  const selectModel = useScopedMutation<Awaited<ReturnType<typeof toolsetsApi.selectModel>>, SelectModelVariables>({
    mutationFn: ({ model }) => toolsetsApi.selectModel(toolset.name, model, selectedProvider),
    onError: (caught, { previous }) => {
      setSelectedModel(previous)
      setError(classifyGatewayError(caught).message)
    },
    onSuccess: (_value, { model }) => {
      setSelectedModel(model)
      setError(null)
      void models.refetch()
    }
  })

  const saveCredentials = (values: Record<string, string>) => {
    setEnv({})
    saveEnv.mutate(values)
  }

  useScopeReset(() => {
    setEnv({})
    setSelectedProvider('')
    setSelectedModel('')
    setError(null)
    setSetupMessage(null)
  }, toolset.name)

  return (
    <PageShell
      actions={<><Button aria-label="Refresh toolset" onClick={() => void config.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Badge variant={toolset.enabled ? 'default' : 'muted'}>{toolset.enabled ? 'Enabled' : 'Disabled'}</Badge></>}
      eyebrow="Tools"
      leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>}
      subtitle={toolset.description || 'Toolset configuration applies to new sessions.'}
      title={toolset.label || toolset.name}
    >
      {error && <div className="error-banner" role="alert">{error}</div>}
      {setupMessage && <div className="success-banner" role="status">{setupMessage}</div>}
      <div className="button-row"><Button disabled={toggle.isPending} onClick={() => toggle.mutate(!toolset.enabled)}>{toolset.enabled ? 'Disable toolset' : 'Enable toolset'}</Button></div>
      {config.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-24 w-full" /></div>}
      {config.error && <GatewayErrorBanner error={config.error} unsupportedText="Toolset setup is unavailable on this gateway." />}
      {config.data?.has_category && <section className="data-card"><h3>Providers</h3><div className="provider-list">{providers.map(provider => <article className="provider-card" key={provider.name}><div><strong>{provider.name}</strong><small>{provider.badge || provider.tag || provider.status || 'Provider'}</small><small>{provider.status === 'ready' ? 'Ready' : provider.status === 'needs_auth' ? 'Authentication required' : provider.status === 'needs_keys' ? 'Credentials required' : provider.status === 'needs_setup' ? 'Setup required' : 'Status unavailable'}</small></div><Button disabled={selectProvider.isPending} onClick={() => selectProvider.mutate(provider.name)} size="sm" variant={provider.is_active ? 'default' : 'secondary'}>{provider.is_active ? 'Selected' : 'Select'}</Button></article>)}</div></section>}
      {selectedProvider && <section className="data-card"><h3>Provider model</h3><select aria-label="Toolset model" disabled={!models.data?.has_models || selectModel.isPending} onChange={event => { if (event.target.value) selectModel.mutate({ model: event.target.value, previous: selectedModel }) }} value={selectedModel || models.data?.current || ''}><option value="">Provider default</option>{models.data?.models.map(model => <option key={model.id} value={model.id}>{model.display || model.id}</option>)}</select>{models.error && <p className="muted">Model selection is unavailable: {classifyGatewayError(models.error).message}</p>}</section>}
      {providers.some(provider => provider.env_vars.length > 0) && <section className="data-card"><h3>Credentials</h3><p className="muted">Values are sent directly to the gateway and are cleared after saving.</p>{providers.flatMap(provider => provider.env_vars).filter((item, index, rows) => rows.findIndex(candidate => candidate.key === item.key) === index).map(item => <label className="config-field" key={item.key}><span>{item.prompt || item.key}{item.is_set ? ' · configured' : ''}</span><Input autoComplete="off" onChange={event => setEnv(current => ({ ...current, [item.key]: event.target.value }))} placeholder={item.is_set ? 'Replace saved credential' : 'Enter credential'} type="password" value={env[item.key] ?? ''} /></label>)}<Button disabled={saveEnv.isPending || Object.values(env).every(value => !value.trim())} onClick={() => saveCredentials(Object.fromEntries(Object.entries(env).filter(([, value]) => value.trim())))}>Save credentials</Button></section>}
      {providers.filter(provider => provider.post_setup).map(provider => <Button key={provider.name} disabled={setup.isPending} onClick={() => void setup.mutateAsync(provider.post_setup!)} variant="secondary">Run setup for {provider.name}</Button>)}
    </PageShell>
  )
}
