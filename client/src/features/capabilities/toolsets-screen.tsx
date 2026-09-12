import { IconChevronRight, IconRefresh, IconSearch, IconTools } from '@tabler/icons-react'
import { useMemo, useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopeReset, useScopedMutation, useScopedQuery, useScopedTask } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import type { ToolsetInfo } from '~/lib/types'
import { ToolsetDetail } from './toolset-detail'
import { createToolsetsApi } from './toolsets-api'

export function ToolsetsScreen({ onBack, onSelect, selected }: { onBack(): void; onSelect?(toolset: ToolsetInfo): void; selected?: string }) {
  const toolsetsApi = useApi(createToolsetsApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryKey = useScopeKey('tools', ['list'])
  const toolsets = useScopedQuery(queryKey, { queryFn: signal => toolsetsApi.list(signal) })
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (toolsets.data ?? []).filter(toolset => !term || `${toolset.name} ${toolset.label} ${toolset.description}`.toLowerCase().includes(term))
  }, [search, toolsets.data])
  const toggle = useScopedMutation<unknown, { enabled: boolean; name: string }, ToolsetInfo[]>({
    mutationFn: ({ enabled, name }) => toolsetsApi.toggle(name, enabled),
    optimistic: {
      queryKey,
      apply: (rows, { name, enabled }) => rows?.map(row => row.name === name ? { ...row, enabled } : row)
    },
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => setError(null)
  })
  const action = useScopedTask()

  useScopeReset(() => {
    setSearch('')
    setConfirmClear(false)
    setError(null)
  })
  const clearAll = async () => {
    setConfirmClear(false)
    const enabled = toolsets.data?.filter(toolset => toolset.enabled) ?? []
    await action.run(async task => {
      for (const toolset of enabled) {
        if (!task.isCurrent()) return
        // A failed toggle ends the loop: the rejection is discarded silently
        // by the runner (no onError callback), matching the previous bare break.
        await toggle.mutateAsync({ enabled: false, name: toolset.name })
      }
    })
  }

  const selectedToolset = selected ? toolsets.data?.find(toolset => toolset.name === selected) : undefined
  if (selected && selectedToolset) return <ToolsetDetail onBack={onBack} toolset={selectedToolset} />
  if (selected && toolsets.data && !selectedToolset) return <section className="screen page-screen"><Button onClick={onBack} variant="text">‹ Back</Button><div className="empty-panel">That toolset is no longer available.</div></section>

  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Capabilities</p><h2>Tools</h2></div><Button aria-label="Refresh tools" onClick={() => void toolsets.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button></header>
      <p className="muted">Toolsets are profile defaults for new sessions. The active conversation keeps its existing tool schema.</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="search-box"><IconSearch size={17} aria-hidden="true" /><Input aria-label="Search toolsets" onChange={event => setSearch(event.target.value)} placeholder="Search toolsets" value={search} /></div>
      <div className="button-row tool-actions"><Badge variant="muted">{toolsets.data?.filter(toolset => toolset.enabled).length ?? 0} enabled</Badge><Button disabled={!toolsets.data?.some(toolset => toolset.enabled) || toggle.isPending} onClick={() => setConfirmClear(true)} size="sm" variant="destructive">Clear enabled toolsets</Button></div>
      {toolsets.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /><Skeleton className="mt-2 h-14 w-full" /></div>}
      {toolsets.error && <GatewayErrorBanner error={toolsets.error} unsupportedText="Toolsets are unavailable on this gateway." />}
      <div className="settings-list capability-list">{filtered.map(toolset => <article className="capability-row" key={toolset.name}><button onClick={() => onSelect?.(toolset)}><IconTools size={20} /><span><strong>{toolset.label || toolset.name}</strong><small>{toolset.description || 'No description'}</small><small>{toolset.tools.length} tools · {toolset.configured ? 'Configured' : 'Setup needed'}</small></span><IconChevronRight size={18} /></button><label className="row-switch"><span className="sr-only">Enable {toolset.label || toolset.name}</span><input checked={toolset.enabled} onChange={event => toggle.mutate({ enabled: event.target.checked, name: toolset.name })} type="checkbox" /></label></article>)}{toolsets.data && filtered.length === 0 && <div className="empty-panel">No toolsets match this search.</div>}</div>
      {confirmClear && <ConfirmDialog confirmLabel="Clear all" description="Disable every enabled toolset for this profile? The change affects new sessions only." onCancel={() => setConfirmClear(false)} onConfirm={() => void clearAll()} title="Clear enabled toolsets" />}
    </section>
  )
}

export function ToolsetRoute({ onBack, toolset }: { onBack(): void; toolset: ToolsetInfo }) {
  return <ToolsetDetail onBack={onBack} toolset={toolset} />
}
