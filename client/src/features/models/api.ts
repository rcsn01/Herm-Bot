import type {
  AuxiliaryModelsResponse,
  HermesConfigRecord,
  ModelAssignmentRequest,
  ModelAssignmentResponse,
  ModelInfoResponse,
  ModelOptionsResponse,
  MoaConfigResponse
} from '~/lib/types'
import type { GatewayPort } from '~/gateway/gateway-port'
import { profilePath, type MobileProfile } from '~/gateway/profile-path'

/** The backend deep-merges PUT /api/config over the on-disk document, so a
 *  partial record only overwrites the keys the screen explicitly sends. */
export type PartialConfig = HermesConfigRecord

export const modelsApi = {
  async getInfo(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<ModelInfoResponse> {
    return (await gateway.request<ModelInfoResponse>({ path: profilePath('/api/model/info', profile), signal })).body
  },

  async getOptions(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<ModelOptionsResponse> {
    return (await gateway.request<ModelOptionsResponse>({ path: profilePath('/api/model/options?explicit_only=1', profile), signal })).body
  },

  async getAuxiliary(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<AuxiliaryModelsResponse> {
    return (await gateway.request<AuxiliaryModelsResponse>({ path: profilePath('/api/model/auxiliary', profile), signal })).body
  },

  async setAssignment(gateway: GatewayPort, profile: MobileProfile, body: ModelAssignmentRequest, signal?: AbortSignal): Promise<ModelAssignmentResponse> {
    return (await gateway.request<ModelAssignmentResponse>({ body, method: 'POST', path: profilePath('/api/model/set', profile), signal })).body
  },

  async getMoa(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<MoaConfigResponse> {
    return (await gateway.request<MoaConfigResponse>({ path: profilePath('/api/model/moa', profile), signal })).body
  },

  async saveMoa(gateway: GatewayPort, profile: MobileProfile, body: MoaConfigResponse, signal?: AbortSignal): Promise<MoaConfigResponse & { ok: boolean }> {
    return (await gateway.request<MoaConfigResponse & { ok: boolean }>({ body, method: 'PUT', path: profilePath('/api/model/moa', profile), signal })).body
  },

  async getConfig(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<HermesConfigRecord> {
    return (await gateway.request<HermesConfigRecord>({ path: profilePath('/api/config', profile), signal })).body
  },

  async saveConfig(gateway: GatewayPort, profile: MobileProfile, partial: PartialConfig, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return (await gateway.request<{ ok: boolean }>({ body: { config: partial }, method: 'PUT', path: profilePath('/api/config', profile), signal })).body
  }
}