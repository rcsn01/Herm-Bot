import { $chat } from '~/state/conversation'
import { $preferences, $sessionSelecting } from '~/state/store'
import { openChatSurface } from '~/navigation/workspace-navigation'

export interface HermesDeepLink {
  kind: 'session'
  profile?: null | string
  sessionId: string
  notificationOwner?: string
}

export interface DeepLinkController {
  resumeSession(sessionId: string): Promise<unknown>
  switchProfile(profile: null | string): Promise<unknown>
}

export function parseHermesDeepLink(raw: string): HermesDeepLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const isHermes = url.protocol === 'hermes:'
  const isWeb = url.protocol === 'http:' || url.protocol === 'https:'
  if (!isHermes && !isWeb) return null
  if (url.username || url.password) return null
  if (isWeb && (typeof window === 'undefined' || url.origin !== window.location.origin)) return null

  const segments = (isHermes && url.host ? `${url.host}${url.pathname}` : url.pathname).split('/').filter(Boolean)
  if (segments.length !== 2 || segments[0] !== 'session') return null
  try {
    const sessionId = decodeURIComponent(segments[1])
    if (!sessionId) return null
    const profile = url.searchParams.has('profile')
      ? url.searchParams.get('profile') || null
      : undefined
    return {
      kind: 'session',
      ...(profile === undefined ? {} : { profile }),
      sessionId,
      ...(url.searchParams.get('push') === '1' ? { notificationOwner: url.searchParams.get('push_owner') ?? '' } : {})
    }
  } catch {
    return null
  }
}

export class DeepLinkCoordinator {
  private activeIntent: HermesDeepLink | null = null
  private generation = 0
  private idlePromise: Promise<void> = Promise.resolve()
  private markIdle?: () => void
  private pendingIntent: HermesDeepLink | null = null
  private ready = false
  private running = false

  constructor(private readonly controller: DeepLinkController, private readonly verifyNotificationOwner: (owner: string) => Promise<boolean> = async () => false) {}

  reset(): void {
    this.generation += 1
    this.pendingIntent = null
    this.activeIntent = null
    if (!this.running) this.finishBusy()
  }

  accept(raw: string): boolean {
    const intent = parseHermesDeepLink(raw)
    if (!intent) return false
    this.generation += 1
    this.pendingIntent = intent
    this.ensureBusy()
    if (this.ready) this.startPending()
    return true
  }

  setReady(ready: boolean): void {
    if (ready === this.ready) return
    this.ready = ready
    if (!ready) {
      this.generation += 1
      if (this.activeIntent && !this.pendingIntent) this.pendingIntent = this.activeIntent
      return
    }
    this.startPending()
  }

  settled(): Promise<void> {
    return this.idlePromise
  }

  private startPending(): void {
    const intent = this.pendingIntent
    if (!intent || !this.ready || this.running) return
    this.pendingIntent = null
    this.activeIntent = intent
    this.running = true
    const generation = this.generation
    void this.apply(intent, generation)
  }

  private async apply(intent: HermesDeepLink, generation: number): Promise<void> {
    try {
      if (intent.notificationOwner !== undefined && (!/^[a-f0-9]{64}$/.test(intent.notificationOwner) || !await this.verifyNotificationOwner(intent.notificationOwner))) return
      if (!this.isCurrent(generation)) return
      if (intent.profile !== undefined) {
        await this.controller.switchProfile(intent.profile)
        if (!this.isCurrent(generation)) return
      }
      const outcome = await this.controller.resumeSession(intent.sessionId)
      const selected = outcome as { session?: { storedSessionId?: string } } | undefined
      if (intent.notificationOwner !== undefined && intent.profile !== undefined && $preferences.get().profile !== intent.profile) return
      if (!this.isCurrent(generation) || $sessionSelecting.get() || selected?.session?.storedSessionId !== intent.sessionId || $chat.get().storedSessionId !== intent.sessionId) return
      openChatSurface()
    } catch {
      // Failed or superseded selection must not navigate over the current surface.
    } finally {
      this.running = false
      this.activeIntent = null
      if (this.ready && this.pendingIntent) this.startPending()
      else if (!this.pendingIntent) this.finishBusy()
    }
  }

  private ensureBusy(): void {
    if (this.markIdle) return
    this.idlePromise = new Promise(resolve => { this.markIdle = resolve })
  }

  private finishBusy(): void {
    this.markIdle?.()
    this.markIdle = undefined
  }

  private isCurrent(generation: number): boolean {
    return this.ready && generation === this.generation
  }
}
