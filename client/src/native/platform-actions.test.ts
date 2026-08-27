import { describe, expect, it, vi } from 'vitest'

import { validatedExternalURL } from '~/native/hermes-connection'
import { PlatformActions } from '~/native/platform-actions'

describe('platform actions', () => {
  it('allows only credential-free HTTP and HTTPS URLs', () => {
    expect(validatedExternalURL('https://example.com/path').hostname).toBe('example.com')
    expect(() => validatedExternalURL('javascript:alert(1)')).toThrow(/only http/i)
    expect(() => validatedExternalURL('https://user:secret@example.com')).toThrow(/credentials/i)
  })

  it('shares only a path returned by the native downloader', async () => {
    const download = vi.fn().mockResolvedValue({ filename: 'report.pdf', path: '/tmp/report.pdf', size: 12 })
    const share = vi.fn().mockResolvedValue(undefined)
    const actions = new PlatformActions({ download, share } as never)
    await actions.downloadAndShare({ path: '/api/files/download?path=report.pdf' })
    expect(share).toHaveBeenCalledWith({ path: '/tmp/report.pdf' })
  })
})
