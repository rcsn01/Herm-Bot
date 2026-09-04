import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconChevronRight, IconEdit, IconPlayerPlay, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Skeleton } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { cronApi, type CronJob, type CronRun } from './api'
import { formatCronError } from './cron-job-editor'

export function CronJobDetail({ jobId, onBack, onEdit, onDeleted, onOpenSession }: { jobId: string; onBack(): void; onDeleted(): void; onEdit(job: CronJob): void; onOpenSession?: (sessionId: string) => Promise<void> }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const key = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'cron', 'job', jobId)
  const job = useQuery({ queryFn: ({ signal }) => cronApi.get(gateway, profile, jobId, signal), queryKey: key })
  const runs = useQuery({ queryFn: ({ signal }) => cronApi.runs(gateway, profile, jobId, 50, signal), queryKey: [...key, 'runs'] })
  const [remove, setRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openingRunId, setOpeningRunId] = useState<string | null>(null)
  const action = useMutation<void, unknown, 'pause' | 'remove' | 'resume' | 'trigger', { scope: CurrentGatewayScope }>({
    mutationFn: async (type: 'pause' | 'remove' | 'resume' | 'trigger') => {
      if (type === 'remove') await cronApi.remove(gateway, profile, jobId)
      else await cronApi[type](gateway, profile, jobId)
    },
    onError: (caught, _type, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(formatCronError(caught)) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSettled: (_data, _error, _type, context) => { if (context && isCurrentGatewayScope(context.scope)) void queryClient.invalidateQueries({ queryKey: gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'cron') }) },
    onSuccess: (_value, type, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      setError(null)
      if (type === 'remove') { setRemove(false); onDeleted() }
    }
  })

  useEffect(() => {
    setRemove(false)
    setError(null)
    setOpeningRunId(null)
  }, [preferences.remoteURL, profile, jobId])
  const value = job.data

  const openRunSession = async (sessionId: string) => {
    if (!onOpenSession || openingRunId) return
    const scope = currentGatewayScope()
    setOpeningRunId(sessionId)
    setError(null)
    try {
      await onOpenSession(sessionId)
    } catch (caught) {
      if (isCurrentGatewayScope(scope)) setError(formatCronError(caught))
    } finally {
      if (isCurrentGatewayScope(scope)) setOpeningRunId(null)
    }
  }

  return <section className="screen page-screen"><header className="page-heading"><Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><Button aria-label="Refresh cron job" onClick={() => void Promise.all([job.refetch(), runs.refetch()])} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button></header>{job.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-24 w-full" /></div>}{job.error && <div className="error-banner" role="alert">{formatCronError(job.error)}</div>}{value && <><header className="page-heading"><div><p className="eyebrow">Cron job</p><h2>{value.name || 'Untitled job'}</h2></div><Badge variant={value.enabled ? 'default' : 'muted'}>{value.enabled ? value.state || 'Active' : 'Paused'}</Badge></header><details className="cron-job-instructions" key={jobId}><summary>Instructions</summary><p>{value.prompt || 'No instructions'}</p></details><p className="muted cron-job-schedule">{value.schedule_display || value.schedule?.display || value.schedule?.expr || 'Schedule unavailable'}</p>{(value.provider || value.model) && <p className="muted cron-job-model">Model override: {[value.provider, value.model].filter(Boolean).join(' · ')}</p>}{value.last_error && <div className="warning-banner" role="status">{value.last_error}</div>}<div className="button-row"><Button disabled={action.isPending} onClick={() => action.mutate('trigger')}><IconPlayerPlay size={16} /> Run now</Button><Button disabled={action.isPending} onClick={() => action.mutate(value.enabled ? 'pause' : 'resume')} variant="secondary">{value.enabled ? 'Pause' : 'Resume'}</Button><Button onClick={() => onEdit(value)} variant="secondary"><IconEdit size={16} /> Edit</Button><Button disabled={action.isPending} onClick={() => setRemove(true)} variant="destructive"><IconTrash size={16} /> Delete</Button></div>{action.isPending && <p className="muted" role="status">The gateway is processing this action. Leaving this screen will not cancel it.</p>}{error && <div className="error-banner" role="alert">{error}</div>}<section className="cron-run-history"><h3>Run history</h3>{runs.isPending && <Skeleton className="h-16 w-full" />}{runs.error && <div className="error-banner" role="alert">{classifyGatewayError(runs.error).message}</div>}{runs.data?.map(run => <RunRow disabled={openingRunId !== null} key={run.id} onOpen={onOpenSession ? () => void openRunSession(run.id) : undefined} opening={openingRunId === run.id} run={run} />)}{runs.data?.length === 0 && <p className="muted">No runs yet.</p>}</section></>}{remove && <ConfirmDialog confirmLabel="Delete" description="Delete this cron job? The gateway will stop registering future runs." onCancel={() => setRemove(false)} onConfirm={() => { setRemove(false); action.mutate('remove') }} title="Delete cron job" />}</section>
}

function RunRow({ disabled, onOpen, opening, run }: { disabled: boolean; onOpen?: () => void; opening: boolean; run: CronRun }) {
  const date = new Date(run.started_at < 10_000_000_000 ? run.started_at * 1_000 : run.started_at)
  const content = <><Badge variant={run.is_active ? 'default' : 'muted'}>{opening ? 'Opening…' : run.is_active ? 'Running' : run.ended_at ? 'Complete' : 'Stopped'}</Badge><time dateTime={date.toISOString()}>{date.toLocaleString()}</time>{onOpen && <IconChevronRight aria-hidden="true" size={18} />}</>
  if (!onOpen) return <article className="cron-run-row">{content}</article>
  return <button aria-label={`Open cron session from ${date.toLocaleString()}`} className="cron-run-row cron-run-row-button" disabled={disabled} onClick={onOpen} type="button">{content}</button>
}
