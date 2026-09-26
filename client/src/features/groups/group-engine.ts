/**
 * The Group send engine's interface for callers outside `features/groups/`.
 * The shared `group-model.ts` leaf has two external carve-outs: `agents-api.ts`
 * uses `groupRoomsFromRoster` and the `GroupRoom` type, and `app.tsx` imports
 * the `GroupRoom` type. One home for the group send engine: the lifecycle
 * verbs the GatewayController drives, the five room actions, and the read
 * surface. Which room to open and what to draft stay with the screens
 * (CONTEXT.md: engine plumbing vs call-site policy).
 *
 * Internal seams (group-store, groups-sync, group-rounds, group-turns) are
 * file-exports, never re-exported here except the read surface below. Writable
 * atoms stay in internal Group implementation modules.
 */

import { useEffect, useMemo } from 'react'
import { useStore } from '@nanostores/react'
import { atom, computed, readonlyType } from 'nanostores'

import type { EngineMember, GroupEngineRequest, GroupMember, GroupRoom } from './group-model'
import {
  $groupActivity as $groupActivityState,
  $groupChats as $groupChatsState,
  $groupNeedsYou as $groupNeedsYouState,
  $groupPrompts as $groupPromptsState,
  adoptMirrorRoom,
  mintGroupRoomId,
  setGroupSyncScheduler,
  uniqueGroupChatName,
  updateGroupChat,
  type GroupActivityEntry,
  type GroupChatRoom,
  type GroupPrompt
} from './group-store'
import {
  createGroupMirror,
  createGroupMirrorGateway,
  type GroupMirror
} from './groups-sync'
import { createGroupRoundDriver, type GroupRoundDriver } from './group-rounds'
import { createGroupMemberGateway, createGroupTurnModule, type GroupTurnModule } from './group-turns'

const $groupChats = readonlyType($groupChatsState)
const $groupActivity = readonlyType($groupActivityState)
const $groupPrompts = readonlyType($groupPromptsState)
const $groupNeedsYou = readonlyType($groupNeedsYouState)

// --- Lifecycle — the GatewayController is the only caller. -------------------

let activeMirror: GroupMirror | null = null
let activeTurns: GroupTurnModule | null = null
let activeDriver: GroupRoundDriver | null = null

/** A gateway swap invalidates any in-flight room drive: bump every room's
 *  epoch so running loops bail at their next member boundary. */
function handleGatewayTransition(): void {
  const rooms = { ...$groupChats.get() }
  for (const name of Object.keys(rooms)) {
    rooms[name] = { ...rooms[name], epoch: (rooms[name].epoch || 0) + 1, running: false }
  }
  $groupChatsState.set(rooms)
}

/** Point the engine at this scope's transport and arm fresh per-lifecycle
 *  member and mirror modules. The scheduler is installed before the initial
 *  pull so local mutations can queue room markers while hydration is in flight. */
export function startGroupEngine(transport: GroupEngineRequest): void {
  if (activeMirror || activeTurns || activeDriver) stopGroupEngine()

  const turns = createGroupTurnModule(createGroupMemberGateway(transport))
  const driver = createGroupRoundDriver(turns)
  const mirror = createGroupMirror(createGroupMirrorGateway(transport))

  activeTurns = turns
  activeDriver = driver
  activeMirror = mirror
  setGroupSyncScheduler(changedRoom => mirror.schedule({ changedRooms: [changedRoom] }))
  void mirror.pull().catch(() => undefined)
}

/** Detach and stop the current lifecycle, bump every room's epoch so live
 *  drives bail at their next member boundary, and stop the active mirror.
 *  Scope teardown and dispose share this choreography. */
export function stopGroupEngine(): void {
  const mirror = activeMirror
  const turns = activeTurns
  const driver = activeDriver
  activeMirror = null
  activeTurns = null
  activeDriver = null
  driver?.deactivate()
  turns?.stop()
  setGroupSyncScheduler(null)
  mirror?.stop()
  handleGatewayTransition()
}

