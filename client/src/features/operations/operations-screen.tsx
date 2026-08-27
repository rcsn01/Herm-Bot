import { IconCalendarClock, IconChevronRight, IconLink, IconMessages, IconRobot, IconUserCheck } from '@tabler/icons-react'

import { Badge } from '~/compat/primitives'
import { CronScreen } from '~/features/cron/cron-screen'
import { OPERATION_RESOURCES, operationById } from '~/features/operations/api'
import { RemoteResourceScreen } from '~/features/shared/remote-resource'

const ICONS = [IconCalendarClock, IconMessages, IconUserCheck, IconLink, IconRobot]

export function OperationsScreen({ selected, onBack, onSelect }: { selected?: string; onBack(): void; onSelect(id: string): void }) {
  const definition = selected ? operationById(selected) : undefined
  if (selected === 'cron') return <CronScreen onBack={onBack} />
  if (definition) return <RemoteResourceScreen definition={definition} onBack={onBack} />

  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Remote work</p><h2>Operations</h2></div><Badge variant="muted">Gateway owned</Badge></header>
      <div className="settings-list capability-list">
        {OPERATION_RESOURCES.map((item, index) => {
          const Icon = ICONS[index]
          return <button key={item.id} onClick={() => onSelect(item.id)}><Icon size={20} /><span><strong>{item.title}</strong><small>{item.description}</small></span><IconChevronRight size={18} /></button>
        })}
      </div>
    </section>
  )
}
