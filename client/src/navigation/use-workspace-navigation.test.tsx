import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $navigation, resetNavigation } from '~/navigation/navigation-store'
import { ROOT_ROUTES } from '~/navigation/routes'
import { resetWorkspacePolicy } from '~/navigation/workspace-navigation'
import { useWorkspaceNavigation, type WorkspaceNavigation } from '~/navigation/use-workspace-navigation'

// The adapter binds the core's policy/navigation stores for rendering. Dispatch
// rows (menu intents, the back tree, fallbacks) are owned by
// workspace-navigation.test.ts; this suite pins the React binding: derived
// reads, the header model, per-screen api narrowing, and history isolation.

beforeEach(() => {
  resetNavigation()
  resetWorkspacePolicy()
})
afterEach(cleanup)

let workspace!: WorkspaceNavigation

function Harness() {
  workspace = useWorkspaceNavigation()
  return null
}

describe('useWorkspaceNavigation', () => {
  it('derives the roster reads and header model at rest', () => {
    render(<Harness />)

    expect(workspace.menuOpen).toBe(false)
    expect(workspace.returnOrigin).toBeNull()
    expect(workspace.foregroundVisible).toBe(false)
    expect(workspace.foregroundDismissible).toBe(false)
    expect(workspace.header).toEqual({ destination: null, title: 'Hermes', backLabel: 'Back to bots' })
  })

  it('tracks verbs: destinations flip visibility, dismissals flip dismissibility', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })
    expect(workspace.foregroundVisible).toBe(true)
    expect(workspace.foregroundDismissible).toBe(false)
    expect(workspace.header.destination).toBe('cron')

    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'tab', tab: 'sessions' }) })
    expect(workspace.foregroundVisible).toBe(true)
    expect(workspace.foregroundDismissible).toBe(true)
    expect(workspace.header.destination).toBeNull()
  })

  it('derives the header model across a cron detail round trip', () => {
    render(<Harness />)

    act(() => { workspace.openWorkspaceDestination('cron') })
    expect(workspace.header).toEqual({ destination: 'cron', title: 'Automations', backLabel: 'Back to bots' })

    act(() => { workspace.screen('cron').navigate({ jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }) })
    expect(workspace.header).toEqual({ destination: 'cron', title: 'Job details', backLabel: 'Back' })

    act(() => { workspace.back() })
    expect(workspace.header).toEqual({ destination: 'cron', title: 'Automations', backLabel: 'Back to bots' })
  })

  it('narrows screen routes to their tab, falling back to the root for foreign routes', () => {
    render(<Harness />)

    act(() => { workspace.openSettings() })
    expect(workspace.screen('settings').route).toEqual(ROOT_ROUTES.settings)
    expect(workspace.screen('cron').route).toEqual(ROOT_ROUTES.cron)
  })

  it('flips showModelBack with the return-origin lifecycle', () => {
    render(<Harness />)

    expect(workspace.screen('settings').showModelBack).toBe(true)

    act(() => { workspace.openMenu() })
    act(() => { workspace.dismissMenu({ type: 'model' }) })
    expect(workspace.screen('settings').showModelBack).toBe(false)

    act(() => { workspace.openChatSurface() })
    expect(workspace.screen('settings').showModelBack).toBe(true)
  })

  it('keeps verb identity stable across re-renders', () => {
    const view = render(<Harness />)
    const first = {
      back: workspace.back,
      dismissForeground: workspace.dismissForeground,
      dismissMenu: workspace.dismissMenu,
      openChatSurface: workspace.openChatSurface,
      openGroupRoom: workspace.openGroupRoom,
      openMenu: workspace.openMenu,
      openSettings: workspace.openSettings,
      openWorkspaceDestination: workspace.openWorkspaceDestination
    }

    view.rerender(<Harness />)

    expect(workspace.back).toBe(first.back)
    expect(workspace.dismissForeground).toBe(first.dismissForeground)
    expect(workspace.dismissMenu).toBe(first.dismissMenu)
    expect(workspace.openChatSurface).toBe(first.openChatSurface)
    expect(workspace.openGroupRoom).toBe(first.openGroupRoom)
    expect(workspace.openMenu).toBe(first.openMenu)
    expect(workspace.openSettings).toBe(first.openSettings)
    expect(workspace.openWorkspaceDestination).toBe(first.openWorkspaceDestination)
  })

  it('does not add a history entry when StrictMode mounts it', () => {
    window.history.replaceState({ screen: 'sessions' }, '', '/sessions')
    const beforeLength = window.history.length
    render(<StrictMode><Harness /></StrictMode>)

    act(() => { workspace.openMenu() })

    expect(window.location.pathname).toBe('/sessions')
    expect(window.history.length).toBe(beforeLength)
    expect(workspace.menuOpen).toBe(true)
    expect($navigation.get().activeTab).toBe('roster')
  })
})