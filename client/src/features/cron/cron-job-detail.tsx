import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconChevronRight, IconEdit, IconPlayerPlay, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'

import { Badge, Button, Skeleton } from '~/compat/primitives'
import { PageShell } from '~/components/page-shell'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedMutation, useScopedQuery, useScopeReset, useScopedTask } from '~/gateway/scope-guard'
import { createCronApi, type CronJob, type CronRun } from './api'
import { formatCronError } from './cron-job-editor'

export function CronJobDetail({ jobId, onBack, onEdit, onDeleted, onOpenSession }: { jobId: string; onBack(): void; onDeleted(): void; onEdit(job: CronJob): void; onOpenSession?: (sessionId: string) => Promise<void> }) {
  const cron = useApi(createCronApi)
  const queryClient = useQueryClient()
  const key = useScopeKey('cron', ['job', jobId])
  const runsKey = useScopeKey('cron', ['job', jobId, 'runs'])
  const cronKey = useScopeKey('cron')
  const job = useScopedQuery(key, { queryFn: signal => cron.get(jobId, signal) })
  const runs = useScopedQuery(runsKey, { queryFn: signal => cron.runs(jobId, 50, signal) })
  const [remove, setRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openingRunId, setOpeningRunId] = useState<string | null>(null)
  const taskRunner = useScopedTask()
  const action = useScopedMutation<void, 'pause' | 'remove' | 'resume' | 'trigger'>({
    mutationFn: async type => {
      if (type === 'remove') await cron.remove(jobId)
      else await cron[type](jobId)
    },
    onError: caught => setError(formatCronError(caught)),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: cronKey }) },
    onSuccess: (_value, type) => {
      setError(null)
      if (type === 'remove') { setRemove(false); onDeleted() }
    }
  })

  useScopeReset(() => {
    setRemove(false)
    setError(null)
    setOpeningRunId(null)
  }, jobId)
  const value = job.data

  const openRunSession = async (sessionId: string) => {
    if (!onOpenSession || openingRunId) return
    await taskRunner.run(async () => {
      setError(null)
      await onOpenSession(sessionId)
    }, { onBusy: busy => setOpeningRunId(busy ? sessionId : null), onError: error => setError(formatCronError(error)) })
  }

  return <PageShell actions={<><Button aria-label="Refresh cron job" onClick={() => void Promise.all([job.refetch(), runs.refetch()])} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>{value && <Badge variant={value.enabled ? 'default' : 'muted'}>{value.enabled ? value.state || 'Active' : 'Paused'}</Badge>}</>} eyebrow="Cron job" leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title={value ? (value.name || 'Untitled job') : 'Cron job'}>{job.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-24 w-full" /></div>}{job.error && <div className="error-banner" role="alert">{formatCronError(job.error)}</div>}{value && <><details className="cron-job-instructions" key={jobId}><summary>Instructions</summary><p>{value.prompt || 'No instructions'}</p></details><p className="muted cron-job-schedule">{value.schedule_display || value.schedule?.display || value.schedule?.expr || 'Schedule unavailable'}</p>{(value.provider || value.model) && <p className="muted cron-job-model">Model override: {[value.provider, value.model].filter(Boolean).join(' · ')}</p>}{value.last_error && <div className="warning-banner" role="status">{value.last_error}</div>}<div className="button-row"><Button disabled={action.isPending} onClick={() => action.mutate('trigger')}><IconPlayerPlay size={16} /> Run now</Button><Button disabled={action.isPending} onClick={() => action.mutate(value.enabled ? 'pause' : 'resume')} variant="secondary">{value.enabled ? 'Pause' : 'Resume'}</Button><Button onClick={() => onEdit(value)} variant="secondary"><IconEdit size={16} /> Edit</Button><Button disabled={action.isPending} onClick={() => setRemove(true)} variant="destructive"><IconTrash size={16} /> Delete</Button></div>{action.isPending && <p className="muted" role="status">The gateway is processing this action. Leaving this screen will not cancel it.</p>}{error && <div className="error-banner" role="alert">{error}</div>}<section className="cron-run-history"><h3>Run history</h3>{runs.isPending && <Skeleton className="h-16 w-full" />}{runs.error && <GatewayErrorBanner error={runs.error} />}{runs.data?.map(run => <RunRow disabled={openingRunId !== null} key={run.id} onOpen={onOpenSession ? () => void openRunSession(run.id) : undefined} opening={openingRunId === run.id} run={run} />)}{runs.data?.length === 0 && <p className="muted">No runs yet.</p>}</section></>}{remove && <ConfirmDialog confirmLabel="Delete" description="Delete this cron job? The gateway will stop registering future runs." onCancel={() => setRemove(false)} onConfirm={() => { setRemove(false); action.mutate('remove') }} title="Delete cron job" />}</PageShell>
}

function RunRow({ disabled, onOpen, opening, run }: { disabled: boolean; onOpen?: () => void; opening: boolean; run: CronRun }) {
  const date = new Date(run.started_at < 10_000_000_000 ? run.started_at * 1_000 : run.started_at)
  const content = <><Badge variant={run.is_active ? 'default' : 'muted'}>{opening ? 'Opening…' : run.is_active ? 'Running' : run.ended_at ? 'Complete' : 'Stopped'}</Badge><time dateTime={date.toISOString()}>{date.toLocaleString()}</time>{onOpen && <IconChevronRight aria-hidden="true" size={18} />}</>
  if (!onOpen) return <article className="cron-run-row">{content}</article>
  return <button aria-label={`Open cron session from ${date.toLocaleString()}`} className="cron-run-row cron-run-row-button" disabled={disabled} onClick={onOpen} type="button">{content}</button>
}
