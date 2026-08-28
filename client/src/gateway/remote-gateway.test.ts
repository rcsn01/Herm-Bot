import { describe, expect, it, vi } from 'vitest'

import { RemoteGateway } from '~/gateway/remote-gateway'

describe('remote gateway connection ownership', () => {
  it('does not let an aborted connection attempt close its successor', async () => {
    let finishOldURL: ((value: { url: string }) => void) | undefined
    const oldURL = new Promise<{ url: string }>(resolve => { finishOldURL = resolve })
    const connection = {
      getWebSocketURL: vi.fn()
        .mockReturnValueOnce(oldURL)
        .mockResolvedValueOnce({ url: 'wss://gateway.test/new' })
    }
    const client = {
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined)
    }
    const gateway = new RemoteGateway(connection as never, client as never)
    const oldScope = new AbortController()

    const stale = gateway.connect('old', { signal: oldScope.signal })
    oldScope.abort()
    await expect(gateway.connect('new')).resolves.toBeUndefined()
    finishOldURL?.({ url: 'wss://gateway.test/old' })

    await expect(stale).rejects.toMatchObject({ kind: 'aborted' })
    expect(client.close).not.toHaveBeenCalled()
    expect(client.connect).toHaveBeenCalledExactlyOnceWith('wss://gateway.test/new')
  })
})
