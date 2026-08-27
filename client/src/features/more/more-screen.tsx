import { IconAdjustments, IconChartBar, IconChevronRight, IconCoin, IconFile, IconFolder, IconHeartRateMonitor, IconSchool, IconUsers } from '@tabler/icons-react'

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
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Gateway administration</p><h2>More</h2></div><Badge variant="muted">Remote</Badge></header>
      <div className="settings-list capability-list">
        {MORE_PAGES.map(item => <button key={item.id} onClick={() => onSelect(item.id)}><item.icon size={20} /><span><strong>{item.title}</strong><small>{item.description}</small></span><IconChevronRight size={18} /></button>)}
      </div>
    </section>
  )
}
