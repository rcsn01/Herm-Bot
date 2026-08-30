import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronRight, IconEdit, IconExternalLink, IconPlus, IconRefresh, IconServer, IconShieldCheck, IconTrash } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { runRemoteAction } from '~/gateway/remote-action'
import { PlatformActions } from '~/native/platform-actions'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { McpCatalogScreen } from './mcp-catalog-screen'
import { McpServerEditor } from './mcp-server-editor'
import { mcpApi, type McpOAuthFlow, type McpServerSummary } from './mcp-api'

const platformActions = new PlatformActions()

export function McpScreen({ onBack, onOpenCatalog, onSelect, selected }: { onBack(): void; onOpenCatalog?(): void; onSelect?(server: McpServerSummary): void; selected?: string }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const queryKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'mcp', 'servers')
  const screenScope = currentGatewayScope()
  const servers = useQuery({ queryFn: ({ signal }) => mcpApi.list(gateway, profile, signal), queryKey })
  const [editor, setEditor] = useState<McpServerSummary | 'new' | null>(null)
  const [catalog, setCatalog] = useState(false)
  const [remove, setRemove] = useState<McpServerSummary | null>(null)
  const [flow, setFlow] = useState<McpOAuthFlow | null>(null)
  const [testResult, setTestResult] = useState<{ name: string; value: Awaited<ReturnType<typeof mcpApi.test>> } | null>(null)
  const pollAbort = useRef<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toggle = useMutation<unknown, unknown, { enabled: boolean; name: string }, { previous?: { servers: McpServerSummary[] }; scope: CurrentGatewayScope }>({
    mutationFn: ({ enabled, name }: { enabled: boolean; name: string }) => mcpApi.toggle(gateway, profile, name, enabled),
    onError: (caught, _value, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      if (context.previous) queryClient.setQueryData(queryKey, context.previous)
      setError(classifyGatewayError(caught).message)
    },
    onMutate: async ({ enabled, name }) => {
      const scope = currentGatewayScope()
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<{ servers: McpServerSummary[] }>(queryKey)
      if (isCurrentGatewayScope(scope)) {
        queryClient.setQueryData<{ servers: McpServerSummary[] }>(queryKey, value => value ? { ...value, servers: value.servers.map(server => server.name === name ? { ...server, enabled } : server) } : value)
      }
      return { previous, scope }
    },
    onSettled: (_data, _error, _variables, context) => { if (context && isCurrentGatewayScope(context.scope)) void queryClient.invalidateQueries({ queryKey }) }
  })
  const removeMutation = useMutation<unknown, unknown, string, { scope: CurrentGatewayScope }>({
    mutationFn: (name: string) => mcpApi.remove(gateway, profile, name),
    onError: (caught, _name, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSettled: (_data, _error, _name, context) => { if (context && isCurrentGatewayScope(context.scope)) void queryClient.invalidateQueries({ queryKey }) },
    onSuccess: (_data, _name, context) => { if (context && isCurrentGatewayScope(context.scope)) setRemove(null) }
  })
  const testMutation = useMutation<Awaited<ReturnType<typeof mcpApi.test>>, unknown, string, { scope: CurrentGatewayScope }>({
    mutationFn: (name: string) => mcpApi.test(gateway, profile, name),
    onError: (caught, _name, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (value, name, context) => { if (context && isCurrentGatewayScope(context.scope)) { setTestResult({ name, value }); setError(null) } }
  })
  const authMutation = useMutation<Awaited<ReturnType<typeof mcpApi.auth>>, unknown, string, { scope: CurrentGatewayScope }>({
    mutationFn: (name: string) => mcpApi.auth(gateway, profile, name),
    onError: (caught, _name, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: async (value, _name, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setFlow(value)
      if (value.authorization_url) {
        try {
          await platformActions.openExternal(value.authorization_url)
          if (!isCurrentGatewayScope(context.scope)) return
        } catch (caught) {
          if (isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message)
        }
      }
    }
  })
  const cancelAuth = useMutation<unknown, unknown, string, { scope: CurrentGatewayScope }>({
    mutationFn: (flowId: string) => mcpApi.cancelOAuth(gateway, profile, flowId),
    onError: (caught, _flowId, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(classifyGatewayError(caught).message) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (_data, _flowId, context) => { if (context && isCurrentGatewayScope(context.scope)) setFlow(null) }
  })

  const openExternal = async (url: string) => {
    const scope = currentGatewayScope()
    try {
      await platformActions.openExternal(url)
    } catch (caught) {
      if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message)
    }
  }

  useEffect(() => {
    setEditor(null)
    setCatalog(false)
    setRemove(null)
    setFlow(null)
    setTestResult(null)
    setError(null)
  }, [preferences.remoteURL, profile])

  useEffect(() => {
    if (!flow || flow.status === 'approved' || flow.status === 'error') return
    const scope = currentGatewayScope()
    const controller = new AbortController()
    pollAbort.current = controller
    const flowId = flow.flow_id
    void runRemoteAction<typeof flow>({
      gateway,
      getScopeEpoch: () => currentGatewayScope().generation,
      intervalMs: 1_000,
      maxAttempts: 60,
      maxIntervalMs: 5_000,
      poll: async (_gateway, signal) => {
        const next = await mcpApi.oauthStatus(gateway, profile, flowId, signal)
        if (isCurrentGatewayScope(scope)) setFlow(next)
        return { result: next, status: next.status }
      },
      signal: controller.signal,
      start: async () => ({ result: flow, status: flow.status }),
      isComplete: state => state.status === 'approved' || state.status === 'error'
    }).then(state => {
      if (controller.signal.aborted || !isCurrentGatewayScope(scope)) return
      if (state.result) setFlow(state.result)
      if (state.result?.status === 'error') setError(state.result.error || 'MCP authorization failed.')
    }).catch(caught => {
      if (controller.signal.aborted || !isCurrentGatewayScope(scope)) return
      setError(classifyGatewayError(caught).message.includes('timed out')
        ? 'MCP authorization timed out. Start authentication again if needed.'
        : classifyGatewayError(caught).message)
    })
    return () => {
      controller.abort()
      if (pollAbort.current === controller) pollAbort.current = null
    }
  }, [flow?.flow_id, gateway, profile])

  const selectedServer = selected ? servers.data?.servers.find(server => server.name === selected) : undefined
  if (selected && selectedServer) return <McpServerRoute onBack={onBack} onSaved={() => { if (!isCurrentGatewayScope(screenScope)) return false; void queryClient.invalidateQueries({ queryKey }); return true }} server={selectedServer} />
  if (selected && servers.data && !selectedServer) return <section className="screen page-screen"><Button onClick={onBack} variant="text">‹ Back</Button><div className="empty-panel">That MCP server is no longer configured.</div></section>
  if (catalog) return <McpCatalogScreen onBack={() => { setCatalog(false); onBack() }} />
  if (editor) return <McpServerEditor onCancel={() => { if (isCurrentGatewayScope(screenScope)) setEditor(null) }} onSaved={() => { if (!isCurrentGatewayScope(screenScope)) return; setEditor(null); void queryClient.invalidateQueries({ queryKey }) }} server={editor === 'new' ? undefined : editor} />

  return <section className="screen page-screen"><header className="page-heading"><div><p className="eyebrow">Capabilities</p><h2>MCP</h2></div><div className="button-row"><Button aria-label="Refresh MCP servers" onClick={() => void servers.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Button onClick={() => setEditor('new')} size="sm"><IconPlus size={16} /> Add</Button></div></header><p className="muted">MCP changes apply to new sessions. Hermes Mobile never reloads the active conversation's tool schema.</p>{error && <div className="error-banner" role="alert">{error}</div>}<div className="button-row"><Button onClick={() => onOpenCatalog ? onOpenCatalog() : setCatalog(true)} variant="secondary"><IconServer size={16} /> Catalog</Button><Badge variant="muted">{profile || 'default'} profile</Badge></div>{servers.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-16 w-full" /></div>}{servers.error && <div className={classifyGatewayError(servers.error).kind === 'unsupported' ? 'unsupported-card' : 'error-banner'} role="alert">{classifyGatewayError(servers.error).kind === 'unsupported' ? 'MCP is unavailable on this gateway.' : classifyGatewayError(servers.error).message}</div>}<div className="settings-list capability-list">{servers.data?.servers.map(server => <article className="capability-row" key={server.name}><button onClick={() => onSelect?.(server)}><IconServer size={20} /><span><strong>{server.name}</strong><small>{server.transport}{server.url ? ` · ${server.url}` : server.command ? ` · ${server.command}` : ''}</small><small>{server.tools?.length ?? 0} tools · {server.enabled ? 'Enabled' : 'Disabled'}</small></span><IconChevronRight size={18} /></button><div className="row-actions"><Button aria-label={`Test ${server.name}`} disabled={testMutation.isPending} onClick={() => testMutation.mutate(server.name)} size="icon-sm" variant="ghost"><IconShieldCheck size={16} /></Button>{server.auth === 'oauth' && <Button aria-label={`Authenticate ${server.name}`} disabled={authMutation.isPending} onClick={() => authMutation.mutate(server.name)} size="icon-sm" variant="ghost">Auth</Button>}<Button aria-label={`Edit ${server.name}`} onClick={() => setEditor(server)} size="icon-sm" variant="ghost"><IconEdit size={16} /></Button><Button aria-label={`Delete ${server.name}`} onClick={() => setRemove(server)} size="icon-sm" variant="ghost"><IconTrash size={16} /></Button><label className="row-switch"><span className="sr-only">Enable {server.name}</span><input checked={server.enabled} onChange={event => toggle.mutate({ enabled: event.target.checked, name: server.name })} type="checkbox" /></label></div></article>)}{servers.data?.servers.length === 0 && <div className="empty-panel">No MCP servers are configured.</div>}</div>{testResult && <section className="data-card"><header className="page-heading"><h3>Test: {testResult.name}</h3><Button onClick={() => setTestResult(null)} variant="text">Close</Button></header>{testResult.value.ok ? <><p>Connected successfully. {testResult.value.tools.length} tools, {testResult.value.prompts ?? 0} prompts, {testResult.value.resources ?? 0} resources.</p><ul>{testResult.value.tools.map(tool => <li key={tool.name}>{tool.name}{tool.schema_chars ? ` · ${tool.schema_chars} schema chars` : ''}</li>)}</ul></> : <p className="muted">{testResult.value.error || 'The server test failed.'}</p>}</section>}{flow && <section className="data-card oauth-flow"><h3>MCP authentication</h3><p>{flow.status === 'authorization_required' ? 'Authorize the server in your browser, then return to Hermes.' : flow.status === 'approved' ? 'Authentication complete.' : flow.error || 'Starting authentication…'}</p>{flow.authorization_url && <Button onClick={() => void openExternal(flow.authorization_url!)} variant="secondary"><IconExternalLink size={16} /> Open authorization</Button>}{flow.status !== 'approved' && flow.status !== 'error' && <Button onClick={() => { pollAbort.current?.abort(); cancelAuth.mutate(flow.flow_id) }} variant="destructive">Cancel authentication</Button>}<Button onClick={() => { pollAbort.current?.abort(); setFlow(null) }} variant="text">Dismiss</Button></section>}{remove && <ConfirmDialog confirmLabel="Delete" description={`Remove MCP server ${remove.name}? Its configuration will be removed from the selected profile.`} onCancel={() => setRemove(null)} onConfirm={() => removeMutation.mutate(remove.name)} title="Delete MCP server" />}</section>
}

export function McpServerRoute({ onBack, onSaved, server }: { onBack(): void; onSaved(): boolean; server: McpServerSummary }) {
  return <McpServerEditor onCancel={onBack} onSaved={() => { if (onSaved()) onBack() }} server={server} />
}
