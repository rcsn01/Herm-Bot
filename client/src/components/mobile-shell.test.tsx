import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileShell } from '~/components/mobile-shell'

afterEach(cleanup)

function renderShell(drawerOpen = false, reconnecting = false) {
  const onOpenDrawer = vi.fn()
  const onRefresh = vi.fn()
  const onAction = vi.fn()
  render(
    <MobileShell
      drawer={<aside>Drawer</aside>}
      drawerOpen={drawerOpen}
      header={<header>Header</header>}
      onOpenDrawer={onOpenDrawer}
      onRefresh={onRefresh}
      reconnecting={reconnecting}
    >
      <div><button onClick={onAction}>Action</button>Scrollable content</div>
    </MobileShell>
  )
  return { onAction, onOpenDrawer, onRefresh, scroller: screen.getByRole('main') }
}

function gesture(scroller: HTMLElement, start: readonly [number, number], end: readonly [number, number], touches = 1) {
  const startTouches = Array.from({ length: touches }, (_, index) => ({ clientX: start[0] + index, clientY: start[1] }))
  fireEvent.touchStart(scroller, { touches: startTouches })
  fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: end[0], clientY: end[1] }] })
}

describe('MobileShell', () => {
  it('keeps the header and drawer outside the content scroller without bottom navigation', () => {
    const { scroller } = renderShell()

    expect(scroller.contains(screen.getByText('Scrollable content'))).toBe(true)
    expect(scroller.contains(screen.getByText('Header'))).toBe(false)
    expect(scroller.contains(screen.getByText('Drawer'))).toBe(false)
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
  })

  it('opens the drawer for a qualifying right swipe without refreshing', () => {
    const { onOpenDrawer, onRefresh, scroller } = renderShell()
    gesture(scroller, [20, 100], [100, 110])

    expect(onOpenDrawer).toHaveBeenCalledOnce()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('refreshes for a vertical pull from the top without opening the drawer', () => {
    const { onOpenDrawer, onRefresh, scroller } = renderShell()
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 })
    gesture(scroller, [40, 10], [45, 105])

    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onOpenDrawer).not.toHaveBeenCalled()
  })

  it('ignores vertical pulls that start away from the scroll top', () => {
    const { onOpenDrawer, onRefresh, scroller } = renderShell()
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 20 })
    gesture(scroller, [40, 10], [45, 120])

    expect(onRefresh).not.toHaveBeenCalled()
    expect(onOpenDrawer).not.toHaveBeenCalled()
  })

  it.each([
    ['leftward', [100, 50], [10, 52], 1],
    ['short', [10, 50], [70, 52], 1],
    ['diagonal', [10, 10], [100, 100], 1],
    ['multi-touch', [10, 50], [100, 52], 2]
  ] as const)('ignores %s gestures', (_label, start, end, touches) => {
    const { onOpenDrawer, onRefresh, scroller } = renderShell()
    gesture(scroller, start, end, touches)

    expect(onOpenDrawer).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('locks the main screen and does not process gestures while the drawer is open', () => {
    const { onOpenDrawer, onRefresh, scroller } = renderShell(true)
    expect(scroller.hasAttribute('inert')).toBe(true)
    expect(scroller.closest('.mobile-shell')?.classList.contains('drawer-open')).toBe(true)

    gesture(scroller, [10, 50], [100, 52])
    gesture(scroller, [40, 10], [42, 120])

    expect(onOpenDrawer).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('announces reconnecting state, makes the shell inert, and ignores interactions', () => {
    const { onAction, onOpenDrawer, onRefresh, scroller } = renderShell(false, true)
    const shell = screen.getByText('Header').closest('.mobile-shell')

    expect(shell?.getAttribute('aria-busy')).toBe('true')
    expect(shell?.hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Reconnecting')

    fireEvent.click(screen.getByRole('button', { name: 'Action' }))
    gesture(scroller, [10, 50], [100, 52])
    gesture(scroller, [40, 10], [42, 120])

    expect(onAction).not.toHaveBeenCalled()
    expect(onOpenDrawer).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
