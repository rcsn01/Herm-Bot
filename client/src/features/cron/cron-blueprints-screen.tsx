import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button, Input, Skeleton, Textarea } from '~/compat/primitives'
import { PageList, PageListButton } from '~/components/page-list'
import { PageShell } from '~/components/page-shell'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { useApi } from '~/gateway/gateway-api-hooks'
import { profileKey } from '~/gateway/profile-path'
import { useScopeKey, useScopedMutation, useScopedQuery, useScopeReset } from '~/gateway/scope-guard'
import { $preferences } from '~/state/store'

import { createCronApi, type AutomationBlueprint, type AutomationBlueprintField, type CronJob } from './api'

const WEEKDAYS = [
  { label: 'Mon', value: 'mon' },
  { label: 'Tue', value: 'tue' },
  { label: 'Wed', value: 'wed' },
  { label: 'Thu', value: 'thu' },
  { label: 'Fri', value: 'fri' },
  { label: 'Sat', value: 'sat' },
  { label: 'Sun', value: 'sun' }
] as const

export function CronBlueprintsScreen({ onCreated }: { onCreated(job: CronJob): void }) {
  const cron = useApi(createCronApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const defaultProfile = profileKey(profile) === 'default'
  const key = useScopeKey('cron', ['blueprints'], { unscoped: true })
  const blueprints = useScopedQuery(key, { enabled: defaultProfile, queryFn: signal => cron.blueprints(signal) })
  const [selected, setSelected] = useState<AutomationBlueprint | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const create = useScopedMutation<CronJob, { blueprint: string; values: Record<string, string> }>({
    mutationFn: ({ blueprint, values: selectedValues }) => cron.instantiate(blueprint, selectedValues),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: job => onCreated(job)
  })

  useScopeReset(() => {
    setSelected(null)
    setValues({})
    setError(null)
  })

  const choose = (blueprint: AutomationBlueprint) => {
    setSelected(blueprint)
    setValues(Object.fromEntries(blueprint.fields.map(field => [field.name, field.default ?? ''])))
    setError(null)
  }
  const updateValue = (field: string, value: string) => {
    setValues(current => ({ ...current, [field]: value }))
  }

  if (selected) {
    return (
      <PageShell
        actions={<Button onClick={() => { setSelected(null); setError(null) }} size="sm" variant="secondary">All blueprints</Button>}
        eyebrow={`${selected.category} blueprint`}
        subtitle={selected.description}
        title={selected.title}
      >
        {error && <div className="error-banner" role="alert">{error}</div>}
        <form className="data-card panel-stack blueprint-form" onSubmit={event => {
          event.preventDefault()
          const missing = selected.fields.find(field => !field.optional && !(values[field.name] ?? '').trim())
          if (missing) {
            setError(`${missing.label} is required.`)
            return
          }
          setError(null)
          create.mutate({ blueprint: selected.key, values: { ...values } })
        }}>
          {selected.fields.map(field => (
            <BlueprintField field={field} key={field.name} onChange={value => updateValue(field.name, value)} value={values[field.name] ?? ''} />
          ))}
          <div className="button-row">
            <Button disabled={create.isPending} type="submit">{create.isPending ? 'Creating…' : 'Create job'}</Button>
            <Button onClick={() => { setSelected(null); setError(null) }} type="button" variant="secondary">Cancel</Button>
          </div>
        </form>
      </PageShell>
    )
  }

  return (
    <PageShell
      eyebrow="Cron Jobs"
      subtitle="Choose a gateway blueprint, then configure it for this bot."
      title="Blueprints"
    >
      {!defaultProfile && <div className="unsupported-card" role="alert">Blueprint discovery is unavailable for named profiles because the gateway exposes its catalog as process-scoped configuration.</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {defaultProfile && blueprints.isPending && <Skeleton className="h-20 w-full" />}
      {defaultProfile && blueprints.error && <GatewayErrorBanner error={blueprints.error} />}
      <PageList className="blueprint-list">
        {defaultProfile && blueprints.data?.blueprints.map(blueprint => (
          <PageListButton
            description={blueprint.description}
            key={blueprint.key}
            meta={`${blueprint.category} · ${blueprint.fields.length} fields`}
            onClick={() => choose(blueprint)}
            title={blueprint.title}
            trailing={<span aria-hidden="true">›</span>}
          />
        ))}
        {defaultProfile && blueprints.data?.blueprints.length === 0 && <div className="empty-panel">No blueprints are available.</div>}
      </PageList>
    </PageShell>
  )
}

function BlueprintField({ field, onChange, value }: { field: AutomationBlueprintField; onChange(value: string): void; value: string }) {
  if (field.type === 'weekdays') {
    const selected = new Set(value.split(',').map(day => day.trim().toLowerCase()).filter(Boolean))
    return (
      <fieldset className="blueprint-weekdays">
        <legend>{field.label}{field.optional ? ' (optional)' : ''}</legend>
        {field.help && <small>{field.help}</small>}
        <div className="weekday-grid">
          {WEEKDAYS.map(day => (
            <label className={selected.has(day.value) ? 'selected' : ''} key={day.value}>
              <input
                checked={selected.has(day.value)}
                onChange={event => {
                  const next = new Set(selected)
                  if (event.target.checked) next.add(day.value)
                  else next.delete(day.value)
                  onChange(WEEKDAYS.filter(candidate => next.has(candidate.value)).map(candidate => candidate.value).join(','))
                }}
                type="checkbox"
              />
              <span>{day.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    )
  }

  const label = <span>{field.label}{field.optional ? ' (optional)' : ''}{field.help && <small>{field.help}</small>}</span>
  if (field.type === 'text') {
    return <label className="config-field">{label}<Textarea aria-label={field.label} onChange={event => onChange(event.target.value)} required={!field.optional} value={value} /></label>
  }
  if (field.type === 'enum') {
    if (field.strict === false) {
      const optionsId = `blueprint-${field.name}-options`
      return (
        <label className="config-field">
          {label}
          <Input aria-label={field.label} list={optionsId} onChange={event => onChange(event.target.value)} required={!field.optional} value={value} />
          <datalist id={optionsId}>{field.options.map(option => <option key={option} value={option} />)}</datalist>
        </label>
      )
    }
    return (
      <label className="config-field">
        {label}
        <select aria-label={field.label} onChange={event => onChange(event.target.value)} required={!field.optional} value={value}>
          <option value="">Choose…</option>
          {field.options.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    )
  }
  return <label className="config-field">{label}<Input aria-label={field.label} onChange={event => onChange(event.target.value)} required={!field.optional} type="time" value={value} /></label>
}
