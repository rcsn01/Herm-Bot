import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $groupChats, replaceGroupChats, type GroupChatRoom } from './group-store'
import {
  createGroupMirror,
  createGroupMirrorGateway,
  type GroupChatSyncSnapshot,
  type GroupMirror,
  type GroupMirrorGateway,
  type GroupMirrorRemoteState
} from './groups-sync'
import type { GroupMessage } from './group-model'

function userEntry(text: string, at = 1000): GroupMessage {
  return { at, from: { kind: 'user', name: 'You' }, id: `u-${text}`, text, thread: 'legacy' }
}

function room(overrides: Partial<GroupChatRoom> = {}): GroupChatRoom {
  return {
    name: 'Room',
    log: [userEntry('local')],
    members: [{ name: 'research' }],
    watermarks: {},
    epoch: 0,
    running: false,
    ...overrides
  }
}

function emptyState(revision = 0, supportsCas = true): GroupMirrorRemoteState {
  return { snapshot: { version: 3, rooms: {}, deleted: {} }, revision, supportsCas }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const mirrors: GroupMirror[] = []

function makeMirror(gateway: GroupMirrorGateway): GroupMirror {
  const mirror = createGroupMirror(gateway)
  mirrors.push(mirror)
  return mirror
}

beforeEach(() => {
  localStorage.clear()
  replaceGroupChats({})
})

afterEach(() => {
  for (const mirror of mirrors.splice(0)) mirror.stop()
  vi.useRealTimers()
})

describe('Group mirror gateway adapter', () => {
  it('maps a default profile read and forwards the abort signal', async () => {
    const controller = new AbortController()
    const snapshot: GroupChatSyncSnapshot = { version: 3, rooms: {} }
    const calls: Array<{ method: string; params: unknown; signal: AbortSignal | undefined }> = []
    const gateway = createGroupMirrorGateway(async (method, params, options) => {
      calls.push({ method, params, signal: options?.signal })
      return {
        profiles: [{
          name: 'default',
          ui_meta: { 'hermes-bots-groups': snapshot },
          ui_meta_revisions: { 'hermes-bots-groups': 7 }
        }]
      }
    })

    await expect(gateway.read(controller.signal)).resolves.toEqual({
      snapshot,
      revision: 7,
      supportsCas: true
    })
    expect(calls).toEqual([{
      method: 'profiles.list',
      params: { include_sessions: false },
      signal: controller.signal
    }])
  })

  it('keeps usable metadata when revisions are absent or malformed', async () => {
    const snapshot: GroupChatSyncSnapshot = { version: 3, rooms: {} }
    const rows = [
      { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot } },
      { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot }, ui_meta_revisions: null },
      { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot }, ui_meta_revisions: { 'hermes-bots-groups': -1 } },
      { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot }, ui_meta_revisions: { 'hermes-bots-groups': [] } },
      { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot }, ui_meta_revisions: { 'hermes-bots-groups': '8' } }
    ]
    let index = 0
    const gateway = createGroupMirrorGateway(async () => ({ profiles: [rows[index++]] }))

    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({ snapshot, revision: 0, supportsCas: false })
    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({ snapshot, revision: 0, supportsCas: true })
    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({ snapshot, revision: 0, supportsCas: true })
    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({ snapshot, revision: 0, supportsCas: true })
    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({ snapshot, revision: 0, supportsCas: true })
  })

  it('defaults absent profile capability and revisions safely', async () => {
    const snapshot: GroupChatSyncSnapshot = { version: 3, rooms: {} }
    let profiles: unknown[] = []
    const gateway = createGroupMirrorGateway(async () => ({ profiles }))

    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({ snapshot: null, revision: 0, supportsCas: false })
    profiles = [{ name: 'default', ui_meta: { 'hermes-bots-groups': snapshot } }]
    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({ snapshot, revision: 0, supportsCas: false })
  })

  it('rejects malformed profile metadata without losing capability detection', async () => {
    const gateway = createGroupMirrorGateway(async () => ({
      profiles: [{
        name: 'default',
        ui_meta: [],
        ui_meta_revisions: { 'hermes-bots-groups': 4 }
      }]
    }))

    await expect(gateway.read(new AbortController().signal)).resolves.toEqual({
      snapshot: null,
      revision: 4,
      supportsCas: true
    })
  })

  it('maps invalid write revisions to an undefined acknowledgement', async () => {
    const revisions: unknown[] = [-1, '8', Infinity, []]
    let index = 0
    const gateway = createGroupMirrorGateway(async () => ({
      applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': revisions[index++] } }
    }))
    const snapshot: GroupChatSyncSnapshot = { version: 3, rooms: {} }
    const signal = new AbortController().signal

    for (let i = 0; i < revisions.length; i += 1) {
      await expect(gateway.write(snapshot, 7, signal)).resolves.toEqual({ applied: true })
    }
  })

  it('pins non-CAS and CAS write request shapes and response mapping', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown>; signal?: AbortSignal }> = []
    const gateway = createGroupMirrorGateway(async (method, params, options) => {
      calls.push({ method, params: params ?? {}, signal: options?.signal })
      return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': 8 } } }
    })
    const snapshot: GroupChatSyncSnapshot = { version: 3, rooms: {} }
    const signal = new AbortController().signal

    await expect(gateway.write(snapshot, undefined, signal)).resolves.toEqual({ applied: true, revision: 8 })
    await expect(gateway.write(snapshot, 7, signal)).resolves.toEqual({ applied: true, revision: 8 })
    expect(calls).toEqual([
      {
        method: 'profiles.configure',
        params: { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot } },
        signal
      },
      {
        method: 'profiles.configure',
        params: {
          name: 'default',
          ui_meta: { 'hermes-bots-groups': snapshot },
          ui_meta_expected_revisions: { 'hermes-bots-groups': 7 }
        },
        signal
      }
    ])
  })
})

