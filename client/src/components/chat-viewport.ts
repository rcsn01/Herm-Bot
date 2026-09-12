import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

import type { ToolActivity } from '~/lib/types'
import type { TranscriptEntry } from '~/transcript/transcript'

const LATEST_DISTANCE_THRESHOLD = 64
const USER_SCROLL_PAUSE_THRESHOLD = 48
const USER_SCROLL_IDLE_MS = 200

export interface ChatViewportOptions {
  active: boolean
  session: {
    runtimeSessionId: null | string
    storedSessionId: null | string
  }
  content: {
    entries: readonly TranscriptEntry[]
    tools: readonly ToolActivity[]
  }
  history: {
    hasMore: boolean
    loadingOlder: boolean
    nextOffset: number
  }
  /** Resolves true only when the domain published an older page; false means no-op, stale, or aborted. */
  onLoadOlder(): Promise<boolean>
  onLoadOlderError(error: unknown): void
}

export interface ChatViewportBinding {
  bottomRef: RefObject<HTMLDivElement | null>
  hasNewMessages: boolean
  jumpToLatest(): void
  loadOlderMessages(): Promise<void>
  olderMessagesRef: RefObject<HTMLButtonElement | null>
  transcriptRef: RefObject<HTMLDivElement | null>
}

interface LoadOperation {
  anchor: PrependAnchor | null
  completion: Promise<void> | null
  frameId: number | null
  lifecycleToken: number
  previousHeight: number
  previousTop: number
  resolveCompletion: (() => void) | null
  result: boolean | null
  runtimeSessionId: string
  settled: boolean
  storedSessionId: string
  layoutConsumed: boolean
  phase: 'loading' | 'compensating' | 'waiting-reactivation'
}

interface PrependAnchor {
  operation: LoadOperation
  previousHeight: number
  previousTop: number
  scroller: HTMLElement
}

interface HistorySnapshot {
  hasMore: boolean
  loadingOlder: boolean
  nextOffset: number
}

