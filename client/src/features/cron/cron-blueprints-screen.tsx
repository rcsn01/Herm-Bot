import { useQuery } from '@tanstack/react-query'
import { IconChevronLeft } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Skeleton, Textarea } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { useScopedMutation } from '~/gateway/scope-guard'
import { profileKey } from '~/gateway/profile-path'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { createCronApi, type AutomationBlueprint, type CronJob } from './api'

export function CronBlueprintsScreen({ onBack, onCreated }: { onBack(): void; onCreated(job: CronJob): void }) {
  const cron = useApi(createCronApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const defaultProfile = profileKey(profile) === 'default'
  const key = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile: null }, 'cron', 'blueprints')
  const blueprints = useQuery({ enabled: defaultProfile, queryFn: ({ signal }) => cron.blueprints(signal), queryKey: key })
  const [selected, setSelected] = useState<AutomationBlueprint | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const create = useScopedMutation<CronJob, { blueprint: string; values: Record<string, string> }>({
    mutationFn: ({ blueprint, values: selectedValues }) => cron.instantiate(blueprint, selectedValues),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: job => onCreated(job)
  })

  useEffect(() => {
    setSelected(null)
    setValues({})
    setError(null)
  }, [preferences.remoteURL, profile])
  const choose = (blueprint: AutomationBlueprint) => { setSelected(blueprint); setValues(Object.fromEntries(blueprint.fields.map(field => [field.name, field.default ?? '']))) }

  return <section className="screen page-screen"><header className="page-heading"><Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><Badge variant="muted">Gateway catalog</Badge></header><p className="eyebrow">Cron Jobs</p><h2>Blueprints</h2><p className="muted">Start from a typed gateway blueprint; the job is created on the selected profile.</p>{!defaultProfile && <div className="unsupported-card" role="alert">Blueprint discovery is unavailable for named profiles because the gateway exposes its catalog as process-scoped configuration.</div>}{error && <div className="error-banner" role="alert">{error}</div>}{defaultProfile && blueprints.isPending && <Skeleton className="h-20 w-full" />}{defaultProfile && blueprints.error && <div className="error-banner" role="alert">{classifyGatewayError(blueprints.error).message}</div>}<div className="settings-list capability-list">{defaultProfile && blueprints.data?.blueprints.map(blueprint => <button key={blueprint.key} onClick={() => choose(blueprint)}><span><strong>{blueprint.title}</strong><small>{blueprint.description}</small><small>{blueprint.category} · {blueprint.fields.length} fields</small></span><span>›</span></button>)}{defaultProfile && blueprints.data?.blueprints.length === 0 && <div className="empty-panel">No blueprints are available.</div>}</div>{defaultProfile && selected && <form className="data-card panel-stack" onSubmit={event => { event.preventDefault(); setError(null); create.mutate({ blueprint: selected.key, values: { ...values } }) }}><h3>{selected.title}</h3>{selected.fields.map(field => <label className="config-field" key={field.name}><span>{field.label}{field.optional ? ' (optional)' : ''}<small>{field.help}</small></span>{field.type === 'text' ? <Textarea onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} value={values[field.name] ?? ''} /> : field.type === 'enum' ? <select onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} value={values[field.name] ?? ''}><option value="">Choose…</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select> : <Input onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} type={field.type === 'time' ? 'datetime-local' : 'text'} value={values[field.name] ?? ''} />}</label>)}<div className="button-row"><Button disabled={create.isPending} type="submit">{create.isPending ? 'Creating…' : 'Create job'}</Button><Button onClick={() => setSelected(null)} type="button" variant="secondary">Cancel</Button></div></form>}</section>
}
