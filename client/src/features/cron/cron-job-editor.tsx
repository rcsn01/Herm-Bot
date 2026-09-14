import { useMemo, useState, type FormEvent } from 'react'

import { PageShell } from '~/components/page-shell'
import { Button, Input, Skeleton, Switch, Textarea } from '~/compat/primitives'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedMutation, useScopedQuery, useScopeReset } from '~/gateway/scope-guard'
import { profileKey } from '~/gateway/profile-path'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { createSkillsApi } from '~/features/capabilities/skills-api'
import { createToolsetsApi } from '~/features/capabilities/toolsets-api'
import { createModelsApi } from '~/features/models/api'
import { createCronApi, type CronJob, type CronJobCreate } from './api'
import { CronDeliveryFields } from './cron-delivery-fields'
import { CronPickerDialog, CronPickerField, type CronPickerOption } from './cron-picker-dialog'
import { CronScheduleFields, scheduleValue, type CronScheduleValue } from './cron-schedule-fields'

export function CronJobEditor({ job, onCancel, onSaved }: { job?: CronJob; onCancel(): void; onSaved(job: CronJob): void }) {
  const cron = useApi(createCronApi)
  const skillsApi = useApi(createSkillsApi)
  const toolsetsApi = useApi(createToolsetsApi)
  const modelsApi = useApi(createModelsApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const defaultProfile = profileKey(profile) === 'default'
  const targetsKey = useScopeKey('cron', ['delivery-targets'], { unscoped: true })
  const skillsKey = useScopeKey('cron-editor', ['skills'])
  const toolsetsKey = useScopeKey('cron-editor', ['toolsets'])
  const modelsKey = useScopeKey('cron-editor', ['models'])
  const jobsKey = useScopeKey('cron', ['jobs'])
  const targets = useScopedQuery(targetsKey, { enabled: defaultProfile, queryFn: signal => cron.deliveryTargets(signal) })
  const availableSkills = useScopedQuery(skillsKey, { queryFn: signal => skillsApi.list(signal) })
  const availableToolsets = useScopedQuery(toolsetsKey, { queryFn: signal => toolsetsApi.list(signal) })
  const availableModels = useScopedQuery(modelsKey, { queryFn: signal => modelsApi.getOptions(signal) })
  const availableJobs = useScopedQuery(jobsKey, { queryFn: signal => cron.list(signal) })
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
  const [picker, setPicker] = useState<null | 'context' | 'model' | 'provider' | 'skills' | 'toolsets'>(null)
  const [error, setError] = useState<string | null>(null)
  const mutation = useScopedMutation<CronJob, CronJobCreate & { enabled?: boolean }>({
    mutationFn: async body => {
      if (job) return cron.update(job.id, body)
      const { enabled: requestedEnabled, ...createBody } = body
      const created = await cron.create(createBody)
      if (requestedEnabled === false) return cron.pause(created.id)
      return created
    },
    onError: caught => setError(formatCronError(caught)),
    onSuccess: value => onSaved(value)
  })

  useScopeReset(() => {
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
    setPicker(null)
    setError(null)
  }, job?.id)

  const skillOptions = useMemo<CronPickerOption[]>(() => (availableSkills.data ?? []).map(skill => ({ description: skill.description, label: skill.name, value: skill.name })), [availableSkills.data])
  const toolsetOptions = useMemo<CronPickerOption[]>(() => (availableToolsets.data ?? []).map(toolset => ({ description: toolset.description, label: toolset.label || toolset.name, value: toolset.name })), [availableToolsets.data])
  const providerOptions = useMemo<CronPickerOption[]>(() => (availableModels.data?.providers ?? []).map(item => ({ label: item.name || item.slug, value: item.slug })), [availableModels.data])
  const modelOptions = useMemo<CronPickerOption[]>(() => (availableModels.data?.providers ?? []).find(item => item.slug === provider)?.models?.map(value => ({ label: value, value })) ?? [], [availableModels.data, provider])
  const contextOptions = useMemo<CronPickerOption[]>(() => (availableJobs.data ?? []).filter(item => item.id !== job?.id).map(item => ({ description: item.schedule_display || item.schedule?.display, label: item.name || item.prompt || 'Untitled job', value: item.id })), [availableJobs.data, job?.id])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!prompt.trim()) { setError('A prompt is required.'); return }
    if (!schedule.expression.trim()) { setError('A schedule is required.'); return }
    const body: CronJobCreate & { enabled?: boolean } = {
      context_from: contextFrom.trim() || undefined,
      deliver: deliver.trim() || 'local',
      enabled,
      model: job ? model.trim() || null : model.trim() || undefined,
      name: name.trim() || undefined,
      no_agent: noAgent,
      prompt: prompt.trim(),
      provider: job ? provider.trim() || null : provider.trim() || undefined,
      schedule: schedule.expression.trim(),
      script: script.trim() || undefined,
      skills: splitList(skills),
      enabled_toolsets: splitList(toolsets),
      workdir: workdir.trim() || undefined
    }
    mutation.mutate(body)
  }

  return (
    <PageShell heading={false} title={job ? 'Edit job' : 'New job'}>
      <form className="cron-job-form" onSubmit={submit}>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <label className="config-field"><span>Name</span><Input onChange={event => setName(event.target.value)} placeholder="Morning briefing" value={name} /></label>
        <label className="config-field"><span>Prompt</span><Textarea onChange={event => setPrompt(event.target.value)} placeholder="Ask Hermes to…" required value={prompt} /></label>
        <CronScheduleFields onChange={setSchedule} value={schedule} />
        <CronDeliveryFields onChange={setDeliver} targets={defaultProfile ? targets.data ?? [] : []} value={deliver} />
        {!defaultProfile && <div className="unsupported-card" role="alert">Delivery target discovery is unavailable for named profiles. Local storage remains available.</div>}
        {defaultProfile && targets.isPending && <Skeleton className="h-8 w-full" />}
        {defaultProfile && targets.error && <GatewayErrorBanner error={targets.error} unsupportedText="Delivery targets are unavailable on this gateway." />}

        <CronPickerField label="Skills" onOpen={() => setPicker('skills')} summary={selectionSummary(splitList(skills), skillOptions, 'No skills selected')} />

        <section className="cron-editor-section">
          <h3>Model override</h3>
          <CronPickerField label="Provider" onOpen={() => setPicker('provider')} summary={selectionSummary(provider ? [provider] : [], providerOptions, 'Use profile default')} />
          <CronPickerField label="Model" onOpen={() => setPicker(provider ? 'model' : 'provider')} summary={provider ? selectionSummary(model ? [model] : [], modelOptions, 'Choose a model') : 'Choose a provider first'} />
        </section>

        <details className="cron-editor-section">
          <summary>Advanced options</summary>
          <div className="cron-editor-advanced">
            <CronPickerField label="Context job" onOpen={() => setPicker('context')} summary={selectionSummary(contextFrom ? [contextFrom] : [], contextOptions, 'No context job')} />
            <CronPickerField label="Toolsets" onOpen={() => setPicker('toolsets')} summary={selectionSummary(splitList(toolsets), toolsetOptions, 'No toolsets selected')} />
            <label className="config-field"><span>Pre-run script</span><Textarea onChange={event => setScript(event.target.value)} value={script} /></label>
            <label className="config-field"><span>Remote work directory</span><Input onChange={event => setWorkdir(event.target.value)} value={workdir} /></label>
            <label className="toggle-field"><span><strong>No agent</strong><small>Use the script as the entire job.</small></span><Switch checked={noAgent} onCheckedChange={setNoAgent} /></label>
          </div>
        </details>

        <label className="toggle-field cron-enabled-field"><span><strong>Enabled</strong><small>Register this automation with the gateway scheduler.</small></span><Switch checked={enabled} onCheckedChange={setEnabled} /></label>
        <div className="cron-editor-actions"><Button disabled={mutation.isPending} type="submit">{mutation.isPending ? 'Saving…' : job ? 'Save changes' : 'Create job'}</Button><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button></div>
      </form>

      {picker === 'skills' && <CronPickerDialog multiple onCancel={() => setPicker(null)} onSave={values => { setSkills(values.join(', ')); setPicker(null) }} options={preserveSelected(skillOptions, splitList(skills))} selected={splitList(skills)} title="Choose skills" />}
      {picker === 'toolsets' && <CronPickerDialog multiple onCancel={() => setPicker(null)} onSave={values => { setToolsets(values.join(', ')); setPicker(null) }} options={preserveSelected(toolsetOptions, splitList(toolsets))} selected={splitList(toolsets)} title="Choose toolsets" />}
      {picker === 'provider' && <CronPickerDialog onCancel={() => setPicker(null)} onSave={values => { const next = values[0] ?? ''; if (next !== provider) setModel(''); setProvider(next); setPicker(null) }} options={preserveSelected(providerOptions, provider ? [provider] : [])} selected={provider ? [provider] : []} title="Choose provider" />}
      {picker === 'model' && <CronPickerDialog onCancel={() => setPicker(null)} onSave={values => { setModel(values[0] ?? ''); setPicker(null) }} options={preserveSelected(modelOptions, model ? [model] : [])} selected={model ? [model] : []} title="Choose model" />}
      {picker === 'context' && <CronPickerDialog onCancel={() => setPicker(null)} onSave={values => { setContextFrom(values[0] ?? ''); setPicker(null) }} options={preserveSelected(contextOptions, contextFrom ? [contextFrom] : [])} selected={contextFrom ? [contextFrom] : []} title="Choose context job" />}
    </PageShell>
  )
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function preserveSelected(options: CronPickerOption[], selected: string[]): CronPickerOption[] {
  const known = new Set(options.map(option => option.value))
  return [...selected.filter(value => !known.has(value)).map(value => ({ label: value, value })), ...options]
}

function selectionSummary(selected: string[], options: CronPickerOption[], empty: string): string {
  if (selected.length === 0) return empty
  const labels = selected.map(value => options.find(option => option.value === value)?.label ?? value)
  return labels.length > 2 ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}` : labels.join(', ')
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
