import { beforeEach, describe, expect, it } from 'vitest'

import {
  $activeRoute,
  $navigation,
  popRoute,
  pushRoute,
  resetNavigation,
  resetRoutes,
  resetTabRoutes,
  setTab
} from '~/navigation/navigation-store'
import { ROOT_ROUTES } from '~/navigation/routes'

beforeEach(() => resetNavigation())

describe('mobile navigation store', () => {
  it('keeps an independent stack for every tab', () => {
    pushRoute('sessions', { type: 'session-detail', tab: 'sessions', sessionId: 'session-1' })
    pushRoute('capabilities', {
      type: 'capability-detail',
      tab: 'capabilities',
      capabilityId: 'terminal',
      capabilityType: 'tool'
    })

    setTab('sessions')
    expect($activeRoute.get()).toMatchObject({ type: 'session-detail', sessionId: 'session-1' })
    setTab('capabilities')
    expect($activeRoute.get()).toMatchObject({ type: 'capability-detail', capabilityId: 'terminal' })
    expect($navigation.get().stacks.chat).toEqual([ROOT_ROUTES.chat])
  })

  it('pops details but never pops a tab root', () => {
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'settings' })
    expect(popRoute('more')).toMatchObject({ type: 'more-detail' })
    expect(popRoute('more')).toBeUndefined()
    expect($navigation.get().stacks.more).toEqual([ROOT_ROUTES.more])
  })

  it('resets scoped routes while retaining the active tab and roots', () => {
    pushRoute('sessions', { type: 'session-detail', tab: 'sessions', sessionId: 'session-1' })
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'projects' })
    setTab('more')

    resetTabRoutes('sessions')
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
    expect($navigation.get().stacks.more).toHaveLength(2)

    resetRoutes()
    expect($navigation.get().activeTab).toBe('more')
    expect($navigation.get().stacks).toEqual({
      chat: [ROOT_ROUTES.chat],
      sessions: [ROOT_ROUTES.sessions],
      capabilities: [ROOT_ROUTES.capabilities],
      operations: [ROOT_ROUTES.operations],
      more: [ROOT_ROUTES.more]
    })
  })

  it('rejects routes pushed onto the wrong stack at runtime', () => {
    expect(() => pushRoute('chat', ROOT_ROUTES.more as never)).toThrow(/more route.*chat stack/)
  })
})
