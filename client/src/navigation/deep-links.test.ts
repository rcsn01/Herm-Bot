import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $pendingDeepLink,
  consumePendingDeepLink,
  parseHermesDeepLink,
  queueDeepLink
} from '~/navigation/deep-links'
import { $navigation, resetNavigation } from '~/navigation/navigation-store'

beforeEach(() => {
  resetNavigation()
  $pendingDeepLink.set(null)
})

describe('parseHermesDeepLink', () => {
  it('parses a session deep link', () => {
    expect(parseHermesDeepLink('hermes://session/abc-123')).toEqual({ kind: 'session', sessionId: 'abc-123' })
  })

  it('tolerates the single-slash spelling', () => {
    expect(parseHermesDeepLink('hermes:/session/abc')).toEqual({ kind: 'session', sessionId: 'abc' })
  })

  it('ignores foreign schemes and unhandled targets', () => {
    expect(parseHermesDeepLink('https://example.com/session/abc')).toBeNull()
    expect(parseHermesDeepLink('otherapp://session/abc')).toBeNull()
    expect(parseHermesDeepLink('hermes://unknown/abc')).toBeNull()
    expect(parseHermesDeepLink('hermes://')).toBeNull()
  })

  it('rejects links without a session id', () => {
    expect(parseHermesDeepLink('hermes://session')).toBeNull()
    expect(parseHermesDeepLink('hermes://session/')).toBeNull()
  })

  it('ignores malformed URLs entirely', () => {
    expect(parseHermesDeepLink('not a url')).toBeNull()
  })
})

describe('deep link queue', () => {
  it('queues accepted links and reports rejections without clobbering a pending link', () => {
    expect(queueDeepLink('hermes://session/s-1')).toBe(true)
    expect($pendingDeepLink.get()).toEqual({ kind: 'session', sessionId: 's-1' })

    expect(queueDeepLink('https://example.com')).toBe(false)
    expect($pendingDeepLink.get()).toEqual({ kind: 'session', sessionId: 's-1' })
  })

  it('replaces a previously queued link', () => {
    queueDeepLink('hermes://session/s-1')
    queueDeepLink('hermes://session/s-2')
    expect($pendingDeepLink.get()).toEqual({ kind: 'session', sessionId: 's-2' })
  })

  it('opens the queued session in chat, like the sessions list does', async () => {
    queueDeepLink('hermes://session/s-1')
    const resumeSession = vi.fn().mockResolvedValue(undefined)

    await expect(consumePendingDeepLink({ resumeSession })).resolves.toBe(true)

    expect(resumeSession).toHaveBeenCalledWith('s-1')
    expect($navigation.get().activeTab).toBe('chat')
    expect($pendingDeepLink.get()).toBeNull()
  })

  it('falls back to the sessions tab when the session cannot be resumed', async () => {
    queueDeepLink('hermes://session/s-1')
    const resumeSession = vi.fn().mockRejectedValue(new Error('gone'))

    await expect(consumePendingDeepLink({ resumeSession })).resolves.toBe(false)

    expect($navigation.get().activeTab).toBe('sessions')
    expect($pendingDeepLink.get()).toBeNull()
  })

  it('does nothing when no link is pending', async () => {
    const resumeSession = vi.fn()
    await expect(consumePendingDeepLink({ resumeSession })).resolves.toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })
})