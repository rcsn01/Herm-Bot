/**
 * The Group send engine's interface for callers outside `features/groups/`.
 * The shared `group-model.ts` leaf has two external carve-outs: `agents-api.ts`
 * uses `groupRoomsFromRoster` and the `GroupRoom` type, and `app.tsx` imports
 * the `GroupRoom` type. This module owns the lifecycle verbs driven by the
 * GatewayController, the room actions, and read-only Group state handles.
 * Which room to open and what to draft stay with the screens (CONTEXT.md:
 * engine plumbing vs call-site policy).
 *
 * Internal seams (group-store, groups-sync, group-rounds, group-turns) remain
 * file-level implementation modules. Writable atoms stay in those modules.
 */

import { readonlyType } from 'nanostores'

import type { EngineMember, GroupEngineRequest, GroupMember, GroupRoom } from './group-model'
import {
  $groupActivity as $groupActivityState,
  $groupChats as $groupChatsState,
  $groupNeedsYou as $groupNeedsYouState,
  $groupPrompts as $groupPromptsState,
  adoptMirrorRoom,
  mintGroupRoomId,
  prepareGroupStateForConnection,
  setGroupSyncScheduler,
  uniqueGroupChatName,
  updateGroupChat,
  type GroupActivityEntry,
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

/** Point the engine at this scope's transport and connection key and arm
 *  fresh per-lifecycle member and mirror modules. The scheduler is installed
 *  before the initial pull so local mutations can queue room markers while
 *  hydration is in flight. */
export function startGroupEngine(transport: GroupEngineRequest, connectionKey: string): void {
  if (activeMirror || activeTurns || activeDriver) stopGroupEngine()

  // Session ids, stranded markers, and prompt cards are wire-targeted at the
  // captured connection. Sweep every mismatched or untagged one before the
  // new modules exist: an immediately opened room must not be able to send a
  // previous connection's stored id or harvest its stranded marker, and the
  // initial pull must not observe the swept state. Same-key state survives a
  // profile-switch restart untouched, and the sweep itself is local — it
  // schedules no mirror write.
  prepareGroupStateForConnection(connectionKey)

  const turns = createGroupTurnModule(createGroupMemberGateway(transport, connectionKey))
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