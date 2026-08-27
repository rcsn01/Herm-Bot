import type { RemoteResourceDefinition } from '~/features/shared/remote-resource'

export const CAPABILITY_RESOURCES = [
  { id: 'models', title: 'Models', path: '/api/model/info', description: 'Current model, available providers, assignments, and model capabilities.' },
  { id: 'providers', title: 'Providers and credentials', path: '/api/env', description: 'Redacted provider setup and credential status. Hermes Mobile never stores revealed values.' },
  { id: 'skills', title: 'Skills', path: '/api/skills', description: 'Installed skills, activation state, and update availability.' },
  { id: 'toolsets', title: 'Toolsets', path: '/api/tools/toolsets', description: 'Tools available to new sessions and their setup requirements.' },
  { id: 'mcp', title: 'MCP servers', path: '/api/mcp/servers', description: 'Configured MCP servers, health, and catalog availability.' },
  { id: 'memory', title: 'Memory', path: '/api/memory', description: 'Active memory provider, health, and profile-scoped status.' },
  { id: 'plugins', title: 'Plugins', path: '/api/dashboard/plugins', description: 'Installed agent and dashboard plugins. Desktop plugin pages are not rendered on iOS.' },
  { id: 'computer-use', title: 'Computer use', path: '/api/tools/computer-use/status', description: 'Remote computer-use reachability and permission status.' }
] as const satisfies readonly RemoteResourceDefinition[]

export type CapabilityId = (typeof CAPABILITY_RESOURCES)[number]['id']
export const capabilityById = (id: string) => CAPABILITY_RESOURCES.find(item => item.id === id)
