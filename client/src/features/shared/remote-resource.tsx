import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'

import { PageShell } from '~/components/page-shell'
import { Badge, Button, Skeleton } from '~/compat/primitives'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { useGatewayApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import { sentenceCaseLabel } from '~/lib/labels'

export type RemoteResourcePresentation = 'credentials' | 'models' | 'providers' | 'summary'

export interface RemoteResourceDefinition {
  description: string
  id: string
  path: string
  presentation?: RemoteResourcePresentation
  profileScoped?: boolean
  defaultProfileOnly?: boolean
  unavailableMessage?: string
  title: string
}

export function RemoteResourceScreen({ definition, onBack }: { definition: RemoteResourceDefinition; onBack(): void }) {
  const api = useGatewayApi()
  const isProfileScoped = definition.profileScoped !== false
  const isDefaultProfileOnly = definition.defaultProfileOnly === true
  const isUnavailableForProfile = isDefaultProfileOnly && !api.isDefaultProfile
  const query = useScopedQuery(useScopeKey(definition.id, undefined, { unscoped: !isProfileScoped }), {
    enabled: !isUnavailableForProfile,
    queryFn: signal => isProfileScoped ? api.request(definition.path, { signal }) : api.unscoped(definition.path, { signal })
  })

  return (
    <PageShell
      actions={<Button aria-label={`Refresh ${definition.title}`} disabled={isUnavailableForProfile} onClick={() => void query.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>}
      eyebrow="Remote gateway"
      leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>}
      subtitle={definition.description}
      title={definition.title}
    >
      {isUnavailableForProfile && <div className="unsupported-card" role="alert"><strong>Unavailable for this profile</strong><p>{definition.unavailableMessage ?? 'This gateway resource is process-scoped and is only available from the default profile.'}</p></div>}
      {!isUnavailableForProfile && query.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-20 w-full" /></div>}
      {!isUnavailableForProfile && query.error && <GatewayErrorBanner error={query.error} subject={definition.title} />}
      {!isUnavailableForProfile && query.data !== undefined && <ResourceOverview presentation={definition.presentation ?? 'summary'} value={query.data} />}
    </PageShell>
  )
}

function ResourceOverview({ presentation, value }: { presentation: RemoteResourcePresentation; value: unknown }) {
  const projected = projectResourceValue(value, presentation)
  if (isEmptyResource(projected)) {
    return <div className="settings-list static resource-summary"><div><span><strong>No details</strong><small>{emptyMessage(presentation)}</small></span><Badge variant="muted">Empty</Badge></div></div>
  }
  return <ResourceValue expandPrimitiveArray={presentation === 'providers'} value={projected} />
}

function ResourceValue({ expandPrimitiveArray = false, value }: { expandPrimitiveArray?: boolean; value: unknown }) {
  if (typeof value === 'boolean') return <Badge variant={value ? 'default' : 'muted'}>{value ? 'On' : 'Off'}</Badge>
  if (value === null || value === undefined) return <small>Not set</small>
  if (value === '') return <small>Empty value</small>
  if (Array.isArray(value)) {
    if (value.length === 0) return <small>Empty list</small>
    if (expandPrimitiveArray && value.every(isPrimitive)) return <small>{value.map(String).join(', ')}</small>
    return <div className="settings-list static resource-summary">{value.map((item, index) => <div key={index}><span><strong>Item {index + 1}</strong></span><ResourceValue value={item} /></div>)}</div>
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return <small>Empty record</small>
    return <div className="settings-list static resource-summary">{entries.map(([key, item]) => <div key={key}><span><strong>{friendlyLabel(key)}</strong></span><ResourceValue expandPrimitiveArray={expandPrimitiveArray} value={item} /></div>)}</div>
  }
  return <small>{String(value)}</small>
}

function projectResourceValue(value: unknown, presentation: RemoteResourcePresentation): unknown {
  if (presentation === 'summary' || presentation === 'credentials' || !value || Array.isArray(value) || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => belongsToPresentation(key, presentation)))
}

function isEmptyResource(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

const isPrimitive = (value: unknown) => value === null || ['boolean', 'number', 'string'].includes(typeof value)

function belongsToPresentation(key: string, presentation: RemoteResourcePresentation): boolean {
  if (presentation === 'summary' || presentation === 'credentials') return true
  const normalized = key.toLowerCase()
  if (presentation === 'providers') return normalized.includes('provider')
  return normalized.includes('model') || normalized.includes('context') || normalized.includes('reasoning') || normalized.includes('vision')
}

function emptyMessage(presentation: RemoteResourcePresentation): string {
  if (presentation === 'providers') return 'The gateway returned no provider information.'
  if (presentation === 'models') return 'The gateway returned no model information.'
  if (presentation === 'credentials') return 'The gateway returned no credential information.'
  return 'The gateway returned this capability without a summary.'
}

const friendlyLabel = (key: string) => sentenceCaseLabel(key)
