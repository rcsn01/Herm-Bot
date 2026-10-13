import { expect, it } from 'vitest'
import { $connection, $gatewayReady, requireGatewayReady } from './store'
import { $networkStatus } from './network-status'
import { $draftOwner } from './draft-owner'
it('unknown network does not prevent a verified live connection', () => {
  expect($gatewayReady.get()).toBe(true)
  expect(() => requireGatewayReady()).not.toThrow()
})
it('explicit offline and a locked owner reject actions', () => {
  $networkStatus.set({ status: 'offline' })
  expect(() => requireGatewayReady()).toThrow(expect.objectContaining({ code: 'GATEWAY_UNAVAILABLE', retryable: false }))
  $networkStatus.set({ status: 'online' })
  $draftOwner.set({ ...$draftOwner.get(), locked: true })
  expect($gatewayReady.get()).toBe(false)
})
it.each(['connecting', 'reconnecting', 'error', 'disconnected', 'unsupported'] as const)('rejects %s', phase => {
  $connection.set({ ...$connection.get(), phase })
  expect($gatewayReady.get()).toBe(false)
})
