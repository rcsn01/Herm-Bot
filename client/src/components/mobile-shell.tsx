import { useRef, type ReactNode, type SyntheticEvent, type TouchEvent } from 'react'

import { useSwipeMotion } from '~/gestures/use-swipe-motion'
import { useKeyboardViewport } from '~/pwa/use-keyboard-viewport'

interface MobileShellProps {
  navigationPage: ReactNode
  navigationPageOpen: boolean
  foreground: ReactNode
  foregroundDismissible?: boolean
  foregroundHeader: ReactNode
  foregroundNavigation?: ReactNode
  foregroundVisible: boolean
  onDismissForeground?(): void
  onRefresh(): unknown
  reconnecting?: boolean
  refreshing?: boolean
  roster: ReactNode
  rosterHeader: ReactNode
}

interface RefreshGestureStart {
  atTop: boolean
  x: number
  y: number
}

function gestureOwnedByControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('button, input, textarea, select, [contenteditable="true"], .session-row'))
}

export function MobileShell({
  navigationPage,
  navigationPageOpen,
  foreground,
  foregroundDismissible = false,
  foregroundHeader,
  foregroundNavigation,
  foregroundVisible,
  onDismissForeground,
  onRefresh,
  reconnecting = false,
  refreshing = false,
  roster,
  rosterHeader
}: MobileShellProps) {
  const shellRef = useKeyboardViewport()
  const refreshStart = useRef<RefreshGestureStart | null>(null)
  const foregroundMotion = useSwipeMotion({
    canStart: target => !gestureOwnedByControl(target),
    direction: 'right',
    enabled: foregroundVisible && foregroundDismissible && !navigationPageOpen && !reconnecting,
    extentPx: () => window.innerWidth,
    initialProgress: 0,
    onCommit: endpoint => { if (endpoint === 1) onDismissForeground?.() },
    restingEndpoint: 0
  })

  const startRefreshGesture = (event: TouchEvent<HTMLElement>) => {
    refreshStart.current = null
    if (navigationPageOpen || reconnecting || event.touches.length !== 1) return
    refreshStart.current = {
      atTop: event.currentTarget.scrollTop <= 0,
      x: event.touches[0]?.clientX ?? 0,
      y: event.touches[0]?.clientY ?? 0
    }
  }

  const finishRefreshGesture = (event: TouchEvent<HTMLElement>) => {
    const start = refreshStart.current
    refreshStart.current = null
    if (!start || navigationPageOpen || reconnecting || event.changedTouches.length !== 1) return
    const touch = event.changedTouches[0]
    if (!touch) return
    const dy = touch.clientY - start.y
    if (start.atTop && dy >= 90 && Math.abs(dy) > 1.2 * Math.abs(touch.clientX - start.x)) void onRefresh()
  }

  const blockInteraction = (event: SyntheticEvent) => {
    if (!reconnecting) return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <>
      <div
        aria-busy={reconnecting}
        className={`mobile-shell${navigationPageOpen ? ' navigation-open' : ''}${reconnecting ? ' reconnecting' : ''}`}
        inert={reconnecting ? true : undefined}
        onClickCapture={blockInteraction}
        onKeyDownCapture={blockInteraction}
        onSubmitCapture={blockInteraction}
        ref={shellRef}
      >
        <div className="screen-stack" inert={navigationPageOpen ? true : undefined}>
          <section aria-hidden={foregroundVisible} className={`roster-layer${foregroundVisible ? ' underlay' : ''}`} inert={foregroundVisible ? true : undefined}>
            {rosterHeader}
            <main
              className="view-container"
              onTouchEnd={finishRefreshGesture}
              onTouchStart={startRefreshGesture}
            >
              {roster}
            </main>
          </section>
          <section
            aria-hidden={!foregroundVisible}
            className={`foreground-layer${foregroundVisible ? ' active' : ''}${foregroundDismissible ? ' dismissible' : ''}${foregroundNavigation ? ' with-workspace-navigation' : ''}`}
            inert={!foregroundVisible ? true : undefined}
            ref={foregroundMotion.ref}
            {...foregroundMotion.bind}
          >
            {foregroundHeader}
            <main
              className="view-container"
              onTouchEnd={finishRefreshGesture}
              onTouchStart={startRefreshGesture}
            >
              {foreground}
            </main>
            {foregroundNavigation}
          </section>
        </div>
        {navigationPage}
        {refreshing && <div className="refresh-indicator">Refreshing from gateway…</div>}
      </div>
      {reconnecting && <div aria-live="polite" className="connection-status" role="status">Reconnecting to Hermes…</div>}
    </>
  )
}
