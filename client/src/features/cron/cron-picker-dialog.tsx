import { IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'

export interface CronPickerOption {
  description?: string
  label: string
  value: string
}

export function CronPickerDialog({ multiple = false, onCancel, onSave, options, selected, title }: {
  multiple?: boolean
  onCancel(): void
  onSave(values: string[]): void
  options: CronPickerOption[]
  selected: string[]
  title: string
}) {
  const [draft, setDraft] = useState(() => new Set(selected))
  const [search, setSearch] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => { dialogRef.current?.focus() }, [])
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return term ? options.filter(option => `${option.label} ${option.description ?? ''}`.toLowerCase().includes(term)) : options
  }, [options, search])

  const choose = (value: string) => {
    if (!multiple) { setDraft(new Set([value])); return }
    setDraft(current => {
      const next = new Set(current)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }} role="presentation">
      <section aria-labelledby="cron-picker-title" aria-modal="true" className="mobile-dialog cron-picker-dialog" onKeyDown={event => { if (event.key === 'Escape') onCancel() }} ref={dialogRef} role="dialog" tabIndex={-1}>
        <h3 id="cron-picker-title">{title}</h3>
        {options.length > 6 && <label className="search-box"><IconSearch aria-hidden="true" size={17} /><Input aria-label={`Search ${title.toLowerCase()}`} onChange={event => setSearch(event.target.value)} type="search" value={search} /></label>}
        <div className="cron-picker-options" role={multiple ? 'group' : 'radiogroup'}>
          {filtered.map(option => <label className="cron-picker-option" key={option.value}><input checked={draft.has(option.value)} name={multiple ? undefined : 'cron-picker'} onChange={() => choose(option.value)} type={multiple ? 'checkbox' : 'radio'} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}
          {filtered.length === 0 && <p className="muted">No options available.</p>}
        </div>
        <div className="button-row">{!multiple && <Button onClick={() => onSave([])} variant="text">Clear</Button>}<Button onClick={onCancel} variant="secondary">Cancel</Button><Button onClick={() => onSave([...draft])}>Done</Button></div>
      </section>
    </div>
  )
}

export function CronPickerField({ label, onOpen, summary }: { label: string; onOpen(): void; summary: string }) {
  return <button className="cron-picker-field" onClick={onOpen} type="button"><span><strong>{label}</strong><small>{summary}</small></span><span aria-hidden="true">›</span></button>
}
