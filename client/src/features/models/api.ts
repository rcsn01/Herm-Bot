import type {
  AuxiliaryModelsResponse,
  HermesConfigRecord,
  ModelAssignmentRequest,
  ModelAssignmentResponse,
  ModelInfoResponse,
  ModelOptionsResponse,
  MoaConfigResponse
} from '~/lib/types'
import type { GatewayApi } from '~/gateway/gateway-api'

/** The backend deep-merges PUT /api/config over the on-disk document, so a
 *  partial record only overwrites the keys the screen explicitly sends. */
export type PartialConfig = HermesConfigRecord

export interface ModelsApi {
  getInfo(signal?: AbortSignal): Promise<ModelInfoResponse>
  getOptions(signal?: AbortSignal): Promise<ModelOptionsResponse>
  getAuxiliary(signal?: AbortSignal): Promise<AuxiliaryModelsResponse>
  setAssignment(body: ModelAssignmentRequest, signal?: AbortSignal): Promise<ModelAssignmentResponse>
  getMoa(signal?: AbortSignal): Promise<MoaConfigResponse>
  saveMoa(body: MoaConfigResponse, signal?: AbortSignal): Promise<MoaConfigResponse & { ok: boolean }>
  getConfig(signal?: AbortSignal): Promise<HermesConfigRecord>
  saveConfig(partial: PartialConfig, signal?: AbortSignal): Promise<{ ok: boolean }>
}

export function createModelsApi(api: GatewayApi): ModelsApi {
  return {
    getInfo: (signal?: AbortSignal) => api.request<ModelInfoResponse>('/api/model/info', { signal }),
    getOptions: (signal?: AbortSignal) => api.request<ModelOptionsResponse>('/api/model/options?explicit_only=1', { signal }),
    getAuxiliary: (signal?: AbortSignal) => api.request<AuxiliaryModelsResponse>('/api/model/auxiliary', { signal }),
    setAssignment: (body: ModelAssignmentRequest, signal?: AbortSignal) =>
      api.request<ModelAssignmentResponse>('/api/model/set', { body, method: 'POST', signal }),
    getMoa: (signal?: AbortSignal) => api.request<MoaConfigResponse>('/api/model/moa', { signal }),
    saveMoa: (body: MoaConfigResponse, signal?: AbortSignal) =>
      api.request<MoaConfigResponse & { ok: boolean }>('/api/model/moa', { body, method: 'PUT', signal }),
    getConfig: (signal?: AbortSignal) => api.request<HermesConfigRecord>('/api/config', { signal }),
    saveConfig: (partial: PartialConfig, signal?: AbortSignal) =>
      api.request<{ ok: boolean }>('/api/config', { body: { config: partial }, method: 'PUT', signal })
  }
}