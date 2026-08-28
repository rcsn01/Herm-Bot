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
  setTab
} from '~/navigation/navigation-store'
import { ROOT_ROUTES } from '~/navigation/routes'

beforeEach(() => resetNavigation())

describe('mobile navigation store', () => {
  it('starts on the Sessions root, which represents the active chat', () => {
    expect($navigation.get()).toMatchObject({ activeTab: 'sessions' })
    expect($activeRoute.get()).toEqual(ROOT_ROUTES.sessions)
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
    expect(isMobileTab('sessions')).toBe(true)
    expect(isMobileTab('chat')).toBe(false)
  })

  it('keeps an independent stack for every destination', () => {
    pushRoute('capabilities', {
      type: 'capability-detail',
      tab: 'capabilities',
      capabilityId: 'terminal',
      capabilityType: 'tool'
    })
    pushRoute('operations', {
      type: 'operation-detail',
      tab: 'operations',
      operationId: 'cron',
      operationType: 'cron'
    })
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'settings' })

    setTab('capabilities')
    expect($activeRoute.get()).toMatchObject({ type: 'capability-detail', capabilityId: 'terminal' })
    setTab('sessions')
    expect($activeRoute.get()).toEqual(ROOT_ROUTES.sessions)
    setTab('operations')
    expect($activeRoute.get()).toMatchObject({ type: 'operation-detail', operationId: 'cron' })
    setTab('more')
    expect($activeRoute.get()).toMatchObject({ type: 'more-detail', page: 'settings' })
  })

  it('returning to Sessions does not reset other destination stacks', () => {
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'projects' })
    setTab('more')
    setTab('sessions')

    expect($navigation.get().stacks.more).toHaveLength(2)
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
  })

  it('pops details but never pops a destination root', () => {
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'settings' })
    expect(popRoute('more')).toMatchObject({ type: 'more-detail' })
    expect(popRoute('more')).toBeUndefined()
    expect($navigation.get().stacks.more).toEqual([ROOT_ROUTES.more])
  })

  it('resets scoped routes while retaining the active destination and roots', () => {
    pushRoute('more', { type: 'more-detail', tab: 'more', page: 'projects' })
    setTab('more')

    resetTabRoutes('sessions')
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
    expect($navigation.get().stacks.more).toHaveLength(2)

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
