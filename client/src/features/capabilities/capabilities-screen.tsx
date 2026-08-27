import { IconBrain, IconChevronRight, IconKey, IconPlug, IconRobot, IconServer, IconSparkles, IconTools } from '@tabler/icons-react'

import { Badge } from '~/compat/primitives'
import { CAPABILITY_RESOURCES, capabilityById } from '~/features/capabilities/api'
import { RemoteResourceScreen } from '~/features/shared/remote-resource'

const ICONS = [IconRobot, IconKey, IconSparkles, IconTools, IconServer, IconBrain, IconPlug, IconTools]

export function CapabilitiesScreen({ selected, onBack, onSelect }: { selected?: string; onBack(): void; onSelect(id: string): void }) {
  const definition = selected ? capabilityById(selected) : undefined
  if (definition) return <RemoteResourceScreen definition={definition} onBack={onBack} />

  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">New sessions</p><h2>Capabilities</h2></div><Badge variant="muted">Profile scoped</Badge></header>
      <p className="muted">Configure what Hermes can use. Changes to skills, tools, MCP, or memory apply to new sessions and do not rewrite the active conversation.</p>
      <div className="settings-list capability-list">
        {CAPABILITY_RESOURCES.map((item, index) => {
          const Icon = ICONS[index]
          return <button key={item.id} onClick={() => onSelect(item.id)}><Icon size={20} /><span><strong>{item.title}</strong><small>{item.description}</small></span><IconChevronRight size={18} /></button>
        })}
      </div>
    </section>
  )
}
