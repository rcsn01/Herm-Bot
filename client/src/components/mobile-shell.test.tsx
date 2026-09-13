import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MobileShell } from '~/components/mobile-shell'

afterEach(cleanup)

function renderShell({ drawerOpen = false, foregroundVisible = true, reconnecting = false } = {}) {
  const onAction = vi.fn()
  const onDismissForeground = vi.fn()
  const onRefresh = vi.fn()
  const view = render(
    <MobileShell
      drawer={<aside>Drawer</aside>}
      drawerOpen={drawerOpen}
      foreground={<div><button onClick={onAction}>Action</button>Foreground content</div>}
      foregroundDismissible
      foregroundHeader={<header>Foreground header</header>}
      foregroundVisible={foregroundVisible}
      onDismissForeground={onDismissForeground}
      onRefresh={onRefresh}
      reconnecting={reconnecting}
      roster={<div>Roster content</div>}
      rosterHeader={<header>Roster header</header>}
    />
  )
  return {
    foreground: view.container.querySelector<HTMLElement>('.foreground-layer')!,
    onAction,
    onDismissForeground,
    onRefresh,
    roster: view.container.querySelector<HTMLElement>('.roster-layer')!,
    view
  }
}

function pointer(node: HTMLElement, type: 'pointerDown' | 'pointerMove' | 'pointerUp', values: Record<string, unknown>) {
  fireEvent[type](node, { isPrimary: true, pointerId: 1, pointerType: 'touch', ...values })
}

describe('MobileShell', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the roster fixed underneath a complete foreground layer', () => {
    const { foreground, roster } = renderShell()

    expect(foreground.contains(screen.getByText('Foreground header'))).toBe(true)
    expect(roster.contains(screen.getByText('Roster header'))).toBe(true)
    expect(roster.contains(screen.getByText('Roster content'))).toBe(true)
    expect(roster.getAttribute('aria-hidden')).toBe('true')
    expect(roster.hasAttribute('inert')).toBe(true)
  })

  it('tracks a rightward foreground drag and commits only after settling', () => {
    const { foreground, onDismissForeground } = renderShell()

    pointer(foreground, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(foreground, 'pointerMove', { clientX: 420, clientY: 108 })
    expect(foreground.style.getPropertyValue('--swipe-progress')).toBe('0.390625')
    expect(onDismissForeground).not.toHaveBeenCalled()

    pointer(foreground, 'pointerUp', { clientX: 420, clientY: 108 })
    act(() => { vi.runAllTimers() })
    expect(onDismissForeground).toHaveBeenCalledOnce()
  })

  it('does not navigate on a leftward screen swipe', () => {
    const { foreground, onDismissForeground } = renderShell()

    pointer(foreground, 'pointerDown', { clientX: 420, clientY: 100 })
    pointer(foreground, 'pointerMove', { clientX: 20, clientY: 108 })
    pointer(foreground, 'pointerUp', { clientX: 20, clientY: 108 })
    act(() => { vi.runAllTimers() })

    expect(foreground.style.getPropertyValue('--swipe-progress')).toBe('0')
    expect(onDismissForeground).not.toHaveBeenCalled()
  })

  it('keeps vertical pull-to-refresh separate from horizontal motion', () => {
    const { onDismissForeground, onRefresh, foreground } = renderShell()
    const scroller = foreground.querySelector<HTMLElement>('.view-container')!
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 })

    fireEvent.touchStart(scroller, { touches: [{ clientX: 40, clientY: 10 }] })
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 45, clientY: 105 }] })

    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onDismissForeground).not.toHaveBeenCalled()
  })

  it('disables foreground motion while the drawer is open or reconnecting', () => {
    const drawer = renderShell({ drawerOpen: true })
    pointer(drawer.foreground, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(drawer.foreground, 'pointerMove', { clientX: 420, clientY: 108 })
    expect(drawer.foreground.style.getPropertyValue('--swipe-progress')).toBe('0')
    drawer.view.unmount()

    const reconnecting = renderShell({ reconnecting: true })
    pointer(reconnecting.foreground, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(reconnecting.foreground, 'pointerMove', { clientX: 420, clientY: 108 })
    expect(reconnecting.foreground.style.getPropertyValue('--swipe-progress')).toBe('0')
  })

  it('makes the shell inert while reconnecting', () => {
    const { onAction, onRefresh, foreground } = renderShell({ reconnecting: true })
    const shell = foreground.closest('.mobile-shell')!

    expect(shell.getAttribute('aria-busy')).toBe('true')
    expect(shell.hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Reconnecting')

    fireEvent.click(screen.getByRole('button', { name: 'Action' }))
    expect(onAction).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
