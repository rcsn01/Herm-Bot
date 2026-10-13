import { afterEach, expect, it, vi } from 'vitest'
import { $chat, Conversation, emptyChatState } from './conversation'
import { $draftOwner, verifyDraftOwner } from './draft-owner'
import { $connection, $preferences } from './store'
import { $networkStatus } from './network-status'
import { transcriptCache } from './transcript-cache'
import { SessionRuntime } from '~/gateway/session-runtime'
import { MemoryGateway } from '~/test/memory-gateway'
import { createSessionSelection, sessionBookmarkKey } from './session-selection'
import { GatewayController } from './gateway-controller'
import { ChatInteraction } from '~/features/chat/chat-interaction'

const row = { row_id: 1, role: 'assistant' as const, content: 'Readable history' }
const session = { contractVersion: 6, info: { desktop_contract: 6, title: 'A' }, rows: [row], runtimeSessionId: 'runtime-a', storedSessionId: 'a' }
const snapshot = (id = 'a', profile: string | null = null) => ({ version: 2 as const, owner: $draftOwner.get(), profile, storedSessionId: id, title: id, source: null, startedAt: null, lastSyncedAt: 1, entries: [{ kind: 'message' as const, author: 'assistant' as const, content: `Saved ${id}`, id: '1', streaming: false }] })
const disposals: Array<() => void> = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.restoreAllMocks() })
function subject(gateway = new MemoryGateway()) {
  $preferences.set({ ...$preferences.get(), profile: null, remoteURL: 'https://test.hermes' })
  const runtime = new SessionRuntime(gateway, { minimumContract: 6, retryDelays: [0] })
  disposals.push(() => runtime.dispose())
  return { runtime, gateway, conversation: new Conversation(runtime) }
}
it('suspends without losing content or provisional runtime identity and ignores old events', () => {
  const { conversation } = subject()
  conversation.adopt({ ...session, storedSessionId: null })
  $chat.set({ ...$chat.get(), running: true, pendingPrompt: { kind: 'secret', requestId: 'secret', question: 'secret' }, tools: [{ id: 'tool', name: 'tool', detail: '', status: 'running' }] })
  conversation.suspend()
  expect($chat.get()).toMatchObject({ availability: 'cached', runtimeSessionId: 'runtime-a', running: false, pendingPrompt: null, tools: [] })
  expect($chat.get().transcript.entries[0].content).toBe('Readable history')
  conversation.onGatewayEvent({ session_id: 'runtime-a', type: 'message.delta', payload: { delta: 'stale' } })
  expect($chat.get().transcript.entries[0].content).toBe('Readable history')
})
it('preserves the same stored conversation through runtime replacement and failed history', async () => {
  const { conversation, gateway } = subject()
  conversation.adopt(session)
  conversation.suspend()
  conversation.adopt({ ...session, rows: [], runtimeSessionId: 'runtime-replaced' })
  expect($chat.get().transcript.entries[0].content).toBe('Readable history')
  gateway.handle('/api/sessions/a/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => { throw new Error('history down') })
  await expect(conversation.reconcileHistory()).rejects.toThrow('history down')
  expect($chat.get()).toMatchObject({ availability: 'cached', lastSyncedAt: null })
  expect($chat.get().transcript.entries[0].content).toBe('Readable history')
  await expect(conversation.send('never sent')).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' })
  expect(gateway.calls.some(call => call.method === 'prompt.submit')).toBe(false)
})
it('retires overlapping same-runtime history responses', async () => {
  const { conversation, gateway } = subject()
  const releases: Array<(value: unknown) => void> = []
  gateway.handle('/api/sessions/a/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => new Promise(resolve => releases.push(resolve)))
  conversation.adopt(session)
  const old = conversation.reconcileHistory(), latest = conversation.reconcileHistory()
  releases[1]({ messages: [{ ...row, content: 'new authoritative history' }] }); await latest
  releases[0]({ messages: [{ ...row, content: 'stale history' }] }); await old
  expect($chat.get().transcript.entries[0].content).toBe('new authoritative history')
  expect($chat.get().availability).toBe('live')
})
it('waits for a completion-triggered follow-up history fetch during synchronization', async () => {
  const { conversation, gateway } = subject()
  const releases: Array<(value: unknown) => void> = []
  gateway.handle('/api/sessions/a/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => new Promise(resolve => releases.push(resolve)))
  conversation.adopt({ ...session, info: { ...session.info, running: true } })
  let settled = false
  const recovery = conversation.reconcileHistory().then(() => { settled = true })
  conversation.onGatewayEvent({ type: 'message.complete', session_id: 'runtime-a', payload: {} })
  expect(releases).toHaveLength(1)
  releases[0]({ messages: [row] })
  await vi.waitFor(() => expect(releases).toHaveLength(2))
  expect(settled).toBe(false)
  releases[1]({ messages: [{ ...row, content: 'Completed authoritative history' }] })
  await recovery
  expect($chat.get().transcript.entries[0].content).toBe('Completed authoritative history')
  expect($chat.get()).toMatchObject({ availability: 'live', running: false, info: { running: false } })
})

it('publishes local A/B/A with bookmarks and zero transport or refresh calls', () => {
  const { runtime, gateway, conversation } = subject()
  const factory = vi.fn()
  const selection = createSessionSelection({ runtime, conversation, sessionsApi: factory })
  selection.selectCached(snapshot('a')); selection.selectCached(snapshot('b')); selection.selectCached(snapshot('a'))
  expect($chat.get()).toMatchObject({ availability: 'cached', runtimeSessionId: null, storedSessionId: 'a', lastSyncedAt: 1 })
  expect($chat.get().transcript.entries[0].content).toBe('Saved a')
  expect(localStorage.getItem(sessionBookmarkKey()) ?? null).toBeNull() // principal-less bookmarks remain memory-only
  expect(factory).not.toHaveBeenCalled(); expect(gateway.calls).toEqual([])
})
it('cross-profile cached opening preserves workspace and rejects an uncached destination', async () => {
  verifyDraftOwner('https://test.hermes', { org_id: 'test', user_id: 'cache-user' })
  $preferences.set({ ...$preferences.get(), remoteURL: 'https://test.hermes', profile: null })
  $chat.set(emptyChatState())
  transcriptCache.write(snapshot('b', 'work'), snapshot('b', 'work'))
  $connection.set({ ...$connection.get(), phase: 'error', errorKind: 'network', workspaceAvailable: true })
  $networkStatus.set({ status: 'offline' })
  const gateway = new MemoryGateway()
  const controller = new GatewayController({} as never, gateway)
  disposals.push(() => controller.dispose())
  await controller.openProfile('work')
  expect($preferences.get().profile).toBe('work')
  expect($chat.get()).toMatchObject({ availability: 'cached', storedSessionId: 'b', runtimeSessionId: null })
  await expect(controller.openProfile('missing')).rejects.toThrow('saved on this device')
  expect($preferences.get().profile).toBe('work')
  expect($chat.get().storedSessionId).toBe('b')
  expect(gateway.calls.filter(call => call.kind !== 'close')).toEqual([])
})
it('resume-only restoration does not create a replacement for a missing target', async () => {
  const { runtime, gateway } = subject(new MemoryGateway().handle('session.resume', () => { throw Object.assign(new Error('Session not found'), { code: 'SESSION_NOT_FOUND' }) }))
  await expect(runtime.reopen({ profile: null, storedSessionId: 'deleted', missingTargetPolicy: 'resume-only' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  expect(gateway.calls.some(call => call.method === 'session.create')).toBe(false)
})

it('offline typing retires completion results and blocked submit never snapshots or clears a draft', async () => {
  let release!: (value: { items: Array<{ text: string }> }) => void
  const commands = { attach: vi.fn(), send: vi.fn(), retryFrom: vi.fn(), completeSlash: vi.fn(() => new Promise<{ items: Array<{ text: string }> }>(resolve => { release = resolve })) }
  const interaction = new ChatInteraction(commands, { request: vi.fn(), upload: vi.fn() })
  disposals.push(() => interaction.dispose())
  interaction.setSession('a')
  interaction.updateDraft('/pending')
  interaction.setGatewayAvailable(false)
  interaction.updateDraft('  /offline exact\ntext  ')
  release({ items: [{ text: 'old' }] }); await Promise.resolve()
  await interaction.submit()
  expect(interaction.$state.get().draft).toBe('  /offline exact\ntext  ')
  expect(interaction.$state.get().slashItems).toEqual([])
  expect(commands.completeSlash).toHaveBeenCalledOnce()
  expect(commands.send).not.toHaveBeenCalled()
  expect(interaction.record()?.recoveries).toEqual([])
  interaction.setGatewayAvailable(true)
  expect(commands.send).not.toHaveBeenCalled()
})
