import type { CSSProperties, ReactNode } from 'react'

import { usePullToRefresh } from '~/gestures/use-pull-to-refresh'
import { useSwipeMotion } from '~/gestures/use-swipe-motion'
import { useKeyboardViewport } from '~/pwa/use-keyboard-viewport'

interface MobileShellProps {
  connectionBanner?: ReactNode
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

function gestureOwnedByControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('button, input, textarea, select, summary, [contenteditable="true"], .session-row'))
}

export function MobileShell({
  connectionBanner,
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
  const refresh = usePullToRefresh(shellRef, { enabled: !navigationPageOpen && !reconnecting, refreshing, onRefresh, surface: foregroundVisible ? 'foreground' : 'roster' })
  const refreshHeld = refresh.phase === 'refreshing' || refresh.phase === 'error'
  const refreshDragging = refresh.phase === 'pulling' || refresh.phase === 'armed'
  const refreshContentStyle = {
    '--refresh-offset': `${refreshDragging ? 128 * (1 - Math.exp(-refresh.distance / 180)) : 0}px`
  } as CSSProperties
  const foregroundMotion = useSwipeMotion({
    canStart: target => !gestureOwnedByControl(target),
    direction: 'right',
    enabled: foregroundVisible && foregroundDismissible && !navigationPageOpen,
    extentPx: () => window.innerWidth,
    initialProgress: 0,
    onCommit: endpoint => { if (endpoint === 1) onDismissForeground?.() },
    restingEndpoint: 0
  })

  return (
    <>
      <div
        className={`mobile-shell${navigationPageOpen ? ' navigation-open' : ''}${reconnecting ? ' reconnecting' : ''}`}
        ref={shellRef}
      >
        {connectionBanner}
        <section aria-hidden={foregroundVisible || navigationPageOpen} className={`roster-layer${foregroundVisible ? ' underlay' : ''}`} inert={foregroundVisible || navigationPageOpen ? true : undefined}>
          <main className="sessions-menu-content">
            {rosterHeader}
            <div className="view-container" data-refresh-phase={!foregroundVisible ? refresh.phase : 'idle'} style={!foregroundVisible ? refreshContentStyle : undefined}>
              {roster}
            </div>
          </main>
        </section>
        <section
          aria-hidden={!foregroundVisible || navigationPageOpen}
          className={`foreground-layer${foregroundVisible ? ' active' : ''}${foregroundDismissible ? ' dismissible' : ''}${foregroundNavigation ? ' with-workspace-navigation' : ''}`}
          inert={!foregroundVisible || navigationPageOpen ? true : undefined}
          ref={foregroundMotion.ref}
          {...foregroundMotion.bind}
        >
          <main className="sessions-menu-content">
            {foregroundHeader}
            <div className="view-container" data-refresh-phase={foregroundVisible ? refresh.phase : 'idle'} style={foregroundVisible ? refreshContentStyle : undefined}>
              {foreground}
            </div>
            {foregroundNavigation}
          </main>
        </section>
        {navigationPage}
        <div
          aria-hidden={refresh.phase === 'idle'}
          aria-live="polite"
          className="pull-refresh"
          data-phase={refresh.phase}
          role="status"
          style={{
            '--refresh-travel': `${64 * (1 - Math.exp(-(refreshHeld ? 90 : refresh.distance) / 100)) - 24}px`,
            '--refresh-scale': refresh.phase === 'idle' ? .9 : .9 + .1 * (refreshHeld ? 1 : refresh.progress),
            opacity: refresh.phase === 'idle' ? 0 : refreshHeld ? 1 : Math.min(refresh.distance / 18, 1)
          } as CSSProperties}
        >
          <svg aria-hidden="true" className="pull-refresh-glyph" viewBox="0 0 24 24">
            <path className="pull-refresh-track" d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
            <path className="pull-refresh-progress" d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" pathLength="1" style={{ strokeDasharray: `${refresh.progress} 1` }} />
            <path className="pull-refresh-progress" d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" pathLength="1" style={{ strokeDasharray: `${refresh.progress} 1` }} />
          </svg>
          <span className="sr-only">{refresh.phase === 'refreshing' ? 'Refreshing…' : refresh.phase === 'error' ? 'Could not refresh' : refresh.phase === 'armed' ? 'Release to refresh' : 'Pull to refresh'}</span>
        </div>
      </div>
    </>
  )
}
