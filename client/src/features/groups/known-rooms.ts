/** The Known rooms read surface over the retained gateway roster and Group store. */

import { useEffect, useMemo } from 'react'
import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'

import type { GroupRoom } from './group-model'
import { $groupChats, type GroupChatRoom } from './group-store'

// --- Known rooms projection. -------------------------------------------------

/** The known-rooms merge: the gateway roster snapshot ∪ local engine rooms,
 *  unioned by room key (roster rows win a shared key — they are the gateway's
 *  richer copy). Local empty-log rooms without both a truthy roomId and members
 *  are filtered; the create dialog supplies both for a new room. */
function groupRoomsView(rosterGroups: GroupRoom[], localRooms: Record<string, GroupChatRoom>): GroupRoom[] {
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

/** The known-rooms projection: recomputes whenever the retained
 *  roster snapshot or $groupChats changes — roster-carrying screens mounted
 *  or not. Unmounting a publisher does not clear its last publication; a later
 *  publisher may replace it. Read-only: writers are publishRosterRooms and
 *  the group-store room verbs. */
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

/** Publish a roster snapshot into the retained read view. This is the one
 *  writer of the retained roster half, wrapped by `useGroupRooms(rosterGroups)`
 *  and callable without React. Its content signature covers the complete
 *  ordered room snapshot, including messages and members. Content-equal arrays
 *  are no-ops, and array identity never triggers a write. `[]` clears the
 *  roster half, matching a pending roster query's publish. Last publish wins. */
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
