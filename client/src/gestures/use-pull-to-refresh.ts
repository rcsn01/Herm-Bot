import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { useEffect, useRef, useState, type RefObject } from 'react'

const REFRESH_DISTANCE = 90
const MIN_FEEDBACK_MS = 350

interface Options {
  enabled: boolean
  refreshing: boolean
  onRefresh(): unknown
  surface: 'foreground' | 'roster'
}

interface Pull {
  id: number
  x: number
  y: number
  vertical: boolean
  ticked: boolean
}

/** One refresh gesture and its feedback for the shell's visible scroll surface. */
export function usePullToRefresh(shellRef: RefObject<HTMLElement | null>, options: Options) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const pull = useRef<Pull | null>(null)
  const pending = useRef(false)
  const [distance, setDistance] = useState(0)
  const [feedback, setFeedback] = useState<'idle' | 'refreshing' | 'error'>('idle')

  useEffect(() => {
    pull.current = null
    setDistance(0)
  }, [options.enabled, options.refreshing, options.surface])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    let mounted = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      pull.current = null
      setDistance(0)
    }
    const available = () => optionsRef.current.enabled && !optionsRef.current.refreshing && !pending.current
    const tick = (gesture: Pull) => {
      if (gesture.ticked) return
      gesture.ticked = true
      void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
    }
    const start = (event: TouchEvent) => {
      cancel()
      if (!available() || event.touches.length !== 1 || !(event.target instanceof Element)) return
      const target = event.target
      if (target.closest('input, textarea, select, [contenteditable="true"], [inert]')) return
      const scroller = target.closest<HTMLElement>('.view-container')
      if (!scroller || scroller.scrollTop > 0) return
      // A nested output panel must finish its own scrolling before refreshing.
      for (let node: Element | null = target; node && node !== scroller; node = node.parentElement) {
        if (node.scrollTop > 0) return
      }
      clearTimeout(timer)
      setFeedback('idle')
      const touch = event.touches[0]
      pull.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY, vertical: false, ticked: false }
    }
    const update = (touch: Touch) => {
      const gesture = pull.current
      if (!gesture || touch.identifier !== gesture.id) return 0
      const dx = touch.clientX - gesture.x
      const dy = touch.clientY - gesture.y
      if (!gesture.vertical) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return 0
        if (dy <= 0 || dy <= 1.2 * Math.abs(dx)) {
          cancel()
          return 0
        }
        gesture.vertical = true
      }
      const next = Math.max(0, dy)
      setDistance(next)
      if (next >= REFRESH_DISTANCE) tick(gesture)
      return next
    }
    const move = (event: TouchEvent) => {
      if (!pull.current) return
      if (!available() || event.touches.length !== 1) { cancel(); return }
      const distance = update(event.touches[0])
      // Native non-passive listener: don't let browser overscroll fight the animation.
      if (distance > 0 && event.cancelable) event.preventDefault()
    }
    const end = (event: TouchEvent) => {
      if (!pull.current) return
      if (!available() || event.changedTouches.length !== 1) { cancel(); return }
      const distance = update(event.changedTouches[0])
      const gesture = pull.current
      cancel()
      if (!gesture?.vertical || distance < REFRESH_DISTANCE) return
      pending.current = true
      setFeedback('refreshing')
      const started = performance.now()
      const finish = (failed: boolean) => {
        if (!mounted) return
        timer = setTimeout(() => {
          pending.current = false
          setFeedback(failed ? 'error' : 'idle')
          if (failed) timer = setTimeout(() => setFeedback('idle'), 1200)
        }, Math.max(0, MIN_FEEDBACK_MS - (performance.now() - started)))
      }
      // Capture synchronous failures too, without claiming a failed refresh succeeded.
      try { Promise.resolve(optionsRef.current.onRefresh()).then(() => finish(false), () => finish(true)) }
      catch { finish(true) }
    }
    shell.addEventListener('touchstart', start, { passive: true })
    shell.addEventListener('touchmove', move, { passive: false })
    shell.addEventListener('touchend', end, { passive: true })
    shell.addEventListener('touchcancel', cancel, { passive: true })
    return () => {
      mounted = false
      clearTimeout(timer)
      shell.removeEventListener('touchstart', start)
      shell.removeEventListener('touchmove', move)
      shell.removeEventListener('touchend', end)
      shell.removeEventListener('touchcancel', cancel)
    }
  }, [shellRef])

  const busy = options.refreshing || feedback === 'refreshing'
  const phase = !options.enabled ? 'idle' : busy ? 'refreshing' : feedback === 'error' ? 'error' : distance >= REFRESH_DISTANCE ? 'armed' : distance > 0 ? 'pulling' : 'idle'
  return { distance, phase, progress: Math.min(distance / REFRESH_DISTANCE, 1) }
}
