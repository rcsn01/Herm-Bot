import { IconAdjustments, IconChartBar, IconChevronRight, IconCoin, IconFile, IconFolder, IconHeartRateMonitor, IconSchool, IconUsers } from '@tabler/icons-react'

import { PageList, PageListButton } from '~/components/page-list'
import { PageShell } from '~/components/page-shell'
import { Badge } from '~/compat/primitives'

export const MORE_PAGES = [
  { id: 'projects', title: 'Projects and files', description: 'Remote projects, files, Git, and artifacts.', icon: IconFolder },
  { id: 'profiles', title: 'Profiles', description: 'Profiles, souls, models, and capabilities.', icon: IconUsers },
  { id: 'learning', title: 'Learning', description: 'Memory and skill relationships.', icon: IconSchool },
  { id: 'system', title: 'System', description: 'Gateway health, updates, maintenance, and backups.', icon: IconHeartRateMonitor },
  { id: 'logs', title: 'Logs', description: 'Filter remote gateway logs.', icon: IconFile },
  { id: 'usage', title: 'Usage', description: 'Activity, token usage, tools, and cost.', icon: IconChartBar },
  { id: 'billing', title: 'Billing', description: 'Subscription and account billing when supported.', icon: IconCoin },
  { id: 'settings', title: 'Settings', description: 'Remote configuration and mobile preferences.', icon: IconAdjustments }
] as const

export type MorePageId = (typeof MORE_PAGES)[number]['id']

export function MoreScreen({ onSelect }: { onSelect(id: MorePageId): void }) {
  return (
    <PageShell actions={<Badge variant="muted">Remote</Badge>} eyebrow="Gateway administration" title="More">
      <PageList className="capability-list">
        {MORE_PAGES.map(item => <PageListButton key={item.id} leading={<item.icon size={20} />} onClick={() => onSelect(item.id)} title={item.title} description={item.description} trailing={<IconChevronRight size={18} />} />)}
      </PageList>
    </PageShell>
  )
}
