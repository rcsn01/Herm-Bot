import { useCallback, useEffect, useRef, useState } from 'react'

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

interface DrawerGuard {
  closing: boolean
  consumed: boolean
  intent: DrawerDismissIntent | null
}

interface UseDrawerControllerOptions {
  onDismissed?(intent: DrawerDismissIntent): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function withoutDrawerBase(state: unknown): Record<string, unknown> {
  const clean = isRecord(state) ? { ...state } : {}
  delete clean.hermesDrawerBase
  delete clean.hermesDrawer
  return clean
}

export function useDrawerController({ onDismissed }: UseDrawerControllerOptions = {}): DrawerController {
  const [isOpen, setIsOpen] = useState(false)
  const [dismissRequest, setDismissRequest] = useState<DrawerDismissRequest | null>(null)
  const isOpenRef = useRef(false)
  const guardRef = useRef<DrawerGuard | null>(null)
  const requestIdRef = useRef(0)
  const onDismissedRef = useRef(onDismissed)
  onDismissedRef.current = onDismissed

  const finish = useCallback((intent: DrawerDismissIntent) => {
    const guard = guardRef.current
    if (guard) guard.consumed = true
    guardRef.current = null
    isOpenRef.current = false
    setDismissRequest(null)
    setIsOpen(false)
    onDismissedRef.current?.(intent)
  }, [])

  const issueRequest = useCallback((intent: DrawerDismissIntent) => {
    requestIdRef.current += 1
    setDismissRequest({ id: requestIdRef.current, intent })
  }, [])

  const consumeHistory = useCallback((guard: DrawerGuard) => {
    if (guard.consumed) return
    guard.consumed = true
    if (isRecord(history.state) && history.state.hermesDrawerBase === true) {
      history.replaceState(withoutDrawerBase(history.state), '', window.location.href)
    }
    if (!guard.intent) guard.intent = { type: 'close' }
    if (!guard.closing) issueRequest(guard.intent)
    else finish(guard.intent)
  }, [finish, issueRequest])

  useEffect(() => {
    if (!isOpen) return
    const guard: DrawerGuard = { closing: false, consumed: false, intent: null }
    guardRef.current = guard
    const baseState = { ...(isRecord(history.state) ? history.state : {}), hermesDrawerBase: true }
    history.replaceState(baseState, '', window.location.href)
    history.pushState({ ...baseState, hermesDrawer: true }, '', window.location.href)

    const onPop = () => {
      if (guardRef.current !== guard) return
      consumeHistory(guard)
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (guardRef.current === guard) guardRef.current = null
      if (!guard.consumed && !guard.closing) history.back()
    }
  }, [consumeHistory, isOpen])

  const openDrawer = useCallback(() => {
    if (isOpenRef.current) return
    isOpenRef.current = true
    setDismissRequest(null)
    setIsOpen(true)
  }, [])

  const requestDismiss = useCallback((intent: DrawerDismissIntent = { type: 'close' }) => {
    const guard = guardRef.current
    if (!isOpenRef.current || guard?.closing || guard?.intent) return
    if (guard) guard.intent = intent
    issueRequest(intent)
  }, [issueRequest])

  const completeDismiss = useCallback((intent?: DrawerDismissIntent) => {
    const guard = guardRef.current
    const chosen = intent ?? guard?.intent ?? { type: 'close' as const }
    if (!guard) {
      finish(chosen)
      return
    }
    if (guard.intent === null) guard.intent = chosen
    if (guard.closing) return
    guard.closing = true
    if (!guard.consumed) {
      history.back()
      return
    }
    finish(guard.intent)
  }, [finish])

  return { completeDismiss, dismissRequest, isOpen, openDrawer, requestDismiss }
}
