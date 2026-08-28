import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DeepLinkCoordinator, parseHermesDeepLink } from '~/navigation/deep-links'
import { $navigation, resetNavigation } from '~/navigation/navigation-store'

beforeEach(() => resetNavigation())

describe('parseHermesDeepLink', () => {
  it('parses legacy session links without forcing a profile change', () => {
    expect(parseHermesDeepLink('hermes://session/abc-123')).toEqual({ kind: 'session', sessionId: 'abc-123' })
  })

  it('preserves a named or explicit default profile', () => {
    expect(parseHermesDeepLink('hermes://session/abc?profile=client%20work%2Fios')).toEqual({
      kind: 'session', profile: 'client work/ios', sessionId: 'abc'
    })
    expect(parseHermesDeepLink('hermes://session/abc?profile=')).toEqual({ kind: 'session', profile: null, sessionId: 'abc' })
  })

  it('tolerates the single-slash spelling', () => {
    expect(parseHermesDeepLink('hermes:/session/abc')).toEqual({ kind: 'session', sessionId: 'abc' })
  })

  it('ignores foreign, malformed, and unhandled links', () => {
    expect(parseHermesDeepLink('https://example.com/session/abc')).toBeNull()
    expect(parseHermesDeepLink('hermes://unknown/abc')).toBeNull()
    expect(parseHermesDeepLink('hermes://session')).toBeNull()
    expect(parseHermesDeepLink('not a url')).toBeNull()
  })
})

describe('deep link coordinator', () => {
  it('keeps only the latest intent until the gateway is ready', async () => {
    const resumeSession = vi.fn().mockResolvedValue(undefined)
    const coordinator = new DeepLinkCoordinator({ resumeSession, switchProfile: vi.fn() })

    expect(coordinator.accept('hermes://session/first')).toBe(true)
    expect(coordinator.accept('hermes://session/second')).toBe(true)
    coordinator.setReady(true)
    await coordinator.settled()

    expect(resumeSession).toHaveBeenCalledExactlyOnceWith('second')
    expect($navigation.get().activeTab).toBe('chat')
  })

  it('switches profile before resuming a profile-aware intent', async () => {
    const order: string[] = []
    const coordinator = new DeepLinkCoordinator({
      resumeSession: async sessionId => { order.push(`resume:${sessionId}`) },
      switchProfile: async profile => { order.push(`profile:${profile ?? 'default'}`) }
    })
    coordinator.setReady(true)

    coordinator.accept('hermes://session/s-1?profile=client%20work')
    await coordinator.settled()

    expect(order).toEqual(['profile:client work', 'resume:s-1'])
    expect($navigation.get().activeTab).toBe('chat')
  })

  it('does not lose the latest intent when a profile switch drops readiness', async () => {
    let finishSwitch: (() => void) | undefined
    const switchGate = new Promise<void>(resolve => { finishSwitch = resolve })
    const resumeSession = vi.fn().mockResolvedValue(undefined)
    let coordinator: DeepLinkCoordinator
    const switchProfile = vi.fn(async () => {
      coordinator.setReady(false)
      await switchGate
    })
    coordinator = new DeepLinkCoordinator({ resumeSession, switchProfile })
    coordinator.setReady(true)

    coordinator.accept('hermes://session/first?profile=work')
    coordinator.accept('hermes://session/second')
    finishSwitch?.()
    await Promise.resolve()
    coordinator.setReady(true)
    await coordinator.settled()

    expect(resumeSession).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('does not let a stale completion choose the final tab', async () => {
    let failFirst: ((error: Error) => void) | undefined
    const first = new Promise<void>((_resolve, reject) => { failFirst = reject })
    const resumeSession = vi.fn((sessionId: string) => sessionId === 'first' ? first : Promise.resolve())
    const coordinator = new DeepLinkCoordinator({ resumeSession, switchProfile: vi.fn() })
    coordinator.setReady(true)

    coordinator.accept('hermes://session/first')
    coordinator.accept('hermes://session/second')
    failFirst?.(new Error('gone'))
    await coordinator.settled()

    expect(resumeSession.mock.calls).toEqual([['first'], ['second']])
    expect($navigation.get().activeTab).toBe('chat')
  })

  it('falls back to sessions when the current intent cannot resume', async () => {
    const coordinator = new DeepLinkCoordinator({
      resumeSession: vi.fn().mockRejectedValue(new Error('gone')),
      switchProfile: vi.fn()
    })
    coordinator.setReady(true)

    coordinator.accept('hermes://session/missing')
    await coordinator.settled()

    expect($navigation.get().activeTab).toBe('sessions')
  })
})
