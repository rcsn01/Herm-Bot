// Mobile-owned copies of the small, runtime-safe gateway contracts it uses.
// Keep this surface narrow; the full Hermes shared package is not a mobile
// dependency.
export {
  JsonRpcGatewayClient,
  JsonRpcGatewayError,
  type ConnectionState,
  type GatewayClientOptions,
  type GatewayEvent,
  type GatewayEventName,
  type GatewayRequestId,
  type JsonRpcErrorPayload,
  type JsonRpcFrame,
  type WebSocketLike
} from './json-rpc-gateway'
export type * from './billing-types'
