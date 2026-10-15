import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeepLinkCoordinator, parseHermesDeepLink } from './deep-links'
import { $activeRoute, $navigation, pushRoute, resetNavigation, setTab } from './navigation-store'
import { $workspacePolicy, dismissMenu, openMenu, resetWorkspacePolicy } from './workspace-navigation'
import { $chat } from '~/state/conversation'
import { $sessionSelecting } from '~/state/store'
function selected(id: string) {
  $chat.set({ ...$chat.get(), storedSessionId: id })
  return { session: { storedSessionId: id } }
}
beforeEach(() => { resetNavigation(); resetWorkspacePolicy(); $sessionSelecting.set(false) })
describe('parseHermesDeepLink', () => {
  it('parses legacy and same-origin session links without inventing a profile', () => {
    expect(parseHermesDeepLink('hermes://session/abc')).toEqual({ kind: 'session', sessionId: 'abc' })
    expect(parseHermesDeepLink('hermes:/session/abc')).toEqual({ kind: 'session', sessionId: 'abc' })
    expect(parseHermesDeepLink(`${window.location.origin}/session/a%2Fb?profile=work`)).toEqual({ kind: 'session', profile: 'work', sessionId: 'a/b' })
    expect(parseHermesDeepLink('hermes://session/abc?profile=')).toEqual({ kind: 'session', profile: null, sessionId: 'abc' })
  })
  it('rejects foreign, credentialed, malformed and unhandled links', () => {
    for (const raw of ['https://example.com/session/abc', `${window.location.protocol}//user:pass@${window.location.host}/session/abc`, `${window.location.origin}/settings/a`, `${window.location.origin}/session/%E0%A4%A`, 'hermes://session', 'hermes://unknown/abc', 'not a url']) expect(parseHermesDeepLink(raw)).toBeNull()
  })
})
describe('deep link coordinator', () => {
  it('keeps only the latest intent until ready', async () => {
    const resumeSession = vi.fn(async (id: string) => selected(id))
    const coordinator = new DeepLinkCoordinator({ resumeSession, switchProfile: vi.fn() })
    coordinator.accept('hermes://session/first'); coordinator.accept('hermes://session/second')
    coordinator.setReady(true); await coordinator.settled()
    expect(resumeSession).toHaveBeenCalledExactlyOnceWith('second')
    expect($navigation.get().activeTab).toBe('sessions')
    expect($activeRoute.get().type).toBe('sessions-root')
  })
  it('switches profile before exact-ID resume', async () => {
    const order: string[] = []
    const coordinator = new DeepLinkCoordinator({ resumeSession: async id => { order.push(`resume:${id}`); return selected(id) }, switchProfile: async profile => { order.push(`profile:${profile}`) } })
    coordinator.setReady(true); coordinator.accept('hermes://session/s-1?profile=work'); await coordinator.settled()
    expect(order).toEqual(['profile:work', 'resume:s-1'])
    expect($navigation.get().activeTab).toBe('sessions')
  })
  it('does not lose the latest intent when switching drops readiness', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const resumeSession = vi.fn(async (id: string) => selected(id))
    let coordinator: DeepLinkCoordinator
    coordinator = new DeepLinkCoordinator({ resumeSession, switchProfile: async () => { coordinator.setReady(false); await gate } })
    coordinator.setReady(true); coordinator.accept('hermes://session/first?profile=work'); coordinator.accept('hermes://session/second')
    finish(); await Promise.resolve(); coordinator.setReady(true); await coordinator.settled()
    expect(resumeSession).toHaveBeenCalledExactlyOnceWith('second')
  })
  it.each(['failed', 'superseded', 'wrong-id', 'pending'])('does not navigate on %s resume', async mode => {
    pushRoute('settings', { category: 'about', tab: 'settings', type: 'settings-category' }); setTab('settings')
    const coordinator = new DeepLinkCoordinator({ resumeSession: async () => {
      if (mode === 'failed') throw new Error('gone')
      if (mode === 'superseded') return undefined
      if (mode === 'pending') $sessionSelecting.set(true)
      return selected(mode === 'wrong-id' ? 'other' : 'target')
    }, switchProfile: vi.fn() })
    coordinator.setReady(true); coordinator.accept('hermes://session/target'); await coordinator.settled()
    expect($navigation.get().activeTab).toBe('settings')
  })
  it('successful landing clears menu and stashed return policy', async () => {
    const coordinator = new DeepLinkCoordinator({ resumeSession: async id => selected(id), switchProfile: vi.fn() })
    coordinator.setReady(true); openMenu(); dismissMenu({ type: 'tab', tab: 'cron' })
    coordinator.accept('hermes://session/abc'); await coordinator.settled()
    expect($workspacePolicy.get()).toMatchObject({ menuOpen: false, returnOrigin: null, returnStack: null })
    expect($navigation.get().activeTab).toBe('sessions')
  })
  it.each([true, false])('verifies notification ownership before profile/resume, match=%s', async allowed => {
    const resumeSession = vi.fn(async (id: string) => selected(id))
    const switchProfile = vi.fn()
    const verify = vi.fn(async () => allowed)
    const coordinator = new DeepLinkCoordinator({ resumeSession, switchProfile }, verify)
    coordinator.setReady(true); coordinator.accept(`${window.location.origin}/session/a?profile=work&push=1&push_owner=${'a'.repeat(64)}`); await coordinator.settled()
    expect(verify).toHaveBeenCalledOnce()
    expect(resumeSession).toHaveBeenCalledTimes(Number(allowed))
    expect(switchProfile).toHaveBeenCalledTimes(Number(allowed))
  })
  it('retires queued notification intents on reset', async () => {
    const resumeSession = vi.fn()
    const coordinator = new DeepLinkCoordinator({ resumeSession, switchProfile: vi.fn() }, async () => true)
    coordinator.accept('hermes://session/a'); coordinator.reset(); coordinator.setReady(true); await coordinator.settled()
    expect(resumeSession).not.toHaveBeenCalled()
  })
})