export function useChatViewport(options: ChatViewportOptions): ChatViewportBinding {
  const { active, content, history, onLoadOlder, onLoadOlderError, session } = options
  const { entries, tools } = content
  const { hasMore, loadingOlder, nextOffset } = history
  const { runtimeSessionId, storedSessionId } = session

  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const olderMessagesRef = useRef<HTMLButtonElement | null>(null)

  const [hasNewMessages, setHasNewMessages] = useState(false)
  const [loadRevision, setLoadRevision] = useState(0)
  const followingLatestRef = useRef(true)
  const touchStartYRef = useRef<number | null>(null)
  const mouseScrollStartTopRef = useRef<number | null>(null)
  const discreteScrollDistanceRef = useRef(0)
  const previousSessionRef = useRef<null | string>(null)
  const previousHistoryOffsetRef = useRef(0)
  const previousEntriesRef = useRef(entries)
  const previousToolsRef = useRef(tools)
  const awaitingInitialHistoryRef = useRef(false)
  const pendingSessionPositionRef = useRef(false)

  const latestRuntimeSessionIdRef = useRef<null | string>(runtimeSessionId)
  const latestStoredSessionIdRef = useRef<null | string>(storedSessionId)
  const latestActiveRef = useRef(active)
  const latestHistoryRef = useRef<HistorySnapshot>({ hasMore, loadingOlder, nextOffset })
  const latestOnLoadOlderRef = useRef(onLoadOlder)
  const latestOnLoadOlderErrorRef = useRef(onLoadOlderError)
  latestRuntimeSessionIdRef.current = runtimeSessionId
  latestStoredSessionIdRef.current = storedSessionId
  latestActiveRef.current = active
  latestHistoryRef.current = { hasMore, loadingOlder, nextOffset }
  latestOnLoadOlderRef.current = onLoadOlder
  latestOnLoadOlderErrorRef.current = onLoadOlderError

  const mountedRef = useRef(false)
  const lifecycleTokenRef = useRef(0)
  const committedRuntimeSessionIdRef = useRef<null | string>(runtimeSessionId)
  const committedStoredSessionIdRef = useRef<null | string>(storedSessionId)
  const committedActiveRef = useRef(active)
  const inFlightRef = useRef<LoadOperation | null>(null)
  const appliedOperationRef = useRef<LoadOperation | null>(null)
  const pendingAnchorRef = useRef<PrependAnchor | null>(null)
  const observerRetryBlockedRef = useRef(false)
  const observerTargetRef = useRef<HTMLButtonElement | null>(null)

  const findScroller = useCallback(() => {
    return transcriptRef.current?.closest<HTMLElement>('.view-container') ?? null
  }, [])
  const scrollerNodeRef = useRef<HTMLElement | null>(null)
  const scrollerNodeInitializedRef = useRef(false)
  const [scrollerRevision, setScrollerRevision] = useState(0)

  const isOperationSessionCurrent = useCallback((operation: LoadOperation) => {
    return mountedRef.current
      && lifecycleTokenRef.current === operation.lifecycleToken
      && latestRuntimeSessionIdRef.current === operation.runtimeSessionId
      && latestStoredSessionIdRef.current === operation.storedSessionId
  }, [])

  const isOperationCurrent = useCallback((operation: LoadOperation) => {
    return !operation.settled && inFlightRef.current === operation && isOperationSessionCurrent(operation)
  }, [isOperationSessionCurrent])

  const waitForOperation = useCallback((operation: LoadOperation) => {
    if (operation.settled) return Promise.resolve()
    if (!operation.completion) {
      operation.completion = new Promise<void>(resolve => {
        operation.resolveCompletion = resolve
      })
    }
    return operation.completion
  }, [])

  const settleOperation = useCallback((operation: LoadOperation) => {
    if (operation.settled) return
    if (operation.frameId !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(operation.frameId)
      operation.frameId = null
    }
    if (pendingAnchorRef.current?.operation === operation) pendingAnchorRef.current = null
    if (inFlightRef.current === operation) inFlightRef.current = null
    operation.settled = true
    const resolve = operation.resolveCompletion
    operation.resolveCompletion = null
    resolve?.()
  }, [])

  const discardOperation = useCallback((operation: LoadOperation) => {
    if (appliedOperationRef.current === operation) appliedOperationRef.current = null
    if (pendingAnchorRef.current?.operation === operation) pendingAnchorRef.current = null
    settleOperation(operation)
  }, [settleOperation])

  const scheduleCompensation = useCallback((operation: LoadOperation): Promise<void> => {
    const anchor = operation.anchor
    if (!anchor || operation.settled) {
      discardOperation(operation)
      return Promise.resolve()
    }

    const currentScroller = findScroller()
    if (!isOperationSessionCurrent(operation) || currentScroller !== anchor.scroller) {
      discardOperation(operation)
      return Promise.resolve()
    }
    if (!latestActiveRef.current) {
      pendingAnchorRef.current = anchor
      operation.phase = 'waiting-reactivation'
      return waitForOperation(operation)
    }
    if (appliedOperationRef.current !== operation) {
      discardOperation(operation)
      return Promise.resolve()
    }
    if (operation.frameId !== null) return waitForOperation(operation)

    operation.phase = 'compensating'
    const completion = waitForOperation(operation)
    if (typeof requestAnimationFrame !== 'function') {
      settleOperation(operation)
      return completion
    }
    try {
      const frame = requestAnimationFrame(() => {
        operation.frameId = null
        const current = findScroller()
        if (!mountedRef.current) {
          discardOperation(operation)
          return
        }
        if (!latestActiveRef.current) {
          if (isOperationSessionCurrent(operation) && current === anchor.scroller && appliedOperationRef.current === operation) {
            pendingAnchorRef.current = anchor
            operation.phase = 'waiting-reactivation'
            return
          }
          discardOperation(operation)
          return
        }
        if (!isOperationCurrent(operation)
          || current !== anchor.scroller
          || appliedOperationRef.current !== operation) {
          discardOperation(operation)
          return
        }
        current.scrollTop = anchor.previousTop + current.scrollHeight - anchor.previousHeight
        if (operation.layoutConsumed && appliedOperationRef.current === operation) appliedOperationRef.current = null
        if (pendingAnchorRef.current?.operation === operation) pendingAnchorRef.current = null
        settleOperation(operation)
      })
      if (!operation.settled) operation.frameId = frame
    } catch {
      settleOperation(operation)
    }
    return completion
  }, [discardOperation, findScroller, isOperationCurrent, isOperationSessionCurrent, settleOperation, waitForOperation])

  const markApplied = useCallback((operation: LoadOperation) => {
    operation.result = true
    appliedOperationRef.current = operation
    observerRetryBlockedRef.current = false
    if (mountedRef.current) setLoadRevision(value => value + 1)
  }, [])

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const currentHistory = latestHistoryRef.current
    const currentRuntimeSessionId = latestRuntimeSessionIdRef.current
    const currentStoredSessionId = latestStoredSessionIdRef.current
    if (!mountedRef.current
      || !latestActiveRef.current
      || !currentRuntimeSessionId
      || !currentStoredSessionId
      || !currentHistory.hasMore
      || currentHistory.loadingOlder
      || inFlightRef.current) return

    const scroller = findScroller()
    const operation: LoadOperation = {
      anchor: null,
      completion: null,
      frameId: null,
      layoutConsumed: false,
      lifecycleToken: lifecycleTokenRef.current,
      previousHeight: scroller?.scrollHeight ?? 0,
      previousTop: scroller?.scrollTop ?? 0,
      resolveCompletion: null,
      result: null,
      runtimeSessionId: currentRuntimeSessionId,
      settled: false,
      storedSessionId: currentStoredSessionId,
      phase: 'loading'
    }
    // This assignment must happen before invoking the callback: the button and
    // observer can otherwise admit two requests in the same turn.
    inFlightRef.current = operation

    try {
      const applied = await latestOnLoadOlderRef.current()
      operation.result = applied
      if (!isOperationCurrent(operation)) return
      if (!applied) {
        settleOperation(operation)
        return
      }

      operation.anchor = scroller ? {
        operation,
        previousHeight: operation.previousHeight,
        previousTop: operation.previousTop,
        scroller
      } : null
      markApplied(operation)
      if (!operation.anchor) {
        settleOperation(operation)
        return
      }

      const currentScroller = findScroller()
      if (!isOperationSessionCurrent(operation) || currentScroller !== scroller) {
        discardOperation(operation)
        return
      }
      if (!latestActiveRef.current) {
        pendingAnchorRef.current = operation.anchor
        operation.phase = 'waiting-reactivation'
        await waitForOperation(operation)
        return
      }
      await scheduleCompensation(operation)
    } catch (caught) {
      operation.result = false
      if (isOperationCurrent(operation)) {
        try {
          latestOnLoadOlderErrorRef.current(caught)
        } catch {
          // Error presentation must not turn the public action into a rejection.
        }
      }
    } finally {
      if (!operation.settled && operation.phase === 'loading') settleOperation(operation)
    }
  }, [discardOperation, findScroller, isOperationCurrent, isOperationSessionCurrent, markApplied, scheduleCompensation, settleOperation, waitForOperation])

  useLayoutEffect(() => {
    const scroller = findScroller()
    if (!scrollerNodeInitializedRef.current) {
      scrollerNodeInitializedRef.current = true
      scrollerNodeRef.current = scroller
      return
    }
    if (scrollerNodeRef.current !== scroller) {
      scrollerNodeRef.current = scroller
      const inFlight = inFlightRef.current
      const pendingAnchor = pendingAnchorRef.current
      const appliedOperation = appliedOperationRef.current
      let staleOperation: LoadOperation | null = null
      if (inFlight?.anchor && inFlight.anchor.scroller !== scroller) staleOperation = inFlight
      else if (pendingAnchor && pendingAnchor.scroller !== scroller) staleOperation = pendingAnchor.operation
      else if (appliedOperation?.anchor && appliedOperation.anchor.scroller !== scroller) staleOperation = appliedOperation
      if (staleOperation) discardOperation(staleOperation)
      setScrollerRevision(value => value + 1)
    }
  })

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      lifecycleTokenRef.current += 1
      observerRetryBlockedRef.current = false
      appliedOperationRef.current = null
      pendingAnchorRef.current = null
      const operation = inFlightRef.current
      if (operation) settleOperation(operation)
    }
  }, [settleOperation])

  useLayoutEffect(() => {
    const identityChanged = committedRuntimeSessionIdRef.current !== runtimeSessionId
      || committedStoredSessionIdRef.current !== storedSessionId
    const wasActive = committedActiveRef.current
    committedRuntimeSessionIdRef.current = runtimeSessionId
    committedStoredSessionIdRef.current = storedSessionId
    committedActiveRef.current = active

    if (identityChanged) {
      lifecycleTokenRef.current += 1
      observerRetryBlockedRef.current = false
      appliedOperationRef.current = null
      pendingAnchorRef.current = null
      const operation = inFlightRef.current
      if (operation) settleOperation(operation)
    }

    if (wasActive && !active) {
      observerRetryBlockedRef.current = false
      const operation = inFlightRef.current
      if (operation?.frameId !== null && operation?.frameId !== undefined) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(operation.frameId)
        operation.frameId = null
        const anchor = operation.anchor
        const currentScroller = findScroller()
        if (anchor && isOperationSessionCurrent(operation) && currentScroller === anchor.scroller) {
          pendingAnchorRef.current = anchor
          operation.phase = 'waiting-reactivation'
        } else {
          discardOperation(operation)
        }
      }
    }
  }, [active, discardOperation, findScroller, isOperationSessionCurrent, runtimeSessionId, settleOperation, storedSessionId])

  useLayoutEffect(() => {
    if (!active) return

    const sessionChanged = previousSessionRef.current !== runtimeSessionId
    const contentChanged = previousEntriesRef.current !== entries || previousToolsRef.current !== tools
    const loadedOlder = !sessionChanged && previousHistoryOffsetRef.current > 0 && nextOffset > previousHistoryOffsetRef.current
    previousHistoryOffsetRef.current = nextOffset
    previousEntriesRef.current = entries
    previousToolsRef.current = tools

    if (sessionChanged) {
      previousSessionRef.current = runtimeSessionId
      awaitingInitialHistoryRef.current = Boolean(runtimeSessionId && storedSessionId && entries.length === 0)
      pendingSessionPositionRef.current = true
      followingLatestRef.current = true
      touchStartYRef.current = null
      mouseScrollStartTopRef.current = null
      discreteScrollDistanceRef.current = 0
      setHasNewMessages(false)
    }

    const pendingAnchor = pendingAnchorRef.current
    if (pendingAnchor) {
      const operation = pendingAnchor.operation
      if (isOperationSessionCurrent(operation) && findScroller() === pendingAnchor.scroller && appliedOperationRef.current === operation) {
        operation.layoutConsumed = true
        if (entries.length > 0) {
          awaitingInitialHistoryRef.current = false
          pendingSessionPositionRef.current = false
        }
        void scheduleCompensation(operation)
        return
      }
      discardOperation(operation)
    }

    const initialHistoryArrived = awaitingInitialHistoryRef.current && entries.length > 0
    if (awaitingInitialHistoryRef.current && entries.length === 0) return

    const appliedOperation = appliedOperationRef.current
    if (appliedOperation) {
      if (!isOperationSessionCurrent(appliedOperation)
        || (appliedOperation.anchor && findScroller() !== appliedOperation.anchor.scroller)) {
        discardOperation(appliedOperation)
        return
      }
      appliedOperation.layoutConsumed = true
      if (entries.length > 0) {
        awaitingInitialHistoryRef.current = false
        pendingSessionPositionRef.current = false
      }
      if (appliedOperation.settled) appliedOperationRef.current = null
      return
    }
    if (!runtimeSessionId || loadingOlder || loadedOlder || inFlightRef.current) return

    if (sessionChanged || pendingSessionPositionRef.current || initialHistoryArrived) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
      followingLatestRef.current = true
      setHasNewMessages(false)
      pendingSessionPositionRef.current = false
      if (initialHistoryArrived) awaitingInitialHistoryRef.current = false
      return
    }
    if (!contentChanged) return
    if (followingLatestRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    } else {
      setHasNewMessages(true)
    }
  }, [active, discardOperation, entries, findScroller, isOperationSessionCurrent, loadRevision, loadingOlder, nextOffset, runtimeSessionId, scheduleCompensation, scrollerRevision, storedSessionId, tools])

  useEffect(() => {
    if (!active || !mountedRef.current) return
    const scroller = findScroller()
    const bottom = bottomRef.current
    if (!scroller) return
    const effectLifecycleToken = lifecycleTokenRef.current
    let disposed = false
    const isLive = () => !disposed && mountedRef.current && latestActiveRef.current && lifecycleTokenRef.current === effectLifecycleToken
    let intentTimer: ReturnType<typeof setTimeout> | undefined
    const pauseFollowing = () => {
      if (!isLive()) return
      followingLatestRef.current = false
    }
    const resetDiscreteIntentSoon = () => {
      if (!isLive()) return
      if (intentTimer !== undefined) clearTimeout(intentTimer)
      intentTimer = setTimeout(() => {
        if (!isLive()) return
        discreteScrollDistanceRef.current = 0
      }, USER_SCROLL_IDLE_MS)
    }
    const trackWheel = (event: WheelEvent) => {
      if (!isLive()) return
      if (event.deltaY >= 0) {
        discreteScrollDistanceRef.current = 0
        return
      }
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1
      discreteScrollDistanceRef.current += Math.abs(event.deltaY) * scale
      if (discreteScrollDistanceRef.current >= USER_SCROLL_PAUSE_THRESHOLD) pauseFollowing()
      resetDiscreteIntentSoon()
    }
    const trackKey = (event: KeyboardEvent) => {
      if (!isLive()) return
      if (event.key === 'Home' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
        pauseFollowing()
      } else if (event.key === 'ArrowUp') {
        discreteScrollDistanceRef.current += 16
        if (discreteScrollDistanceRef.current >= USER_SCROLL_PAUSE_THRESHOLD) pauseFollowing()
      } else {
        return
      }
      resetDiscreteIntentSoon()
    }
    const startTouch = (event: TouchEvent) => {
      if (!isLive()) return
      touchStartYRef.current = event.touches.length === 1 ? event.touches[0]?.clientY ?? null : null
    }
    const trackTouch = (event: TouchEvent) => {
      if (!isLive()) return
      const currentY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined
      const startY = touchStartYRef.current
      if (currentY === undefined || startY === null) return
      if (currentY < startY) {
        touchStartYRef.current = currentY
      } else if (currentY - startY >= USER_SCROLL_PAUSE_THRESHOLD) {
        pauseFollowing()
      }
    }
    const finishTouch = () => {
      if (!isLive()) return
      touchStartYRef.current = null
    }
    const startPointer = (event: PointerEvent) => {
      if (!isLive()) return
      if (event.pointerType === 'mouse') mouseScrollStartTopRef.current = scroller.scrollTop
    }
    const trackPointer = (event: PointerEvent) => {
      if (!isLive()) return
      const startTop = mouseScrollStartTopRef.current
      if (event.pointerType === 'mouse' && startTop !== null && startTop - scroller.scrollTop >= USER_SCROLL_PAUSE_THRESHOLD) pauseFollowing()
    }
    const finishPointer = () => {
      if (!isLive()) return
      mouseScrollStartTopRef.current = null
    }
    const resumeFollowing = () => {
      if (!isLive()) return
      followingLatestRef.current = true
      setHasNewMessages(false)
    }
    const trackScrollPosition = () => {
      if (!isLive()) return
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      if (distanceFromBottom <= LATEST_DISTANCE_THRESHOLD) resumeFollowing()
    }

    let bottomObserver: IntersectionObserver | undefined
    if (bottom && typeof IntersectionObserver !== 'undefined') {
      bottomObserver = new IntersectionObserver(entries => {
        if (!isLive()) return
        if (entries.some(entry => entry.isIntersecting)) resumeFollowing()
      }, { root: scroller })
      bottomObserver.observe(bottom)
    }

    scroller.addEventListener('keydown', trackKey)
    scroller.addEventListener('pointerdown', startPointer, { passive: true })
    scroller.addEventListener('pointermove', trackPointer, { passive: true })
    scroller.addEventListener('pointercancel', finishPointer, { passive: true })
    scroller.addEventListener('pointerup', finishPointer, { passive: true })
    scroller.addEventListener('scroll', trackScrollPosition, { passive: true })
    scroller.addEventListener('touchstart', startTouch, { passive: true })
    scroller.addEventListener('touchmove', trackTouch, { passive: true })
    scroller.addEventListener('touchcancel', finishTouch, { passive: true })
    scroller.addEventListener('touchend', finishTouch, { passive: true })
    scroller.addEventListener('wheel', trackWheel, { passive: true })

    return () => {
      disposed = true
      if (intentTimer !== undefined) clearTimeout(intentTimer)
      bottomObserver?.disconnect()
      touchStartYRef.current = null
      mouseScrollStartTopRef.current = null
      discreteScrollDistanceRef.current = 0
      scroller.removeEventListener('keydown', trackKey)
      scroller.removeEventListener('pointerdown', startPointer)
      scroller.removeEventListener('pointermove', trackPointer)
      scroller.removeEventListener('pointercancel', finishPointer)
      scroller.removeEventListener('pointerup', finishPointer)
      scroller.removeEventListener('scroll', trackScrollPosition)
      scroller.removeEventListener('touchstart', startTouch)
      scroller.removeEventListener('touchmove', trackTouch)
      scroller.removeEventListener('touchcancel', finishTouch)
      scroller.removeEventListener('touchend', finishTouch)
      scroller.removeEventListener('wheel', trackWheel)
    }
  }, [active, findScroller, runtimeSessionId, scrollerRevision, storedSessionId])

  useEffect(() => {
    const target = olderMessagesRef.current
    if (observerTargetRef.current !== target) {
      observerTargetRef.current = target
      observerRetryBlockedRef.current = false
    }
    const eligible = active && mountedRef.current && Boolean(runtimeSessionId && storedSessionId && target && hasMore && !loadingOlder)
    if (!eligible || typeof IntersectionObserver === 'undefined') {
      if (!active || !runtimeSessionId || !storedSessionId || !target || !hasMore) observerRetryBlockedRef.current = false
      return
    }
    if (!target || !runtimeSessionId || !storedSessionId || !hasMore) return

    const effectLifecycleToken = lifecycleTokenRef.current
    let disposed = false
    const isLive = () => !disposed
      && mountedRef.current
      && latestActiveRef.current
      && lifecycleTokenRef.current === effectLifecycleToken
      && observerTargetRef.current === target
    const observer = new IntersectionObserver(entries => {
      if (!isLive()) return
      const intersecting = entries.some(entry => entry.isIntersecting)
      if (entries.some(entry => !entry.isIntersecting)) observerRetryBlockedRef.current = false
      if (!intersecting || observerRetryBlockedRef.current) return
      const currentHistory = latestHistoryRef.current
      if (!latestRuntimeSessionIdRef.current
        || !latestStoredSessionIdRef.current
        || !currentHistory.hasMore
        || currentHistory.loadingOlder
        || inFlightRef.current) return

      observerRetryBlockedRef.current = true
      void loadOlderMessages()
    }, { root: findScroller() })
    observer.observe(target)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [active, findScroller, hasMore, loadOlderMessages, loadingOlder, nextOffset, runtimeSessionId, scrollerRevision, storedSessionId])

  const jumpToLatest = useCallback(() => {
    if (!mountedRef.current || !latestActiveRef.current) return
    followingLatestRef.current = true
    setHasNewMessages(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [])

  return {
    bottomRef,
    hasNewMessages,
    jumpToLatest,
    loadOlderMessages,
    olderMessagesRef,
    transcriptRef
  }
}
