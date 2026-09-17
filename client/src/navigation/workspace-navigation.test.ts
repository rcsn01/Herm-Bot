import { beforeEach, describe, expect, it } from 'vitest'

import source from './workspace-navigation.ts?raw'

import { $navigation, applyPathState, resetNavigation } from './navigation-store'
import { ROOT_ROUTES } from './routes'
import {
  isAppShellScreenPath,
  narrowRoute,
  restoreWorkspacePath,
  SCREEN_URL_HEADS,
  workspaceBackLabel,
  workspaceDestinationFor,
  workspaceMenuIntent,
  workspaceRouteTitle,
  workspaceTabTitle,
  WORKSPACE_DESTINATIONS
} from './workspace-navigation'

const VALID_SCREEN_PATHS: Record<string, string> = {
  group: '/group/id%3Ar-crew',
  sessions: '/sessions',
  capabilities: '/capabilities/mcp',
  cron: '/cron/job-1/edit',
  settings: '/settings/model'
}

const REJECTED_SCREEN_PATHS = [
  '/session/abc',
  '/session/abc?profile=work',
  '/nope',
  '/bot',
  '/bot/extra',
  '/capabilities/nope',
  '/capabilities/%',
  '/group',
  '/group/a/b',
  '/settings/nope',
  '/unknown'
]

beforeEach(() => resetNavigation())

describe('WORKSPACE_DESTINATIONS', () => {
  it('lists the bottom-nav destinations in DOM order with their labels', () => {
    expect(WORKSPACE_DESTINATIONS).toEqual([
      { id: 'sessions', label: 'Sessions' },
      { id: 'cron', label: 'Automations' },
      { id: 'capabilities', label: 'Capabilities' },
      { id: 'model', label: 'Models' }
    ])
  })
})

describe('workspaceTabTitle', () => {
  it('titles every tab', () => {
    expect(workspaceTabTitle('roster')).toBe('Hermes')
    expect(workspaceTabTitle('capabilities')).toBe('Capabilities')
    expect(workspaceTabTitle('cron')).toBe('Automations')
    expect(workspaceTabTitle('settings')).toBe('Settings')
    expect(workspaceTabTitle('sessions')).toBe('Sessions')
  })
})

describe('workspaceRouteTitle', () => {
  it('titles cron routes', () => {
    expect(workspaceRouteTitle('cron', { type: 'cron-job-detail', tab: 'cron', jobId: 'job-1' })).toBe('Job details')
    expect(workspaceRouteTitle('cron', { type: 'cron-job-editor', tab: 'cron', jobId: 'job-1' })).toBe('Edit job')
    expect(workspaceRouteTitle('cron', { type: 'cron-job-editor', tab: 'cron' })).toBe('New job')
    expect(workspaceRouteTitle('cron', { type: 'cron-blueprints', tab: 'cron' })).toBe('Blueprints')
    expect(workspaceRouteTitle('cron', { type: 'cron-root', tab: 'cron' })).toBe('Automations')
  })

  it('titles capability routes, including special detail ids and prefixes', () => {
    expect(workspaceRouteTitle('capabilities', { type: 'capabilities-section', tab: 'capabilities', section: 'mcp' })).toBe('MCP')
    expect(workspaceRouteTitle('capabilities', { type: 'capabilities-section', tab: 'capabilities', section: 'skills' })).toBe('Skills')
    expect(workspaceRouteTitle('capabilities', { type: 'capabilities-section', tab: 'capabilities', section: 'tools' })).toBe('Tools')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'skills', capabilityId: 'skills-hub' })).toBe('Skill hub')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'mcp', capabilityId: 'mcp-catalog' })).toBe('MCP catalog')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'mcp', capabilityId: 'mcp:new' })).toBe('Add server')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'skills', capabilityId: 'skill:cookie' })).toBe('cookie')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'skills', capabilityId: 'skill:' })).toBe('Skill')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'tools', capabilityId: 'toolset:browser' })).toBe('browser')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'tools', capabilityId: 'toolset:' })).toBe('Toolset')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'mcp', capabilityId: 'mcp:Server One' })).toBe('Server One')
    expect(workspaceRouteTitle('capabilities', { type: 'capability-detail', tab: 'capabilities', section: 'mcp', capabilityId: 'mcp:' })).toBe('MCP server')
    expect(workspaceRouteTitle('capabilities', { type: 'capabilities-root', tab: 'capabilities' })).toBe('Capabilities')
  })

  it('lets the route branch win over the destination fallback and falls back otherwise', () => {
    // Verbatim quirk: the route-type branches run regardless of destination.
    expect(workspaceRouteTitle('model', { type: 'cron-job-detail', tab: 'cron', jobId: 'job-1' })).toBe('Job details')
    expect(workspaceRouteTitle('model', { type: 'settings-category', tab: 'settings', category: 'model' })).toBe('Models')
  })
})

