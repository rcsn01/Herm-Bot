import type { GatewayPort } from '~/gateway/gateway-port'

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
  deliver?: null | string
  enabled: boolean
  id: string
  last_error?: null | string
  last_run_at?: null | string
  name?: null | string
  next_run_at?: null | string
  prompt?: null | string
  schedule?: { display?: string; expr?: string; kind?: string }
  schedule_display?: null | string
  state?: null | string
}

const TRIGGER_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const profilePath = (path: string, profile: null | string) => profile ? `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}` : path

export const cronApi = {
  async list(gateway: GatewayPort, profile: null | string): Promise<CronJob[]> {
    return (await gateway.request<CronJob[]>({ path: profilePath('/api/cron/jobs', profile) })).body
  },
  async runs(gateway: GatewayPort, profile: null | string, id: string, limit = 20): Promise<CronRun[]> {
    const path = profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/runs?limit=${limit}`, profile)
    return (await gateway.request<{ runs?: CronRun[] }>({ path })).body.runs ?? []
  },
  async pause(gateway: GatewayPort, profile: null | string, id: string): Promise<CronJob> {
    return (await gateway.request<CronJob>({ method: 'POST', path: profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/pause`, profile) })).body
  },
  async resume(gateway: GatewayPort, profile: null | string, id: string): Promise<CronJob> {
    return (await gateway.request<CronJob>({ method: 'POST', path: profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/resume`, profile) })).body
  },
  async trigger(gateway: GatewayPort, profile: null | string, id: string): Promise<CronJob> {
    return (await gateway.request<CronJob>({ method: 'POST', path: profilePath(`/api/cron/jobs/${encodeURIComponent(id)}/trigger`, profile), timeoutMs: TRIGGER_TIMEOUT_MS })).body
  },
  async remove(gateway: GatewayPort, profile: null | string, id: string): Promise<void> {
    await gateway.request({ method: 'DELETE', path: profilePath(`/api/cron/jobs/${encodeURIComponent(id)}`, profile) })
  }
}
