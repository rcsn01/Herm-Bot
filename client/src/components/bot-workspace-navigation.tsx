import { IconBolt, IconCalendarClock, IconMessages, IconRobot } from '@tabler/icons-react'

import { Button } from '~/compat/primitives'

export type BotWorkspaceDestination = 'sessions' | 'cron' | 'capabilities' | 'model'

const destinations = [
  { icon: IconMessages, id: 'sessions', label: 'Sessions' },
  { icon: IconCalendarClock, id: 'cron', label: 'Automations' },
  { icon: IconBolt, id: 'capabilities', label: 'Capabilities' },
  { icon: IconRobot, id: 'model', label: 'Models' }
] as const satisfies ReadonlyArray<{ icon: typeof IconMessages; id: BotWorkspaceDestination; label: string }>

export function BotWorkspaceNavigation({ active, onSelect }: { active: BotWorkspaceDestination; onSelect(destination: BotWorkspaceDestination): void }) {
  return (
    <nav aria-label="Bot workspace" className="bot-workspace-navigation">
      {destinations.map(destination => (
        <Button
          aria-current={active === destination.id ? 'page' : undefined}
          aria-label={destination.label}
          className="bot-workspace-tab"
          key={destination.id}
          onClick={() => onSelect(destination.id)}
          type="button"
          variant="ghost"
        >
          <destination.icon aria-hidden="true" size={21} />
          <span>{destination.label}</span>
        </Button>
      ))}
    </nav>
  )
}
