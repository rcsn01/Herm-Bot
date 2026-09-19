import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconChevronRight, IconEdit, IconExternalLink, IconPlus, IconRefresh, IconServer, IconShieldCheck, IconTrash } from '@tabler/icons-react'
import { useCallback, useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { PageHeading, PageShell } from '~/components/page-shell'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi, useGatewayApi } from '~/gateway/gateway-api-hooks'
import { beginScopedTask, useScopeKey, useScopeReset, useScopedMutation, useScopedQuery } from '~/gateway/scope-guard'
import { useOAuthFlow } from '~/gateway/oauth-flow'
import { PlatformActions } from '~/native/platform-actions'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { McpCatalogScreen } from './mcp-catalog-screen'
import { McpServerEditor } from './mcp-server-editor'
import { createMcpOAuthAdapter } from './mcp-oauth'
import { createMcpApi, type McpServerSummary } from './mcp-api'

const platformActions = new PlatformActions()

export function McpScreen({ onAdd, onBack, onOpenCatalog, onSelect, selected }: { onAdd?(): void; onBack(): void; onOpenCatalog?(): void; onSelect?(server: McpServerSummary): void; selected?: string }) {
  const api = useGatewayApi()
  const mcpApi = useApi(createMcpApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const queryKey = useScopeKey('mcp', ['servers'])
  const servers = useScopedQuery(queryKey, { queryFn: signal => mcpApi.list(signal) })
  const [editor, setEditor] = useState<McpServerSummary | 'new' | null>(null)
  const [catalog, setCatalog] = useState(false)
  const [remove, setRemove] = useState<McpServerSummary | null>(null)
  const [authServer, setAuthServer] = useState<string | null>(null)
  const [cancelFlowId, setCancelFlowId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ name: string; value: Awaited<ReturnType<typeof mcpApi.test>> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toggle = useScopedMutation<unknown, { enabled: boolean; name: string }, { servers: McpServerSummary[] }>({
    mutationFn: ({ enabled, name }) => mcpApi.toggle(name, enabled),
    optimistic: {
      queryKey,
      apply: (value, { name, enabled }) => value ? { ...value, servers: value.servers.map(server => server.name === name ? { ...server, enabled } : server) } : value
    },
    onError: caught => setError(classifyGatewayError(caught).message)
  })
  const removeMutation = useScopedMutation<unknown, string>({
    mutationFn: name => mcpApi.remove(name),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey }) },
    onSuccess: () => setRemove(null)
  })
  const testMutation = useScopedMutation<Awaited<ReturnType<typeof mcpApi.test>>, string>({
    mutationFn: name => mcpApi.test(name),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: (value, name) => { setTestResult({ name, value }); setError(null) }
  })
  const openExternal = useCallback((url: string) => platformActions.openExternal(url), [])
  const oauth = useOAuthFlow({ openExternal })
  const cancelAuth = useScopedMutation<unknown, string>({
    mutationFn: flowId => mcpApi.cancelOAuth(flowId),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      oauth.stop()
      setAuthServer(null)
      setCancelFlowId(null)
    }
  })

  useScopeReset(() => {
    setEditor(null)
    setCatalog(false)
    setRemove(null)
    setAuthServer(null)
    setCancelFlowId(null)
    setTestResult(null)
    setError(null)
  })

  const startAuth = (serverName: string) => {
    setError(null)
    setCancelFlowId(null)
    setAuthServer(serverName)
    oauth.start(createMcpOAuthAdapter(mcpApi, api.gateway, serverName))
  }

  const cancel = () => {
    const flowId = oauth.snapshot?.flowId ?? cancelFlowId
    oauth.stop()
    if (flowId) {
      setCancelFlowId(flowId)
      cancelAuth.mutate(flowId)
    } else {
      setAuthServer(null)
      setCancelFlowId(null)
    }
  }

  const dismiss = () => {
    oauth.stop()
    setAuthServer(null)
    setCancelFlowId(null)
  }

  const selectedServer = selected ? servers.data?.servers.find(server => server.name === selected) : undefined
  if (selected === 'new') return <McpServerEditor onCancel={onBack} onSaved={() => { const task = beginScopedTask(); if (!task.isCurrent()) return; void queryClient.invalidateQueries({ queryKey }); onBack() }} />
  if (selected && selectedServer) return <McpServerRoute onBack={onBack} onSaved={() => { const task = beginScopedTask(); if (!task.isCurrent()) return false; void queryClient.invalidateQueries({ queryKey }); return true }} server={selectedServer} />
  if (selected && servers.data && !selectedServer) return <PageShell leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title="MCP"><div className="empty-panel">That MCP server is no longer configured.</div></PageShell>
  if (catalog) return <McpCatalogScreen onBack={() => { setCatalog(false); onBack() }} />
  if (editor) return <McpServerEditor onCancel={() => { const task = beginScopedTask(); if (task.isCurrent()) setEditor(null) }} onSaved={() => { const task = beginScopedTask(); if (!task.isCurrent()) return; setEditor(null); void queryClient.invalidateQueries({ queryKey }) }} server={editor === 'new' ? undefined : editor} />

  return <PageShell actions={<div className="button-row"><Button aria-label="Refresh MCP servers" onClick={() => void servers.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Button onClick={() => onAdd ? onAdd() : setEditor('new')} size="sm"><IconPlus size={16} /> Add</Button></div>} eyebrow="Capabilities" leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="MCP changes apply to new sessions. Hermes Mobile never reloads the active conversation's tool schema." title="MCP">{error && <div className="error-banner" role="alert">{error}</div>}<div className="button-row"><Button onClick={() => onOpenCatalog ? onOpenCatalog() : setCatalog(true)} variant="secondary"><IconServer size={16} /> Catalog</Button><Badge variant="muted">{profile || 'default'} profile</Badge></div>{servers.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-16 w-full" /></div>}{servers.error && <GatewayErrorBanner error={servers.error} unsupportedText="MCP is unavailable on this gateway." />}<div className="settings-list capability-list">{servers.data?.servers.map(server => <article className="capability-row" key={server.name}><button onClick={() => onSelect?.(server)}><IconServer size={20} /><span><strong>{server.name}</strong><small>{server.transport}{server.url ? ` · ${server.url}` : server.command ? ` · ${server.command}` : ''}</small><small>{server.tools?.length ?? 0} tools · {server.enabled ? 'Enabled' : 'Disabled'}</small></span><IconChevronRight size={18} /></button><div className="row-actions"><Button aria-label={`Test ${server.name}`} disabled={testMutation.isPending} onClick={() => testMutation.mutate(server.name)} size="icon-sm" variant="ghost"><IconShieldCheck size={16} /></Button>{server.auth === 'oauth' && <Button aria-label={`Authenticate ${server.name}`} disabled={oauth.busy || cancelAuth.isPending || cancelFlowId !== null} onClick={() => startAuth(server.name)} size="icon-sm" variant="ghost">Auth</Button>}<Button aria-label={`Edit ${server.name}`} onClick={() => setEditor(server)} size="icon-sm" variant="ghost"><IconEdit size={16} /></Button><Button aria-label={`Delete ${server.name}`} onClick={() => setRemove(server)} size="icon-sm" variant="ghost"><IconTrash size={16} /></Button><label className="row-switch"><span className="sr-only">Enable {server.name}</span><input checked={server.enabled} onChange={event => toggle.mutate({ enabled: event.target.checked, name: server.name })} type="checkbox" /></label></div></article>)}{servers.data?.servers.length === 0 && <div className="empty-panel">No MCP servers are configured.</div>}</div>{testResult && <section className="data-card"><PageHeading actions={<Button onClick={() => setTestResult(null)} variant="text">Close</Button>} level={3} title={`Test: ${testResult.name}`} />{testResult.value.ok ? <><p>Connected successfully. {testResult.value.tools.length} tools, {testResult.value.prompts ?? 0} prompts, {testResult.value.resources ?? 0} resources.</p><ul>{testResult.value.tools.map(tool => <li key={tool.name}>{tool.name}{tool.schema_chars ? ` · ${tool.schema_chars} schema chars` : ''}</li>)}</ul></> : <p className="muted">{testResult.value.error || 'The server test failed.'}</p>}</section>}{authServer && <section className="data-card oauth-flow"><h3>MCP authentication</h3><p>{oauth.snapshot?.phase === 'waiting' ? oauth.error?.message || (oauth.snapshot.authorizationURL ? 'Authorize the server in your browser, then return to Hermes.' : 'Starting authentication…') : oauth.snapshot?.phase === 'approved' ? 'Authentication complete.' : oauth.busy ? 'Starting authentication…' : oauth.snapshot?.message || oauth.error?.message || 'MCP authorization failed.'}</p>{oauth.snapshot?.authorizationURL && <Button onClick={() => void oauth.openAuthorization()} variant="secondary"><IconExternalLink size={16} /> Open authorization</Button>}{(oauth.snapshot?.phase === 'waiting' || cancelFlowId !== null) && <Button disabled={cancelAuth.isPending} onClick={cancel} variant="destructive">{cancelAuth.isPending ? 'Cancelling…' : 'Cancel authentication'}</Button>}<Button onClick={dismiss} variant="text">Dismiss</Button></section>}{remove && <ConfirmDialog confirmLabel="Delete" description={`Remove MCP server ${remove.name}? Its configuration will be removed from the selected profile.`} onCancel={() => setRemove(null)} onConfirm={() => removeMutation.mutate(remove.name)} title="Delete MCP server" />}</PageShell>
}

export function McpServerRoute({ onBack, onSaved, server }: { onBack(): void; onSaved(): boolean; server: McpServerSummary }) {
  return <McpServerEditor onCancel={onBack} onSaved={() => { if (onSaved()) onBack() }} server={server} />
}
