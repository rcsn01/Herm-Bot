import { useRef, type ReactNode, type TouchEvent } from 'react'

interface MobileShellProps {
  children: ReactNode
  header: ReactNode
  navigation: ReactNode
  onRefresh(): unknown
  refreshing?: boolean
}

export function MobileShell({ children, header, navigation, onRefresh, refreshing = false }: MobileShellProps) {
  const scroller = useRef<HTMLElement>(null)
  const pullStart = useRef<number | null>(null)

  const startPull = (event: TouchEvent<HTMLElement>) => {
    pullStart.current = (scroller.current?.scrollTop ?? 0) <= 0 ? event.touches[0]?.clientY ?? null : null
  }

  const finishPull = (event: TouchEvent<HTMLElement>) => {
    const start = pullStart.current
    pullStart.current = null
    if (start === null || (scroller.current?.scrollTop ?? 0) > 0) return
    const end = event.changedTouches[0]?.clientY
    if (end !== undefined && end - start > 90) void onRefresh()
  }

  return (
    <div className="mobile-shell">
      {header}
      {refreshing && <div className="refresh-indicator">Refreshing from gateway…</div>}
      <main className="view-container" onTouchEnd={finishPull} onTouchStart={startPull} ref={scroller}>
        {children}
      </main>
      {navigation}
    </div>
  )
}
