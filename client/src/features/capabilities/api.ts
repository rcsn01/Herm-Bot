import type { RemoteResourceDefinition } from '~/features/shared/remote-resource'

/** The three capability families that are safe to expose in the primary tab. */
export const CAPABILITY_RESOURCES = [
  { id: 'skills', title: 'Skills', path: '/api/skills', description: 'Installed skills, activation, learned content, and the skill hub.' },
  { id: 'tools', title: 'Tools', path: '/api/tools/toolsets', description: 'Toolsets, provider requirements, and setup status.' },
  { id: 'mcp', title: 'MCP', path: '/api/mcp/servers', description: 'Configured MCP servers, catalog entries, tests, and authentication.' }
] as const satisfies readonly RemoteResourceDefinition[]

export type CapabilityId = (typeof CAPABILITY_RESOURCES)[number]['id']
export const capabilityById = (id: string) => CAPABILITY_RESOURCES.find(item => item.id === id)
