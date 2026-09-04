import type { GatewayPort } from '~/gateway/gateway-port'
import { GatewayError } from '~/gateway/gateway-error'
import { profileKey, profilePath, profileParams, type MobileProfile } from '~/gateway/profile-path'

export interface CronRun {
  actual_cost_usd?: null | number
  ended_at?: null | number
  estimated_cost_usd?: null | number
  id: string
  input_tokens?: number
  is_active?: boolean
  last_active?: number
  message_count?: number
  model?: null | string
  output_tokens?: number
  preview?: null | string
  started_at: number
  title?: null | string
  tool_call_count?: number
}

export interface CronJob {
  context_from?: null | string
  deliver?: null | string
  enabled: boolean
  id: string
  last_error?: null | string
  last_run_at?: null | string
  model?: null | string
  name?: null | string
  next_run_at?: null | string
  no_agent?: boolean
  prompt?: null | string
  provider?: null | string
  script?: null | string
  schedule?: { display?: string; expr?: string; kind?: string }
  schedule_display?: null | string
  skills?: string[]
  state?: null | string
  enabled_toolsets?: string[]
  workdir?: null | string
}

export interface CronDeliveryTarget {
  home_env_var: null | string
  home_target_set: boolean
  id: string
  name: string
}

export interface CronJobCreate {
  context_from?: string
  deliver?: string
  enabled_toolsets?: string[]
  model?: null | string
  name?: string
  no_agent?: boolean
  prompt: string
  provider?: null | string
  schedule: string
  script?: string
  skills?: string[]
  workdir?: string
}

export type CronJobUpdate = Partial<CronJobCreate> & { enabled?: boolean }

export interface AutomationBlueprintField {
  default: null | string
  help: string
  label: string
  name: string
  optional: boolean
  options: string[]
  strict?: boolean
  type: 'enum' | 'text' | 'time' | 'weekdays'
}

export interface AutomationBlueprint {
  appUrl: string
  category: string
  command: string
  description: string
  fields: AutomationBlueprintField[]
  key: string
  tags: string[]
  title: string
}

const TRIGGER_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 60_000
const PROCESS_SCOPED_CRON_MESSAGE = 'This gateway route reads process-wide cron delivery configuration and is only available from the default profile.'

function requireDefaultProfile(profile: MobileProfile): void {
  if (profileKey(profile) !== 'default') {
    throw new GatewayError(PROCESS_SCOPED_CRON_MESSAGE, {
      code: 'PROFILE_SCOPE_UNSUPPORTED',
      kind: 'unsupported',
      retryable: false
    })
  }
}

async function request<T>(gateway: GatewayPort, path: string, options: { body?: unknown; method?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  return (await gateway.request<T>({ ...options, path })).body
}

export const cronApi = {
  list(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<CronJob[]> {
    return request(gateway, profilePath('/api/cron/jobs', profile), { signal, timeoutMs: REQUEST_TIMEOUT_MS })
  },
  get(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<CronJob> {
    return request(gateway, profilePath(`/api/cron/jobs/${encodeURIComponent(id)}`, profile), { signal, timeoutMs: REQUEST_TIMEOUT_MS })
  },
  runs(gateway: GatewayPort, profile: MobileProfile, id: string, limit = 20, signal?: AbortSignal): Promise<CronRun[]> {
    return request(gateway, profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`, profile), { signal, timeoutMs: REQUEST_TIMEOUT_MS }).then(value => (value as { runs?: CronRun[] }).runs ?? [])
  },
  deliveryTargets(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<CronDeliveryTarget[]> {
    requireDefaultProfile(profile)
    return request(gateway, '/api/cron/delivery-targets', { signal, timeoutMs: REQUEST_TIMEOUT_MS }).then(value => (value as { targets?: CronDeliveryTarget[] }).targets ?? [])
  },
  create(gateway: GatewayPort, profile: MobileProfile, body: CronJobCreate, signal?: AbortSignal): Promise<CronJob> {
    return request(gateway, profilePath('/api/cron/jobs', profile), { body, method: 'POST', signal, timeoutMs: REQUEST_TIMEOUT_MS })
  },
  update(gateway: GatewayPort, profile: MobileProfile, id: string, updates: CronJobUpdate, signal?: AbortSignal): Promise<CronJob> {
    return request(gateway, profilePath(`/api/cron/jobs/${encodeURIComponent(id)}`, profile), { body: { updates }, method: 'PUT', signal, timeoutMs: REQUEST_TIMEOUT_MS })
  },
  pause(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<CronJob> {
    return request(gateway, profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/pause`, profile), { method: 'POST', signal })
  },
  resume(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<CronJob> {
    return request(gateway, profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/resume`, profile), { method: 'POST', signal })
  },
  trigger(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<CronJob> {
    return request(gateway, profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/trigger`, profile), { method: 'POST', signal, timeoutMs: TRIGGER_TIMEOUT_MS })
  },
  remove(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<void> {
    return request(gateway, profilePath(`/api/cron/jobs/${encodeURIComponent(id)}`, profile), { method: 'DELETE', signal }).then(() => undefined)
  },
  blueprints(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<{ blueprints: AutomationBlueprint[] }> {
    requireDefaultProfile(profile)
    return request(gateway, '/api/cron/blueprints', { signal, timeoutMs: REQUEST_TIMEOUT_MS })
  },
  instantiate(gateway: GatewayPort, profile: MobileProfile, blueprint: string, values: Record<string, string>, signal?: AbortSignal): Promise<CronJob> {
    const query = profileParams(profile)
    return request(gateway, `/api/cron/blueprints/instantiate?${query}`, { body: { blueprint, values }, method: 'POST', signal, timeoutMs: REQUEST_TIMEOUT_MS })
  }
}

export { REQUEST_TIMEOUT_MS, TRIGGER_TIMEOUT_MS }
