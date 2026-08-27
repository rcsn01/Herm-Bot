export type GatewayScopeKey = readonly ['gateway', string, string, string, ...unknown[]]

export interface GatewayScope {
  connectionKey: string
  profile?: null | string
}

export function gatewayScopeKey(scope: GatewayScope, domain: string, ...parts: unknown[]): GatewayScopeKey {
  return ['gateway', scope.connectionKey, scope.profile ?? '', domain, ...parts]
}

/** Captures the current epoch. The returned predicate fails after a scope change. */
export function createEpochGuard(readEpoch: () => number): () => boolean {
  const epoch = readEpoch()
  return () => readEpoch() === epoch
}

export function assertCurrentEpoch(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new DOMException('Gateway scope changed.', 'AbortError')
}
