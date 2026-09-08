import { Capacitor } from '@capacitor/core'
import { atom } from 'nanostores'
import { registerSW } from 'virtual:pwa-register'

import { $chat } from '~/state/conversation'

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export interface PwaState {
  error: string | null
  installPrompt: BeforeInstallPromptEvent | null
  offline: boolean
  updateAvailable: boolean
  updating: boolean
}

const initialState = (): PwaState => ({
  error: null,
  installPrompt: null,
  offline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
  updateAvailable: false,
  updating: false
})

export const $pwa = atom<PwaState>(initialState())
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null

function patchState(patch: Partial<PwaState>) {
  $pwa.set({ ...$pwa.get(), ...patch })
}

export function canInitializePwa(): boolean {
  return import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator && !Capacitor.isNativePlatform()
}

/** Register browser-only PWA lifecycle listeners. Returns their cleanup function. */
export function initializePwa(): () => void {
  if (!canInitializePwa()) return () => undefined

  let active = true
  let registration: ServiceWorkerRegistration | undefined
  const online = () => patchState({ offline: false })
  const offline = () => patchState({ offline: true })
  const beforeInstall = (event: Event) => {
    event.preventDefault()
    patchState({ installPrompt: event as BeforeInstallPromptEvent })
  }
  const installed = () => patchState({ installPrompt: null })
  const checkUpdate = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) void registration?.update().catch(() => undefined)
  }

  window.addEventListener('online', online)
  window.addEventListener('offline', offline)
  window.addEventListener('beforeinstallprompt', beforeInstall)
  window.addEventListener('appinstalled', installed)
  document.addEventListener('visibilitychange', checkUpdate)

  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh: () => { if (active) patchState({ updateAvailable: true }) },
    onOfflineReady: () => { if (active) patchState({ offline: !navigator.onLine }) },
    onRegisteredSW: (_url, value) => { if (active) registration = value },
    onRegisterError: () => { if (active) patchState({ error: 'Offline installation failed. The online app is still available.' }) }
  })

  return () => {
    active = false
    document.removeEventListener('visibilitychange', checkUpdate)
    window.removeEventListener('online', online)
    window.removeEventListener('offline', offline)
    window.removeEventListener('beforeinstallprompt', beforeInstall)
    window.removeEventListener('appinstalled', installed)
    applyUpdate = null
    $pwa.set(initialState())
  }
}

export async function installPwa(): Promise<void> {
  const prompt = $pwa.get().installPrompt
  if (!prompt) return
  patchState({ installPrompt: null, error: null })
  try {
    await prompt.prompt()
    await prompt.userChoice
  } catch {
    patchState({ error: 'Installation was not completed. You can install from your browser menu.' })
  }
}

/** Called only from the visible update action; registration never forces reload. */
export async function activatePwaUpdate(): Promise<void> {
  const chat = $chat.get()
  const pwa = $pwa.get()
  if (!applyUpdate || !pwa.updateAvailable || pwa.updating || pwa.offline || chat.running || chat.pendingPrompt) return
  patchState({ updating: true, error: null })
  try {
    await applyUpdate(true)
  } catch {
    patchState({ updating: false, error: 'The update could not be loaded. Try again when connected.' })
  }
}

export function dismissPwaMessage(): void {
  patchState({ error: null, installPrompt: null })
}
