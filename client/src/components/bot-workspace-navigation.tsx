import { IconBolt, IconCalendarClock, IconMessages, IconRobot } from '@tabler/icons-react'

import { Button } from '~/compat/primitives'
import { WORKSPACE_DESTINATIONS, type WorkspaceDestination } from '~/navigation/workspace-navigation'

export type BotWorkspaceDestination = WorkspaceDestination

const ICONS = {
  sessions: IconMessages,
  cron: IconCalendarClock,
  capabilities: IconBolt,
  model: IconRobot
} as const satisfies Record<WorkspaceDestination, typeof IconMessages>

export function BotWorkspaceNavigation({ active, onSelect, showAutomations = true }: { active: BotWorkspaceDestination; onSelect(destination: BotWorkspaceDestination): void; showAutomations?: boolean }) {
  return (
    <nav aria-label="Bot workspace" className="bot-workspace-navigation">
      {WORKSPACE_DESTINATIONS.filter(destination => showAutomations || destination.id !== 'cron').map(destination => {
        const Icon = ICONS[destination.id]
        return (
          <Button
            aria-current={active === destination.id ? 'page' : undefined}
            aria-label={destination.label}
            className="bot-workspace-tab"
            key={destination.id}
            onClick={() => onSelect(destination.id)}
            type="button"
            variant="ghost"
          >
            <Icon aria-hidden="true" size={20} />
            <span>{destination.label}</span>
          </Button>
        )
      })}
    </nav>
  )
}