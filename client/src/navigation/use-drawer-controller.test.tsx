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
  it('opens with a drawer sentinel layered over the current screen entry', () => {
    window.history.replaceState({ hermesScreen: 4 }, '', '/sessions')
    let controller!: DrawerController
    render(<Harness onReady={value => { controller = value }} />)

    act(() => { controller.openDrawer() })

    expect(controller.isOpen).toBe(true)
    expect(window.history.state).toMatchObject({ hermesDrawer: true, hermesDrawerBase: true, hermesScreen: 4 })
  })

  it('waits for guard consumption before completing a visual close and intent', () => {
    window.history.replaceState({ hermesScreen: 4 }, '', '/sessions')
    const back = vi.spyOn(window.history, 'back')
    const onDismissed = vi.fn()
    let controller!: DrawerController
    render(<Harness onDismissed={onDismissed} onReady={value => { controller = value }} />)
    act(() => { controller.openDrawer() })

    act(() => { controller.requestDismiss({ type: 'tab', tab: 'capabilities' }) })
    expect(controller.dismissRequest?.intent).toEqual({ type: 'tab', tab: 'capabilities' })
    act(() => { controller.completeDismiss() })
    expect(back).toHaveBeenCalledOnce()
    expect(onDismissed).not.toHaveBeenCalled()

    act(() => {
      window.history.replaceState({ hermesScreen: 4, hermesDrawerBase: true }, '', '/sessions')
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
    })
    expect(controller.isOpen).toBe(false)
    expect(onDismissed).toHaveBeenCalledWith({ type: 'tab', tab: 'capabilities' })
    back.mockRestore()
  })

  it('turns native back into a dismissal request without traversing history twice', () => {
    window.history.replaceState({ hermesScreen: 4 }, '', '/sessions')
    const back = vi.spyOn(window.history, 'back')
    let controller!: DrawerController
    render(<Harness onReady={value => { controller = value }} />)
    act(() => { controller.openDrawer() })

    act(() => {
      window.history.replaceState({ hermesScreen: 4, hermesDrawerBase: true }, '', '/sessions')
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
    })
    expect(controller.isOpen).toBe(true)
    expect(controller.dismissRequest?.intent).toEqual({ type: 'close' })

    act(() => { controller.completeDismiss() })
    expect(back).not.toHaveBeenCalled()
    expect(controller.isOpen).toBe(false)
    back.mockRestore()
  })
})
