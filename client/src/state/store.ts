import { atom, computed } from 'nanostores'

import { defaultRemoteURL } from '~/native/hermes-connection'

import type { AuthMode, ConnectionPreferences, GatewayStatus, StoredSession } from '~/lib/types'

export type ConnectionPhase = 'connected' | 'connecting' | 'disconnected' | 'error' | 'reconnecting' | 'unsupported'

export const $connection = atom<{
  authMode: AuthMode
  error: null | string
  phase: ConnectionPhase
  status: GatewayStatus | null
}>({ authMode: 'token', error: null, phase: 'connecting', status: null })

/** True while a roster-tapped profile switch is connecting; the app shell
 *  renders the destination in place instead of the full-screen boot takeover. */
export const $profileSwitching = atom(false)

export const $preferences = atom<ConnectionPreferences>({
  authMode: 'token',
  profile: localStorage.getItem('hermes.profile'),
  remoteURL: defaultRemoteURL(),
  theme: (localStorage.getItem('hermes.theme') as ConnectionPreferences['theme']) ?? 'system'
})

export const $sessions = atom<StoredSession[]>([])
export const $sessionsHasMore = atom(false)
export const $sessionsLoadingMore = atom(false)
export const $isReady = computed($connection, connection => connection.phase === 'connected')

export function savePreferences(next: Partial<ConnectionPreferences>) {
  const value = { ...$preferences.get(), ...next }
  $preferences.set(value)
  localStorage.setItem('hermes.remoteURL', value.remoteURL)
  localStorage.setItem('hermes.theme', value.theme)
  if (value.profile) localStorage.setItem('hermes.profile', value.profile)
  else localStorage.removeItem('hermes.profile')
}
