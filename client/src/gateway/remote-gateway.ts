import { JsonRpcGatewayClient, type GatewayEvent } from '@hermes/shared'

import type { GatewayPort, GatewayRequestOptions, GatewayUploadOptions } from './gateway-port'
import { classifyGatewayError } from './gateway-error'
import type { HermesConnectionPlugin } from '~/native/hermes-connection'
import { HermesConnection } from '~/native/hermes-connection'

function rejectIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

export class RemoteGateway implements GatewayPort {
  readonly client: JsonRpcGatewayClient

  constructor(
    private readonly connection: HermesConnectionPlugin = HermesConnection,
    client?: JsonRpcGatewayClient
  ) {
    this.client = client ?? new JsonRpcGatewayClient({ requestIdPrefix: 'mobile' })
  }

  async connect(profile?: null | string): Promise<void> {
    try {
      const { url } = await this.connection.getWebSocketURL({ profile })
      await this.client.connect(url)
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  close(): void {
    this.client.close()
  }

  async request<T>(options: GatewayRequestOptions) {
    rejectIfAborted(options.signal)
    try {
      const result = await this.connection.request<T>(options)
      rejectIfAborted(options.signal)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  async upload<T>(options: GatewayUploadOptions) {
    rejectIfAborted(options.signal)
    try {
      const result = await this.connection.upload<T>(options)
      rejectIfAborted(options.signal)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    try {
      return await this.client.request<T>(method, params, options.timeoutMs, options.signal)
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  subscribe(handler: (event: GatewayEvent) => void): () => void {
    return this.client.onAny(handler)
  }
}
