import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMediaConnection } from '~/features/chat/chat-interaction'
import { useChatInteraction } from '~/features/chat/use-chat-interaction'
import { chatDrafts } from './chat-drafts'
import { $draftOwner } from '~/state/draft-owner'
import { $chat, emptyChatState, type Conversation } from '~/state/conversation'

function conversationStub() {
  return {
    attach: vi.fn(),
    completeSlash: vi.fn(),
    retryFrom: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined)
  } as unknown as Conversation
}

function mediaStub(): ChatMediaConnection {
  return {
    request: vi.fn(),
    upload: vi.fn()
  } as unknown as ChatMediaConnection
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(() => {
  chatDrafts.clearOwner(false)
  $draftOwner.set({ gateway: '', principal: null, generation: $draftOwner.get().generation + 1, locked: false })
  $chat.set(emptyChatState())
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
})

describe('useChatInteraction lifecycle', () => {
  it('keeps the interaction live through StrictMode effect cleanup rehearsal', async () => {
    const conversation = conversationStub()
    const mediaConnection = mediaStub()
    const hook = renderHook(() => useChatInteraction({ conversation, mediaConnection }), { wrapper: StrictMode })

    act(() => hook.result.current.interaction.updateDraft('strict mode'))
    await act(async () => { await hook.result.current.interaction.submit() })

    expect(hook.result.current.state.draft).toBe('')
    expect(conversation.send).toHaveBeenCalledWith('strict mode')
  })

  it('makes pending callbacks inert after a true unmount', async () => {
    const conversation = conversationStub()
    const mediaConnection = mediaStub()
    const pending = deferred<void>()
    vi.mocked(conversation.send).mockReturnValue(pending.promise)
    const hook = renderHook(() => useChatInteraction({ conversation, mediaConnection }))

    act(() => hook.result.current.interaction.updateDraft('in flight'))
    let submission!: Promise<void>
    act(() => { submission = hook.result.current.interaction.submit() })
    expect(hook.result.current.interaction.$state.get().submitting).toBe(true)

    hook.unmount()
    await Promise.resolve()
    await act(async () => {
      pending.resolve()
      await submission
    })

    act(() => hook.result.current.interaction.updateDraft('ignored'))
    expect(hook.result.current.interaction.$state.get()).toMatchObject({ draft: '', submitting: true })
  })

  it('feeds session identity from $chat into the interaction', async () => {
    const conversation = conversationStub()
    const mediaConnection = mediaStub()
    vi.mocked(conversation.attach).mockResolvedValue('@file:one')
    const hook = renderHook(() => useChatInteraction({ conversation, mediaConnection }))

    act(() => hook.result.current.interaction.updateDraft('preserved draft'))
    await act(async () => {
      await hook.result.current.interaction.attach([new File(['one'], 'one.txt')])
    })
    expect(hook.result.current.state.attachmentRefs).toEqual(['@file:one'])

    act(() => {
      $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    })

    expect(hook.result.current.interaction.$state.get()).toMatchObject({
      attachmentRefs: [],
      draft: ''
    })
  })
})


it('recovers a provisional draft after unmounting and promotes it when a stored ID arrives', async () => {
  const conversation = conversationStub()
  const mediaConnection = mediaStub()
  $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-provisional' })
  const first = renderHook(() => useChatInteraction({ conversation, mediaConnection }))
  act(() => first.result.current.interaction.updateDraft('not linked yet'))
  first.unmount()
  await Promise.resolve()
  const second = renderHook(() => useChatInteraction({ conversation, mediaConnection }))
  expect(second.result.current.state.draft).toBe('not linked yet')
  act(() => $chat.set({ ...$chat.get(), storedSessionId: 'stored-now' }))
  expect(second.result.current.state.draft).toBe('not linked yet')
  expect(second.result.current.interaction.record()?.conversation).toBe('stored-now')
})
