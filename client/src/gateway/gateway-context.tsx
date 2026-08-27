import { createContext, useContext, type ReactNode } from 'react'

import type { GatewayPort } from '~/gateway/gateway-port'

const GatewayContext = createContext<GatewayPort | null>(null)

export function GatewayProvider({ children, gateway }: { children: ReactNode; gateway: GatewayPort }) {
  return <GatewayContext.Provider value={gateway}>{children}</GatewayContext.Provider>
}

export function useGateway(): GatewayPort {
  const gateway = useContext(GatewayContext)
  if (!gateway) throw new Error('GatewayProvider is missing.')
  return gateway
}