// --- Actions — call-site policy (which room, which draft) stays with screens.

/** Adopt a mirror row locally, pull the live projection, and harvest replies
 *  stranded by timed-out turns — the body of the group-screen open effect.
 *  The screen keeps only its mount-once guard. */
export function openGroupRoom(room: GroupRoom): void {
  adoptMirrorRoom(room)
  const mirror = activeMirror
  const turns = activeTurns
  if (mirror) void mirror.pull().catch(() => undefined)
  if (turns) void turns.harvestRoom(room.key, room.members).catch(() => undefined)
}

/** Mint a durable room identity, keep the display name unique, write the room,
 *  and return it — the create dialog's write path. Throws when no free name. */
export function createGroupChat(
  baseName: string,
  members: GroupMember[],
  takenNames: ReadonlySet<string>
): GroupRoom {
  const name = uniqueGroupChatName(baseName, takenNames)
  const roomId = mintGroupRoomId()
  updateGroupChat(`id:${roomId}`, room => ({ ...room, members, name, roomId }))
  return { key: `id:${roomId}`, log: [], members, name, roomId }
}

// --- Known rooms — the engine's read projection. ----------------------------

/** The known-rooms merge: the gateway roster snapshot ∪ local engine rooms,
 *  unioned by durable room key (roster rows win a shared key — they are the
 *  gateway's richer copy); empty runtime tombstones (no transcript, no
 *  durable identity) never render — the create dialog always sets roomId and
 *  members, so a just-created room is retained. The one merge, behind one
 *  pure function. */
export function groupRoomsView(rosterGroups: GroupRoom[], localRooms: Record<string, GroupChatRoom>): GroupRoom[] {
  const merged = new Map(rosterGroups.map(room => [room.key, room]))
  for (const [key, room] of Object.entries(localRooms)) {
    // Empty runtime tombstones (no transcript, no durable identity) never
    // render — the create dialog always sets roomId and members, so a
    // just-created room is retained.
    if (room.log.length === 0 && (!room.roomId || room.members.length === 0)) continue
    // The map key now IS the durable room key; trust it instead of recomputing.
    if (merged.has(key)) continue
    merged.set(key, {
      key,
      ...(room.image ? { image: room.image } : {}),
      log: room.log,
      members: room.members,
      name: room.name,
      ...(room.roomId ? { roomId: room.roomId } : {})
    })
  }
  return [...merged.values()]
}

/** The retained roster snapshot: the last roster half any roster-carrying
 *  caller published. Internal — writers are publishRosterRooms only. */
const $rosterRooms = atom<GroupRoom[]>([])

/** The engine's known-rooms projection: recomputes whenever the retained
 *  roster snapshot or $groupChats changes — roster-carrying screens mounted
 *  or not. Retention: always holds the last-known view; the roster snapshot
 *  outlives every roster screen. Read-only: the writers are
 *  publishRosterRooms and the group-store room verbs. */
export const $knownRooms = computed([$rosterRooms, $groupChats], groupRoomsView)

function groupRoomsContentSignature(rooms: readonly GroupRoom[]): string {
  const timestamp = (at: number): (string | number)[] => {
    if (Number.isNaN(at)) return ['nan']
    if (at === Number.POSITIVE_INFINITY) return ['+infinity']
    if (at === Number.NEGATIVE_INFINITY) return ['-infinity']
    if (Object.is(at, -0)) return ['-zero']
    return ['finite', at]
  }

  return JSON.stringify(rooms.map(room => [
    room.key,
    room.image ?? null,
    room.log.map(entry => [
      timestamp(entry.at),
      entry.from.kind,
      entry.from.name,
      entry.from.source ?? null,
      entry.id ?? null,
      entry.text,
      entry.thread ?? null
    ]),
    room.members.map(member => [
      member.name,
      member.handle ?? null,
      member.connectionId ?? null,
      member.connectionKind ?? null,
      member.connectionLabel ?? null,
      member.sourceScoped ?? null
    ]),
    room.name,
    room.roomId ?? null
  ]))
}