describe('Group mirror lifecycle', () => {
  it('holds a scheduled mutation behind the initial pull barrier', async () => {
    const firstRead = deferred<GroupMirrorRemoteState>()
    const read = vi.fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(emptyState())
      .mockResolvedValueOnce(emptyState(1))
    const write = vi.fn().mockResolvedValue({ applied: true, revision: 1 })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })

    mirror.schedule({ changedRooms: ['Room'] })
    const initialPull = mirror.pull()
    expect(write).not.toHaveBeenCalled()

    firstRead.resolve(emptyState())
    await initialPull
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('returns false without replacing local state when no snapshot exists', async () => {
    const read = vi.fn().mockResolvedValue({ snapshot: null, revision: 0, supportsCas: false })
    replaceGroupChats({ Room: room() })
    const before = $groupChats.get()
    const mirror = makeMirror({ read, write: vi.fn() })

    await expect(mirror.pull()).resolves.toBe(false)
    expect($groupChats.get()).toEqual(before)
  })

  it('does not publish an empty local cache', async () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const mirror = makeMirror({
      read: vi.fn().mockResolvedValue(emptyState()),
      write
    })
    await mirror.pull()

    mirror.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
  })

  it('accepts a non-CAS write without a revision acknowledgement', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue(emptyState(4, false))
    const write = vi.fn().mockResolvedValue({ applied: true })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(write).toHaveBeenCalledWith(expect.anything(), undefined, expect.any(AbortSignal))
  })

  it('retries when the applied revision is wrong', async () => {
    vi.useFakeTimers()
    let writes = 0
    const read = vi.fn().mockResolvedValue(emptyState(1))
    const write = vi.fn().mockImplementation(async () => {
      writes += 1
      return { applied: true, revision: writes === 1 ? 1 : 2 }
    })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(write).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not let a debounce bypass retry backoff', async () => {
    vi.useFakeTimers()
    let writes = 0
    const read = vi.fn().mockResolvedValue(emptyState(0, false))
    const write = vi.fn().mockImplementation(async () => {
      writes += 1
      return writes === 1 ? { applied: false } : { applied: true }
    })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(write).toHaveBeenCalledOnce()
    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(write).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(650)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('settles a failed initial pull before releasing queued work', async () => {
    const firstRead = deferred<GroupMirrorRemoteState>()
    const read = vi.fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue(emptyState())
    const write = vi.fn().mockResolvedValue({ applied: true })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    mirror.schedule({ changedRooms: ['Room'] })
    const pull = mirror.pull()
    expect(write).not.toHaveBeenCalled()

    firstRead.reject(new Error('offline'))
    await expect(pull).rejects.toThrow('offline')
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  })

  it('waits for all concurrent initial pulls before flushing', async () => {
    const firstRead = deferred<GroupMirrorRemoteState>()
    const secondRead = deferred<GroupMirrorRemoteState>()
    const read = vi.fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
      .mockResolvedValue(emptyState(1))
    const write = vi.fn().mockResolvedValue({ applied: true, revision: 1 })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    mirror.schedule({ changedRooms: ['Room'] })
    const firstPull = mirror.pull()
    const secondPull = mirror.pull()
    expect(read).toHaveBeenCalledOnce()

    firstRead.resolve(emptyState())
    await firstPull
    expect(write).not.toHaveBeenCalled()
    secondRead.resolve(emptyState())
    await secondPull
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  })

  it('does not publish a stopped pull and aborts its adapter signal', async () => {
    const pendingRead = deferred<GroupMirrorRemoteState>()
    const read = vi.fn().mockReturnValue(pendingRead.promise)
    const mirror = makeMirror({ read, write: vi.fn() })
    const pull = mirror.pull()
    const signal = read.mock.calls[0][0] as AbortSignal

    mirror.stop()
    expect(signal.aborted).toBe(true)
    pendingRead.resolve({
      snapshot: { version: 3, rooms: { 'name:Remote': { name: 'Remote', revision: 1, log: [userEntry('remote')] } } },
      revision: 1,
      supportsCas: true
    })

    await expect(pull).resolves.toBe(false)
    expect($groupChats.get()).toEqual({})
  })

  it('does not read back or publish after stopping during a write', async () => {
    vi.useFakeTimers()
    const writePending = deferred<{ applied: boolean; revision: number }>()
    const read = vi.fn()
      .mockResolvedValueOnce(emptyState())
      .mockResolvedValueOnce(emptyState())
      .mockResolvedValueOnce(emptyState(1))
    const write = vi.fn().mockReturnValue(writePending.promise)
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(write).toHaveBeenCalledOnce()

    mirror.stop()
    writePending.resolve({ applied: true, revision: 1 })
    await vi.advanceTimersByTimeAsync(0)

    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not publish a read-back result after stopping', async () => {
    vi.useFakeTimers()
    const readBack = deferred<GroupMirrorRemoteState>()
    const read = vi.fn()
      .mockResolvedValueOnce(emptyState(1))
      .mockResolvedValueOnce(emptyState(1))
      .mockReturnValueOnce(readBack.promise)
    const write = vi.fn().mockResolvedValue({ applied: true, revision: 2 })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(read).toHaveBeenCalledTimes(3)

    mirror.stop()
    readBack.resolve({
      snapshot: { version: 3, rooms: { 'name:Remote': { name: 'Remote', revision: 2, log: [userEntry('remote')] } } },
      revision: 2,
      supportsCas: true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect($groupChats.get().Remote).toBeUndefined()
  })

  it('preserves a local mutation that arrives while a write is in flight', async () => {
    vi.useFakeTimers()
    const writePending = deferred<{ applied: boolean; revision: number }>()
    let readCount = 0
    const read = vi.fn().mockImplementation(async () => {
      readCount += 1
      if (readCount <= 2) return emptyState(0)
      if (readCount <= 4) return emptyState(1)
      return emptyState(2)
    })
    const writes: GroupChatSyncSnapshot[] = []
    const write = vi.fn().mockImplementation((snapshot: GroupChatSyncSnapshot) => {
      writes.push(snapshot)
      return writes.length === 1 ? writePending.promise : Promise.resolve({ applied: true, revision: 2 })
    })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    replaceGroupChats({ Room: room(), New: room({ name: 'New', log: [userEntry('new')] }) })
    mirror.schedule({ changedRooms: ['New'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(writes).toHaveLength(1)

    writePending.resolve({ applied: true, revision: 1 })
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].rooms['name:New']).toBeTruthy()
  })

  it('retries a read-back revision race with a fresh read', async () => {
    vi.useFakeTimers()
    let readCount = 0
    const read = vi.fn().mockImplementation(async () => {
      readCount += 1
      if (readCount === 1) return emptyState(3)
      if (readCount === 2) return emptyState(3)
      if (readCount === 3) return emptyState(3)
      if (readCount === 4) return emptyState(4)
      return emptyState(5)
    })
    const write = vi.fn().mockImplementation(async (_snapshot, expectedRevision) => ({
      applied: true,
      revision: (expectedRevision as number) + 1
    }))
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(write).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledTimes(2)
    expect(readCount).toBe(5)
  })

  it('drops a failed job after the bounded retry window and accepts new work', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue(emptyState())
    const write = vi.fn().mockResolvedValue({ applied: false })
    replaceGroupChats({ Room: room() })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(write).toHaveBeenCalledTimes(9)

    mirror.schedule({ changedRooms: ['Room'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(write).toHaveBeenCalledTimes(10)
  })

  it('serializes a pull before a flush so read-back cannot publish stale data', async () => {
    vi.useFakeTimers()
    const oldPullRead = deferred<GroupMirrorRemoteState>()
    let readCount = 0
    const read = vi.fn().mockImplementation(() => {
      readCount += 1
      if (readCount === 1) return Promise.resolve(emptyState())
      if (readCount === 2) return oldPullRead.promise
      if (readCount === 3) return Promise.resolve(emptyState(1))
      return Promise.resolve({
        snapshot: { version: 3, rooms: {}, deleted: { 'id:old': 2 } },
        revision: 2,
        supportsCas: true
      })
    })
    const write = vi.fn().mockResolvedValue({ applied: true, revision: 2 })
    replaceGroupChats({
      Old: room({ name: 'Old', roomId: 'old' }),
      Job: room({ name: 'Job', roomId: 'job' })
    })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    const oldPull = mirror.pull()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    mirror.schedule({ changedRooms: ['Job'] })
    await vi.advanceTimersByTimeAsync(350)
    expect(read).toHaveBeenCalledTimes(2)

    oldPullRead.resolve({
      snapshot: { version: 3, rooms: { 'id:old': { name: 'Old', roomId: 'old', revision: 1, log: [userEntry('old')] } } },
      revision: 1,
      supportsCas: true
    })
    await expect(oldPull).resolves.toBe(true)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
    expect($groupChats.get().Old).toBeUndefined()
  })

  it('queues a pull behind deferred read-back publication', async () => {
    vi.useFakeTimers()
    const readBack = deferred<GroupMirrorRemoteState>()
    let readCount = 0
    const read = vi.fn().mockImplementation(() => {
      readCount += 1
      if (readCount <= 2) return Promise.resolve(emptyState())
      if (readCount === 3) return readBack.promise
      return Promise.resolve({
        snapshot: { version: 3, rooms: {}, deleted: { 'id:old': 2 } },
        revision: 2,
        supportsCas: true
      })
    })
    const write = vi.fn().mockResolvedValue({ applied: true, revision: 1 })
    replaceGroupChats({
      Old: room({ name: 'Old', roomId: 'old' }),
      Job: room({ name: 'Job', roomId: 'job' })
    })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Job'] })
    await vi.advanceTimersByTimeAsync(350)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    const queuedPull = mirror.pull()
    expect(read).toHaveBeenCalledTimes(3)

    readBack.resolve(emptyState(1))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
    await expect(queuedPull).resolves.toBe(true)
    expect($groupChats.get().Old).toBeUndefined()
  })

  it('preserves the active flush markers during read-back', async () => {
    vi.useFakeTimers()
    const flushRead = deferred<GroupMirrorRemoteState>()
    let readCount = 0
    const read = vi.fn().mockImplementation(() => {
      readCount += 1
      if (readCount === 1) return Promise.resolve(emptyState())
      if (readCount === 2) return flushRead.promise
      return Promise.resolve({
        snapshot: {
          version: 3,
          rooms: { 'id:r-1': { name: 'Gone', roomId: 'r-1', revision: 1, log: [userEntry('remote')] } },
          deleted: { 'id:r-1': 1 }
        },
        revision: 1,
        supportsCas: true
      })
    })
    const write = vi.fn().mockResolvedValue({ applied: true, revision: 1 })
    replaceGroupChats({ Gone: room({ name: 'Gone', roomId: 'r-1' }) })
    const mirror = makeMirror({ read, write })
    await mirror.pull()

    mirror.schedule({ changedRooms: ['Gone'] })
    await vi.advanceTimersByTimeAsync(350)
    flushRead.resolve(emptyState())
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    expect($groupChats.get().Gone).toBeTruthy()

    const queuedPull = mirror.pull()
    mirror.stop()
    await expect(queuedPull).resolves.toBe(false)
    expect(write).toHaveBeenCalledOnce()
  })
})
