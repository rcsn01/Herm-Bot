import { expect, it, vi } from 'vitest'
import { createGuardedGateway } from './guarded-gateway'
import { MemoryGateway } from '~/test/memory-gateway'
import { $connection } from '~/state/store'
it('rejects all dispatch methods without underlying calls', async () => {
  const transport = new MemoryGateway()
  const rpc = vi.spyOn(transport, 'rpc'), request = vi.spyOn(transport, 'request'), upload = vi.spyOn(transport, 'upload')
  const gateway = createGuardedGateway(transport)
  $connection.set({ ...$connection.get(), phase: 'reconnecting' })
  await expect(gateway.rpc('prompt.submit')).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', retryable: false })
  await expect(gateway.request({ path: '/api/status' })).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' })
  await expect(gateway.upload({ path: '/api/upload', dataBase64: '', field: 'file', filename: 'file' })).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' })
  expect(rpc).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled()
})
it('forwards available work', async () => {
  const transport = new MemoryGateway().handle('test', () => ({ ok: true }))
  await expect(createGuardedGateway(transport).rpc('test')).resolves.toEqual({ ok: true })
})
