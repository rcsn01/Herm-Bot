import { gatewayScopeSnapshot, sameGatewayScope, type GatewayScopeSnapshot } from './gateway-scope'
import { $preferences } from '~/state/store'

export interface CurrentGatewayScope extends GatewayScopeSnapshot {
  /** Changes even when the user switches away and back to the same profile. */
  generation: number
}

let generation = 0
let last = gatewayScopeSnapshot($preferences.get().remoteURL, $preferences.get().profile)

$preferences.listen(preferences => {
  const next = gatewayScopeSnapshot(preferences.remoteURL, preferences.profile)
  if (!sameGatewayScope(last, next)) {
    generation += 1
    last = next
  }
})

/** Capture the profile and connection selected when an async operation starts. */
export function currentGatewayScope(): CurrentGatewayScope {
  const preferences = $preferences.get()
  const current = gatewayScopeSnapshot(preferences.remoteURL, preferences.profile)
  if (!sameGatewayScope(last, current)) {
    generation += 1
    last = current
  }
  return { ...current, generation }
}

/** True only while the captured connection/profile is still foreground. */
export function isCurrentGatewayScope(scope: CurrentGatewayScope): boolean {
  const current = currentGatewayScope()
  return scope.generation === current.generation && sameGatewayScope(scope, current)
}
