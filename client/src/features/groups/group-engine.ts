/**
 * The Group send engine's interface — the only import path for callers
 * outside `features/groups/` (one carve-out: features/agents/agents-api.ts
 * consumes groupRoomsFromRoster and the GroupRoom type from the shared
 * group-model.ts leaf). One home for the group send engine: the lifecycle
 * verbs the GatewayController drives, the five room actions, and the read
 * surface. Which room to open and what to draft stay with the screens
 * (CONTEXT.md: engine plumbing vs call-site policy).
 *
 * Internal seams (group-store, group-runtime, groups-sync, group-rounds,
 * group-turns) are file-exports, never re-exported here except the read
 * surface below — writers stay inside the engine.
 */

import { useEffect, useMemo } from 'react'
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

import type { GroupMember, GroupRoom } from './group-model'
import {
  $groupChats,
  adoptMirrorRoom,
  getGroupRoom,
  mintGroupRoomId,
  setGroupSyncScheduler,
  uniqueGroupChatName,
  updateGroupChat,
  type GroupChatRoom
} from './group-store'
import {
  $groupActivity,
  $groupPrompts,
  setEngineTransport,
  type GroupActivityEntry,
  type GroupEngineRequest,
  type GroupPrompt
} from './group-runtime'
import {
  createGroupMirror,
  createGroupMirrorGateway,
  groupChatRoomKey,
  type GroupMirror
} from './groups-sync'
import { harvestStrandedGroupReply } from './group-turns'

// --- Lifecycle — the GatewayController is the only caller. -------------------

let activeMirror: GroupMirror | null = null

/** A gateway swap invalidates any in-flight room drive: bump every room's
 *  epoch so running loops bail at their next member boundary. */
function handleGatewayTransition(): void {
  const rooms = { ...$groupChats.get() }
  for (const name of Object.keys(rooms)) {
    rooms[name] = { ...rooms[name], epoch: (rooms[name].epoch || 0) + 1, running: false }
  }
  $groupChats.set(rooms)
}

/** Point the engine at this scope's transport and arm a fresh mirror writer.
 *  The scheduler is installed before the initial pull so local mutations can
 *  queue room markers while hydration is still in flight. */
export function startGroupEngine(transport: GroupEngineRequest): void {
  if (activeMirror) stopGroupEngine()

  setEngineTransport(transport)
  const mirror = createGroupMirror(createGroupMirrorGateway(transport))
  activeMirror = mirror
  setGroupSyncScheduler(changedRoom => mirror.schedule({ changedRooms: [changedRoom] }))
  void mirror.pull().catch(() => undefined)
}

/** Clear the transport and scheduler, bump every room's epoch so live drive
 *  loops bail at their next member boundary, and stop the active mirror.
 *  Scope teardown and dispose share this choreography. */
export function stopGroupEngine(): void {
  const mirror = activeMirror
  activeMirror = null
  setGroupSyncScheduler(null)
  mirror?.stop()
  setEngineTransport(null)
  handleGatewayTransition()
}

// --- Actions — call-site policy (which room, which draft) stays with screens.

/** Adopt a mirror row locally, pull the live projection, and harvest replies
 *  stranded by timed-out turns — the body of the group-screen open effect.
 *  The screen keeps only its mount-once guard. */
export function openGroupRoom(room: GroupRoom): void {
  adoptMirrorRoom(room)
  const mirror = activeMirror
  if (mirror) void mirror.pull().catch(() => undefined)
  const local = getGroupRoom(room.name)
  if (local.stranded && Object.keys(local.stranded).length > 0) {
    void Promise.all(room.members.map(member => harvestStrandedGroupReply(room.name, member))).catch(
      () => undefined
    )
  }
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
  updateGroupChat(name, room => ({ ...room, members, name, roomId }))
  return { key: `id:${roomId}`, log: [], members, name, roomId }
}

// --- Reads. ------------------------------------------------------------------

const $knownRooms = atom<GroupRoom[]>([])
const EMPTY_ROOMS: GroupRoom[] = []

/** The known-rooms projection: the gateway roster snapshot ∪ local engine
 *  rooms, unioned by durable room key (roster rows win a shared key — they
 *  are the gateway's richer copy); empty runtime tombstones are filtered.
 *  The one merge, behind one pure function. */
export function groupRoomsView(rosterGroups: GroupRoom[], localRooms: Record<string, GroupChatRoom>): GroupRoom[] {
  const merged = new Map(rosterGroups.map(room => [room.key, room]))
  for (const room of Object.values(localRooms)) {
    // Empty runtime tombstones (no transcript, no durable identity) never
    // render — the create dialog always sets roomId and members, so a
    // just-created room is retained.
    if (room.log.length === 0 && (!room.roomId || room.members.length === 0)) continue
    const key = groupChatRoomKey(room.name, room)
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

/** The known rooms. Callers holding roster data pass it and the hook runs the
 *  one merge, publishing the view to the engine-internal $knownRooms atom
 *  (provider-free callers — the app header — call without arguments and read
 *  the last published view). Callers pass freshly built
 *  `roster.data?.groups ?? []` arrays whose identity changes every render
 *  while the query is pending: the stable roster copy is keyed on a content
 *  signature (the room-key list), never array identity, or the publish
 *  effect below loops. */
export function useGroupRooms(rosterGroups?: GroupRoom[]): GroupRoom[] {
  const localRooms = useStore($groupChats)
  const rosterKeys = (rosterGroups ?? EMPTY_ROOMS).map(room => room.key).join('|')
  // Content signature, not identity: the memo closure holds the roster array
  // from the render where the signature last changed — content-equal arrays
  // produce the identical view.
  const stableRoster = useMemo(() => rosterGroups ?? EMPTY_ROOMS, [rosterKeys])
  const rooms = useMemo(
    () => groupRoomsView(stableRoster, localRooms),
    [stableRoster, localRooms]
  )
  useEffect(() => {
    // rooms is exactly the derived value being published; identity-stable.
    if (rosterGroups !== undefined) $knownRooms.set(rooms)
  }, [rooms])
  const knownRooms = useStore($knownRooms)
  return rosterGroups !== undefined ? rooms : knownRooms
}

// --- Read surface (re-exported; writers stay inside the engine). -------------

export { $groupChats, $groupNeedsYou, GROUP_CHAT_MAX_MEMBERS, getGroupRoom } from './group-store'
export { $groupActivity, $groupPrompts } from './group-runtime'

// --- Actions re-exported from the drive (bodies stay in group-rounds/turns). -

export { sendToGroupChat, stopGroupThread } from './group-rounds'
export { answerGroupPrompt } from './group-turns'

// --- Types. ------------------------------------------------------------------

export type { GroupEngineRequest as GroupEngineTransport, GroupActivityEntry, GroupPrompt } from './group-runtime'
export type { GroupChatRoom } from './group-store'