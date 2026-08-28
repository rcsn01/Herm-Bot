import type { GatewayEvent } from '@hermes/shared'
import type { NativeRequestOptions, NativeUploadOptions } from '~/native/hermes-connection'
import type { NativeResponse } from '~/lib/types'

export interface GatewayRequestOptions extends NativeRequestOptions {
  signal?: AbortSignal
}

export interface GatewayUploadOptions extends NativeUploadOptions {
  signal?: AbortSignal
}

export interface GatewayPort {
  connect(profile?: null | string, options?: { signal?: AbortSignal }): Promise<void>
  close(): void
  request<T = unknown>(options: GatewayRequestOptions): Promise<NativeResponse<T>>
  rpc<T = unknown>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>
  upload<T = unknown>(options: GatewayUploadOptions): Promise<NativeResponse<T>>
  subscribe(handler: (event: GatewayEvent) => void): () => void
  subscribeState(handler: (state: string) => void): () => void
}
