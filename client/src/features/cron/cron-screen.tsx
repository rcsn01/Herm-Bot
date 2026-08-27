import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { IconChevronLeft, IconPlayerPlay, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'

import { Badge, Button, Skeleton } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { cronApi, type CronJob, type CronRun } from '~/features/cron/api'
import { classifyGatewayError } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { $preferences } from '~/state/store'

export function CronScreen({ onBack }: { onBack(): void }) {
  const gateway = useGateway()
  const preferences = $preferences.get()
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const queryKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'cron', 'jobs')
  const [remove, setRemove] = useState<CronJob | null>(null)
  const jobs = useQuery({ queryFn: () => cronApi.list(gateway, profile), queryKey })
  const mutation = useMutation({
    mutationFn: async (action: { job: CronJob; type: 'pause' | 'remove' | 'resume' | 'trigger' }) => {
      if (action.type === 'remove') return cronApi.remove(gateway, profile, action.job.id)
      return cronApi[action.type](gateway, profile, action.job.id)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey })
  })
  const error = jobs.error ?? mutation.error

  return (
    <section className="screen page-screen">
      <header className="page-heading">
        <Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>
        <Button aria-label="Refresh cron jobs" onClick={() => void jobs.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>
      </header>
      <p className="eyebrow">Remote automation</p>
      <h2>Cron jobs</h2>
      <p className="muted">Jobs for the {profile || 'default'} profile. Running a job continues on the gateway if you leave this screen.</p>
      {jobs.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-20 w-full" /></div>}
      {error && <div className="error-banner" role="alert">{classifyGatewayError(error).message}</div>}
      {jobs.data?.length === 0 && <div className="empty-panel">No cron jobs exist for this profile.</div>}
      <div className="cron-job-list">
        {jobs.data?.map(job => (
          <article className="cron-job-card" key={job.id}>
            <header><div><strong>{job.name || job.prompt || 'Untitled cron job'}</strong><small>{scheduleText(job)}</small></div><Badge variant={job.enabled ? 'default' : 'muted'}>{job.enabled ? job.state || 'Active' : 'Paused'}</Badge></header>
            <dl>
              <div><dt>Next run</dt><dd>{formatTime(job.next_run_at)}</dd></div>
              <div><dt>Last run</dt><dd>{formatTime(job.last_run_at)}</dd></div>
              {job.deliver && <div><dt>Delivery</dt><dd>{job.deliver}</dd></div>}
            </dl>
            {job.last_error && <div className="error-banner" role="status">{job.last_error}</div>}
            <CronRunHistory gateway={gateway} job={job} profile={profile} scopeKey={queryKey} />
            <footer>
              <Button disabled={mutation.isPending} onClick={() => mutation.mutate({ job, type: 'trigger' })} size="sm" variant="secondary"><IconPlayerPlay size={16} /> Run now</Button>
              <Button disabled={mutation.isPending} onClick={() => mutation.mutate({ job, type: job.enabled ? 'pause' : 'resume' })} size="sm" variant="secondary">{job.enabled ? 'Pause' : 'Resume'}</Button>
              <Button aria-label={`Delete ${job.name || 'cron job'}`} disabled={mutation.isPending} onClick={() => setRemove(job)} size="sm" variant="destructive"><IconTrash size={16} /> Delete</Button>
            </footer>
          </article>
        ))}
      </div>
      {remove && <ConfirmDialog confirmLabel="Delete" description={`Delete ${remove.name || 'this cron job'}? Its run history will no longer be available from this job.`} onCancel={() => setRemove(null)} onConfirm={() => { const job = remove; setRemove(null); mutation.mutate({ job, type: 'remove' }) }} title="Delete cron job" />}
    </section>
  )
}

function CronRunHistory({ gateway, job, profile, scopeKey }: { gateway: GatewayPort; job: CronJob; profile: null | string; scopeKey: QueryKey }) {
  const [showFull, setShowFull] = useState(false)
  const history = useQuery({
    queryFn: () => cronApi.runs(gateway, profile, job.id),
    queryKey: [...scopeKey, job.id, 'runs']
  })
  const visibleRuns = showFull ? history.data : history.data?.slice(0, 3)

  return (
    <section className="cron-run-history" aria-label={`Run history for ${job.name || 'cron job'}`}>
      <div className="cron-history-heading"><strong>Recent runs</strong><Badge variant="muted">{showFull ? `Latest ${history.data?.length ?? 0}` : 'Top 3'}</Badge></div>
      {history.isPending && <Skeleton className="h-16 w-full" />}
      {history.error && <div className="error-banner" role="alert">{classifyGatewayError(history.error).message}</div>}
      {history.data?.length === 0 && <p className="muted">This job has not run yet.</p>}
      {visibleRuns?.map(run => <CronRunRow key={run.id} run={run} />)}
      {(history.data?.length ?? 0) > 3 && <Button className="cron-history-toggle" onClick={() => setShowFull(value => !value)} size="sm" variant="secondary">{showFull ? 'Show latest 3' : `Show full history (${history.data?.length})`}</Button>}
    </section>
  )
}

function CronRunRow({ run }: { run: CronRun }) {
  const status = run.is_active ? 'Running' : run.ended_at ? 'Complete' : 'Stopped'
  const milliseconds = run.started_at < 10_000_000_000 ? run.started_at * 1_000 : run.started_at
  const date = new Date(milliseconds)
  return (
    <article className="cron-run-row">
      <Badge variant={run.is_active ? 'default' : 'muted'}>{status}</Badge>
      <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
    </article>
  )
}

function scheduleText(job: CronJob): string {
  return job.schedule_display || job.schedule?.display || job.schedule?.expr || 'Schedule unavailable'
}

function formatTime(value?: null | string): string {
  if (!value) return 'Never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
