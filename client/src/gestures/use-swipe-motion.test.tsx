import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useMemo } from 'react'

import { useSwipeMotion, type SwipeMotionBinding } from '~/gestures/use-swipe-motion'

function Harness({
  direction = 'right',
  initialProgress,
  onCommit = vi.fn(),
  onReady = vi.fn()
}: {
  direction?: 'left' | 'right'
  initialProgress?: number
  onCommit?: (endpoint: 0 | 1) => void
  onReady?: (binding: SwipeMotionBinding) => void
}) {
  const options = useMemo(() => ({
    direction,
    enabled: true,
    extentPx: () => 200,
    initialProgress,
    onCommit,
    restingEndpoint: initialProgress === 1 ? 1 as const : 0 as const
  }), [direction, initialProgress, onCommit])
  const motion = useSwipeMotion(options)

  useEffect(() => { onReady(motion) }, [motion, onReady])

  return <div data-testid="surface" ref={motion.ref} {...motion.bind} />
}

function pointer(node: HTMLElement, type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', values: Record<string, unknown>) {
  fireEvent[type](node, { isPrimary: true, pointerId: 1, pointerType: 'touch', ...values })
}

function flushMotion() {
  act(() => { vi.runAllTimers() })
}

describe('useSwipeMotion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('tracks horizontal progress without committing during the drag', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const surface = screen.getByTestId('surface')

    pointer(surface, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(surface, 'pointerMove', { clientX: 120, clientY: 104 })

    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('0.5')
    expect(surface.dataset.swipePhase).toBe('dragging')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('settles a short drag back to rest and commits after the threshold', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<Harness onCommit={onCommit} />)
    const surface = screen.getByTestId('surface')

    pointer(surface, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(surface, 'pointerMove', { clientX: 70, clientY: 104 })
    act(() => { vi.advanceTimersByTime(200) })
    pointer(surface, 'pointerUp', { clientX: 70, clientY: 104 })
    flushMotion()
    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('0')
    expect(onCommit).not.toHaveBeenCalled()

    rerender(<Harness onCommit={onCommit} />)
    pointer(surface, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(surface, 'pointerMove', { clientX: 110, clientY: 104 })
    pointer(surface, 'pointerUp', { clientX: 110, clientY: 104 })
    flushMotion()

    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('1')
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith(1)
  })

  it('supports left-directed progress and conceals from the revealed endpoint', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<Harness direction="left" initialProgress={0} onCommit={onCommit} />)
    const surface = screen.getByTestId('surface')

    pointer(surface, 'pointerDown', { clientX: 220, clientY: 100 })
    pointer(surface, 'pointerMove', { clientX: 120, clientY: 104 })
    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('0.5')
    pointer(surface, 'pointerUp', { clientX: 120, clientY: 104 })
    flushMotion()
    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('1')
    expect(onCommit).toHaveBeenCalledWith(1)

    rerender(<Harness direction="left" initialProgress={1} onCommit={onCommit} />)
    pointer(surface, 'pointerDown', { clientX: 120, clientY: 100 })
    pointer(surface, 'pointerMove', { clientX: 220, clientY: 104 })
    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('0.5')
  })

  it('yields to vertical movement and ignores secondary pointers', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const surface = screen.getByTestId('surface')

    pointer(surface, 'pointerDown', { clientX: 20, clientY: 20 })
    pointer(surface, 'pointerMove', { clientX: 24, clientY: 80 })
    pointer(surface, 'pointerUp', { clientX: 120, clientY: 80 })
    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('0')
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerDown(surface, { isPrimary: false, pointerId: 2, pointerType: 'touch', clientX: 20, clientY: 20 })
    fireEvent.pointerMove(surface, { isPrimary: false, pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 20 })
    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('0')
  })

  it('commits a fast flick after enough travel', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const surface = screen.getByTestId('surface')

    pointer(surface, 'pointerDown', { clientX: 20, clientY: 100 })
    act(() => { vi.advanceTimersByTime(100) })
    pointer(surface, 'pointerMove', { clientX: 60, clientY: 104 })
    act(() => { vi.advanceTimersByTime(10) })
    pointer(surface, 'pointerUp', { clientX: 80, clientY: 104 })
    flushMotion()

    expect(onCommit).toHaveBeenCalledWith(1)
  })

  it('cancels, handles lost pointers, and suppresses the follow-up click', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const surface = screen.getByTestId('surface')

    pointer(surface, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(surface, 'pointerMove', { clientX: 120, clientY: 104 })
    fireEvent.pointerCancel(surface, { pointerId: 1 })
    flushMotion()
    expect(surface.style.getPropertyValue('--swipe-progress')).toBe('0')
    expect(onCommit).not.toHaveBeenCalled()

    pointer(surface, 'pointerDown', { clientX: 20, clientY: 100 })
    pointer(surface, 'pointerMove', { clientX: 120, clientY: 104 })
    pointer(surface, 'pointerUp', { clientX: 120, clientY: 104 })
    flushMotion()
    const click = fireEvent.click(surface)
    expect(click).toBe(false)
  })
})
