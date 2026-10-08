import { Capacitor } from '@capacitor/core'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useKeyboardViewport } from '~/pwa/use-keyboard-viewport'

function Harness() {
  const ref = useKeyboardViewport()
  return <div data-testid="shell" ref={ref}><textarea aria-label="Message" /><button>Send</button></div>
}

let viewport: EventTarget & { height: number; offsetTop: number; scale: number }
let nextFrame = 0
const frames = new Map<number, FrameRequestCallback>()

function flushFrames() {
  act(() => {
    const queued = [...frames.values()]
    frames.clear()
    for (const callback of queued) callback(0)
  })
}

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 })
  frames.clear()
  nextFrame = 0
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false)
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser keyboard viewport', () => {
  it('tracks keyboard resize and panning, then restores the CSS layout on blur', () => {
    render(<Harness />)
    const shell = screen.getByTestId('shell')
    const input = screen.getByRole('textbox')
    expect(shell.style.height).toBe('')

    input.focus()
    viewport.height = 430
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(shell.style.height).toBe('430px')
    expect(shell.style.top).toBe('0px')

    viewport.offsetTop = 45
    viewport.dispatchEvent(new Event('scroll'))
    flushFrames()
    expect(shell.style.top).toBe('45px')

    input.blur()
    flushFrames()
    expect(shell.style.height).toBe('')
    expect(shell.style.top).toBe('')
  })

  it('handles keyboard dismissal while the input stays focused and subsequent reopening', () => {
    render(<Harness />)
    screen.getByRole('textbox').focus()
    for (const height of [430, 844, 360]) {
      viewport.height = height
      viewport.dispatchEvent(new Event('resize'))
      flushFrames()
      expect(screen.getByTestId('shell').style.height).toBe(`${height}px`)
    }
  })

  it('does not mistake pinch zoom for a keyboard and resumes after zoom ends', () => {
    render(<Harness />)
    screen.getByRole('textbox').focus()
    viewport.height = 430
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(screen.getByTestId('shell').style.height).toBe('430px')

    viewport.scale = 2
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(screen.getByTestId('shell').style.height).toBe('')
    viewport.scale = 1
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(screen.getByTestId('shell').style.height).toBe('430px')
  })

  it('leaves native apps and browsers without VisualViewport unchanged', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    const native = render(<Harness />)
    screen.getByRole('textbox').focus()
    flushFrames()
    expect(screen.getByTestId('shell').style.height).toBe('')
    native.unmount()

    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false)
    vi.stubGlobal('visualViewport', undefined)
    render(<Harness />)
    screen.getByRole('textbox').focus()
    flushFrames()
    expect(screen.getByTestId('shell').style.height).toBe('')
  })

  it('removes listeners and pending updates on unmount', () => {
    const removeViewportListener = vi.spyOn(viewport, 'removeEventListener')
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')
    const view = render(<Harness />)
    const shell = screen.getByTestId('shell')
    screen.getByRole('textbox').focus()
    flushFrames()
    viewport.dispatchEvent(new Event('resize'))
    expect(frames.size).toBe(1)

    view.unmount()
    expect(frames.size).toBe(0)
    expect(shell.style.height).toBe('')
    expect(removeViewportListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeViewportListener).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(removeDocumentListener).toHaveBeenCalledWith('focusin', expect.any(Function))
    expect(removeDocumentListener).toHaveBeenCalledWith('focusout', expect.any(Function))
  })
})
