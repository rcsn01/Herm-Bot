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

/** The backend deep-merges PUT /api/config over the on-disk document, so a
 *  partial record only overwrites the keys the screen explicitly sends. */
export type PartialConfig = HermesConfigRecord

const profilePath = (path: string, profile: null | string) =>
  profile ? `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}` : path

export const modelsApi = {
  async getInfo(gateway: GatewayPort, profile: null | string): Promise<ModelInfoResponse> {
    return (await gateway.request<ModelInfoResponse>({ path: profilePath('/api/model/info', profile) })).body
  },

  async getOptions(gateway: GatewayPort, profile: null | string): Promise<ModelOptionsResponse> {
    return (await gateway.request<ModelOptionsResponse>({ path: profilePath('/api/model/options?explicit_only=1', profile) })).body
  },

  async getAuxiliary(gateway: GatewayPort, profile: null | string): Promise<AuxiliaryModelsResponse> {
    return (await gateway.request<AuxiliaryModelsResponse>({ path: profilePath('/api/model/auxiliary', profile) })).body
  },

  async setAssignment(gateway: GatewayPort, profile: null | string, body: ModelAssignmentRequest): Promise<ModelAssignmentResponse> {
    return (await gateway.request<ModelAssignmentResponse>({ body, method: 'POST', path: profilePath('/api/model/set', profile) })).body
  },

  async getMoa(gateway: GatewayPort, profile: null | string): Promise<MoaConfigResponse> {
    return (await gateway.request<MoaConfigResponse>({ path: profilePath('/api/model/moa', profile) })).body
  },

  async saveMoa(gateway: GatewayPort, profile: null | string, body: MoaConfigResponse): Promise<MoaConfigResponse & { ok: boolean }> {
    return (await gateway.request<MoaConfigResponse & { ok: boolean }>({ body, method: 'PUT', path: profilePath('/api/model/moa', profile) })).body
  },

  async getConfig(gateway: GatewayPort, profile: null | string): Promise<HermesConfigRecord> {
    return (await gateway.request<HermesConfigRecord>({ path: profilePath('/api/config', profile) })).body
  },

  async saveConfig(gateway: GatewayPort, profile: null | string, partial: PartialConfig): Promise<{ ok: boolean }> {
    return (await gateway.request<{ ok: boolean }>({ body: { config: partial }, method: 'PUT', path: profilePath('/api/config', profile) })).body
  }
}