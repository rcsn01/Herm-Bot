import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useNavigationPageController, type NavigationPageController, type NavigationPageDismissIntent } from '~/navigation/use-navigation-page-controller'

function Harness({ onReady, onDismissed }: { onReady: (controller: NavigationPageController) => void; onDismissed?: (intent: NavigationPageDismissIntent) => void }) {
  const controller = useNavigationPageController({ onDismissed })
  onReady(controller)
  return null
}

afterEach(cleanup)

describe('useNavigationPageController', () => {
  it('opens without changing the browser URL or history entry', () => {
    window.history.replaceState({ screen: 'sessions' }, '', '/sessions')
    const beforeLength = window.history.length
    const beforeState = window.history.state
    let controller!: NavigationPageController
    render(<Harness onReady={value => { controller = value }} />)

    act(() => { controller.openNavigationPage() })

    expect(controller.isOpen).toBe(true)
    expect(window.location.pathname).toBe('/sessions')
    expect(window.history.length).toBe(beforeLength)
    expect(window.history.state).toBe(beforeState)
  })

  it('dismisses immediately in memory and reports the intent', () => {
    const onDismissed = vi.fn()
    let controller!: NavigationPageController
    render(<Harness onDismissed={onDismissed} onReady={value => { controller = value }} />)

    act(() => { controller.openNavigationPage() })
    act(() => { controller.requestDismiss({ type: 'tab', tab: 'capabilities' }) })

    expect(controller.isOpen).toBe(false)
    expect(onDismissed).toHaveBeenCalledExactlyOnceWith({ type: 'tab', tab: 'capabilities' })
  })

  it('does not close or report an intent when already closed', () => {
    const onDismissed = vi.fn()
    let controller!: NavigationPageController
    render(<Harness onDismissed={onDismissed} onReady={value => { controller = value }} />)

    act(() => { controller.requestDismiss() })

    expect(controller.isOpen).toBe(false)
    expect(onDismissed).not.toHaveBeenCalled()
  })

  it('does not add a history entry when StrictMode mounts it', () => {
    window.history.replaceState({ screen: 'sessions' }, '', '/sessions')
    const beforeLength = window.history.length
    let controller!: NavigationPageController
    render(<StrictMode><Harness onReady={value => { controller = value }} /></StrictMode>)

    act(() => { controller.openNavigationPage() })

    expect(window.location.pathname).toBe('/sessions')
    expect(window.history.length).toBe(beforeLength)
    expect(controller.isOpen).toBe(true)
  })
})
