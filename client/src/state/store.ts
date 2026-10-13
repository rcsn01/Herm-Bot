import { atom, computed } from 'nanostores'

import { $draftOwner } from './draft-owner'
import { $networkStatus } from './network-status'
import { GatewayError, type GatewayErrorKind } from '~/gateway/gateway-error'
import { defaultRemoteURL } from '~/native/hermes-connection'

import type { AuthMode, ConnectionPreferences, GatewayStatus, StoredSession } from '~/lib/types'

export type ConnectionPhase = 'connected' | 'connecting' | 'disconnected' | 'error' | 'reconnecting' | 'unsupported'

export const $connection = atom<{
  authMode: AuthMode
  error: null | string
  errorKind: GatewayErrorKind | null
  workspaceAvailable: boolean
  phase: ConnectionPhase
  status: GatewayStatus | null
}>({ authMode: 'token', error: null, errorKind: null, workspaceAvailable: false, phase: 'connecting', status: null })

/** True while a roster-tapped profile switch is connecting; the app shell
 *  renders the destination in place instead of the full-screen boot takeover. */
export const $profileSwitching = atom(false)
export const $sessionSelecting = atom(false)

export const $preferences = atom<ConnectionPreferences>({
  authMode: 'token',
  profile: localStorage.getItem('hermes.profile'),
  remoteURL: defaultRemoteURL(),
  theme: (localStorage.getItem('hermes.theme') as ConnectionPreferences['theme']) ?? 'system'
})

export const $sessions = atom<StoredSession[]>([])
export const $sessionsHasMore = atom(false)
export const $sessionsLoadingMore = atom(false)
export const $gatewayReady = computed([$connection, $networkStatus, $draftOwner], (connection, network, owner) =>
  connection.phase === 'connected' && network.status !== 'offline' && !owner.locked && Boolean(owner.gateway))
export const $isReady = $gatewayReady

export function requireGatewayReady() {
  if (!$gatewayReady.get()) throw new GatewayError('Hermes is unavailable. Reconnect before trying this action.', { kind: 'validation', code: 'GATEWAY_UNAVAILABLE', retryable: false })
}

export function savePreferences(next: Partial<ConnectionPreferences>) {
  const value = { ...$preferences.get(), ...next }
  $preferences.set(value)
  localStorage.setItem('hermes.remoteURL', value.remoteURL)
  localStorage.setItem('hermes.theme', value.theme)
  if (value.profile) localStorage.setItem('hermes.profile', value.profile)
  else localStorage.removeItem('hermes.profile')
}
