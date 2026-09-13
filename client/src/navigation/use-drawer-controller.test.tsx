import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDrawerController, type DrawerController } from '~/navigation/use-drawer-controller'

function Harness({ onReady, onDismissed }: { onReady: (controller: DrawerController) => void; onDismissed?: (intent: DrawerController['dismissRequest'] extends infer T ? T extends { intent: infer I } ? I : never : never) => void }) {
  const controller = useDrawerController({ onDismissed })
  onReady(controller)
  return null
}

afterEach(cleanup)

describe('useDrawerController', () => {
  it('opens without changing browser history', () => {
    window.history.replaceState({ screen: 'sessions' }, '', '/sessions')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    let controller!: DrawerController
    render(<Harness onReady={value => { controller = value }} />)

    act(() => { controller.openDrawer() })

    expect(controller.isOpen).toBe(true)
    expect(window.history.state).toEqual({ screen: 'sessions' })
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('completes a visual close without traversing history', () => {
    const back = vi.spyOn(window.history, 'back')
    const onDismissed = vi.fn()
    let controller!: DrawerController
    render(<Harness onDismissed={onDismissed} onReady={value => { controller = value }} />)
    act(() => { controller.openDrawer() })

    act(() => { controller.requestDismiss({ type: 'tab', tab: 'capabilities' }) })
    expect(controller.dismissRequest?.intent).toEqual({ type: 'tab', tab: 'capabilities' })
    act(() => { controller.completeDismiss() })

    expect(back).not.toHaveBeenCalled()
    expect(controller.isOpen).toBe(false)
    expect(onDismissed).toHaveBeenCalledWith({ type: 'tab', tab: 'capabilities' })
  })

  it('closes directly when a swipe reaches the dismissed endpoint', () => {
    const onDismissed = vi.fn()
    let controller!: DrawerController
    render(<Harness onDismissed={onDismissed} onReady={value => { controller = value }} />)
    act(() => { controller.openDrawer() })
    act(() => { controller.completeDismiss() })

    expect(controller.isOpen).toBe(false)
    expect(onDismissed).toHaveBeenCalledWith({ type: 'close' })
  })
})
