import { useStore } from '@nanostores/react'
import { IconBolt, IconCalendarClock, IconChevronLeft, IconChevronRight, IconRobot } from '@tabler/icons-react'

import { Button } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { $preferences } from '~/state/store'

interface BotScreenProps {
  onBack(): void
  onOpenCapabilities(): void
  onOpenCronJobs(): void
  onOpenModel(): void
}

/** Per-bot surface: one gateway profile owns its capabilities and cron routines. */
export function BotScreen({ onBack, onOpenCapabilities, onOpenCronJobs, onOpenModel }: BotScreenProps) {
  const preferences = useStore($preferences)
  return (
    <section className="screen page-screen bot-screen">
      <header className="page-heading">
        <Button aria-label="Back to chat" onClick={onBack} size="icon-sm" variant="ghost"><IconChevronLeft size={20} /></Button>
      </header>
      <div className="bot-identity">
        <BrandMark />
        <div>
          <h2>{preferences.profile || 'default'}</h2>
          <p className="muted">Hermes bot profile</p>
        </div>
      </div>
      <div className="settings-list capability-list">
        <button onClick={onOpenCapabilities}>
          <IconBolt size={20} />
          <span><strong>Capabilities</strong><small>Skills, tools, and MCP servers this bot can use.</small></span>
          <IconChevronRight size={18} />
        </button>
        <button onClick={onOpenCronJobs}>
          <IconCalendarClock size={20} />
          <span><strong>Cron Jobs</strong><small>Scheduled routines owned by this bot.</small></span>
          <IconChevronRight size={18} />
        </button>
        <button onClick={onOpenModel}>
          <IconRobot size={20} />
          <span><strong>Model</strong><small>Model assignment and provider defaults.</small></span>
          <IconChevronRight size={18} />
        </button>
      </div>
    </section>
  )
}