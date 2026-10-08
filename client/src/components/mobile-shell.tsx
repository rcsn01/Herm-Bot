import type { CSSProperties, ReactNode, SyntheticEvent } from 'react'

import { usePullToRefresh } from '~/gestures/use-pull-to-refresh'
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

function gestureOwnedByControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('button, input, textarea, select, summary, [contenteditable="true"], .session-row'))
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
  const refresh = usePullToRefresh(shellRef, { enabled: !navigationPageOpen && !reconnecting, refreshing, onRefresh, surface: foregroundVisible ? 'foreground' : 'roster' })
  const refreshHeld = refresh.phase === 'refreshing' || refresh.phase === 'error'
  const foregroundMotion = useSwipeMotion({
    canStart: target => !gestureOwnedByControl(target),
    direction: 'right',
    enabled: foregroundVisible && foregroundDismissible && !navigationPageOpen && !reconnecting,
    extentPx: () => window.innerWidth,
    initialProgress: 0,
    onCommit: endpoint => { if (endpoint === 1) onDismissForeground?.() },
    restingEndpoint: 0
  })

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
            <main className="view-container">
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
            <main className="view-container">
              {foreground}
            </main>
            {foregroundNavigation}
          </section>
        </div>
        {navigationPage}
        <div
          aria-hidden={refresh.phase === 'idle'}
          aria-live="polite"
          className="pull-refresh"
          data-phase={refresh.phase}
          role="status"
          style={{
            '--refresh-travel': `${64 * (1 - Math.exp(-(refreshHeld ? 90 : refresh.distance) / 100)) - 24}px`,
            '--refresh-scale': refresh.phase === 'idle' ? .85 : .85 + .15 * (refreshHeld ? 1 : refresh.progress),
            opacity: refresh.phase === 'idle' ? 0 : refreshHeld ? 1 : Math.min(refresh.distance / 36, 1)
          } as CSSProperties}
        >
          <svg aria-hidden="true" className="pull-refresh-glyph" viewBox="0 0 24 24">
            <circle className="pull-refresh-track" cx="12" cy="12" r="10" />
            <circle className="pull-refresh-ring" cx="12" cy="12" r="10" style={{ strokeDasharray: '62.83', strokeDashoffset: refresh.phase === 'refreshing' ? 44 : 62.83 * (1 - refresh.progress) }} />
            <path className="pull-refresh-arrow" d="M12 7v10m-4-4 4 4 4-4" />
          </svg>
          <span>{refresh.phase === 'refreshing' ? 'Refreshing…' : refresh.phase === 'error' ? 'Could not refresh' : refresh.phase === 'armed' ? 'Release to refresh' : 'Pull to refresh'}</span>
        </div>
      </div>
      {reconnecting && <div aria-live="polite" className="connection-status" role="status">Reconnecting to Hermes…</div>}
    </>
  )
}
