import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Haptics } from '@capacitor/haptics'

vi.mock('@capacitor/haptics', () => ({ Haptics: { impact: vi.fn().mockResolvedValue(undefined) }, ImpactStyle: { Light: 'LIGHT' } }))

import { MobileShell } from '~/components/mobile-shell'

afterEach(cleanup)

function renderShell({ navigationPageOpen = false, foregroundVisible = true, reconnecting = false, refreshing = false, refreshHandler = vi.fn() } = {}) {
  const onAction = vi.fn()
  const onDismissForeground = vi.fn()
  const onRefresh = refreshHandler
  const view = render(
    <MobileShell
      navigationPage={<aside>Navigation page</aside>}
      navigationPageOpen={navigationPageOpen}
      foreground={<div><button onClick={onAction}>Action</button><details><summary>Activity toggle</summary><pre>Output</pre></details>Foreground content</div>}
      foregroundDismissible
      foregroundHeader={<header>Foreground header</header>}
      foregroundVisible={foregroundVisible}
      onDismissForeground={onDismissForeground}
      onRefresh={onRefresh}
      reconnecting={reconnecting}
      refreshing={refreshing}
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
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
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

  it('leaves details summaries to their own controls instead of capturing their pointers', () => {
    const { foreground, onDismissForeground } = renderShell()
    const summary = screen.getByText('Activity toggle')
    pointer(summary, 'pointerDown', { clientX: 20, clientY: 100 })
    expect(foreground.getAttribute('data-swipe-phase')).toBe('idle')
    pointer(summary, 'pointerMove', { clientX: 420, clientY: 108 })
    pointer(summary, 'pointerUp', { clientX: 420, clientY: 108 })
    act(() => { vi.runAllTimers() })
    expect(onDismissForeground).not.toHaveBeenCalled()
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

  it('follows the finger, arms with one light tick, and disarms when pulled back', () => {
    const { foreground, onRefresh } = renderShell()
    const scroller = foreground.querySelector<HTMLElement>('.view-container')!
    const indicator = foreground.closest('.mobile-shell')!.querySelector<HTMLElement>('.pull-refresh')!
    fireEvent.touchStart(scroller, { touches: [{ identifier: 1, clientX: 40, clientY: 100 }] })
    expect(fireEvent.touchMove(scroller, { cancelable: true, touches: [{ identifier: 1, clientX: 40, clientY: 145 }] })).toBe(false)
    expect(indicator.dataset.phase).toBe('pulling')
    expect(indicator.textContent).toContain('Pull to refresh')
    expect(Number(indicator.querySelector<SVGElement>('.pull-refresh-ring')!.style.strokeDashoffset)).toBeCloseTo(31.415)
    expect(Haptics.impact).not.toHaveBeenCalled()
    fireEvent.touchMove(scroller, { touches: [{ identifier: 1, clientX: 40, clientY: 195 }] })
    expect(indicator.dataset.phase).toBe('armed')
    expect(indicator.textContent).toContain('Release to refresh')
    fireEvent.touchMove(scroller, { touches: [{ identifier: 1, clientX: 40, clientY: 205 }] })
    expect(Haptics.impact).toHaveBeenCalledExactlyOnceWith({ style: 'LIGHT' })
    fireEvent.touchMove(scroller, { touches: [{ identifier: 1, clientX: 40, clientY: 145 }] })
    expect(indicator.dataset.phase).toBe('pulling')
    fireEvent.touchEnd(scroller, { changedTouches: [{ identifier: 1, clientX: 40, clientY: 145 }] })
    expect(indicator.dataset.phase).toBe('idle')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('holds the spinner during refresh, blocks duplicates, and settles when done', async () => {
    let resolve!: () => void
    const refreshHandler = vi.fn(() => new Promise<void>(done => { resolve = done }))
    const { foreground } = renderShell({ refreshHandler })
    const scroller = foreground.querySelector<HTMLElement>('.view-container')!
    const indicator = foreground.closest('.mobile-shell')!.querySelector<HTMLElement>('.pull-refresh')!
    const gesture = () => {
      fireEvent.touchStart(scroller, { touches: [{ identifier: 1, clientX: 40, clientY: 100 }] })
      fireEvent.touchMove(scroller, { touches: [{ identifier: 1, clientX: 40, clientY: 205 }] })
      fireEvent.touchEnd(scroller, { changedTouches: [{ identifier: 1, clientX: 40, clientY: 205 }] })
    }
    gesture()
    expect(indicator.dataset.phase).toBe('refreshing')
    expect(screen.getByRole('status').textContent).toContain('Refreshing')
    gesture()
    expect(refreshHandler).toHaveBeenCalledOnce()
    await act(async () => { resolve(); await Promise.resolve() })
    expect(indicator.dataset.phase).toBe('refreshing')
    act(() => vi.runAllTimers())
    expect(indicator.dataset.phase).toBe('idle')
    expect(indicator.getAttribute('aria-hidden')).toBe('true')
  })

  it.each(['short', 'horizontal', 'upward', 'cancelled', 'multitouch', 'scrolled', 'nested-scrolled'])('does not refresh a %s gesture', kind => {
    const { foreground, onRefresh } = renderShell()
    const scroller = foreground.querySelector<HTMLElement>('.view-container')!
    const target = kind === 'nested-scrolled' ? screen.getByText('Output') : scroller
    if (kind === 'scrolled' || kind === 'nested-scrolled') Object.defineProperty(target, 'scrollTop', { value: 20 })
    const touch = { identifier: 1, clientX: 40, clientY: 100 }
    fireEvent.touchStart(target, { touches: [touch] })
    const next = { ...touch, clientX: kind === 'horizontal' ? 240 : 40, clientY: kind === 'short' ? 140 : kind === 'upward' ? 0 : 220 }
    fireEvent.touchMove(target, { touches: kind === 'multitouch' ? [next, { ...next, identifier: 2 }] : [next] })
    if (kind === 'cancelled') fireEvent.touchCancel(target)
    fireEvent.touchEnd(target, { changedTouches: [next] })
    expect(onRefresh).not.toHaveBeenCalled()
    expect(foreground.closest('.mobile-shell')!.querySelector<HTMLElement>('.pull-refresh')!.dataset.phase).toBe('idle')
  })

  it.each([{ navigationPageOpen: true }, { reconnecting: true }, { refreshing: true }])('blocks pulls while unavailable: %j', options => {
    const { foreground, onRefresh } = renderShell(options)
    const scroller = foreground.querySelector<HTMLElement>('.view-container')!
    fireEvent.touchStart(scroller, { touches: [{ clientX: 40, clientY: 100 }] })
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 40, clientY: 220 }] })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('supports the roster and keeps refreshing when haptics are unavailable', async () => {
    vi.mocked(Haptics.impact).mockRejectedValueOnce(new Error('Unsupported'))
    const { roster, onRefresh } = renderShell({ foregroundVisible: false })
    const scroller = roster.querySelector<HTMLElement>('.view-container')!
    fireEvent.touchStart(scroller, { touches: [{ clientX: 40, clientY: 100 }] })
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 40, clientY: 220 }] })
    await act(async () => { await Promise.resolve() })
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('shows failed refresh feedback and clears its timers on unmount', async () => {
    const { foreground, view } = renderShell({ refreshHandler: vi.fn().mockRejectedValue(new Error('Offline')) })
    const scroller = foreground.querySelector<HTMLElement>('.view-container')!
    fireEvent.touchStart(scroller, { touches: [{ clientX: 40, clientY: 100 }] })
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 40, clientY: 220 }] })
    await act(async () => { await Promise.resolve() })
    act(() => vi.runOnlyPendingTimers())
    expect(screen.getByRole('status').textContent).toContain('Could not refresh')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disables foreground motion while the navigation page is open or reconnecting', () => {
    const navigationPage = renderShell({ navigationPageOpen: true })
    pointer(navigationPage.foreground, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(navigationPage.foreground, 'pointerMove', { clientX: 420, clientY: 108 })
    expect(navigationPage.foreground.style.getPropertyValue('--swipe-progress')).toBe('0')
    navigationPage.view.unmount()

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
