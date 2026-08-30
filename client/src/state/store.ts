import { atom, computed } from 'nanostores'

import type { AuthMode, ChatState, ConnectionPreferences, GatewayStatus, StoredSession } from '~/lib/types'
import { emptyChatState } from '~/state/event-reducer'

export type ConnectionPhase = 'connected' | 'connecting' | 'disconnected' | 'error' | 'reconnecting' | 'unsupported'
export type MobileView = 'chat' | 'files' | 'remote' | 'sessions' | 'settings'

export const $connection = atom<{
  authMode: AuthMode
  error: null | string
  phase: ConnectionPhase
  status: GatewayStatus | null
}>({ authMode: 'token', error: null, phase: 'disconnected', status: null })

export const $preferences = atom<ConnectionPreferences>({
  authMode: 'token',
  profile: localStorage.getItem('hermes.profile'),
  remoteURL: localStorage.getItem('hermes.remoteURL') ?? '',
  theme: (localStorage.getItem('hermes.theme') as ConnectionPreferences['theme']) ?? 'system'
})

export const $chat = atom<ChatState>(emptyChatState())
export const $sessions = atom<StoredSession[]>([])
export const $view = atom<MobileView>('chat')
export const $queuedPrompts = atom<string[]>([])
export const $isReady = computed($connection, connection => connection.phase === 'connected')

export function savePreferences(next: Partial<ConnectionPreferences>) {
  const value = { ...$preferences.get(), ...next }
  $preferences.set(value)
  localStorage.setItem('hermes.remoteURL', value.remoteURL)
  localStorage.setItem('hermes.theme', value.theme)
  if (value.profile) localStorage.setItem('hermes.profile', value.profile)
  else localStorage.removeItem('hermes.profile')
}