let rosterSignature = groupRoomsContentSignature([])

/** Publish a roster snapshot into the engine — the one writer of the
 *  retained roster half, wrapped by `useGroupRooms(rosterRooms)` and callable
 *  without React (tests; a future push-sync roster source). Its content
 *  signature covers the complete ordered room snapshot, including messages
 *  and members. Content-equal arrays are no-ops, and array identity never
 *  triggers a write. `[]` clears the roster half, matching a pending roster
 *  query's publish. Last publish wins. */
export function publishRosterRooms(rosterRooms: readonly GroupRoom[]): void {
  const signature = groupRoomsContentSignature(rosterRooms)
  if (signature === rosterSignature) return
  rosterSignature = signature
  $rosterRooms.set([...rosterRooms])
}

/** Clear the retained roster half. The one beforeEach verb for the
 *  projection's own state; the local half resets through
 *  `replaceGroupChats({})` — the store owns rooms. */
export function resetKnownRooms(): void {
  rosterSignature = groupRoomsContentSignature([])
  $rosterRooms.set([])
}

/** The known rooms for roster-free callers (the app header): one
 *  subscription to the live projection, no roster data required. Recomputes
 *  whenever $groupChats or the retained roster contribution changes, whether
 *  or not any roster-carrying screen is mounted. */
export function useKnownRooms(): GroupRoom[] {
  return useStore($knownRooms)
}

/** The known rooms for roster-carrying callers. Pass the freshly built
 *  `roster.data?.groups ?? []`: the hook publishes it through
 *  publishRosterRooms using the complete ordered room snapshot, never array
 *  identity, and returns that render's merged view synchronously without an
 *  effect round-trip. Two callers holding equal content publish the same
 *  signature; the second write is a no-op (last publish wins). */
export function useGroupRooms(rosterGroups: GroupRoom[]): GroupRoom[] {
  const localRooms = useStore($groupChats)
  const signature = groupRoomsContentSignature(rosterGroups)
  // Keep one shallow snapshot per content signature. A changed signature
  // creates a new array even when the caller reused its input array.
  const stableRoster = useMemo(() => [...rosterGroups], [signature])
  const rooms = useMemo(
    () => groupRoomsView(stableRoster, localRooms),
    [stableRoster, localRooms]
  )
  useEffect(() => {
    // publishRosterRooms dedupes content-equal snapshots internally.
    publishRosterRooms(stableRoster)
  }, [stableRoster])
  return rooms
}

// --- Read surface (typed exports; writable atoms stay in Group modules). ------

export { $groupChats, $groupActivity, $groupPrompts, $groupNeedsYou }
export { GROUP_CHAT_MAX_MEMBERS, getGroupRoom } from './group-store'
// --- Actions — thin wrappers over the active captured lifecycle. ------------

export function sendToGroupChat(roomKey: string, members: EngineMember[], text: string, thread?: null | string): null | string {
  return activeDriver ? activeDriver.sendToGroupChat(roomKey, members, text, thread) : null
}

export async function stopGroupThread(roomKey: string, thread: null | string, members: EngineMember[] | null = null): Promise<void> {
  if (!activeDriver) return
  await activeDriver.stopGroupThread(roomKey, thread, members)
}

export async function answerGroupPrompt(
  entry: GroupPrompt,
  member: GroupMember,
  answers: Record<string, string> | string | undefined
): Promise<void> {
  if (!activeTurns) return
  await activeTurns.answer(entry, member, answers)
}

// --- Types. ------------------------------------------------------------------

export type { GroupEngineRequest as GroupEngineTransport } from './group-model'
export type { GroupActivityEntry, GroupPrompt } from './group-store'
export type { GroupChatRoom } from './group-store'