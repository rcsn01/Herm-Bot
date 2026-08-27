import type {
  ProfilesResponse,
  SessionInfo,
  SessionMessage,
  SessionRuntimeInfo,
  StatusResponse
} from '../../../../desktop/src/types/hermes'

export type { ProfilesResponse, SessionInfo, SessionMessage, SessionRuntimeInfo, StatusResponse }

export type AuthMode = 'interactive' | 'token'
export type ThemeMode = 'dark' | 'light' | 'system'

export interface ConnectionPreferences {
  authMode: AuthMode
  profile: null | string
  remoteURL: string
  theme: ThemeMode
}

export interface NativeIdentity {
  display_name: string
  email: string
  expires_at: number
  org_id: string
  provider: string
  user_id: string
}

export interface NativeResponse<T = unknown> {
  body: T
  headers: Record<string, string>
  status: number
}

export interface GatewayStatus extends StatusResponse {
  auth_providers?: string[]
  auth_required: boolean
  profiles?: Array<{ is_default?: boolean; name: string } | string>
}

export interface StoredSession {
  id: string
  message_count: number
  preview: string
  source: string
  started_at: number
  title: string
}

export interface TranscriptMessage {
  content: string
  id: string
  reasoning?: string
  role: 'assistant' | 'system' | 'tool' | 'user'
  rowId?: number
  streaming?: boolean
}

export interface ToolActivity {
  detail?: string
  id: string
  name: string
  status: 'complete' | 'generating' | 'progress' | 'running'
}

export interface PendingPrompt {
  kind: 'approval' | 'clarify' | 'secret' | 'sudo'
  payload: Record<string, unknown>
  requestId: string
}

export interface ChatState {
  contractVersion: number | null
  error: null | string
  info: null | SessionRuntimeInfo
  messages: TranscriptMessage[]
  pendingPrompt: null | PendingPrompt
  running: boolean
  runtimeSessionId: null | string
  storedSessionId: null | string
  tools: ToolActivity[]
}
