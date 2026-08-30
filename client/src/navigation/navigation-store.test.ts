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
import { MOBILE_TABS, ROOT_ROUTES } from '~/navigation/routes'

beforeEach(() => resetNavigation())

describe('mobile navigation store', () => {
  it('keeps the exact drawer order while launching on Sessions', () => {
    expect(MOBILE_TABS).toEqual(['capabilities', 'cron', 'settings', 'sessions'])
    expect($navigation.get()).toMatchObject({ activeTab: 'sessions' })
    expect($activeRoute.get()).toEqual(ROOT_ROUTES.sessions)
    expect(isMobileTab('sessions')).toBe(true)
    expect(isMobileTab('operations')).toBe(false)
  })

  it('keeps an independent stack for every destination', () => {
    pushRoute('capabilities', { section: 'skills', tab: 'capabilities', type: 'capabilities-section' })
    pushRoute('cron', { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' })
    pushRoute('settings', { category: 'model', tab: 'settings', type: 'settings-category' })

    setTab('capabilities')
    expect($activeRoute.get()).toMatchObject({ type: 'capabilities-section', section: 'skills' })
    setTab('sessions')
    expect($activeRoute.get()).toEqual(ROOT_ROUTES.sessions)
    setTab('cron')
    expect($activeRoute.get()).toMatchObject({ type: 'cron-job-detail', jobId: 'job-1' })
    setTab('settings')
    expect($activeRoute.get()).toMatchObject({ type: 'settings-category', category: 'model' })
  })

  it('retains each stack when switching tabs', () => {
    pushRoute('settings', { page: 'gateway', tab: 'settings', type: 'settings-administration' })
    setTab('settings')
    setTab('sessions')

    expect($navigation.get().stacks.settings).toHaveLength(2)
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
  })

  it('pops details but never pops a destination root', () => {
    pushRoute('cron', { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' })
    expect(popRoute('cron')).toMatchObject({ type: 'cron-job-detail' })
    expect(popRoute('cron')).toBeUndefined()
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])
  })

  it('resets scoped routes while retaining the active destination and roots', () => {
    pushRoute('settings', { page: 'projects', tab: 'settings', type: 'settings-administration' })
    setTab('settings')

    resetTabRoutes('sessions')
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
    expect($navigation.get().stacks.settings).toHaveLength(2)

    resetRoutes()
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks).toEqual({
      capabilities: [ROOT_ROUTES.capabilities],
      cron: [ROOT_ROUTES.cron],
      settings: [ROOT_ROUTES.settings],
      sessions: [ROOT_ROUTES.sessions]
    })
  })

  it('rejects routes pushed onto the wrong stack at runtime', () => {
    expect(() => pushRoute('sessions', ROOT_ROUTES.cron as never)).toThrow(/cron route.*sessions stack/)
  })
})
