export type GatewayScopeKey = readonly ['gateway', string, string, string, ...unknown[]]

export interface GatewayScope {
  connectionKey: string
  profile?: null | string
}

export interface GatewayScopeSnapshot {
  connectionKey: string
  profile: null | string
}

export function gatewayScopeSnapshot(connectionKey: string, profile?: null | string): GatewayScopeSnapshot {
  return { connectionKey, profile: profile ?? null }
}

export function sameGatewayScope(left: GatewayScopeSnapshot, right: GatewayScopeSnapshot): boolean {
  return left.connectionKey === right.connectionKey && left.profile === right.profile
}

export function gatewayScopeKey(scope: GatewayScope, domain: string, ...parts: unknown[]): GatewayScopeKey {
  return ['gateway', scope.connectionKey, scope.profile ?? 'default', domain, ...parts]
}

/** Captures the current epoch. The returned predicate fails after a scope change. */
export function createEpochGuard(readEpoch: () => number): () => boolean {
  const epoch = readEpoch()
  return () => readEpoch() === epoch
}

export function assertCurrentEpoch(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new DOMException('Gateway scope changed.', 'AbortError')
}
