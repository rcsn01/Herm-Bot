import { IconCalendarClock, IconPlus } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { PageShell } from '~/components/page-shell'
import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery, useScopeReset } from '~/gateway/scope-guard'
import type { WorkspaceScreenApi } from '~/navigation/use-workspace-navigation'
import { CronBlueprintsScreen } from './cron-blueprints-screen'
import { CronJobDetail } from './cron-job-detail'
import { CronJobEditor } from './cron-job-editor'
import { createCronApi, type CronJob } from './api'

export function CronScreen({ onOpenSession, workspace }: { onOpenSession?: (sessionId: string) => Promise<void>; workspace: WorkspaceScreenApi<'cron'> }) {
  const cron = useApi(createCronApi)
  const scopeKey = useScopeKey('cron', ['jobs'])
  const jobs = useScopedQuery(scopeKey, { queryFn: signal => cron.list(signal) })
  const [search, setSearch] = useState('')
  const [showCreateOptions, setShowCreateOptions] = useState(false)
  const [status, setStatus] = useState<'all' | 'active' | 'paused' | 'error'>('all')
  const activeRoute = workspace.route
  const navigate = workspace.navigate
  useScopeReset(() => {
    setSearch('')
    setShowCreateOptions(false)
    setStatus('all')
  })

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (jobs.data ?? []).filter(job => {
      const matchesText = !term || `${job.name ?? ''} ${job.prompt ?? ''} ${job.schedule_display ?? ''}`.toLowerCase().includes(term)
      const matchesStatus = status === 'all' || (status === 'active' && job.enabled && !job.last_error) || (status === 'paused' && !job.enabled) || (status === 'error' && Boolean(job.last_error))
      return matchesText && matchesStatus
    })
  }, [jobs.data, search, status])

  if (activeRoute.type === 'cron-job-detail') return <CronJobDetail jobId={activeRoute.jobId} onBack={workspace.back} onDeleted={() => navigate({ tab: 'cron', type: 'cron-root' })} onEdit={job => navigate({ jobId: job.id, tab: 'cron', type: 'cron-job-editor' })} onOpenSession={onOpenSession} />
  if (activeRoute.type === 'cron-job-editor') {
    const job = activeRoute.jobId ? jobs.data?.find(item => item.id === activeRoute.jobId) : undefined
    return <CronJobEditor job={job} onCancel={() => navigate({ tab: 'cron', type: 'cron-root' })} onSaved={saved => navigate({ jobId: saved.id, tab: 'cron', type: 'cron-job-detail' })} />
  }
  if (activeRoute.type === 'cron-blueprints') return <CronBlueprintsScreen onCreated={job => navigate({ jobId: job.id, tab: 'cron', type: 'cron-job-detail' })} />

  return (
    <PageShell heading={false} title="Automations">
      <div className="search-box"><IconCalendarClock aria-hidden="true" size={17} /><Input aria-label="Search cron jobs" onChange={event => setSearch(event.target.value)} placeholder="Search jobs" value={search} /></div>
      <div className="filter-row"><label><select aria-label="Cron job status" onChange={event => setStatus(event.target.value as typeof status)} value={status}><option value="all">All</option><option value="active">Active</option><option value="paused">Paused</option><option value="error">Needs attention</option></select></label></div>
      {jobs.isFetching && jobs.data && <p className="muted" role="status">Refreshing…</p>}
      {jobs.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-20 w-full" /><Skeleton className="mt-2 h-20 w-full" /></div>}
      {jobs.error && <GatewayErrorBanner error={jobs.error} unsupportedText="Cron jobs are unavailable on this gateway." />}
      <div className="cron-job-list filtered-list">
        <Button className="cron-new-automation" onClick={() => setShowCreateOptions(true)} type="button" variant="ghost"><IconPlus aria-hidden="true" size={18} /><span>New automations</span></Button>
        {jobs.data && filtered.length === 0 && <div className="empty-panel">{jobs.data.length === 0 ? 'No cron jobs exist for this profile.' : 'No cron jobs match these filters.'}</div>}
        {filtered.map(job => <CronJobCard job={job} key={job.id} onOpen={() => navigate({ jobId: job.id, tab: 'cron', type: 'cron-job-detail' })} />)}
      </div>
      {showCreateOptions && <NewAutomationDialog
        onBlueprint={() => { setShowCreateOptions(false); navigate({ tab: 'cron', type: 'cron-blueprints' }) }}
        onCancel={() => setShowCreateOptions(false)}
        onScratch={() => { setShowCreateOptions(false); navigate({ tab: 'cron', type: 'cron-job-editor' }) }}
      />}
    </PageShell>
  )
}

function NewAutomationDialog({ onBlueprint, onCancel, onScratch }: { onBlueprint(): void; onCancel(): void; onScratch(): void }) {
  const firstChoice = useRef<HTMLButtonElement>(null)
  useEffect(() => { firstChoice.current?.focus() }, [])

  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }} role="presentation">
      <section aria-labelledby="new-automation-title" aria-modal="true" className="mobile-dialog" onKeyDown={event => { if (event.key === 'Escape') onCancel() }} role="dialog">
        <h3 id="new-automation-title">New automation</h3>
        <p>Choose how you want to create it.</p>
        <div className="automation-create-options">
          <Button onClick={onBlueprint} ref={firstChoice} variant="secondary">Use a blueprint</Button>
          <Button onClick={onScratch}>Create from scratch</Button>
        </div>
        <Button onClick={onCancel} variant="text">Cancel</Button>
      </section>
    </div>
  )
}

function CronJobCard({ job, onOpen }: { job: CronJob; onOpen(): void }) {
  return <button className="cron-job-card cron-job-card-button" onClick={onOpen}><header><div><strong>{job.name || job.prompt || 'Untitled cron job'}</strong><small>{job.schedule_display || job.schedule?.display || job.schedule?.expr || 'Schedule unavailable'}</small></div><Badge variant={job.enabled ? 'default' : 'muted'}>{job.enabled ? job.state || 'Active' : 'Paused'}</Badge></header><dl><div><dt>Next run</dt><dd>{formatTime(job.next_run_at)}</dd></div><div><dt>Last run</dt><dd>{formatTime(job.last_run_at)}</dd></div></dl>{job.last_error && <p className="muted">{job.last_error}</p>}</button>
}

function formatTime(value?: null | string): string {
  if (!value) return 'Never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
