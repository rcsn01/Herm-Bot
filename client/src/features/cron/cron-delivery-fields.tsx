import { useMemo } from 'react'

import { Badge, Input } from '~/compat/primitives'
import type { CronDeliveryTarget } from './api'

export function CronDeliveryFields({ targets, value, onChange }: { onChange(value: string): void; targets: CronDeliveryTarget[]; value: string }) {
  const selected = useMemo(() => new Set(value.split(',').map(item => item.trim()).filter(Boolean)), [value])
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next].join(','))
  }
  return <fieldset className="delivery-fields"><legend>Delivery</legend><p className="muted">The gateway delivers after the job finishes. Choose local storage or configured platform targets.</p><div className="delivery-targets">{targets.map(target => <label className="delivery-target" key={target.id}><input checked={selected.has(target.id)} onChange={() => toggle(target.id)} type="checkbox" /><span><strong>{target.name}</strong>{!target.home_target_set && <small>Home channel is not configured</small>}</span></label>)}{targets.length === 0 && <Badge variant="muted">No delivery targets reported</Badge>}</div><label>Custom target expression (optional)<Input onChange={event => onChange(event.target.value)} placeholder="origin,local,telegram" value={value} /></label></fieldset>
}
