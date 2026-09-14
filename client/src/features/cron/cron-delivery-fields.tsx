import { useMemo, useState } from 'react'

import type { CronDeliveryTarget } from './api'
import { CronPickerDialog, CronPickerField } from './cron-picker-dialog'

export function CronDeliveryFields({ targets, value, onChange }: { onChange(value: string): void; targets: CronDeliveryTarget[]; value: string }) {
  const [open, setOpen] = useState(false)
  const selected = useMemo(() => value.split(',').map(item => item.trim()).filter(Boolean), [value])
  const options = useMemo(() => {
    const known = new Map<string, { description?: string; label: string; value: string }>()
    known.set('local', { description: 'Keep completed runs in Hermes.', label: 'Local storage', value: 'local' })
    for (const target of targets) known.set(target.id, {
      description: target.home_target_set ? undefined : 'Home channel is not configured.',
      label: target.name,
      value: target.id
    })
    for (const id of selected) if (!known.has(id)) known.set(id, { description: 'Custom target', label: id, value: id })
    return [...known.values()]
  }, [selected, targets])
  const summary = selected.length === 0 ? 'Local storage' : selected.map(id => options.find(option => option.value === id)?.label ?? id).join(', ')

  return (
    <>
      <CronPickerField label="Delivery" onOpen={() => setOpen(true)} summary={summary} />
      {open && <CronPickerDialog multiple onCancel={() => setOpen(false)} onSave={values => { onChange(values.join(',') || 'local'); setOpen(false) }} options={options} selected={selected.length ? selected : ['local']} title="Delivery targets" />}
    </>
  )
}
