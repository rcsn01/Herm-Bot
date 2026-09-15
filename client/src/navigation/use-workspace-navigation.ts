import { useCallback, useRef, useState } from 'react'

import { $navigation, applyPathState, popRoute, pushRoute, resetTabRoutes, setTab } from '~/navigation/navigation-store'
import type { MobileRoute, MobileTab } from '~/navigation/routes'
import type { WorkspaceDestination, WorkspaceMenuIntent } from '~/navigation/workspace-navigation'

export interface WorkspaceNavigation {
  menuOpen: boolean                 // the navigation-page latch (StrictMode-safe, idempotent open)
  returnOrigin: MobileTab | null    // drives back labels and showModelBack
  openMenu(): void                  // captures origin tab + origin stack, then opens
  dismissMenu(intent?: WorkspaceMenuIntent): void
  openWorkspaceDestination(destination: WorkspaceDestination): void
  exitToReturnOrigin(fallback?: MobileTab): void  // default fallback 'roster'
  clearReturn(): void               // return origin + return stack, as a pair, without navigating
  backOr(tab: MobileTab, fallback: () => void): void
  closeToRoster(): void
}

export function useWorkspaceNavigation(): WorkspaceNavigation {
  const [menuOpen, setMenuOpen] = useState(false)
  const [returnOrigin, setReturnOrigin] = useState<MobileTab | null>(null)
  const menuOpenRef = useRef(false)
  const menuOriginRef = useRef<MobileTab | null>(null)
  const menuOriginStackRef = useRef<MobileRoute[] | null>(null)
  const returnStackRef = useRef<MobileRoute[] | null>(null)

  const openMenu = useCallback(() => {
    const navigation = $navigation.get()
    menuOriginRef.current = navigation.activeTab
    menuOriginStackRef.current = [...navigation.stacks[navigation.activeTab]] as MobileRoute[]
    if (menuOpenRef.current) return
    menuOpenRef.current = true
    setMenuOpen(true)
  }, [])

  const openDestination = useCallback((tab: MobileTab) => {
    resetTabRoutes(tab)
    setTab(tab)
  }, [])

  const openModelSettings = useCallback(() => {
    setTab('settings')
    const current = $navigation.get().stacks.settings.at(-1)
    if (current?.type === 'settings-category' && current.category === 'model') return
    resetTabRoutes('settings')
    pushRoute('settings', { category: 'model', tab: 'settings', type: 'settings-category' })
  }, [])

  const clearReturn = useCallback(() => {
    setReturnOrigin(null)
    returnStackRef.current = null
  }, [])

  const dismissMenu = useCallback((intent: WorkspaceMenuIntent = { type: 'close' }) => {
    if (!menuOpenRef.current) return
    menuOpenRef.current = false
    setMenuOpen(false)
    const origin = menuOriginRef.current
    const originStack = menuOriginStackRef.current
    menuOriginRef.current = null
    menuOriginStackRef.current = null
    if (intent.type === 'tab') {
      if (origin === intent.tab) return
      setReturnOrigin(origin)
      returnStackRef.current = originStack
      openDestination(intent.tab)
    } else if (intent.type === 'model') {
      const originRoute = originStack?.at(-1)
      if (origin === 'settings' && originRoute?.type === 'settings-category' && originRoute.category === 'model') return
      setReturnOrigin(origin)
      returnStackRef.current = originStack
      openModelSettings()
    }
  }, [openDestination, openModelSettings])

  const openWorkspaceDestination = useCallback((destination: WorkspaceDestination) => {
    if (destination === 'sessions') {
      openMenu()
      return
    }
    if (destination === 'model') openModelSettings()
    else openDestination(destination)
  }, [openDestination, openMenu, openModelSettings])

  const exitToReturnOrigin = useCallback((fallback: MobileTab = 'roster') => {
    const destination = returnOrigin ?? fallback
    const returnStack = returnStackRef.current
    const reopenMenu = returnOrigin !== null && returnStack !== null
    setReturnOrigin(null)
    returnStackRef.current = null
    if (returnStack) applyPathState(destination, returnStack)
    else setTab(destination)
    if (reopenMenu) openMenu()
  }, [openMenu, returnOrigin])

  const backOr = useCallback((tab: MobileTab, fallback: () => void) => {
    if (popRoute(tab) === undefined) fallback()
  }, [])

  const closeToRoster = useCallback(() => {
    setReturnOrigin(null)
    returnStackRef.current = null
    setTab('roster')
  }, [])

  return { menuOpen, returnOrigin, openMenu, dismissMenu, openWorkspaceDestination, exitToReturnOrigin, clearReturn, backOr, closeToRoster }
}