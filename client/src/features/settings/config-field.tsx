import { Input, Switch, Textarea } from '~/compat/primitives'
import type { ConfigFieldSchema } from '~/lib/types'

export function ConfigField({ description, onChange, schema, value }: { description?: string; onChange(value: unknown): void; schema: ConfigFieldSchema; value: unknown }) {
  const label = description || 'Configuration value'
  if (schema.type === 'boolean') return <label className="toggle-field"><span><strong>{label}</strong>{schema.description && <small>{schema.description}</small>}</span><Switch checked={Boolean(value)} onCheckedChange={onChange} /></label>
  if (schema.type === 'select') return <label className="config-field"><span>{label}{schema.description && <small>{schema.description}</small>}</span><select onChange={event => onChange(event.target.value)} value={value == null ? '' : String(value)}><option value="">Provider default</option>{(schema.options ?? []).map(option => { const normalized = typeof option === 'object' && option !== null ? String((option as { value?: unknown }).value ?? '') : String(option); const text = typeof option === 'object' && option !== null ? String((option as { label?: unknown }).label ?? normalized) : normalized; return <option key={normalized} value={normalized}>{text}</option> })}</select></label>
  if (schema.type === 'number') return <label className="config-field"><span>{label}{schema.description && <small>{schema.description}</small>}</span><Input inputMode="decimal" onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} type="number" value={value == null ? '' : String(value)} /></label>
  if (schema.type === 'list') return <label className="config-field"><span>{label}{schema.description && <small>{schema.description}</small>}</span><Textarea onChange={event => onChange(parseList(event.target.value))} value={formatList(value)} /></label>
  return <label className="config-field"><span>{label}{schema.description && <small>{schema.description}</small>}</span><Textarea onChange={event => onChange(event.target.value)} value={value == null ? '' : String(value)} /></label>
}

function formatList(value: unknown): string {
  return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') : value == null ? '' : String(value)
}

function parseList(value: string): string[] {
  return value.split('\n').map(item => item.trim()).filter(Boolean)
}
