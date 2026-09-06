import { useMemo } from 'react'

import { useStore } from '@nanostores/react'

import { useGateway } from './gateway-context'
import { createGatewayApi, type GatewayApi } from './gateway-api'
import { $preferences } from '~/state/store'

/**
 * Bind the current GatewayPort to the active Profile. Memoized on
 * (gateway, profile) only — a profile or connection switch yields a new
 * binding; in-flight stale-Scope requests still die via SessionRuntime's
 * generation guard. Never cache a binding across Scope changes.
 */
export function useGatewayApi(): GatewayApi {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  return useMemo(() => createGatewayApi(gateway, preferences.profile), [gateway, preferences.profile])
}

/** Build a feature API over the bound GatewayApi: `useApi(createCronApi)`. */
export function useApi<T>(factory: (api: GatewayApi) => T): T {
  const api = useGatewayApi()
  return useMemo(() => factory(api), [api, factory])
}