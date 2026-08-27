import type { GatewayScope } from '~/gateway/gateway-scope'
import { cancelGatewayQueries, clearGatewayQueries } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'

export interface ScopeTransitionHooks {
  clearForeground(): void
  resetScopedNavigation(): void
}

export class ConnectionCoordinator {
  private epoch = 0
  private scope: GatewayScope

  constructor(
    readonly gateway: RemoteGateway,
    connectionKey: string,
    profile: null | string,
    private readonly hooks: ScopeTransitionHooks
  ) {
    this.scope = { connectionKey, profile }
  }

  currentScope(): GatewayScope & { epoch: number } {
    return { ...this.scope, epoch: this.epoch }
  }

  async switchScope(connectionKey: string, profile: null | string): Promise<void> {
    if (connectionKey === this.scope.connectionKey && profile === this.scope.profile) return
    const previousConnection = this.scope.connectionKey
    this.epoch += 1
    await cancelGatewayQueries(previousConnection)
    this.gateway.close()
    this.hooks.clearForeground()
    this.hooks.resetScopedNavigation()
    if (connectionKey !== previousConnection) clearGatewayQueries(previousConnection)
    this.scope = { connectionKey, profile }
    await this.gateway.connect(profile)
  }

  async logout(): Promise<void> {
    this.epoch += 1
    this.gateway.close()
    await cancelGatewayQueries()
    clearGatewayQueries()
    this.hooks.clearForeground()
    this.hooks.resetScopedNavigation()
  }
}
