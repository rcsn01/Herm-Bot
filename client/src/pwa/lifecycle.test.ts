import { Capacitor } from '@capacitor/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { register, update } = vi.hoisted(() => {
  const update = vi.fn(async () => undefined)
  return {
    register: vi.fn<(options?: { onNeedRefresh?: () => void }) => typeof update>(() => update),
    update
  }
})
vi.mock('virtual:pwa-register', () => ({ registerSW: register }))

import { chatDrafts, emptyDraft } from '~/features/chat/chat-drafts'
import { $draftOwner, verifyDraftOwner } from '~/state/draft-owner'
import { $chat, emptyChatState } from '~/state/conversation'
import { $pwa, activatePwaUpdate, initializePwa, installPwa } from './lifecycle'

describe('PWA lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('PROD', true)
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false)
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} })
    chatDrafts.clearOwner(false)
    verifyDraftOwner('https://gateway.test', { org_id: 'org', user_id: 'user' })
    $chat.set(emptyChatState())
    $pwa.set({ error: null, installPrompt: null, offline: false, updateAvailable: false, updating: false })
    register.mockClear()
    update.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('registers only on a secure supported web production surface and cleans up', () => {
    const cleanup = initializePwa()
    expect(register).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('offline'))
    expect($pwa.get().offline).toBe(true)
    cleanup()
    expect($pwa.get().updateAvailable).toBe(false)

    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    initializePwa()
    expect(register).toHaveBeenCalledOnce()
  })

  it('defers an available update until the explicit action', async () => {
    const cleanup = initializePwa()
    const options = register.mock.calls[0]?.[0]
    options?.onNeedRefresh?.()
    expect(update).not.toHaveBeenCalled()
    expect($pwa.get().updateAvailable).toBe(true)

    await activatePwaUpdate()
    expect(update).toHaveBeenCalledWith(true)
    cleanup()
  })

  it('never reloads a running conversation or an unanswered prompt', async () => {
    const cleanup = initializePwa()
    register.mock.calls[0]?.[0]?.onNeedRefresh?.()
    $chat.set({ ...emptyChatState(), running: true })
    await activatePwaUpdate()
    expect(update).not.toHaveBeenCalled()
    $chat.set({ ...emptyChatState(), pendingPrompt: { kind: 'secret', question: '', requestId: '' } })
    await activatePwaUpdate()
    expect(update).not.toHaveBeenCalled()
    $chat.set(emptyChatState())
    await activatePwaUpdate()
    expect(update).toHaveBeenCalledOnce()
    cleanup()
  })

  it('updates saved text but cannot reload unsaved work, uploads, or attachments', async () => {
    const cleanup = initializePwa()
    register.mock.calls[0]?.[0]?.onNeedRefresh?.()
    const context = { owner: $draftOwner.get(), profile: null, conversation: 'draft-test', provisional: false }
    const { key } = chatDrafts.select(context)
    chatDrafts.write(key, { ...emptyDraft(), text: 'recover after update' })
    await activatePwaUpdate()
    expect(update).toHaveBeenCalledOnce()
    $pwa.set({ ...$pwa.get(), updating: false })
    update.mockClear()
    const stop = chatDrafts.task(key)
    await activatePwaUpdate()
    expect(update).not.toHaveBeenCalled()
    stop()
    chatDrafts.write(key, { ...emptyDraft(), text: 'attachment', attachments: [{ ref: '@file:a', name: 'a', size: 1, type: '', runtimeId: 'runtime' }] })
    await activatePwaUpdate()
    expect(update).not.toHaveBeenCalled()
    chatDrafts.write(key, { ...emptyDraft(), text: 'unsaved' })
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    chatDrafts.write(key, { ...emptyDraft(), text: 'cannot save' })
    await activatePwaUpdate()
    expect(update).not.toHaveBeenCalled()
    failure.mockRestore()
    cleanup()
  })

  it('reports update failures without rejecting a UI handler', async () => {
    const cleanup = initializePwa()
    register.mock.calls[0]?.[0]?.onNeedRefresh?.()
    update.mockRejectedValueOnce(new Error('offline'))
    await expect(activatePwaUpdate()).resolves.toBeUndefined()
    expect($pwa.get()).toMatchObject({ updating: false, error: expect.stringContaining('could not be loaded') })
    cleanup()
  })

  it('does not register on HTTP or development servers', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    initializePwa()()
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    vi.stubEnv('PROD', false)
    initializePwa()()
    expect(register).not.toHaveBeenCalled()
  })

  it('offers and consumes the captured install prompt', async () => {
    const cleanup = initializePwa()
    const prompt = vi.fn(async () => undefined)
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' })
    })
    window.dispatchEvent(event)
    expect($pwa.get().installPrompt).toBe(event)

    await installPwa()
    expect(prompt).toHaveBeenCalledOnce()
    expect($pwa.get().installPrompt).toBeNull()
    cleanup()
  })
})
