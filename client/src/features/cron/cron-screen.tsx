import { useQuery } from '@tanstack/react-query'
import { IconCalendarClock, IconChevronRight, IconPlus, IconRefresh } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import type { CronRoute } from '~/navigation/routes'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { CronBlueprintsScreen } from './cron-blueprints-screen'
import { CronJobDetail } from './cron-job-detail'
import { CronJobEditor } from './cron-job-editor'
import { cronApi, type CronJob } from './api'

export function CronScreen({ onBack, onNavigate, onOpenSession, route }: { onBack?: () => void; onNavigate?: (route: CronRoute) => void; onOpenSession?: (sessionId: string) => Promise<void>; route?: CronRoute }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const scopeKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'cron', 'jobs')
  const jobs = useQuery({ queryFn: ({ signal }) => cronApi.list(gateway, profile, signal), queryKey: scopeKey })
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'paused' | 'error'>('all')
  const activeRoute = route ?? { tab: 'cron', type: 'cron-root' as const }
  const navigate = onNavigate ?? (() => undefined)
  useEffect(() => {
    setSearch('')
    setStatus('all')
  }, [preferences.remoteURL, profile])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (jobs.data ?? []).filter(job => {
      const matchesText = !term || `${job.name ?? ''} ${job.prompt ?? ''} ${job.schedule_display ?? ''}`.toLowerCase().includes(term)
      const matchesStatus = status === 'all' || (status === 'active' && job.enabled && !job.last_error) || (status === 'paused' && !job.enabled) || (status === 'error' && Boolean(job.last_error))
      return matchesText && matchesStatus
    })
  }, [jobs.data, search, status])

  if (activeRoute.type === 'cron-job-detail') return <CronJobDetail jobId={activeRoute.jobId} onBack={() => onBack ? onBack() : navigate({ tab: 'cron', type: 'cron-root' })} onDeleted={() => navigate({ tab: 'cron', type: 'cron-root' })} onEdit={job => navigate({ jobId: job.id, tab: 'cron', type: 'cron-job-editor' })} onOpenSession={onOpenSession} />
  if (activeRoute.type === 'cron-job-editor') {
    const job = activeRoute.jobId ? jobs.data?.find(item => item.id === activeRoute.jobId) : undefined
    return <CronJobEditor job={job} onCancel={() => navigate({ tab: 'cron', type: 'cron-root' })} onSaved={saved => navigate({ jobId: saved.id, tab: 'cron', type: 'cron-job-detail' })} />
  }
  if (activeRoute.type === 'cron-blueprints') return <CronBlueprintsScreen onBack={() => navigate({ tab: 'cron', type: 'cron-root' })} onCreated={job => navigate({ jobId: job.id, tab: 'cron', type: 'cron-job-detail' })} />

  return <section className="screen page-screen"><header className="page-heading"><div><p className="eyebrow">Remote automation</p><h2>Cron Jobs</h2></div><div className="button-row"><Button aria-label="Refresh cron jobs" onClick={() => void jobs.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Button onClick={() => navigate({ tab: 'cron', type: 'cron-blueprints' })} size="sm" variant="secondary">Blueprints</Button><Button onClick={() => navigate({ tab: 'cron', type: 'cron-job-editor' })} size="sm"><IconPlus size={16} /> New</Button></div></header><p className="muted">Gateway-owned schedules for the {profile || 'default'} profile. Running jobs continue when you leave this screen.</p><div className="search-box"><IconCalendarClock size={17} aria-hidden="true" /><Input aria-label="Search cron jobs" onChange={event => setSearch(event.target.value)} placeholder="Search jobs" value={search} /></div><div className="filter-row"><label>Status<select aria-label="Cron job status" onChange={event => setStatus(event.target.value as typeof status)} value={status}><option value="all">All</option><option value="active">Active</option><option value="paused">Paused</option><option value="error">Needs attention</option></select></label><Badge variant="muted">{filtered.length} jobs</Badge></div>{jobs.isFetching && jobs.data && <p className="muted" role="status">Refreshing…</p>}{jobs.isStale && jobs.data && !jobs.isFetching && <p className="muted" role="status">Showing cached jobs. Pull to refresh.</p>}{jobs.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-20 w-full" /><Skeleton className="mt-2 h-20 w-full" /></div>}{jobs.error && <div className={classifyGatewayError(jobs.error).kind === 'unsupported' ? 'unsupported-card' : 'error-banner'} role="alert">{classifyGatewayError(jobs.error).kind === 'unsupported' ? 'Cron Jobs are unavailable on this gateway.' : classifyGatewayError(jobs.error).message}</div>}{jobs.data && filtered.length === 0 && <div className="empty-panel">{jobs.data.length === 0 ? 'No cron jobs exist for this profile.' : 'No cron jobs match these filters.'}</div>}<div className="cron-job-list">{filtered.map(job => <CronJobCard job={job} key={job.id} onOpen={() => navigate({ jobId: job.id, tab: 'cron', type: 'cron-job-detail' })} />)}</div></section>
}

function CronJobCard({ job, onOpen }: { job: CronJob; onOpen(): void }) {
  return <button className="cron-job-card cron-job-card-button" onClick={onOpen}><header><div><strong>{job.name || job.prompt || 'Untitled cron job'}</strong><small>{job.schedule_display || job.schedule?.display || job.schedule?.expr || 'Schedule unavailable'}</small></div><Badge variant={job.enabled ? 'default' : 'muted'}>{job.enabled ? job.state || 'Active' : 'Paused'}</Badge></header><dl><div><dt>Next run</dt><dd>{formatTime(job.next_run_at)}</dd></div><div><dt>Last run</dt><dd>{formatTime(job.last_run_at)}</dd></div></dl>{job.last_error && <p className="muted">{job.last_error}</p>}<span className="card-chevron"><IconChevronRight size={18} /></span></button>
}

function formatTime(value?: null | string): string {
  if (!value) return 'Never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
