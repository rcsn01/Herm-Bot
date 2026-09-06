import { describe, expect, it } from 'vitest'

import { createCronApi } from './api'
import { createGatewayApi } from '~/gateway/gateway-api'
import { MemoryGateway } from '~/test/memory-gateway'

describe('cronApi process-scoped catalog routes', () => {
  it('does not request delivery targets or blueprints for a named profile', async () => {
    const gateway = new MemoryGateway()
    const api = createCronApi(createGatewayApi(gateway, 'work'))

    expect(() => api.deliveryTargets()).toThrow(/only available from the default profile/i)
    expect(() => api.blueprints()).toThrow(/only available from the default profile/i)

    expect(gateway.calls).toHaveLength(0)
  })

  it('keeps process-scoped catalog routes unscoped for the default profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/cron/delivery-targets', () => ({ targets: [{ id: 'local', name: 'Local', home_target_set: true, home_env_var: null }] }))
      .handle('/api/cron/blueprints', () => ({ blueprints: [] }))
    const api = createCronApi(createGatewayApi(gateway, null))

    await api.deliveryTargets()
    await api.blueprints()

    expect(gateway.calls.map(call => call.value)).toEqual([
      expect.objectContaining({ path: '/api/cron/delivery-targets' }),
      expect.objectContaining({ path: '/api/cron/blueprints' })
    ])
  })
})