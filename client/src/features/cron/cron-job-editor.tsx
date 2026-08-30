import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'

import { Badge, Button, Input, Skeleton, Switch, Textarea } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { profileKey } from '~/gateway/profile-path'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { cronApi, type CronJob, type CronJobCreate, type CronJobUpdate } from './api'
import { CronDeliveryFields } from './cron-delivery-fields'
import { CronScheduleFields, scheduleValue, type CronScheduleValue } from './cron-schedule-fields'

export function CronJobEditor({ job, onCancel, onSaved }: { job?: CronJob; onCancel(): void; onSaved(job: CronJob): void }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const defaultProfile = profileKey(profile) === 'default'
  const targets = useQuery({ enabled: defaultProfile, queryFn: ({ signal }) => cronApi.deliveryTargets(gateway, profile, signal), queryKey: gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: null }, 'cron', 'delivery-targets') })
  const initialSchedule = scheduleValue(job?.schedule)
  const [name, setName] = useState(job?.name ?? '')
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [schedule, setSchedule] = useState<CronScheduleValue>(initialSchedule)
  const [deliver, setDeliver] = useState(job?.deliver ?? 'local')
  const [enabled, setEnabled] = useState(job?.enabled ?? true)
  const [skills, setSkills] = useState((job?.skills ?? []).join(', '))
  const [model, setModel] = useState(job?.model ?? '')
  const [provider, setProvider] = useState(job?.provider ?? '')
  const [script, setScript] = useState(job?.script ?? '')
  const [contextFrom, setContextFrom] = useState(job?.context_from ?? '')
  const [workdir, setWorkdir] = useState(job?.workdir ?? '')
  const [toolsets, setToolsets] = useState((job?.enabled_toolsets ?? []).join(', '))
  const [noAgent, setNoAgent] = useState(job?.no_agent ?? false)
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation<CronJob, unknown, CronJobCreate & { enabled?: boolean }, { scope: CurrentGatewayScope }>({
    mutationFn: async body => {
      if (job) return cronApi.update(gateway, profile, job.id, body)
      const { enabled: requestedEnabled, ...createBody } = body
      const created = await cronApi.create(gateway, profile, createBody)
      if (requestedEnabled === false) return cronApi.pause(gateway, profile, created.id)
      return created
    },
    onError: (caught, _body, context) => { if (context && isCurrentGatewayScope(context.scope)) setError(formatCronError(caught)) },
    onMutate: () => ({ scope: currentGatewayScope() }),
    onSuccess: (value, _body, context) => { if (context && isCurrentGatewayScope(context.scope)) onSaved(value) }
  })

  useEffect(() => {
    // A route can be reused for a different job after a profile refresh. Reset
    // all drafts rather than leaking the previous job into the new profile.
    setName(job?.name ?? '')
    setPrompt(job?.prompt ?? '')
    setSchedule(scheduleValue(job?.schedule))
    setDeliver(job?.deliver ?? 'local')
    setEnabled(job?.enabled ?? true)
    setSkills((job?.skills ?? []).join(', '))
    setModel(job?.model ?? '')
    setProvider(job?.provider ?? '')
    setScript(job?.script ?? '')
    setContextFrom(job?.context_from ?? '')
    setWorkdir(job?.workdir ?? '')
    setToolsets((job?.enabled_toolsets ?? []).join(', '))
    setNoAgent(job?.no_agent ?? false)
    setError(null)
  }, [job?.id, preferences.remoteURL, profile])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!prompt.trim()) { setError('A prompt is required.'); return }
    if (!schedule.expression.trim()) { setError('A schedule is required.'); return }
    const body: CronJobCreate & { enabled?: boolean } = {
      context_from: contextFrom.trim() || undefined,
      deliver: deliver.trim() || 'local',
      enabled,
      model: model.trim() || undefined,
      name: name.trim() || undefined,
      no_agent: noAgent,
      prompt: prompt.trim(),
      provider: provider.trim() || undefined,
      schedule: schedule.expression.trim(),
      script: script.trim() || undefined,
      skills: splitList(skills),
      enabled_toolsets: splitList(toolsets),
      workdir: workdir.trim() || undefined
    }
    mutation.mutate(body)
  }

  return <form className="panel-stack" onSubmit={submit}><header className="page-heading"><div><p className="eyebrow">Cron Jobs</p><h2>{job ? 'Edit job' : 'New job'}</h2></div><Badge variant="muted">{profile || 'default'} profile</Badge></header>{error && <div className="error-banner" role="alert">{error}</div>}<label className="config-field"><span>Name</span><Input onChange={event => setName(event.target.value)} placeholder="Morning briefing" value={name} /></label><label className="config-field"><span>Prompt</span><Textarea onChange={event => setPrompt(event.target.value)} placeholder="Ask Hermes to…" value={prompt} /></label><CronScheduleFields onChange={setSchedule} value={schedule} /><CronDeliveryFields onChange={setDeliver} targets={defaultProfile ? targets.data ?? [] : []} value={deliver} />{!defaultProfile && <div className="unsupported-card" role="alert">Delivery target discovery is unavailable for named profiles because the gateway exposes it as process-scoped configuration. The local target remains available.</div>}{defaultProfile && targets.isPending && <Skeleton className="h-8 w-full" />}{defaultProfile && targets.error && <div className={classifyGatewayError(targets.error).kind === 'unsupported' ? 'unsupported-card' : 'error-banner'} role="alert">{classifyGatewayError(targets.error).kind === 'unsupported' ? 'Delivery targets are unavailable on this gateway.' : classifyGatewayError(targets.error).message}</div>}<label className="config-field"><span>Skills (comma separated)</span><Input onChange={event => setSkills(event.target.value)} value={skills} /></label><section className="data-card"><h3>Model overrides</h3><div className="form-grid"><label className="config-field"><span>Provider</span><Input onChange={event => setProvider(event.target.value)} value={provider} /></label><label className="config-field"><span>Model</span><Input onChange={event => setModel(event.target.value)} value={model} /></label></div></section><details className="data-card"><summary>Advanced options</summary><div className="panel-stack"><label className="config-field"><span>Pre-run script</span><Textarea onChange={event => setScript(event.target.value)} value={script} /></label><label className="config-field"><span>Context from job ID</span><Input onChange={event => setContextFrom(event.target.value)} value={contextFrom} /></label><label className="config-field"><span>Remote work directory</span><Input onChange={event => setWorkdir(event.target.value)} value={workdir} /></label><label className="config-field"><span>Toolsets (comma separated)</span><Input onChange={event => setToolsets(event.target.value)} value={toolsets} /></label><label className="toggle-field"><span><strong>No agent</strong><small>Use the script as the entire job.</small></span><Switch checked={noAgent} onCheckedChange={setNoAgent} /></label></div></details><label className="toggle-field"><span><strong>Enabled</strong><small>Scheduler registration happens on the gateway.</small></span><Switch checked={enabled} onCheckedChange={setEnabled} /></label><div className="button-row"><Button disabled={mutation.isPending} type="submit">{mutation.isPending ? 'Saving…' : job ? 'Save changes' : 'Create job'}</Button><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button></div></form>
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

export function formatCronError(error: unknown): string {
  const classified = classifyGatewayError(error)
  if (classified.status === 424) return `Job was saved but scheduler registration failed: ${classified.message}`
  if (classified.status === 400 || classified.status === 422) {
    const details = classified.details
    return `${classified.message}${details ? ` — ${typeof details === 'string' ? details : JSON.stringify(details)}` : ''}`
  }
  if (classified.status === 409) return `This job is already claimed by another runner. Try again later; no automatic retry was made.`
  return classified.message
}
