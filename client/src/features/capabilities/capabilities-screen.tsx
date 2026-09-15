import { IconBrain, IconChevronRight, IconServer, IconSparkles, IconTools } from '@tabler/icons-react'

import { PageList, PageListButton } from '~/components/page-list'
import { PageShell } from '~/components/page-shell'
import type { CapabilitiesRoute, CapabilitySection } from '~/navigation/routes'
import { SkillsScreen } from './skills-screen'
import { SkillDetail } from './skill-detail'
import { SkillHubScreen } from './skill-hub-screen'
import { ToolsetDetail } from './toolset-detail'
import { ToolsetsScreen } from './toolsets-screen'
import { McpCatalogScreen } from './mcp-catalog-screen'
import { McpScreen } from './mcp-screen'
import type { SkillInfo, ToolsetInfo } from '~/lib/types'
import type { McpServerSummary } from './mcp-api'

const sections: ReadonlyArray<{ description: string; icon: typeof IconBrain; id: CapabilitySection; title: string }> = [
  { description: 'Installed, learned, and hub skills.', icon: IconSparkles, id: 'skills', title: 'Skills' },
  { description: 'Toolsets, providers, and setup requirements.', icon: IconTools, id: 'tools', title: 'Tools' },
  { description: 'Servers, catalog, tests, and OAuth.', icon: IconServer, id: 'mcp', title: 'MCP' }
]

interface CapabilitiesScreenProps {
  onBack(): void
  onNavigate(route: CapabilitiesRoute): void
  route: CapabilitiesRoute
}

export function CapabilitiesScreen({ onBack, onNavigate, route }: CapabilitiesScreenProps) {
  if (route.type === 'capabilities-root') {
    return <PageShell heading={false} title="Capabilities"><PageList className="capability-list">{sections.map(section => <PageListButton key={section.id} leading={<section.icon size={20} />} onClick={() => onNavigate({ section: section.id, tab: 'capabilities', type: 'capabilities-section' })} title={section.title} description={section.description} trailing={<IconChevronRight size={18} />} />)}</PageList></PageShell>
  }

  const section = route.section
  const selected = route.type === 'capability-detail' ? route.capabilityId : undefined
  const back = () => onBack()
  const navigateDetail = (capabilityId: string) => onNavigate({ capabilityId, section, tab: 'capabilities', type: 'capability-detail' })

  if (section === 'skills') {
    if (selected === 'skills-hub') return <SkillHubScreen onBack={back} />
    return <SkillsScreen onBack={back} onOpenHub={() => navigateDetail('skills-hub')} onSelect={skill => navigateDetail(`skill:${skill.name}`)} selected={selected?.startsWith('skill:') ? selected.slice(6) : undefined} />
  }
  if (section === 'tools') return <ToolsetsScreen onBack={back} onSelect={toolset => navigateDetail(`toolset:${toolset.name}`)} selected={selected?.startsWith('toolset:') ? selected.slice(8) : undefined} />
  if (selected === 'mcp-catalog') return <McpCatalogScreen onBack={back} />
  return <McpScreen onAdd={() => navigateDetail('mcp:new')} onBack={back} onOpenCatalog={() => navigateDetail('mcp-catalog')} onSelect={server => navigateDetail(`mcp:${server.name}`)} selected={selected?.startsWith('mcp:') ? selected.slice(4) : undefined} />
}

/** Kept as a small route helper so callers/tests can make links without knowing wire ids. */
export function capabilityRoute(section: CapabilitySection): CapabilitiesRoute {
  return { section, tab: 'capabilities', type: 'capabilities-section' }
}

export type { McpServerSummary, SkillInfo, ToolsetInfo }