describe('workspaceDestinationFor', () => {
  it('maps bot-configuration surfaces and null elsewhere', () => {
    expect(workspaceDestinationFor('capabilities', { type: 'capabilities-section', tab: 'capabilities', section: 'skills' })).toBe('capabilities')
    expect(workspaceDestinationFor('cron', { type: 'cron-job-editor', tab: 'cron' })).toBe('cron')
    expect(workspaceDestinationFor('settings', { type: 'settings-category', tab: 'settings', category: 'model' })).toBe('model')
    expect(workspaceDestinationFor('settings', { type: 'settings-root', tab: 'settings' })).toBeNull()
    expect(workspaceDestinationFor('settings', { type: 'settings-administration', tab: 'settings', page: 'profiles' })).toBeNull()
    expect(workspaceDestinationFor('roster', { type: 'roster-root', tab: 'roster' })).toBeNull()
    expect(workspaceDestinationFor('sessions', { type: 'sessions-root', tab: 'sessions' })).toBeNull()
  })
})

describe('narrowRoute', () => {
  it('passes matching routes through and falls back to each tab root for foreign routes', () => {
    const capabilitiesRoute = { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' } as const
    const cronRoute = { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' } as const
    const settingsRoute = { page: 'profiles', tab: 'settings', type: 'settings-administration' } as const

    expect(narrowRoute('capabilities', capabilitiesRoute)).toBe(capabilitiesRoute)
    expect(narrowRoute('cron', cronRoute)).toBe(cronRoute)
    expect(narrowRoute('settings', settingsRoute)).toBe(settingsRoute)

    expect(narrowRoute('capabilities', cronRoute)).toEqual(ROOT_ROUTES.capabilities)
    expect(narrowRoute('cron', capabilitiesRoute)).toEqual(ROOT_ROUTES.cron)
    expect(narrowRoute('settings', capabilitiesRoute)).toEqual(ROOT_ROUTES.settings)
  })
})

describe('workspaceMenuIntent', () => {
  it('maps the model pseudo-destination and passes tabs through', () => {
    expect(workspaceMenuIntent('model')).toEqual({ type: 'model' })
    expect(workspaceMenuIntent('cron')).toEqual({ type: 'tab', tab: 'cron' })
    expect(workspaceMenuIntent('capabilities')).toEqual({ type: 'tab', tab: 'capabilities' })
    expect(workspaceMenuIntent('sessions')).toEqual({ type: 'tab', tab: 'sessions' })
  })
})

describe('workspaceBackLabel', () => {
  it('gives nested detail the plain back label', () => {
    expect(workspaceBackLabel(true, 'cron', false)).toBe('Back')
    expect(workspaceBackLabel(true, 'cron', true)).toBe('Back')
    expect(workspaceBackLabel(true, 'capabilities', true)).toBe('Back')
    expect(workspaceBackLabel(true, 'model', false)).toBe('Back')
  })

  it('reads Back to menu on the model surface with a return origin', () => {
    expect(workspaceBackLabel(true, 'model', true)).toBe('Back to menu')
  })

  it('falls back to the menu-origin return and then the roster', () => {
    expect(workspaceBackLabel(false, 'capabilities', true)).toBe('Back to menu')
    expect(workspaceBackLabel(false, null, true)).toBe('Back to menu')
    expect(workspaceBackLabel(false, null, false)).toBe('Back to bots')
    expect(workspaceBackLabel(false, 'model', false)).toBe('Back to bots')
  })
})

describe('restoreWorkspacePath', () => {
  it('parses capability routes and detail ids into the in-memory router', () => {
    expect(restoreWorkspacePath('/capabilities')).toBe(true)
    expect($navigation.get().stacks.capabilities).toEqual([ROOT_ROUTES.capabilities])

    expect(restoreWorkspacePath('/capabilities/skills')).toBe(true)
    expect($navigation.get().stacks.capabilities).toEqual([
      ROOT_ROUTES.capabilities,
      { section: 'skills', tab: 'capabilities', type: 'capabilities-section' }
    ])

    expect(restoreWorkspacePath('/capabilities/mcp/Server%20One%2F2')).toBe(true)
    expect($navigation.get().stacks.capabilities).toEqual([
      ROOT_ROUTES.capabilities,
      { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' },
      { capabilityId: 'Server One/2', section: 'mcp', tab: 'capabilities', type: 'capability-detail' }
    ])
    expect($navigation.get().activeTab).toBe('capabilities')
  })

  it('parses cron routes with reserved segments', () => {
    expect(restoreWorkspacePath('/cron/blueprints')).toBe(true)
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { tab: 'cron', type: 'cron-blueprints' }])

    expect(restoreWorkspacePath('/cron/new')).toBe(true)
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { tab: 'cron', type: 'cron-job-editor' }])

    expect(restoreWorkspacePath('/cron/job-1/edit')).toBe(true)
    expect($navigation.get().stacks.cron).toEqual([
      ROOT_ROUTES.cron,
      { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' },
      { jobId: 'job-1', tab: 'cron', type: 'cron-job-editor' }
    ])

    expect(restoreWorkspacePath('/cron/job-1')).toBe(true)
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])

    expect(restoreWorkspacePath('/cron/blueprints/edit')).toBe(false)
  })

  it('parses settings and group-room routes', () => {
    expect(restoreWorkspacePath('/settings/model')).toBe(true)
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([
      ROOT_ROUTES.settings,
      { category: 'model', tab: 'settings', type: 'settings-category' }
    ])

    expect(restoreWorkspacePath('/settings/profiles')).toBe(true)
    expect($navigation.get().stacks.settings).toEqual([
      ROOT_ROUTES.settings,
      { page: 'profiles', tab: 'settings', type: 'settings-administration' }
    ])

    expect(restoreWorkspacePath('/group/id%3Ar-abc-1')).toBe(true)
    expect($navigation.get().activeTab).toBe('roster')
    expect($navigation.get().stacks.roster).toEqual([
      ROOT_ROUTES.roster,
      { roomId: 'id:r-abc-1', tab: 'roster', type: 'group-room' }
    ])
  })

  it('maps the bare root to the roster root, like today', () => {
    expect(restoreWorkspacePath('/')).toBe(true)
    expect($navigation.get().activeTab).toBe('roster')
    expect($navigation.get().stacks.roster).toEqual([ROOT_ROUTES.roster])
  })

  it('rejects session deep links and malformed paths, leaving the store untouched', () => {
    for (const pathname of REJECTED_SCREEN_PATHS) {
      expect(restoreWorkspacePath(pathname)).toBe(false)
    }
    expect($navigation.get().activeTab).toBe('roster')
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])
  })

  it('does not change a populated navigation state when a path is rejected', () => {
    applyPathState('cron', [
      ROOT_ROUTES.cron,
      { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }
    ])
    applyPathState('capabilities', [
      ROOT_ROUTES.capabilities,
      { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' }
    ])
    applyPathState('settings', [
      ROOT_ROUTES.settings,
      { category: 'model', tab: 'settings', type: 'settings-category' }
    ])
    const before = structuredClone($navigation.get())

    for (const pathname of REJECTED_SCREEN_PATHS) {
      expect(restoreWorkspacePath(pathname)).toBe(false)
      expect($navigation.get()).toEqual(before)
    }
  })

  it('parses a trailing slash into the section route', () => {
    expect(restoreWorkspacePath('/capabilities/mcp/')).toBe(true)
    expect($navigation.get().stacks.capabilities).toEqual([
      ROOT_ROUTES.capabilities,
      { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' }
    ])
  })
})

