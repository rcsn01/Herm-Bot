import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { mcpApi, runMcpInstallAction, type McpCatalogEntry } from './mcp-api'

export function McpCatalogScreen({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const scopeKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'mcp', 'catalog')
  const catalog = useQuery({ queryFn: ({ signal }) => mcpApi.catalog(gateway, profile, signal), queryKey: scopeKey })
  const [pending, setPending] = useState<McpCatalogEntry | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  type InstallVariables = { entry: McpCatalogEntry; env: Record<string, string> }
  const install = useMutation<Awaited<ReturnType<typeof runMcpInstallAction>>, unknown, InstallVariables, { scope: CurrentGatewayScope }>({
    mutationFn: ({ entry, env: values }) => runMcpInstallAction(gateway, profile, signal => mcpApi.installCatalog(gateway, profile, entry.name, values, signal), undefined, () => currentGatewayScope().generation),
    onError: (caught, _variables, context) => { if (context && isCurrentGatewayScope(context.scope)) { setEnv({}); setError(classifyGatewayError(caught).message) } },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_value, _variables, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setPending(null)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: scopeKey })
    },
    // Credentials are one-shot form input, never mutation state or cache.
    onSettled: (_data, _error, _variables, context) => {
      if (context && isCurrentGatewayScope(context.scope)) setEnv({})
    }
  })

  useEffect(() => {
    setPending(null)
    setEnv({})
    setError(null)
  }, [preferences.remoteURL, profile])

  const confirmInstall = () => {
    if (!pending) return
    const missing = pending.required_env.filter(variable => variable.required && !env[variable.name]?.trim())
    if (missing.length > 0) {
      setError(`Enter the required credential${missing.length === 1 ? '' : 's'}: ${missing.map(variable => variable.name).join(', ')}.`)
      return
    }
    install.mutate({ entry: pending, env: { ...env } })
  }

  return <section className="screen page-screen"><header className="page-heading"><Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><Button aria-label="Refresh MCP catalog" onClick={() => void catalog.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button></header><p className="eyebrow">MCP</p><h2>Catalog</h2><p className="muted">Install approved MCP servers into the {profile || 'default'} profile. Credentials stay in the gateway.</p>{error && <div className="error-banner" role="alert">{error}</div>}{catalog.isPending && <Skeleton className="h-24 w-full" />}{catalog.error && <div className="error-banner" role="alert">{classifyGatewayError(catalog.error).message}</div>}<div className="settings-list capability-list">{catalog.data?.entries.map(entry => <article className="hub-result" key={entry.name}><div><strong>{entry.name}</strong><small>{entry.description}</small><small>{entry.transport} · {entry.installed ? entry.enabled ? 'Enabled' : 'Installed' : 'Not installed'}</small></div><Button disabled={entry.installed || install.isPending} onClick={() => setPending(entry)} size="sm">{entry.installed ? 'Installed' : 'Install'}</Button></article>)}{catalog.data?.entries.length === 0 && <div className="empty-panel">The MCP catalog is empty.</div>}</div>{pending && <ConfirmDialog confirmLabel="Install" description={`Install ${pending.name}? Inspect the ${pending.transport} command and provide only the requested credentials.`} onCancel={() => { setPending(null); setEnv({}) }} onConfirm={confirmInstall} title="Install MCP server" />}{pending && pending.required_env.length > 0 && <section className="data-card"><h3>Required credentials</h3>{pending.required_env.map(variable => <label className="config-field" key={variable.name}><span>{variable.prompt || variable.name}{variable.required ? ' (required)' : ''}</span><Input autoComplete="off" onChange={event => setEnv(current => ({ ...current, [variable.name]: event.target.value }))} type="password" value={env[variable.name] ?? ''} /></label>)}</section>}</section>
}
