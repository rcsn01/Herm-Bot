import { beforeEach, describe, expect, it, vi } from 'vitest'

import source from './workspace-navigation.ts?raw'

import { $navigation, applyPathState, resetNavigation, setTab } from './navigation-store'
import { MOBILE_TABS, ROOT_ROUTES } from './routes'
import {
  $workspacePolicy,
  back,
  dismissForeground,
  dismissMenu,
  groupIdFromRoute,
  isAppShellScreenPath,
  narrowRoute,
  openChatSurface,
  openGroupRoom,
  openMenu,
  openSettings,
  openWorkspaceDestination,
  resetWorkspace,
  resetWorkspacePolicy,
  restoreWorkspacePath,
  SCREEN_URL_HEADS,
  workspaceBackLabel,
  workspaceDestinationFor,
  workspaceMenuIntent,
  workspaceRouteTitle,
  workspaceTabTitle,
  WORKSPACE_BACK_FALLBACKS,
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

beforeEach(() => {
  resetNavigation()
  resetWorkspacePolicy()
})

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

describe('WORKSPACE_BACK_FALLBACKS', () => {
  it('covers every tab: menu-entered destinations fall to sessions, the rest to the roster', () => {
    expect(WORKSPACE_BACK_FALLBACKS).toEqual({ roster: 'roster', capabilities: 'sessions', cron: 'sessions', settings: 'roster', sessions: 'roster' })
    for (const tab of MOBILE_TABS) expect(WORKSPACE_BACK_FALLBACKS[tab]).toBeDefined()
  })
})

describe('groupIdFromRoute', () => {
  it('decodes group-room routes and nulls everything else', () => {
    expect(groupIdFromRoute({ roomId: 'g1', tab: 'roster', type: 'group-room' })).toBe('g1')
    expect(groupIdFromRoute(ROOT_ROUTES.roster)).toBeNull()
    expect(groupIdFromRoute(ROOT_ROUTES.cron)).toBeNull()
    expect(groupIdFromRoute({ category: 'model', tab: 'settings', type: 'settings-category' })).toBeNull()
  })
})

describe('openMenu / dismissMenu', () => {
  it('latches the menu and captures the origin tab + stack, recapturing while open', () => {
    openMenu()
    expect($workspacePolicy.get()).toMatchObject({ menuOpen: true, menuOrigin: 'roster', menuOriginStack: [ROOT_ROUTES.roster] })

    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    openMenu()
    expect($workspacePolicy.get()).toMatchObject({ menuOpen: true, menuOrigin: 'cron', menuOriginStack: [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }] })
  })

  it('dismisses as a no-op when closed', () => {
    dismissMenu()
    dismissMenu({ type: 'tab', tab: 'cron' })
    expect($workspacePolicy.get().menuOpen).toBe(false)
    expect($navigation.get().activeTab).toBe('roster')
  })

  it('close intent closes and clears the captured origin pair only', () => {
    openMenu()
    dismissMenu({ type: 'close' })
    expect($workspacePolicy.get()).toEqual({ menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
    expect($navigation.get().activeTab).toBe('roster')
  })

  it('tab intent stashes the origin pair and lands the destination fresh', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    openMenu()
    dismissMenu({ type: 'tab', tab: 'capabilities' })
    expect($navigation.get().activeTab).toBe('capabilities')
    expect($navigation.get().stacks.capabilities).toEqual([ROOT_ROUTES.capabilities])
    expect($workspacePolicy.get()).toMatchObject({
      menuOpen: false,
      menuOrigin: null,
      menuOriginStack: null,
      returnOrigin: 'cron',
      returnStack: [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }]
    })
  })

  it('tab intent for the origin tab closes without stashing', () => {
    setTab('cron')
    openMenu()
    dismissMenu({ type: 'tab', tab: 'cron' })
    expect($navigation.get().activeTab).toBe('cron')
    expect($workspacePolicy.get()).toEqual({ menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
  })

  it('model intent opens the model route fresh and stashes the origin pair', () => {
    applyPathState('settings', [ROOT_ROUTES.settings, { category: 'appearance', tab: 'settings', type: 'settings-category' }])
    openMenu()
    dismissMenu({ type: 'model' })
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([ROOT_ROUTES.settings, { category: 'model', tab: 'settings', type: 'settings-category' }])
    expect($workspacePolicy.get()).toMatchObject({ returnOrigin: 'settings', returnStack: [ROOT_ROUTES.settings, { category: 'appearance', tab: 'settings', type: 'settings-category' }] })
  })

  it('model intent closes only when the origin already sits on the model surface', () => {
    applyPathState('settings', [ROOT_ROUTES.settings, { category: 'model', tab: 'settings', type: 'settings-category' }])
    openMenu()
    dismissMenu({ type: 'model' })
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([ROOT_ROUTES.settings, { category: 'model', tab: 'settings', type: 'settings-category' }])
    expect($workspacePolicy.get()).toEqual({ menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
  })
})

describe('openWorkspaceDestination', () => {
  it('opens the sessions menu for the sessions destination', () => {
    openWorkspaceDestination('sessions')
    expect($workspacePolicy.get()).toMatchObject({ menuOpen: true, menuOrigin: 'roster', menuOriginStack: [ROOT_ROUTES.roster] })
  })

  it('opens cron and capabilities fresh without stashing', () => {
    openWorkspaceDestination('cron')
    expect($navigation.get().activeTab).toBe('cron')
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])
    expect($workspacePolicy.get().returnOrigin).toBeNull()

    openWorkspaceDestination('capabilities')
    expect($navigation.get().activeTab).toBe('capabilities')
    expect($navigation.get().stacks.capabilities).toEqual([ROOT_ROUTES.capabilities])
  })

  it('opens the model route fresh — the bottom-nav path never stashes and stays idempotent', () => {
    openWorkspaceDestination('model')
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([ROOT_ROUTES.settings, { category: 'model', tab: 'settings', type: 'settings-category' }])
    expect($workspacePolicy.get().returnOrigin).toBeNull()

    openWorkspaceDestination('model')
    expect($navigation.get().stacks.settings).toEqual([ROOT_ROUTES.settings, { category: 'model', tab: 'settings', type: 'settings-category' }])
  })
})

describe('back(source)', () => {
  it('① pops a group-room route, staying on the roster', () => {
    openGroupRoom('g1')
    back('header')
    expect($navigation.get().activeTab).toBe('roster')
    expect($navigation.get().stacks.roster).toEqual([ROOT_ROUTES.roster])
  })

  it('② leaves the sessions surface to the roster and clears the return pair', () => {
    openMenu()
    dismissMenu({ type: 'tab', tab: 'sessions' })
    expect($workspacePolicy.get().returnOrigin).toBe('roster')

    back('header')
    expect($navigation.get().activeTab).toBe('roster')
    expect($workspacePolicy.get().returnOrigin).toBeNull()
    expect($workspacePolicy.get().returnStack).toBeNull()
  })

  it('③ consumes the return pair from the model surface and reopens the menu on the restored origin', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    openMenu()
    dismissMenu({ type: 'model' })
    back('header')

    expect($navigation.get().activeTab).toBe('cron')
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    expect($workspacePolicy.get()).toEqual({
      menuOpen: true,
      menuOrigin: 'cron',
      menuOriginStack: [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }],
      returnOrigin: null,
      returnStack: null
    })
  })

  it('④ pops nested detail routes on the active tab', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    back('screen')
    expect($navigation.get().activeTab).toBe('cron')
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])
  })

  it('④ at a destination root the header falls to the roster while the screen falls per tab', () => {
    openWorkspaceDestination('capabilities')
    back('header')
    expect($navigation.get().activeTab).toBe('roster')

    openWorkspaceDestination('capabilities')
    back('screen')
    expect($navigation.get().activeTab).toBe('sessions')
  })

  it('④ exits a settings root to the roster for both sources', () => {
    openSettings()
    back('header')
    expect($navigation.get().activeTab).toBe('roster')

    openSettings()
    back('screen')
    expect($navigation.get().activeTab).toBe('roster')
  })

  it('④ pops the model route when it was opened without a return origin', () => {
    openWorkspaceDestination('model')
    back('screen')
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([ROOT_ROUTES.settings])
  })
})

