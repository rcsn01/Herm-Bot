import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $navigation, applyPathState, resetNavigation } from '~/navigation/navigation-store'
import { ROOT_ROUTES } from '~/navigation/routes'
import { useWorkspaceNavigation, type WorkspaceNavigation } from '~/navigation/use-workspace-navigation'

beforeEach(() => resetNavigation())
afterEach(cleanup)

let workspace!: WorkspaceNavigation

function Harness() {
  workspace = useWorkspaceNavigation()
  return null
}

describe('useWorkspaceNavigation', () => {
  it('opens idempotently and keeps the menu out of browser history', () => {
    window.history.replaceState({ screen: 'cron' }, '', '/cron')
    const beforeLength = window.history.length
    const beforeState = window.history.state
    render(<Harness />)

    act(() => {
      workspace.openMenu()
      workspace.openMenu()
    })

    expect(workspace.menuOpen).toBe(true)
    expect(window.location.pathname).toBe('/cron')
    expect(window.history.length).toBe(beforeLength)
    expect(window.history.state).toBe(beforeState)
  })

  it('does nothing when dismissing while closed', () => {
    render(<Harness />)

    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'cron' }) })

    expect(workspace.menuOpen).toBe(false)
    expect(workspace.returnOrigin).toBeNull()
    expect($navigation.get().activeTab).toBe('roster')
  })

  it('does not add a history entry when StrictMode mounts it', () => {
    window.history.replaceState({ screen: 'sessions' }, '', '/sessions')
    const beforeLength = window.history.length
    render(<StrictMode><Harness /></StrictMode>)

    act(() => { workspace.openMenu() })

    expect(window.location.pathname).toBe('/sessions')
    expect(window.history.length).toBe(beforeLength)
    expect(workspace.menuOpen).toBe(true)
  })

  it('keeps every verb out of browser history', () => {
    window.history.replaceState(null, '', '/')
    const back = vi.spyOn(window.history, 'back')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })
    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'capabilities' }) })
    act(() => { workspace.openWorkspaceDestination('model') })
    act(() => { workspace.exitToReturnOrigin() })
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'cron' }) })
    act(() => { workspace.clearReturn() })
    act(() => { workspace.backOr('cron', () => undefined) })
    act(() => { workspace.closeToRoster() })

    expect(back).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/')
  })

  it('closes only when the dismissed destination equals the origin tab', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    render(<Harness />)

    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'cron' }) })

    expect(workspace.menuOpen).toBe(false)
    expect(workspace.returnOrigin).toBeNull()
    expect($navigation.get().activeTab).toBe('cron')
    expect($navigation.get().stacks.cron).toHaveLength(2)
  })

  it('stashes a non-origin destination, restores its stack, and reopens the menu over the origin', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    render(<Harness />)

    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'capabilities' }) })

    expect(workspace.menuOpen).toBe(false)
    expect(workspace.returnOrigin).toBe('cron')
    expect($navigation.get().activeTab).toBe('capabilities')
    expect($navigation.get().stacks.capabilities).toEqual([ROOT_ROUTES.capabilities])
    expect($navigation.get().stacks.cron).toHaveLength(2)

    act(() => { workspace.exitToReturnOrigin('sessions') })

    expect($navigation.get().activeTab).toBe('cron')
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    expect(workspace.menuOpen).toBe(true)
    expect(workspace.returnOrigin).toBeNull()

    // The reopened menu recaptured the restored origin: dismissing to it closes only.
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'cron' }) })
    expect(workspace.menuOpen).toBe(false)
    expect(workspace.returnOrigin).toBeNull()
    expect($navigation.get().activeTab).toBe('cron')
  })

  it('closes only when the origin already sits on the model category', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('model') })
    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'model' }) })

    expect(workspace.menuOpen).toBe(false)
    expect(workspace.returnOrigin).toBeNull()
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([
      ROOT_ROUTES.settings,
      { category: 'model', tab: 'settings', type: 'settings-category' }
    ])
  })

  it('stashes the origin and opens the model category from another surface', () => {
    applyPathState('cron', [ROOT_ROUTES.cron])
    render(<Harness />)

    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'model' }) })

    expect(workspace.returnOrigin).toBe('cron')
    expect($navigation.get().activeTab).toBe('settings')
    expect($navigation.get().stacks.settings).toEqual([
      ROOT_ROUTES.settings,
      { category: 'model', tab: 'settings', type: 'settings-category' }
    ])
  })

  it('stashes nothing on a plain close', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })
    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu() })

    expect(workspace.menuOpen).toBe(false)
    expect(workspace.returnOrigin).toBeNull()
    expect($navigation.get().activeTab).toBe('cron')
  })

  it('opens the menu for the sessions destination', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('sessions') })

    expect(workspace.menuOpen).toBe(true)
    expect($navigation.get().activeTab).toBe('roster')
  })

  it('keeps an existing model-category stack top (idempotent open)', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('model') })
    expect($navigation.get().stacks.settings).toEqual([
      ROOT_ROUTES.settings,
      { category: 'model', tab: 'settings', type: 'settings-category' }
    ])

    // The model category atop a deeper stack is kept, not reset.
    applyPathState('settings', [
      ROOT_ROUTES.settings,
      { page: 'profiles', tab: 'settings', type: 'settings-administration' },
      { category: 'model', tab: 'settings', type: 'settings-category' }
    ])
    act(() => { workspace.openWorkspaceDestination('model') })

    expect($navigation.get().stacks.settings).toEqual([
      ROOT_ROUTES.settings,
      { page: 'profiles', tab: 'settings', type: 'settings-administration' },
      { category: 'model', tab: 'settings', type: 'settings-category' }
    ])
  })

  it('resets and selects tab destinations', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })

    expect($navigation.get().activeTab).toBe('cron')
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])
  })

  it('falls back when no menu-originated return exists', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })
    act(() => { workspace.exitToReturnOrigin() })

    expect($navigation.get().activeTab).toBe('roster')
    expect(workspace.menuOpen).toBe(false)
  })

  it('uses an explicit fallback and does not touch stacks when restoring nothing', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })
    act(() => { workspace.exitToReturnOrigin('sessions') })

    expect($navigation.get().activeTab).toBe('sessions')
    expect($navigation.get().stacks.sessions).toEqual([ROOT_ROUTES.sessions])
  })

  it('pops the stack or runs the fallback at its root', () => {
    applyPathState('cron', [ROOT_ROUTES.cron, { jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }])
    render(<Harness />)

    let fellBack = false
    act(() => { workspace.backOr('cron', () => { fellBack = true }) })
    expect(fellBack).toBe(false)
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])

    act(() => { workspace.backOr('cron', () => { fellBack = true }) })
    expect(fellBack).toBe(true)
  })

  it('clears the return origin and stack as a pair without navigating', () => {
    applyPathState('cron', [ROOT_ROUTES.cron])
    render(<Harness />)

    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'capabilities' }) })
    expect(workspace.returnOrigin).toBe('cron')

    act(() => { workspace.clearReturn() })

    expect(workspace.returnOrigin).toBeNull()
    expect($navigation.get().activeTab).toBe('capabilities')

    // The return stack is gone, so the exit falls back instead of restoring.
    act(() => { workspace.exitToReturnOrigin('sessions') })
    expect($navigation.get().activeTab).toBe('sessions')
    expect(workspace.menuOpen).toBe(false)
  })

  it('clears the return state and lands on the roster', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })
    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'capabilities' }) })
    expect(workspace.returnOrigin).toBe('cron')

    act(() => { workspace.closeToRoster() })

    expect($navigation.get().activeTab).toBe('roster')
    expect(workspace.returnOrigin).toBeNull()
  })
})