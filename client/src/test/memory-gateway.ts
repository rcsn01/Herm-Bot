import type { GatewayEvent } from '@hermes/shared'
import type { GatewayPort, GatewayRequestOptions, GatewayUploadOptions } from '~/gateway/gateway-port'
import type { NativeResponse } from '~/lib/types'

export interface MemoryGatewayCall {
  kind: 'request' | 'rpc' | 'upload'
  method?: string
  value: unknown
}

type Handler = (value: unknown) => unknown | Promise<unknown>

export class MemoryGateway implements GatewayPort {
  readonly calls: MemoryGatewayCall[] = []
  private readonly handlers = new Map<string, Handler>()
  private readonly subscribers = new Set<(event: GatewayEvent) => void>()

  handle(key: string, handler: Handler): this {
    this.handlers.set(key, handler)
    return this
  }

  async request<T>(options: GatewayRequestOptions): Promise<NativeResponse<T>> {
    options.signal?.throwIfAborted()
    this.calls.push({ kind: 'request', method: options.method, value: options })
    const body = await this.invoke(options.path, options)
    return { body: body as T, headers: {}, status: 200 }
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<T> {
    options.signal?.throwIfAborted()
    this.calls.push({ kind: 'rpc', method, value: params })
    return await this.invoke(method, params) as T
  }

  async upload<T>(options: GatewayUploadOptions): Promise<NativeResponse<T>> {
    options.signal?.throwIfAborted()
    this.calls.push({ kind: 'upload', value: options })
    const body = await this.invoke(options.path, options)
    return { body: body as T, headers: {}, status: 200 }
  }

  subscribe(handler: (event: GatewayEvent) => void): () => void {
    this.subscribers.add(handler)
    return () => this.subscribers.delete(handler)
  }

  emit(event: GatewayEvent): void {
    for (const handler of this.subscribers) handler(event)
  }

  private async invoke(key: string, value: unknown): Promise<unknown> {
    const handler = this.handlers.get(key)
    if (!handler) throw new Error(`No MemoryGateway handler for ${key}`)
    return handler(value)
  }
}
