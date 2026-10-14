import { atom } from 'nanostores'

export type PrivacyStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
export const PRIVACY_KEY = 'hermes.privacy.v1'
const RESET_PREFIX = 'hermes.privacy.reset.v1:'
const HISTORY_PREFIX = 'hermes.transcript.v2:'
export interface PrivacyResult { complete: boolean; failures: string[] }
export interface PrivacyReset { owner: string; revision: string; external: boolean }

export function browserPrivacyStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** Installation-wide history policy and content-free, account-scoped reset revisions. */
export class LocalPrivacy {
  readonly $state = atom({ saveHistory: false, error: null as string | null })
  readonly $reset = atom<PrivacyReset | null>(null)
  private sessionDisabled = false
  private operationError: string | null = null
  private revisions = new Map<string, string>()

  constructor(private readonly storage: PrivacyStorage | null) { this.refreshPolicy() }

  refreshPolicy() {
    let saveHistory = false
    let error: string | null = null
    try {
      if (!this.storage) throw new Error('Storage unavailable')
      const raw = this.storage.getItem(PRIVACY_KEY)
      if (raw === null) saveHistory = true
      else {
        const value: unknown = JSON.parse(raw)
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || (value as { version?: unknown }).version !== 1 || typeof (value as { saveHistory?: unknown }).saveHistory !== 'boolean') throw new Error('Invalid privacy preference')
        saveHistory = (value as { saveHistory: boolean }).saveHistory
      }
    } catch { error = 'History saving is off because the privacy preference could not be read. Choose a setting again to save it.' }
    saveHistory = saveHistory && !this.sessionDisabled
    error = this.operationError ?? error
    const previous = this.$state.get()
    if (previous.saveHistory !== saveHistory || previous.error !== error) this.$state.set({ saveHistory, error })
    return saveHistory
  }

  historyAllowed() { return this.refreshPolicy() }

  setHistorySaving(enabled: boolean): PrivacyResult {
    this.sessionDisabled = !enabled
    this.operationError = null
    this.$state.set({ saveHistory: enabled, error: null })
    const failures: string[] = []
    try {
      if (!this.storage) throw new Error('Storage unavailable')
      const raw = JSON.stringify({ version: 1, saveHistory: enabled })
      this.storage.setItem(PRIVACY_KEY, raw)
      if (this.storage.getItem(PRIVACY_KEY) !== raw) throw new Error('Preference not saved')
    } catch {
      failures.push('Privacy preference could not be saved. This choice may not survive restart or reach other tabs.')
      this.sessionDisabled = true
    }
    if (!enabled || failures.length) {
      if (!this.purgeHistory()) failures.push('Some saved history could not be removed. Clear this site’s data before sharing the device.')
    }
    this.operationError = failures.join(' ') || null
    this.$state.set({ saveHistory: enabled && !this.sessionDisabled, error: this.operationError })
    return { complete: failures.length === 0, failures }
  }

  purgeHistory(): boolean {
    let complete = true
    try {
      if (!this.storage) return false
      const keys = Array.from({ length: this.storage.length }, (_, i) => this.storage!.key(i))
      for (const key of keys) if (key && (key.startsWith(HISTORY_PREFIX) || key === 'hermes.transcript.v1')) {
        try { this.storage.removeItem(key); if (this.storage.getItem(key) !== null) complete = false } catch { complete = false }
      }
    } catch { complete = false }
    return complete
  }

  revision(owner: string): string | null {
    if (this.revisions.has(owner)) return this.revisions.get(owner)!
    try { return this.storage?.getItem(RESET_PREFIX + encodeURIComponent(owner)) ?? null } catch { return 'unavailable' }
  }

  isCurrent(owner: string, revision: string | null) { return this.revision(owner) === revision }
  resetDurable(owner: string) { return !this.revisions.has(owner) && this.revision(owner) !== 'unavailable' }

  beginReset(owner: string): PrivacyResult {
    const revision = crypto.randomUUID()
    let complete = true
    try {
      if (!this.storage) throw new Error('Storage unavailable')
      const key = RESET_PREFIX + encodeURIComponent(owner)
      this.storage.setItem(key, revision)
      if (this.storage.getItem(key) !== revision) throw new Error('Reset not saved')
      this.revisions.delete(owner)
    } catch { this.revisions.set(owner, revision); complete = false }
    // Notify local owners even if cross-tab invalidation failed.
    this.$reset.set({ owner, revision, external: false })
    return { complete, failures: complete ? [] : ['Other tabs could not be invalidated. Close them and clear this site’s data before sharing the device.'] }
  }

  storageChanged(event: Pick<StorageEvent, 'key'>) {
    if (event.key === PRIVACY_KEY || event.key === null) {
      // Clearing origin storage is not an explicit choice to enable history.
      // Keep this process disabled, particularly after a failed preference write.
      if (event.key !== null) {
        this.sessionDisabled = false
        this.operationError = null
      }
      if (!this.refreshPolicy() && !this.purgeHistory()) {
        this.operationError = 'Some saved history could not be removed. Clear this site’s data before sharing the device.'
        this.refreshPolicy()
      }
    }
    if (event.key?.startsWith(RESET_PREFIX)) {
      try {
        const owner = decodeURIComponent(event.key.slice(RESET_PREFIX.length))
        this.revisions.delete(owner)
        const revision = this.revision(owner)
        if (revision) this.$reset.set({ owner, revision, external: true })
      } catch { /* Invalid external reset keys do not identify an account. */ }
    }
  }

  initialize() {
    if (!this.refreshPolicy() && !this.purgeHistory()) {
      this.operationError = 'Some saved history could not be removed. Clear this site’s data before sharing the device.'
      this.refreshPolicy()
    }
    const changed = (event: StorageEvent) => this.storageChanged(event)
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }
}

export const localPrivacy = new LocalPrivacy(browserPrivacyStorage())
