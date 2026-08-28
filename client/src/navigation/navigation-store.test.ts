import { beforeEach, describe, expect, it } from 'vitest'

import {
  $activeRoute,
  $navigation,
  isMobileTab,
  popRoute,
  pushRoute,
  resetNavigation,
  resetRoutes,
  resetTabRoutes,
  setTab,
  showSessionsChat,
  showSessionsList
} from '~/navigation/navigation-store'
import { ROOT_ROUTES } from '~/navigation/routes'

beforeEach(() => resetNavigation())

describe('mobile navigation store', () => {
  it('starts on the Sessions list and no longer exposes a Chat tab', () => {
    expect($navigation.get()).toMatchObject({ activeTab: 'sessions' })
    expect($activeRoute.get()).toEqual(ROOT_ROUTES.sessions)
    expect(isMobileTab('sessions')).toBe(true)
    expect(isMobileTab('chat')).toBe(false)
  })

  it('keeps an independent stack for every tab', () => {
    showSessionsChat()
    pushRoute('capabilities', {
      type: 'capability-detail',
      tab: 'capabilities',
      capabilityId: 'terminal',
      capabilityType: 'tool'
    })

    setTab('capabilities')
    expect($activeRoute.get()).toMatchObject({ type: 'capability-detail', capabilityId: 'terminal' })
    setTab('sessions')
    expect($activeRoute.get()).toMatchObject({ type: 'sessions-chat' })
  })

  it('switches Sessions subviews without stacking duplicate chat routes', () => {
    showSessionsChat()
    showSessionsChat()
    expect($navigation.get().stacks.sessions).toEqual([
      ROOT_ROUTES.sessions,
      { type: 'sessions-chat', tab: 'sessions' }
    ])

    setTab('more')
    showSessionsChat()
    expect($navigation.get()).toMatchObject({ activeTab: 'sessions' })
    expect($navigation.get().stacks.sessions).toHaveLength(2)

    showSessionsList()
    showSessionsList()
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
  })

  it('pops details but never pops a tab root', () => {
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'settings' })
    expect(popRoute('more')).toMatchObject({ type: 'more-detail' })
    expect(popRoute('more')).toBeUndefined()
    expect($navigation.get().stacks.more).toEqual([ROOT_ROUTES.more])
  })

  it('resets scoped routes while retaining the active tab and roots', () => {
    showSessionsChat()
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'projects' })
    setTab('more')

    resetTabRoutes('sessions')
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
    expect($navigation.get().stacks.more).toHaveLength(2)

    showSessionsChat()
    setTab('more')
    resetRoutes()
    expect($navigation.get().activeTab).toBe('more')
    expect($navigation.get().stacks).toEqual({
      sessions: [ROOT_ROUTES.sessions],
      capabilities: [ROOT_ROUTES.capabilities],
      operations: [ROOT_ROUTES.operations],
      more: [ROOT_ROUTES.more]
    })
  })

  it('rejects routes pushed onto the wrong stack at runtime', () => {
    expect(() => pushRoute('sessions', ROOT_ROUTES.more as never)).toThrow(/more route.*sessions stack/)
  })
})
