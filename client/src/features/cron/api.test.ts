import { describe, expect, it } from 'vitest'

import { cronApi } from './api'
import { MemoryGateway } from '~/test/memory-gateway'

describe('cronApi process-scoped catalog routes', () => {
  it('does not request delivery targets or blueprints for a named profile', async () => {
    const gateway = new MemoryGateway()

    expect(() => cronApi.deliveryTargets(gateway, 'work')).toThrow(/only available from the default profile/i)
    expect(() => cronApi.blueprints(gateway, 'work')).toThrow(/only available from the default profile/i)

    expect(gateway.calls).toHaveLength(0)
  })

  it('keeps process-scoped catalog routes unscoped for the default profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/cron/delivery-targets', () => ({ targets: [{ id: 'local', name: 'Local', home_target_set: true, home_env_var: null }] }))
      .handle('/api/cron/blueprints', () => ({ blueprints: [] }))

    await cronApi.deliveryTargets(gateway, null)
    await cronApi.blueprints(gateway, null)

    expect(gateway.calls.map(call => call.value)).toEqual([
      expect.objectContaining({ path: '/api/cron/delivery-targets' }),
      expect.objectContaining({ path: '/api/cron/blueprints' })
    ])
  })
})
