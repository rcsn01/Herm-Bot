import { describe, expect, it } from 'vitest'

import { ROOT_ROUTES } from './routes'
import { navigationFromPath } from './screen-url'

describe('direct navigation URL parser', () => {
  it('maps tab roots', () => {
    expect(navigationFromPath('/')).toEqual({ stack: [ROOT_ROUTES.roster], tab: 'roster' })
    expect(navigationFromPath('/sessions')).toEqual({ stack: [ROOT_ROUTES.sessions], tab: 'sessions' })
    expect(navigationFromPath('/capabilities')).toEqual({ stack: [ROOT_ROUTES.capabilities], tab: 'capabilities' })
    expect(navigationFromPath('/cron')).toEqual({ stack: [ROOT_ROUTES.cron], tab: 'cron' })
    expect(navigationFromPath('/settings')).toEqual({ stack: [ROOT_ROUTES.settings], tab: 'settings' })
  })

  it('parses capability routes and decodes detail ids', () => {
    const section = { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' } as const
    const skills = { section: 'skills', tab: 'capabilities', type: 'capabilities-section' } as const
    const detail = { capabilityId: 'Server One/2', section: 'mcp', tab: 'capabilities', type: 'capability-detail' } as const

    expect(navigationFromPath('/capabilities/skills')).toEqual({ stack: [ROOT_ROUTES.capabilities, skills], tab: 'capabilities' })
    expect(navigationFromPath('/capabilities/mcp/Server%20One%2F2')).toEqual({
      stack: [ROOT_ROUTES.capabilities, section, detail],
      tab: 'capabilities'
    })
  })

  it('parses cron routes with reserved segments', () => {
    const detail = { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' } as const
    const editor = { jobId: 'job-1', tab: 'cron', type: 'cron-job-editor' } as const
    const blueprints = { tab: 'cron', type: 'cron-blueprints' } as const
    const fresh = { tab: 'cron', type: 'cron-job-editor' } as const

    expect(navigationFromPath('/cron/blueprints')).toEqual({ stack: [ROOT_ROUTES.cron, blueprints], tab: 'cron' })
    expect(navigationFromPath('/cron/new')).toEqual({ stack: [ROOT_ROUTES.cron, fresh], tab: 'cron' })
    expect(navigationFromPath('/cron/job-1/edit')).toEqual({ stack: [ROOT_ROUTES.cron, detail, editor], tab: 'cron' })
    expect(navigationFromPath('/cron/job-1')).toEqual({ stack: [ROOT_ROUTES.cron, detail], tab: 'cron' })
    expect(navigationFromPath('/cron/blueprints/edit')).toBeNull()
  })

  it('parses settings categories and administration pages', () => {
    const category = { category: 'model', tab: 'settings', type: 'settings-category' } as const
    const admin = { page: 'profiles', tab: 'settings', type: 'settings-administration' } as const

    expect(navigationFromPath('/settings/model')).toEqual({ stack: [ROOT_ROUTES.settings, category], tab: 'settings' })
    expect(navigationFromPath('/settings/profiles')).toEqual({ stack: [ROOT_ROUTES.settings, admin], tab: 'settings' })
    expect(navigationFromPath('/settings/nope')).toBeNull()
  })

  it('leaves session deep links and unknown paths to their own handlers', () => {
    expect(navigationFromPath('/session/abc')).toBeNull()
    expect(navigationFromPath('/session/abc?profile=work')).toBeNull()
    expect(navigationFromPath('/nope')).toBeNull()
    expect(navigationFromPath('/bot')).toBeNull()
    expect(navigationFromPath('/capabilities/nope')).toBeNull()
    expect(navigationFromPath('/capabilities/mcp')).not.toBeNull()
    expect(navigationFromPath('/capabilities/mcp/')).toEqual({
      stack: [ROOT_ROUTES.capabilities, { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' }],
      tab: 'capabilities'
    })
  })

  it('parses group-room routes', () => {
    const route = { roomId: 'id:r-abc-1', tab: 'roster', type: 'group-room' } as const

    expect(navigationFromPath('/group/id%3Ar-abc-1')).toEqual({
      stack: [ROOT_ROUTES.roster, route],
      tab: 'roster'
    })
    expect(navigationFromPath('/group')).toBeNull()
    expect(navigationFromPath('/group/a/b')).toBeNull()
  })
})
