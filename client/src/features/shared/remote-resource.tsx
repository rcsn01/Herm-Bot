import { useQuery } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'

import { Badge, Button, Skeleton } from '~/compat/primitives'
import { GatewayError, classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { $preferences } from '~/state/store'

export interface RemoteResourceDefinition {
  description: string
  id: string
  path: string
  profileScoped?: boolean
  title: string
}

export function RemoteResourceScreen({ definition, onBack }: { definition: RemoteResourceDefinition; onBack(): void }) {
  const gateway = useGateway()
  const preferences = $preferences.get()
  const profile = definition.profileScoped === false ? null : preferences.profile
  const separator = definition.path.includes('?') ? '&' : '?'
  const path = profile ? `${definition.path}${separator}profile=${encodeURIComponent(profile)}` : definition.path
  const query = useQuery({
    queryFn: async () => (await gateway.request({ path })).body,
    queryKey: gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, definition.id)
  })
  const error = query.error ? classifyGatewayError(query.error) : null

  return (
    <section className="screen page-screen">
      <header className="page-heading">
        <Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>
        <Button aria-label={`Refresh ${definition.title}`} onClick={() => void query.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>
      </header>
      <p className="eyebrow">Remote gateway</p>
      <h2>{definition.title}</h2>
      <p className="muted">{definition.description}</p>
      {query.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-20 w-full" /></div>}
      {error && <ResourceError error={error} title={definition.title} />}
      {query.data !== undefined && <ResourceOverview value={query.data} />}
    </section>
  )
}

function ResourceError({ error, title }: { error: GatewayError; title: string }) {
  const unsupported = error.kind === 'unsupported'
  return <div className={unsupported ? 'unsupported-card' : 'error-banner'} role="alert"><strong>{unsupported ? 'Unavailable' : `Could not load ${title}`}</strong><p>{unsupported ? 'This gateway does not provide this optional capability.' : error.message}</p></div>
}

function ResourceOverview({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <div className="data-card"><strong>{value.length} items</strong><p className="muted">Open an item to inspect or manage it when this gateway supports mutations.</p></div>
  if (!value || typeof value !== 'object') return <div className="data-card"><strong>{String(value || 'Ready')}</strong></div>

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => isSummaryValue(item))
    .slice(0, 12)
  return (
    <div className="settings-list static resource-summary">
      {entries.map(([key, item]) => <div key={key}><span><strong>{friendlyLabel(key)}</strong></span><SummaryValue value={item} /></div>)}
      {entries.length === 0 && <div><span><strong>Connected</strong><small>The gateway returned this capability without a summary.</small></span><Badge>Ready</Badge></div>}
    </div>
  )
}

function SummaryValue({ value }: { value: unknown }) {
  if (typeof value === 'boolean') return <Badge variant={value ? 'default' : 'muted'}>{value ? 'On' : 'Off'}</Badge>
  if (Array.isArray(value)) return <Badge variant="muted">{value.length}</Badge>
  if (value && typeof value === 'object') return <Badge variant="muted">{Object.keys(value).length}</Badge>
  return <small>{String(value ?? 'Not set')}</small>
}

function isSummaryValue(value: unknown): boolean {
  return value === null || ['boolean', 'number', 'string'].includes(typeof value) || Array.isArray(value) || (typeof value === 'object' && value !== null)
}

const friendlyLabel = (key: string) => key.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
