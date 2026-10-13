import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

export interface AppLifecycleHandle {
  remove(): Promise<void>
}

/** Observe foreground/background changes on both Capacitor and the browser. */
export async function observeAppLifecycle(
  handler: (state: { isActive: boolean }) => void
): Promise<AppLifecycleHandle> {
  if (Capacitor.isNativePlatform()) {
    return App.addListener('appStateChange', handler)
  }

  let pageVisible = document.visibilityState !== 'hidden'
  const emit = (isActive: boolean) => handler({ isActive })
  const onVisibilityChange = () => {
    const visible = document.visibilityState !== 'hidden'
    if (visible === pageVisible) return
    pageVisible = visible
    emit(visible)
  }
  const onPageHide = () => {
    if (!pageVisible) return
    pageVisible = false
    emit(false)
  }
  const onPageShow = () => {
    if (document.visibilityState === 'hidden' || pageVisible) return
    pageVisible = true
    emit(true)
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)

  return {
    async remove() {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }
}
