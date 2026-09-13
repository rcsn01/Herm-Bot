import { useCallback, useRef, useState } from 'react'

import type { MobileTab } from '~/navigation/routes'

export type DrawerDismissIntent =
  | { type: 'close' }
  | { type: 'model' }
  | { type: 'tab'; tab: MobileTab }

export interface DrawerDismissRequest {
  id: number
  intent: DrawerDismissIntent
}

export interface DrawerController {
  completeDismiss(intent?: DrawerDismissIntent): void
  dismissRequest: DrawerDismissRequest | null
  isOpen: boolean
  openDrawer(): void
  requestDismiss(intent?: DrawerDismissIntent): void
}

interface UseDrawerControllerOptions {
  onDismissed?(intent: DrawerDismissIntent): void
}

export function useDrawerController({ onDismissed }: UseDrawerControllerOptions = {}): DrawerController {
  const [isOpen, setIsOpen] = useState(false)
  const [dismissRequest, setDismissRequest] = useState<DrawerDismissRequest | null>(null)
  const isOpenRef = useRef(false)
  const dismissIntentRef = useRef<DrawerDismissIntent | null>(null)
  const requestIdRef = useRef(0)
  const onDismissedRef = useRef(onDismissed)
  onDismissedRef.current = onDismissed

  const finish = useCallback((intent: DrawerDismissIntent) => {
    if (!isOpenRef.current) return
    dismissIntentRef.current = null
    isOpenRef.current = false
    setDismissRequest(null)
    setIsOpen(false)
    onDismissedRef.current?.(intent)
  }, [])

  const issueRequest = useCallback((intent: DrawerDismissIntent) => {
    requestIdRef.current += 1
    setDismissRequest({ id: requestIdRef.current, intent })
  }, [])

  const openDrawer = useCallback(() => {
    if (isOpenRef.current) return
    dismissIntentRef.current = null
    isOpenRef.current = true
    setDismissRequest(null)
    setIsOpen(true)
  }, [])

  const requestDismiss = useCallback((intent: DrawerDismissIntent = { type: 'close' }) => {
    if (!isOpenRef.current || dismissIntentRef.current) return
    dismissIntentRef.current = intent
    issueRequest(intent)
  }, [issueRequest])

  const completeDismiss = useCallback((intent?: DrawerDismissIntent) => {
    if (!isOpenRef.current) return
    finish(intent ?? dismissIntentRef.current ?? { type: 'close' })
  }, [finish])

  return { completeDismiss, dismissRequest, isOpen, openDrawer, requestDismiss }
}
