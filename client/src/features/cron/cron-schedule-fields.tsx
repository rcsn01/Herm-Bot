import { Input } from '~/compat/primitives'

export type CronScheduleMode = 'cron' | 'duration' | 'natural' | 'once'

export interface CronScheduleValue {
  expression: string
  mode: CronScheduleMode
}

export function CronScheduleFields({ value, onChange }: { onChange(value: CronScheduleValue): void; value: CronScheduleValue }) {
  const once = value.mode === 'once'
  return <fieldset className="schedule-fields"><legend>Schedule</legend><label>Type<select aria-label="Schedule type" onChange={event => onChange({ ...value, expression: defaultExpression(event.target.value as CronScheduleMode), mode: event.target.value as CronScheduleMode })} value={value.mode}><option value="duration">Repeating interval</option><option value="natural">Natural language</option><option value="cron">Cron expression</option><option value="once">One time</option></select></label><label>{value.mode === 'duration' ? 'Duration' : value.mode === 'natural' ? 'Natural schedule' : value.mode === 'cron' ? 'Cron expression' : 'Run at'}<Input aria-label="Schedule value" onChange={event => onChange({ ...value, expression: once ? isoValue(event.target.value) : event.target.value })} placeholder={placeholder(value.mode)} type={once ? 'datetime-local' : 'text'} value={once ? localDateTimeValue(value.expression) : value.expression} /></label><p className="muted schedule-help">{help(value.mode)}</p></fieldset>
}

export function scheduleValue(schedule?: { expr?: string; kind?: string } | null): CronScheduleValue {
  const kind = schedule?.kind
  const mode: CronScheduleMode = kind === 'duration' ? 'duration' : kind === 'cron' ? 'cron' : kind === 'once' || kind === 'timestamp' ? 'once' : 'natural'
  return { expression: schedule?.expr ?? defaultExpression(mode), mode }
}

function defaultExpression(mode: CronScheduleMode): string {
  if (mode === 'duration') return '30m'
  if (mode === 'natural') return 'every day 9am'
  if (mode === 'cron') return '0 9 * * *'
  return new Date(Date.now() + 60 * 60 * 1_000).toISOString()
}

function placeholder(mode: CronScheduleMode): string {
  if (mode === 'duration') return '30m'
  if (mode === 'natural') return 'every monday 9am'
  if (mode === 'cron') return '0 9 * * *'
  return '2026-01-01T09:00:00Z'
}

function localDateTimeValue(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function isoValue(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

function help(mode: CronScheduleMode): string {
  if (mode === 'duration') return 'Runs after the duration and repeats when the backend schedule supports it.'
  if (mode === 'natural') return 'Use the same natural-language schedule accepted by hermes cron.'
  if (mode === 'cron') return 'Five-field cron expression evaluated by the gateway.'
  return 'One-shot schedules use an ISO-8601 timestamp and are never scheduled on the device.'
}
