import type { GatewayPort } from './gateway-port'
import { requireGatewayReady } from '~/state/store'

/** Feature code cannot use the recovery transport to dispatch unavailable work. */
export function createGuardedGateway(port: GatewayPort, requireReady = requireGatewayReady): GatewayPort {
  return {
    close: () => port.close(),
    async rpc(method, params, options) { requireReady(); return port.rpc(method, params, options) },
    async request(options) { requireReady(); return port.request(options) },
    async upload(options) { requireReady(); return port.upload(options) }
  }
}
