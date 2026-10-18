import '@testing-library/dom'
import { beforeEach } from 'vitest'
import { $connection } from '~/state/store'
import { $draftOwner } from '~/state/draft-owner'
import { $networkStatus } from '~/state/network-status'

// Most feature tests exercise a verified, ready workspace. Interruption tests
// replace this evidence explicitly before invoking commands.
let ownerGeneration = 0
beforeEach(() => {
  $draftOwner.set({ gateway: 'https://test.hermes', principal: null, generation: ++ownerGeneration, locked: false })
  $networkStatus.set({ status: 'unknown' })
  $connection.set({ authMode: 'token', error: null, errorKind: null, workspaceAvailable: true, phase: 'connected', status: null })
})

Object.defineProperty(window, 'matchMedia', {
  value: (query: string) => ({
    addEventListener: () => undefined,
    matches: false,
    media: query,
    removeEventListener: () => undefined
  })
})

// JSDOM has no top layer. Browser tests cover native dialog focus and dismissal.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } }
})

let uuidCounter = 0
Object.defineProperty(globalThis, 'crypto', {
  value: { ...globalThis.crypto, randomUUID: () => `test-uuid-${++uuidCounter}` }
})
