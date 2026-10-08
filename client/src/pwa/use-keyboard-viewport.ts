import { Capacitor } from '@capacitor/core'
import { useEffect, useRef } from 'react'

/** Keep browser inputs above the keyboard without changing native shell sizing. */
export function useKeyboardViewport() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const shell = ref.current
    const viewport = window.visualViewport
    if (!shell || !viewport || Capacitor.isNativePlatform()) return

    let frame: number | null = null
    const restore = () => {
      shell.style.removeProperty('height')
      shell.style.removeProperty('top')
    }
    const update = () => {
      const focused = document.activeElement
      const editing = focused instanceof HTMLElement
        && focused.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')
      // A zoomed viewport is not a keyboard resize. Don't relayout the app
      // while the user is magnifying it. Preserve the standalone CSS fallback.
      if (!editing || viewport.scale !== 1) {
        restore()
        return
      }
      shell.style.height = `${viewport.height}px`
      shell.style.top = `${viewport.offsetTop}px`
    }
    const scheduleUpdate = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        update()
      })
    }

    update()
    viewport.addEventListener('resize', scheduleUpdate)
    viewport.addEventListener('scroll', scheduleUpdate)
    window.addEventListener('resize', scheduleUpdate)
    document.addEventListener('focusin', scheduleUpdate)
    document.addEventListener('focusout', scheduleUpdate)

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', scheduleUpdate)
      viewport.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      document.removeEventListener('focusin', scheduleUpdate)
      document.removeEventListener('focusout', scheduleUpdate)
      restore()
    }
  }, [])

  return ref
}
