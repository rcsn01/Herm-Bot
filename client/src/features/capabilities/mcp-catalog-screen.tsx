import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { PageShell } from '~/components/page-shell'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi, useGatewayApi } from '~/gateway/gateway-api-hooks'
import { runGatewayAction, type GatewayActionState } from '~/gateway/remote-action'
import { beginScopedTask, useScopeKey, useScopeReset, useScopedMutation, useScopedQuery } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { createMcpApi, type McpCatalogEntry } from './mcp-api'

export function McpCatalogScreen({ onBack }: { onBack(): void }) {
  const api = useGatewayApi()
  const mcpApi = useApi(createMcpApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const scopeKey = useScopeKey('mcp', ['catalog'])
  const catalog = useScopedQuery(scopeKey, { queryFn: signal => mcpApi.catalog(signal) })
  const [pending, setPending] = useState<McpCatalogEntry | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  type InstallVariables = { entry: McpCatalogEntry; env: Record<string, string> }
  const install = useScopedMutation<GatewayActionState, InstallVariables>({
    mutationFn: ({ entry, env: values }) => {
      const task = beginScopedTask()
      return runGatewayAction(api, {
        isCurrentScope: () => task.isCurrent(),
        start: signal => mcpApi.installCatalog(entry.name, values, signal)
      })
    },
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setPending(null)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: scopeKey })
    }
  })

  useScopeReset(() => {
    setPending(null)
    setEnv({})
    setError(null)
  })

  const confirmInstall = () => {
    if (!pending) return
    const missing = pending.required_env.filter(variable => variable.required && !env[variable.name]?.trim())
    if (missing.length > 0) {
      setError(`Enter the required credential${missing.length === 1 ? '' : 's'}: ${missing.map(variable => variable.name).join(', ')}.`)
      return
    }
    const values = { ...env }
    setEnv({})
    install.mutate({ entry: pending, env: values })
  }

  return <PageShell actions={<Button aria-label="Refresh MCP catalog" onClick={() => void catalog.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>} eyebrow="MCP" leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle={`Install approved MCP servers into the ${profile || 'default'} profile. Credentials stay in the gateway.`} title="Catalog">{error && <div className="error-banner" role="alert">{error}</div>}{catalog.isPending && <Skeleton className="h-24 w-full" />}{catalog.error && <GatewayErrorBanner error={catalog.error} />}<div className="settings-list capability-list">{catalog.data?.entries.map(entry => <article className="hub-result" key={entry.name}><div><strong>{entry.name}</strong><small>{entry.description}</small><small>{entry.transport} · {entry.installed ? entry.enabled ? 'Enabled' : 'Installed' : 'Not installed'}</small></div><Button disabled={entry.installed || install.isPending} onClick={() => setPending(entry)} size="sm">{entry.installed ? 'Installed' : 'Install'}</Button></article>)}{catalog.data?.entries.length === 0 && <div className="empty-panel">The MCP catalog is empty.</div>}</div>{pending && <ConfirmDialog confirmLabel="Install" description={`Install ${pending.name}? Inspect the ${pending.transport} command and provide only the requested credentials.`} onCancel={() => { setPending(null); setEnv({}) }} onConfirm={confirmInstall} title="Install MCP server" />}{pending && pending.required_env.length > 0 && <section className="data-card"><h3>Required credentials</h3>{pending.required_env.map(variable => <label className="config-field" key={variable.name}><span>{variable.prompt || variable.name}{variable.required ? ' (required)' : ''}</span><Input autoComplete="off" onChange={event => setEnv(current => ({ ...current, [variable.name]: event.target.value }))} type="password" value={env[variable.name] ?? ''} /></label>)}</section>}</PageShell>
}