describe('isAppShellScreenPath', () => {
  it('parses and serves an explicit valid path for every parsable head', () => {
    for (const head of SCREEN_URL_HEADS) {
      if (!head.parsable) continue
      const pathname = VALID_SCREEN_PATHS[head.head]
      expect(pathname, `missing valid parser vector for ${head.head}`).toBeDefined()
      expect(restoreWorkspacePath(pathname!)).toBe(true)
      expect(isAppShellScreenPath(pathname!)).toBe(true)
    }
  })

  it('serves the legacy heads byte-for-byte', () => {
    expect(isAppShellScreenPath('/bot')).toBe(true)
    expect(isAppShellScreenPath('/bot/extra')).toBe(true)
    expect(isAppShellScreenPath('/navigation')).toBe(true)
  })

  it('serves malformed subpaths under a served head — prefix semantics, not parse success', () => {
    expect(isAppShellScreenPath('/group/a/b')).toBe(true)
    expect(isAppShellScreenPath('/sessions/x')).toBe(true)
    expect(isAppShellScreenPath('/settings/x/y')).toBe(true)
    expect(isAppShellScreenPath('/cron/a/b/c')).toBe(true)
  })

  it('rejects unknown heads and the session deep-link head', () => {
    expect(isAppShellScreenPath('/')).toBe(false)
    expect(isAppShellScreenPath('/nope')).toBe(false)
    expect(isAppShellScreenPath('/bots')).toBe(false)
    expect(isAppShellScreenPath('/session/abc')).toBe(false)
    expect(isAppShellScreenPath('/session/a/more')).toBe(false)
  })

  it('serves every parsable head — the parser/allowlist drift class, closed by assertion', () => {
    for (const head of SCREEN_URL_HEADS) {
      if (head.parsable) expect(isAppShellScreenPath(`/${head.head}`)).toBe(true)
    }
  })

  it('keeps legacy heads served but unparsable', () => {
    for (const head of SCREEN_URL_HEADS) {
      if (head.legacy) {
        expect(head.served).toBe(true)
        expect(restoreWorkspacePath(`/${head.head}`)).toBe(false)
      }
    }
  })
})

describe('DOM-free guard', () => {
  it('keeps the core importable from the service-worker bundle (no React, no app imports)', () => {
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier.startsWith('./') || specifier.startsWith('~/navigation/')).toBe(true)
    }
    expect(specifiers).not.toContain('react')
  })
})