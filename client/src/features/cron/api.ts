import type { GatewayApi } from '~/gateway/gateway-api'

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

function jobPath(id: string): string {
  return `/api/cron/jobs/${encodeURIComponent(id)}`
}

export interface CronApi {
  list(signal?: AbortSignal): Promise<CronJob[]>
  get(id: string, signal?: AbortSignal): Promise<CronJob>
  runs(id: string, limit?: number, signal?: AbortSignal): Promise<CronRun[]>
  deliveryTargets(signal?: AbortSignal): Promise<CronDeliveryTarget[]>
  create(body: CronJobCreate, signal?: AbortSignal): Promise<CronJob>
  update(id: string, updates: CronJobUpdate, signal?: AbortSignal): Promise<CronJob>
  pause(id: string, signal?: AbortSignal): Promise<CronJob>
  resume(id: string, signal?: AbortSignal): Promise<CronJob>
  trigger(id: string, signal?: AbortSignal): Promise<CronJob>
  remove(id: string, signal?: AbortSignal): Promise<void>
  blueprints(signal?: AbortSignal): Promise<{ blueprints: AutomationBlueprint[] }>
  instantiate(blueprint: string, values: Record<string, string>, signal?: AbortSignal): Promise<CronJob>
}

export function createCronApi(api: GatewayApi): CronApi {
  return {
    list: (signal?: AbortSignal) => api.request('/api/cron/jobs', { signal, timeoutMs: REQUEST_TIMEOUT_MS }),
    get: (id: string, signal?: AbortSignal) => api.request(jobPath(id), { signal, timeoutMs: REQUEST_TIMEOUT_MS }),
    runs: (id: string, limit = 20, signal?: AbortSignal) =>
      api
        .request<{ runs?: CronRun[] }>(`${jobPath(id)}/runs`, { params: { limit }, signal, timeoutMs: REQUEST_TIMEOUT_MS })
        .then(value => value.runs ?? []),
    deliveryTargets: (signal?: AbortSignal) =>
      api
        .defaultOnly<{ targets?: CronDeliveryTarget[] }>(PROCESS_SCOPED_CRON_MESSAGE, '/api/cron/delivery-targets', { signal, timeoutMs: REQUEST_TIMEOUT_MS })
        .then(value => value.targets ?? []),
    create: (body: CronJobCreate, signal?: AbortSignal) =>
      api.request('/api/cron/jobs', { body, method: 'POST', signal, timeoutMs: REQUEST_TIMEOUT_MS }),
    update: (id: string, updates: CronJobUpdate, signal?: AbortSignal) =>
      api.request(jobPath(id), { body: { updates }, method: 'PUT', signal, timeoutMs: REQUEST_TIMEOUT_MS }),
    pause: (id: string, signal?: AbortSignal) => api.request(`${jobPath(id)}/pause`, { method: 'POST', signal }),
    resume: (id: string, signal?: AbortSignal) => api.request(`${jobPath(id)}/resume`, { method: 'POST', signal }),
    trigger: (id: string, signal?: AbortSignal) =>
      api.request(`${jobPath(id)}/trigger`, { method: 'POST', signal, timeoutMs: TRIGGER_TIMEOUT_MS }),
    remove: (id: string, signal?: AbortSignal) =>
      api.request(jobPath(id), { method: 'DELETE', signal }).then(() => undefined),
    blueprints: (signal?: AbortSignal) =>
      api.defaultOnly(PROCESS_SCOPED_CRON_MESSAGE, '/api/cron/blueprints', { signal, timeoutMs: REQUEST_TIMEOUT_MS }),
    instantiate: (blueprint: string, values: Record<string, string>, signal?: AbortSignal) =>
      api.request('/api/cron/blueprints/instantiate', {
        body: { blueprint, values },
        method: 'POST',
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS
      })
  }
}

export { REQUEST_TIMEOUT_MS, TRIGGER_TIMEOUT_MS }