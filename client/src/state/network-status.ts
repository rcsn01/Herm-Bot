import { atom } from 'nanostores'

export type NetworkStatus = 'online' | 'offline' | 'unknown'
export const $networkStatus = atom<{ status: NetworkStatus }>({ status: 'unknown' })

/** Browser connectivity is evidence, not proof that Hermes is reachable. */
export function observeNetworkStatus(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = typeof window === 'undefined' ? undefined : window,
  evidence: Pick<Navigator, 'onLine'> | undefined = typeof navigator === 'undefined' ? undefined : navigator
): () => void {
  $networkStatus.set({ status: typeof evidence?.onLine === 'boolean' ? evidence.onLine ? 'online' : 'offline' : 'unknown' })
  const online = () => $networkStatus.set({ status: 'online' })
  const offline = () => $networkStatus.set({ status: 'offline' })
  target?.addEventListener('online', online)
  target?.addEventListener('offline', offline)
  return () => {
    target?.removeEventListener('online', online)
    target?.removeEventListener('offline', offline)
  }
}
