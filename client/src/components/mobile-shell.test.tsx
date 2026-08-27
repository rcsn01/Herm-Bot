import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MobileShell } from '~/components/mobile-shell'

describe('mobile shell scrolling', () => {
  it('keeps chrome outside the content scroller and refreshes only from its top', () => {
    const onRefresh = vi.fn()
    render(
      <MobileShell
        header={<header>Header</header>}
        navigation={<nav aria-label="Main navigation">Navigation</nav>}
        onRefresh={onRefresh}
      >
        <div>Scrollable content</div>
      </MobileShell>
    )

    const scroller = screen.getByRole('main')
    expect(scroller.contains(screen.getByText('Scrollable content'))).toBe(true)
    expect(scroller.contains(screen.getByText('Header'))).toBe(false)
    expect(scroller.contains(screen.getByRole('navigation'))).toBe(false)

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 20 })
    fireEvent.touchStart(scroller, { touches: [{ clientY: 10 }] })
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientY: 120 }] })
    expect(onRefresh).not.toHaveBeenCalled()

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 })
    fireEvent.touchStart(scroller, { touches: [{ clientY: 10 }] })
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientY: 120 }] })
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
