import { describe, expect, it } from 'vitest'

import { ROOT_ROUTES } from './routes'
import { navigationFromPath, pathForTabRoute } from './screen-url'

describe('screen URL codec', () => {
  it('maps every tab root', () => {
    expect(pathForTabRoute('roster', ROOT_ROUTES.roster)).toBe('/')
    expect(pathForTabRoute('sessions', ROOT_ROUTES.sessions)).toBe('/sessions')
    expect(pathForTabRoute('capabilities', ROOT_ROUTES.capabilities)).toBe('/capabilities')
    expect(pathForTabRoute('cron', ROOT_ROUTES.cron)).toBe('/cron')
    expect(pathForTabRoute('settings', ROOT_ROUTES.settings)).toBe('/settings')
  })

  it('round-trips capability routes, encoding detail ids', () => {
    const section = { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' } as const
    const skills = { section: 'skills', tab: 'capabilities', type: 'capabilities-section' } as const
    const detail = { capabilityId: 'Server One/2', section: 'mcp', tab: 'capabilities', type: 'capability-detail' } as const
    const path = pathForTabRoute('capabilities', detail)
    expect(path).toBe('/capabilities/mcp/Server%20One%2F2')

    expect(navigationFromPath('/capabilities')).toEqual({ stack: [ROOT_ROUTES.capabilities], tab: 'capabilities' })
    expect(navigationFromPath('/capabilities/skills')).toEqual({
      stack: [ROOT_ROUTES.capabilities, skills],
      tab: 'capabilities'
    })
    expect(navigationFromPath(path)).toEqual({
      stack: [ROOT_ROUTES.capabilities, section, detail],
      tab: 'capabilities'
    })
  })

  it('round-trips cron routes with reserved segments', () => {
    const detail = { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' } as const
    const editor = { jobId: 'job-1', tab: 'cron', type: 'cron-job-editor' } as const
    const blueprints = { tab: 'cron', type: 'cron-blueprints' } as const
    const fresh = { tab: 'cron', type: 'cron-job-editor' } as const

    expect(navigationFromPath('/cron/blueprints')).toEqual({ stack: [ROOT_ROUTES.cron, blueprints], tab: 'cron' })
    expect(navigationFromPath('/cron/new')).toEqual({ stack: [ROOT_ROUTES.cron, fresh], tab: 'cron' })
    expect(navigationFromPath('/cron/job-1/edit')).toEqual({ stack: [ROOT_ROUTES.cron, detail, editor], tab: 'cron' })
    expect(navigationFromPath('/cron/job-1')).toEqual({ stack: [ROOT_ROUTES.cron, detail], tab: 'cron' })
    expect(pathForTabRoute('cron', detail)).toBe('/cron/job-1')
    expect(pathForTabRoute('cron', editor)).toBe('/cron/job-1/edit')
    expect(pathForTabRoute('cron', fresh)).toBe('/cron/new')
    // a job id may not squat a reserved word or an editor suffix position
    expect(navigationFromPath('/cron/blueprints/edit')).toBeNull()
    expect(navigationFromPath('/cron/new')).toEqual({ stack: [ROOT_ROUTES.cron, fresh], tab: 'cron' })
  })

  it('round-trips settings categories and administration pages', () => {
    const category = { category: 'model', tab: 'settings', type: 'settings-category' } as const
    const admin = { page: 'profiles', tab: 'settings', type: 'settings-administration' } as const

    expect(navigationFromPath('/settings/model')).toEqual({ stack: [ROOT_ROUTES.settings, category], tab: 'settings' })
    expect(navigationFromPath('/settings/profiles')).toEqual({ stack: [ROOT_ROUTES.settings, admin], tab: 'settings' })
    expect(pathForTabRoute('settings', category)).toBe('/settings/model')
    expect(pathForTabRoute('settings', admin)).toBe('/settings/profiles')
    expect(navigationFromPath('/settings/nope')).toBeNull()
  })

  it('treats the session deep-link namespace as foreign and rejects junk paths', () => {
    expect(navigationFromPath('/session/abc')).toBeNull()
    expect(navigationFromPath('/session/abc?profile=work')).toBeNull()
    expect(navigationFromPath('/nope')).toBeNull()
    expect(navigationFromPath('/bot')).toBeNull()
    expect(navigationFromPath('/bot/extra')).toBeNull()
    expect(navigationFromPath('/capabilities/nope')).toBeNull()
    expect(navigationFromPath('/capabilities/mcp')).not.toBeNull()
    expect(navigationFromPath('/capabilities/mcp/')).toEqual({
      stack: [ROOT_ROUTES.capabilities, { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' }],
      tab: 'capabilities'
    })
  })

  it('rejects a route rendered under a mismatched tab', () => {
    expect(() => pathForTabRoute('roster', ROOT_ROUTES.cron)).toThrow(/cron route.*roster tab/)
  })
})