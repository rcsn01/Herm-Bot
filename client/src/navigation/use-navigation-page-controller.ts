import { useCallback, useRef, useState } from 'react'

import type { MobileTab } from '~/navigation/routes'

export type NavigationPageDismissIntent =
  | { type: 'close' }
  | { type: 'model' }
  | { type: 'tab'; tab: MobileTab }

export interface NavigationPageController {
  isOpen: boolean
  openNavigationPage(): void
  requestDismiss(intent?: NavigationPageDismissIntent): void
}

interface UseNavigationPageControllerOptions {
  onDismissed?(intent: NavigationPageDismissIntent): void
}

export function useNavigationPageController({ onDismissed }: UseNavigationPageControllerOptions = {}): NavigationPageController {
  const [isOpen, setIsOpen] = useState(false)
  const isOpenRef = useRef(false)
  const onDismissedRef = useRef(onDismissed)
  onDismissedRef.current = onDismissed

  const openNavigationPage = useCallback(() => {
    if (isOpenRef.current) return
    isOpenRef.current = true
    setIsOpen(true)
  }, [])

  const requestDismiss = useCallback((intent: NavigationPageDismissIntent = { type: 'close' }) => {
    if (!isOpenRef.current) return
    isOpenRef.current = false
    setIsOpen(false)
    onDismissedRef.current?.(intent)
  }, [])

  return { isOpen, openNavigationPage, requestDismiss }
}
