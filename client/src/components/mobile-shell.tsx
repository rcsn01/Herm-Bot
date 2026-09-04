import { useRef, type ReactNode, type SyntheticEvent, type TouchEvent } from 'react'

interface MobileShellProps {
  children: ReactNode
  drawer: ReactNode
  drawerOpen: boolean
  header: ReactNode
  onOpenDrawer(): void
  onRefresh(): unknown
  reconnecting?: boolean
  refreshing?: boolean
}

interface GestureStart {
  atTop: boolean
  x: number
  y: number
}

export function MobileShell({ children, drawer, drawerOpen, header, onOpenDrawer, onRefresh, reconnecting = false, refreshing = false }: MobileShellProps) {
  const scroller = useRef<HTMLElement>(null)
  const gestureStart = useRef<GestureStart | null>(null)

  const startGesture = (event: TouchEvent<HTMLElement>) => {
    gestureStart.current = null
    if (drawerOpen || reconnecting || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (!touch) return
    gestureStart.current = {
      atTop: (scroller.current?.scrollTop ?? 0) <= 0,
      x: touch.clientX,
      y: touch.clientY
    }
  }

  const trackGesture = (event: TouchEvent<HTMLElement>) => {
    if (event.touches.length !== 1) gestureStart.current = null
  }

  const blockInteraction = (event: SyntheticEvent) => {
    if (!reconnecting) return
    event.preventDefault()
    event.stopPropagation()
  }

  const finishGesture = (event: TouchEvent<HTMLElement>) => {
    const start = gestureStart.current
    gestureStart.current = null
    if (!start || drawerOpen || reconnecting || event.changedTouches.length !== 1) return
    const touch = event.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)
    if (dx >= 72 && absX > 1.2 * absY) {
      onOpenDrawer()
    } else if (start.atTop && dy >= 90 && absY > 1.2 * absX) {
      void onRefresh()
    }
  }

  return (
    <>
      <div
        aria-busy={reconnecting}
        className={`mobile-shell${drawerOpen ? ' drawer-open' : ''}${reconnecting ? ' reconnecting' : ''}`}
        inert={reconnecting ? true : undefined}
        onClickCapture={blockInteraction}
        onKeyDownCapture={blockInteraction}
        onSubmitCapture={blockInteraction}
      >
        {header}
        {drawer}
        {refreshing && <div className="refresh-indicator">Refreshing from gateway…</div>}
        <main className="view-container" inert={drawerOpen ? true : undefined} onTouchEnd={finishGesture} onTouchMove={trackGesture} onTouchStart={startGesture} ref={scroller}>
          {children}
        </main>
      </div>
      {reconnecting && <div aria-live="polite" className="connection-status" role="status">Reconnecting to Hermes…</div>}
    </>
  )
}
