import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefCallback } from 'react'

export type SwipeDirection = 'left' | 'right'
export type SwipePhase = 'idle' | 'pending' | 'dragging' | 'settling'
export type SwipeEndpoint = 0 | 1

export interface SwipeMotionOptions {
  canStart?(target: EventTarget | null): boolean
  direction: SwipeDirection
  enabled: boolean
  extentPx(): number
  initialProgress?: number
  onCommit(endpoint: SwipeEndpoint): void
  restingEndpoint: SwipeEndpoint
}

export interface SwipeAnimateOptions {
  commit?: boolean
  durationMs?: number
  onSettled?(): void
}

export interface SwipeMotionBinding {
  animateTo(endpoint: SwipeEndpoint, options?: SwipeAnimateOptions): void
  bind: {
    'data-swipe-direction': SwipeDirection
    'data-swipe-phase': SwipePhase
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  }
  cancel(): void
  phase: SwipePhase
  progress: number
  ref: RefCallback<HTMLElement>
  setProgress(progress: number): void
}

interface ActivePointer {
  id: number
  locked: boolean
  startProgress: number
  startTime: number
  startX: number
  startY: number
  lastX: number
  lastY: number
}

const ACTIVATION_SLOP_PX = 8
const HORIZONTAL_RATIO = 1.2
const COMMIT_PROGRESS = 0.35
const FLICK_MIN_DISTANCE_PX = 12
const FLICK_MIN_SPEED_PX_MS = 0.5
const FULL_SETTLE_MS = 220
const MIN_SETTLE_MS = 80

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress))
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useSwipeMotion(options: SwipeMotionOptions): SwipeMotionBinding {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const elementRef = useRef<HTMLElement | null>(null)
  const progressRef = useRef(clampProgress(options.initialProgress ?? options.restingEndpoint))
  const phaseRef = useRef<SwipePhase>('idle')
  const activePointerRef = useRef<ActivePointer | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const animationTokenRef = useRef(0)
  const suppressClickRef = useRef(false)
  const [phase, setPhase] = useState<SwipePhase>('idle')

  const writeProgress = useCallback((progress: number) => {
    const clamped = clampProgress(progress)
    progressRef.current = clamped
    const element = elementRef.current
    if (!element) return
    element.style.setProperty('--swipe-progress', String(clamped))
  }, [])

  const writePhase = useCallback((nextPhase: SwipePhase) => {
    phaseRef.current = nextPhase
    setPhase(current => current === nextPhase ? current : nextPhase)
    if (elementRef.current) elementRef.current.dataset.swipePhase = nextPhase
  }, [])

  const cancelAnimation = useCallback(() => {
    animationTokenRef.current += 1
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [])

  const releasePointer = useCallback((element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId)
  }, [])

  const finishAnimation = useCallback((
    endpoint: SwipeEndpoint,
    commit: boolean,
    onSettled?: () => void
  ) => {
    writeProgress(endpoint)
    writePhase('idle')
    if (commit) optionsRef.current.onCommit(endpoint)
    onSettled?.()
  }, [writePhase, writeProgress])

  const animateTo = useCallback((endpoint: SwipeEndpoint, animateOptions: SwipeAnimateOptions = {}) => {
    cancelAnimation()
    activePointerRef.current = null
    const start = progressRef.current
    const distance = Math.abs(endpoint - start)
    const token = animationTokenRef.current
    if (distance < 0.0001) {
      finishAnimation(endpoint, Boolean(animateOptions.commit), animateOptions.onSettled)
      return
    }

    writePhase('settling')
    const duration = prefersReducedMotion()
      ? 0
      : animateOptions.durationMs ?? Math.max(MIN_SETTLE_MS, Math.min(FULL_SETTLE_MS, FULL_SETTLE_MS * distance))
    if (duration === 0) {
      finishAnimation(endpoint, Boolean(animateOptions.commit), animateOptions.onSettled)
      return
    }

    const startedAt = performance.now()
    const frame = (timestamp: number) => {
      if (animationTokenRef.current !== token) return
      const t = Math.min(1, (timestamp - startedAt) / duration)
      const eased = t * t * (3 - 2 * t)
      writeProgress(start + (endpoint - start) * eased)
      if (t >= 1) {
        animationFrameRef.current = null
        finishAnimation(endpoint, Boolean(animateOptions.commit), animateOptions.onSettled)
      } else {
        animationFrameRef.current = requestAnimationFrame(frame)
      }
    }
    animationFrameRef.current = requestAnimationFrame(frame)
  }, [cancelAnimation, finishAnimation, writePhase, writeProgress])

  const setProgress = useCallback((progress: number) => {
    cancelAnimation()
    activePointerRef.current = null
    writeProgress(progress)
    writePhase('idle')
  }, [cancelAnimation, writePhase, writeProgress])

  const cancel = useCallback(() => {
    animateTo(optionsRef.current.restingEndpoint)
  }, [animateTo])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = optionsRef.current
    if (!current.enabled || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return
    if (current.canStart && !current.canStart(event.target)) return
    cancelAnimation()
    const element = event.currentTarget
    const now = performance.now()
    activePointerRef.current = {
      id: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      locked: false,
      startProgress: progressRef.current,
      startTime: now,
      startX: event.clientX,
      startY: event.clientY
    }
    suppressClickRef.current = false
    writePhase('pending')
    element.setPointerCapture?.(event.pointerId)
  }, [cancelAnimation, writePhase])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = activePointerRef.current
    const current = optionsRef.current
    if (!active || active.id !== event.pointerId || !current.enabled) return
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)
    active.lastX = event.clientX
    active.lastY = event.clientY
    if (!active.locked) {
      if (Math.max(absX, absY) < ACTIVATION_SLOP_PX) return
      if (absX <= HORIZONTAL_RATIO * absY) {
        const element = event.currentTarget
        activePointerRef.current = null
        releasePointer(element, event.pointerId)
        writePhase('idle')
        return
      }
      active.locked = true
      writePhase('dragging')
    }
    event.preventDefault()
    suppressClickRef.current = true
    const sign = current.direction === 'right' ? 1 : -1
    const extent = Math.max(1, current.extentPx())
    writeProgress(active.startProgress + sign * dx / extent)
  }, [releasePointer, writePhase, writeProgress])

  const settlePointer = useCallback((event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const active = activePointerRef.current
    const current = optionsRef.current
    if (!active || active.id !== event.pointerId) return
    activePointerRef.current = null
    releasePointer(event.currentTarget, event.pointerId)
    if (!active.locked) {
      writePhase('idle')
      return
    }
    const sign = current.direction === 'right' ? 1 : -1
    const signedDistance = sign * (event.clientX - active.startX)
    const elapsed = Math.max(1, performance.now() - active.startTime)
    const speed = Math.abs(signedDistance) / elapsed
    const towardEndpoint = current.restingEndpoint === 0
      ? progressRef.current >= COMMIT_PROGRESS
      : progressRef.current <= 1 - COMMIT_PROGRESS
    const flick = !cancelled && signedDistance >= FLICK_MIN_DISTANCE_PX && speed >= FLICK_MIN_SPEED_PX_MS
    const commit = !cancelled && (towardEndpoint || flick)
    const endpoint: SwipeEndpoint = commit ? (current.restingEndpoint === 0 ? 1 : 0) : current.restingEndpoint
    animateTo(endpoint, { commit })
  }, [animateTo, releasePointer, writePhase])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    settlePointer(event, false)
  }, [settlePointer])

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    settlePointer(event, true)
  }, [settlePointer])

  const onLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (activePointerRef.current?.id === event.pointerId) settlePointer(event, true)
  }, [settlePointer])

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const ref = useCallback<RefCallback<HTMLElement>>(element => {
    elementRef.current = element
    if (!element) return
    element.style.setProperty('--swipe-progress', String(progressRef.current))
    element.dataset.swipePhase = phaseRef.current
    element.dataset.swipeDirection = optionsRef.current.direction
  }, [])

  useEffect(() => {
    if (elementRef.current) elementRef.current.dataset.swipeDirection = options.direction
    if (!options.enabled && phaseRef.current !== 'settling') setProgress(options.restingEndpoint)
  }, [options.direction, options.enabled, options.restingEndpoint, setProgress])

  useEffect(() => () => {
    cancelAnimation()
    activePointerRef.current = null
  }, [cancelAnimation])

  return {
    animateTo,
    bind: {
      'data-swipe-direction': options.direction,
      'data-swipe-phase': phase,
      onClickCapture,
      onLostPointerCapture,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp
    },
    cancel,
    phase,
    progress: progressRef.current,
    ref,
    setProgress
  }
}