describe('openChatSurface', () => {
  it('lands the chat surface fresh: policy zeroed, sessions active — even from a menu-open state', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    openMenu()
    dismissMenu({ type: 'model' })
    expect($workspacePolicy.get().returnOrigin).toBe('cron')

    openChatSurface()
    expect($navigation.get().activeTab).toBe('sessions')
    expect($workspacePolicy.get()).toEqual({ menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
  })
})

describe('openSettings', () => {
  it('opens the settings root fresh and clears the return pair', () => {
    applyPathState('settings', [ROOT_ROUTES.settings, { category: 'model', tab: 'settings', type: 'settings-category' }])
    openMenu()
    dismissMenu({ type: 'model' })

    openSettings()
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([ROOT_ROUTES.settings])
    expect($workspacePolicy.get().returnOrigin).toBeNull()
  })
})

describe('openGroupRoom', () => {
  it('pushes group-room routes onto the roster stack', () => {
    openGroupRoom('g1')
    expect($navigation.get().stacks.roster).toEqual([ROOT_ROUTES.roster, { roomId: 'g1', tab: 'roster', type: 'group-room' }])

    openGroupRoom('g2')
    expect($navigation.get().stacks.roster).toEqual([
      ROOT_ROUTES.roster,
      { roomId: 'g1', tab: 'roster', type: 'group-room' },
      { roomId: 'g2', tab: 'roster', type: 'group-room' }
    ])
  })
})

describe('dismissForeground', () => {
  it('resets a group-room foreground to the roster root, keeping the return pair', () => {
    openMenu()
    dismissMenu({ type: 'tab', tab: 'cron' })
    setTab('roster')
    openGroupRoom('g1')

    dismissForeground()
    expect($navigation.get().activeTab).toBe('roster')
    expect($navigation.get().stacks.roster).toEqual([ROOT_ROUTES.roster])
    expect($workspacePolicy.get().returnOrigin).toBe('roster')
    expect($workspacePolicy.get().returnStack).toEqual([ROOT_ROUTES.roster])
  })

  it('returns the sessions surface to the roster', () => {
    setTab('sessions')
    dismissForeground()
    expect($navigation.get().activeTab).toBe('roster')
  })

  it('is a no-op on bot-configuration tabs', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])

    dismissForeground()
    expect($navigation.get().activeTab).toBe('cron')
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
  })
})

