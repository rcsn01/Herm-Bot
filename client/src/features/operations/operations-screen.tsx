import { IconCalendarClock, IconChevronRight, IconLink, IconMessages, IconRobot, IconUserCheck } from '@tabler/icons-react'

import { PageList, PageListButton } from '~/components/page-list'
import { PageShell } from '~/components/page-shell'
import { Badge } from '~/compat/primitives'
import { CronScreen } from '~/features/cron/cron-screen'
import { OPERATION_RESOURCES, operationById } from '~/features/operations/api'
import { RemoteResourceScreen } from '~/features/shared/remote-resource'
import type { WorkspaceScreenApi } from '~/navigation/use-workspace-navigation'

const ICONS = [IconCalendarClock, IconMessages, IconUserCheck, IconLink, IconRobot]

export function OperationsScreen({ selected, onBack, onSelect }: { selected?: string; onBack(): void; onSelect(id: string): void }) {
  const definition = selected ? operationById(selected) : undefined
  if (selected === 'cron') {
    // Operations embeds the cron list outside the Workspace module: static
    // root route, no in-module navigation, and the embedder owns back.
    const cronWorkspace: WorkspaceScreenApi<'cron'> = { back: onBack, navigate: () => undefined, route: { tab: 'cron', type: 'cron-root' } }
    return <CronScreen workspace={cronWorkspace} />
  }
  if (definition) return <RemoteResourceScreen definition={definition} onBack={onBack} />

  return (
    <PageShell actions={<Badge variant="muted">Gateway owned</Badge>} eyebrow="Remote work" title="Operations">
      <PageList className="capability-list">
        {OPERATION_RESOURCES.map((item, index) => {
          const Icon = ICONS[index]
          return <PageListButton key={item.id} leading={<Icon size={20} />} onClick={() => onSelect(item.id)} title={item.title} description={item.description} trailing={<IconChevronRight size={18} />} />
        })}
      </PageList>
    </PageShell>
  )
}
