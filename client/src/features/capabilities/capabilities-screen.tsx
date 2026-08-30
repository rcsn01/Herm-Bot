import { IconBrain, IconChevronRight, IconServer, IconSparkles, IconTools } from '@tabler/icons-react'

import { Badge, Button } from '~/compat/primitives'
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
    return <section className="screen page-screen"><header className="page-heading"><div><p className="eyebrow">New sessions</p><h2>Capabilities</h2></div><Badge variant="muted">Profile scoped</Badge></header><p className="muted">Choose what Hermes can use. Capability changes apply to new sessions and never rebuild the active conversation.</p><div className="settings-list capability-list">{sections.map(section => <button key={section.id} onClick={() => onNavigate({ section: section.id, tab: 'capabilities', type: 'capabilities-section' })}><section.icon size={20} /><span><strong>{section.title}</strong><small>{section.description}</small></span><IconChevronRight size={18} /></button>)}</div></section>
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
  return <McpScreen onBack={back} onOpenCatalog={() => navigateDetail('mcp-catalog')} onSelect={server => navigateDetail(`mcp:${server.name}`)} selected={selected?.startsWith('mcp:') ? selected.slice(4) : undefined} />
}

/** Kept as a small route helper so callers/tests can make links without knowing wire ids. */
export function capabilityRoute(section: CapabilitySection): CapabilitiesRoute {
  return { section, tab: 'capabilities', type: 'capabilities-section' }
}

export type { McpServerSummary, SkillInfo, ToolsetInfo }