describe('resetWorkspace', () => {
  it('zeroes every route stack and the policy together (scope teardown, Δ2)', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    openMenu()
    dismissMenu({ type: 'model' })

    resetWorkspace()
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])
    expect($navigation.get().stacks.settings).toEqual([ROOT_ROUTES.settings])
    expect($workspacePolicy.get()).toEqual({ menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
  })
})

describe('history isolation', () => {
  it('keeps every verb out of the browser history stack', () => {
    const backSpy = vi.spyOn(window.history, 'back')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    try {
      openMenu()
      dismissMenu({ type: 'model' })
      openWorkspaceDestination('cron')
      openGroupRoom('g1')
      openChatSurface()
      openSettings()
      dismissForeground()
      back('header')
      back('screen')
      resetWorkspace()

      expect(backSpy).not.toHaveBeenCalled()
      expect(pushSpy).not.toHaveBeenCalled()
      expect(replaceSpy).not.toHaveBeenCalled()
    } finally {
      backSpy.mockRestore()
      pushSpy.mockRestore()
      replaceSpy.mockRestore()
    }
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
    // pwa/policy.ts → pwa/sw.ts pulls this file into the service-worker
    // bundle; the import set must stay exactly these three.
    expect(specifiers.sort()).toEqual(['./navigation-store', './routes', 'nanostores'])
  })
})