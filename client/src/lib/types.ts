import type {
  AutomationBlueprint,
  AutomationBlueprintField,
  AuxiliaryModelsResponse,
  AuxiliaryTaskAssignment,
  ConfigFieldSchema,
  ConfigSchemaResponse,
  CustomEndpoint,
  CustomEndpointUpdate,
  CustomEndpointsResponse,
  EnvVarInfo,
  HermesConfigRecord,
  MemoryProviderConfig as DesktopMemoryProviderConfig,
  MemoryProviderField as DesktopMemoryProviderField,
  MemoryProviderOAuthStatus,
  MemoryStatusResponse as DesktopMemoryStatusResponse,
  ModelAssignmentRequest,
  ModelAssignmentResponse,
  ModelCapabilities,
  ModelInfoResponse,
  ModelOptionProvider,
  ModelOptionsResponse,
  MoaConfigResponse,
  MoaModelSlot,
  OAuthPollResponse,
  OAuthProvider,
  OAuthProvidersResponse,
  OAuthStartResponse,
  ProfilesResponse,
  SessionInfo,
  SessionMessage,
  SessionRuntimeInfo,
  SkillInfo,
  StaleAuxAssignment,
  StatusResponse,
  ToolEnvVar,
  ToolProvider,
  ToolsetInfo
} from '../../../../desktop/src/types/hermes'

export type {
  AutomationBlueprint,
  AutomationBlueprintField,
  AuxiliaryModelsResponse,
  AuxiliaryTaskAssignment,
  ConfigFieldSchema,
  ConfigSchemaResponse,
  CustomEndpoint,
  CustomEndpointUpdate,
  CustomEndpointsResponse,
  EnvVarInfo,
  HermesConfigRecord,
  MemoryProviderOAuthStatus,
  ModelAssignmentRequest,
  ModelAssignmentResponse,
  ModelCapabilities,
  ModelInfoResponse,
  ModelOptionProvider,
  ModelOptionsResponse,
  MoaConfigResponse,
  MoaModelSlot,
  OAuthPollResponse,
  OAuthProvider,
  OAuthProvidersResponse,
  OAuthStartResponse,
  ProfilesResponse,
  SessionInfo,
  SessionMessage,
  SessionRuntimeInfo,
  SkillInfo,
  StaleAuxAssignment,
  StatusResponse,
  ToolEnvVar,
  ToolProvider,
  ToolsetInfo
}

// Mobile owns the view-model additions used by the profile settings screens.
// The gateway has added optional provider diagnostics over time; keeping those
// fields here avoids coupling the mobile client to the desktop/shared package.
export type MemoryProviderFieldKind = DesktopMemoryProviderField['kind'] | 'boolean' | 'integer'

export interface MemoryProviderField extends Omit<DesktopMemoryProviderField, 'kind' | 'value'> {
  kind: MemoryProviderFieldKind
  maximum?: number
  minimum?: number
  value: unknown
  when?: Record<string, unknown>
}

export interface MemoryProviderConfig extends Omit<DesktopMemoryProviderConfig, 'fields'> {
  fields: MemoryProviderField[]
}

export interface MemoryStatusProvider {
  available?: boolean
  configured: boolean
  description: string
  name: string
  setup?: {
    dependencies_installed?: boolean
    external_dependencies?: Array<{ name?: string }>
    pip_dependencies?: string[]
  }
  status?: string
}

export type MemoryStatusResponse = Omit<DesktopMemoryStatusResponse, 'providers'> & {
  providers: MemoryStatusProvider[]
}

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
  displayKind?: string
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
  historyBackfilled: boolean
  historyHasMore: boolean
  historyLoadingOlder: boolean
  historyNextOffset: number
  info: null | SessionRuntimeInfo
  messages: TranscriptMessage[]
  pendingPrompt: null | PendingPrompt
  running: boolean
  runtimeSessionId: null | string
  storedSessionId: null | string
  tools: ToolActivity[]
}
