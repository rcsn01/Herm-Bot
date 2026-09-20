# Plan: Room identity for the Group send engine (key local state by the durable room key)

**Status:** finalized design, ready to implement · **Cluster:** `client/src/features/groups/` (group-model, group-store, group-rounds, group-turns, groups-sync, group-engine, group-screen) + their suites

**Origin:** architecture review 2026-09-20 (candidate 1, strength: Strong), building on the member-key unification (commit e6ba0e9). Every claim below was verified against the working tree immediately before writing this plan.

## 1. Problem (evidence)

1. **The durable seam exists but stops at the mirror.** `groupChatRoomKey` (groups-sync.ts:95–98) keys the wire projection and the known-rooms union: the mirror's outbound snapshot keys rooms by it (groups-sync.ts:234), `mergeGroupChatSyncSnapshots` merges by it, and `GroupRoom.key` rides the route — `openGroupRoom(roomId)` pushes the durable key as the route param (navigation/workspace-navigation.ts:177), `groupIdFromRoute` (:79) hands it to the screen, and the screen finds its row by key (`rooms.find(candidate => candidate.key === roomId)`, group-screen.tsx:82). Then the seam is abandoned: `useGroupEngineState(room?.name ?? roomId)` downgrades to the display name (group-screen.tsx:83).
2. **The engine's local state keys by mutable display name.** The rooms map is keyed by name — `updateGroupChat(group, …)` (group-store.ts:338), `getGroupRoom(group)` (:356), `adoptMirrorRoom` keys `room.name` (:414), `createGroupChat` writes under the name (group-engine.ts:115). So are the runtime feed atoms: `$groupActivity[group]` (recordGroupActivity, group-store.ts:80), `$groupPrompts[`${group}::${memberKey}`]` (group-turns.ts:338, :413, cleanup :1014–1021, `GroupPrompt.group` group-store.ts:101), `$groupNeedsYou[group]` (writers group-store.ts:405 and group-turns.ts:402; cleared group-rounds.ts:346; read group-screen.tsx:40).
3. **The rename path moves the room row and nothing else.** The merge's rename branch (groups-sync.ts:532–546, "A remote rename with a higher revision moves the local record to the new display name") re-keys the room in `$groupChats` but strands `$groupActivity`, `$groupPrompts`, and `$groupNeedsYou` under the old name; the screen reads by the new name, so a room mid-conversation loses its activity line, its pending clarify/approval cards, and its needs-you badge. The move only fires when the local twin resolves — id-keyed rooms via `localByRoomId`; a name-keyed room's remote rename recreates the row from the projection instead (tombstone for the old key), and its atoms strand identically. Nothing else in the engine holds room identity: the map key IS the identity.
4. **A latent wire bug hides behind the name-keyed map.** `groupChatSyncSnapshot` builds the compact room's `name` from the map key (`name: String(name).slice(0, 64)`, groups-sync.ts:219) — correct today only because map key ≡ display name. Any key-shape change that leaves this line breaks the wire shape (the desktop would see `id:r123` as a room name).
5. **The state is persisted by display name.** `localStorage['hermes.group-chats.v2']` (group-store.ts:176) stores the map keyed by display name; the mirror's local indexing does the same (`rooms[projected.name]`, groups-sync.ts:463, rename moves `rooms[localName]` → `rooms[targetName]`, :541–546).

The deep fix is not a sweep bolted onto the rename branch — it is making the durable room key the one identity everywhere, at which point a display-name rename stops being an identity event at all for every room that carries a minted `roomId` (all locally created rooms do; desktop rooms carry theirs on the wire), and the residual name-keyed class keeps today's tombstone-and-recreate rename, re-keying through one explicit sweep only where the wire still carries the old key (§3.4).

## 2. Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Key shape | Keep `groupChatRoomKey`'s format exactly: `id:<roomId>` when the room carries a roomId, `name:<name>` otherwise | Already the mirror's wire identity and `GroupRoom.key`'s format (group-model.ts); byte-stable on the wire, zero desktop coordination |
| Key home | Move the function to group-model.ts as `groupRoomKey`; groups-sync and group-engine import it from there | The store (lowest layer) needs the key and must not import upward from groups-sync; group-model is the pure leaf both already import from — the same placement the member key got |
| Rooms map key | `$groupChats` keys by `groupRoomKey(room.name, room)` in memory and in persisted storage (bump to v3) | The map key is the room's identity; persisting by display name preserves the bug one layer down. `name:`/`id:` prefixes keep the two identity classes distinct |
| Param vocabulary | The `group: string` parameter becomes `roomKey: string` at the store, round-driver, turn-module, and facade seams | An opaque `id:r123` living in a param named "group" is a trap for the next reader; the interface must tell the truth. Mechanical churn, absorbed by the suites |
| Name-keyed rooms | The `name:<name>` class stays (desktop rooms without a roomId). Renaming one re-keys the row and sweeps the feed atoms only when the wire still carries the old key (the envelope key resolves the local twin — §3.4); when the desktop re-keys its own snapshot first (tombstone for the old key plus the room under the new key), the row recreates from the projection as today and the atoms strand as today. Renaming an id-keyed room only updates the `name` field | Minting local roomIds for desktop's name-keyed rooms would fork shared durable identity on the wire (a `name:` twin plus an `id:` orphan in the same envelope) — rejected |
| Runtime atoms | `$groupActivity[roomKey]`, `$groupPrompts[`${roomKey}::${memberKey}`]` (and the `GroupPrompt.group` field renamed to `roomKey`), `$groupNeedsYou[roomKey]` | Runtime-only state, never persisted — no migration, keys are derived fresh from rows each session |
| Screen / route | Zero navigation change. The route already carries the durable key; the screen stops downgrading to `room?.name ?? roomId` and keys the engine by the key directly | `groupIdFromRoute` and `GroupRoom.key` already agree on the format; the downgrade at group-screen.tsx:83 is the only seam crossing that needs flipping |
| Unknown-key stubs | `updateGroupChat`/`getGroupRoom` fallback stubs derive their fields from the key (`name:` → display part; `id:` → `roomId` from the key, name = the raw key), preserving the structural invariant `map key === groupRoomKey(room.name, room)` | Real rooms always exist before a drive (the screen adopts the row first); the stub is defensive, but it must not create a room whose identity disagrees with its own map key |
| Wire | No shape change: the envelope is already durable-keyed. One correction is forced by the re-key: `compact.name` must use `room.name`, not the map key (defect 4 above) | `keysFor` in the merge already accepts `id:`-/`name:`-prefixed labels, so the sync scheduler passing map keys needs no adaptation |

## 3. Design per file

### 3.1 Files table

| File | Change |
|---|---|
| group-model.ts | Gains `groupRoomKey(name, room)` — the one durable room identity, documented beside `groupMemberKey` |
| group-store.ts | Rooms map, `updateGroupChat`/`getGroupRoom`/`adoptMirrorRoom`/`appendGroupChatEntry`/`recordGroupActivity` re-keyed to `roomKey`; the unknown-key stubs derive fields from the key; gains `renameRoomState(previousKey, nextKey)`; storage bumps to `hermes.group-chats.v3` with the v2 copy as rollback; the loader re-keys v2 (and v1) map entries to durable keys |
| groups-sync.ts | `groupChatRoomKey` deleted (imports `groupRoomKey` from group-model); `groupChatSyncSnapshot` keys and names rooms from `room.name`; `mergeRemoteGroupChatSnapshotIntoRooms` indexed by durable keys throughout — an id-keyed room's rename is a field update; a name-keyed rename re-keys via the envelope-key twin and calls `renameRoomState`, or recreates from the projection when the desktop already re-keyed (§3.4) |
| group-rounds.ts | `group: string` → `roomKey: string` across `sendToGroupChat`, `stopGroupThread`, `runGroupChatRounds`, `recordRoomCancellation`, `roomEpochIsCurrent`; everything else is mechanical |
| group-turns.ts | `GroupTurnSpec.group`/`GroupTurnInput.group`/`TurnCapture.group`/`roomOf`/`syncGroupClarify`/prompt keys/`operationKey` re-keyed; `GroupPrompt.group` renamed to `roomKey` (type lives in group-store.ts:97–112) |
| group-engine.ts | Facade verbs take `roomKey`; `createGroupChat` writes under `id:${roomId}` (its returned `GroupRoom.key` is already durable — unchanged); `groupRoomsView` uses the local map key directly (the map key now IS the durable key); `openGroupRoom` harvests by `room.key` |
| group-screen.tsx | `useGroupEngineState(roomId)` — the route param is already the durable key; send/stop/getGroupRoom pass `room.key` |
| CONTEXT.md | Carries the **Room key** entry (already added in the working tree, CONTEXT.md:31 — the term is already named inside Known rooms); it becomes engine-wide load-bearing |

### 3.2 `groupRoomKey` (group-model.ts)

```ts
/** Durable room identity, shared with the mirror's wire projection:
 *  `id:<roomId>` when the room carries one (a display-name rename is then a
 *  field update — the map key, the feed atoms, and the mirror entry never
 *  move), `name:<name>` otherwise. The local store's map key, the runtime
 *  feed atoms, and the sync snapshot all key rooms by it. Computed locally
 *  from the room row; the `name:` class is the escape hatch for desktop
 *  rooms that never carried a roomId. */
export function groupRoomKey(name: string, room: { roomId?: null | string }): string {
  return typeof room?.roomId === 'string' && room.roomId ? `id:${room.roomId}` : `name:${String(name)}`
}
```

Structural invariant, documented here and enforced by the store's write paths: **for every room in `$groupChats`, the map key equals `groupRoomKey(room.name, room)`**. `groupRoomsView`'s union (group-engine.ts:135) may then trust the map key instead of recomputing.

### 3.3 The store re-key (group-store.ts)

- `updateGroupChat(roomKey, mutate, { sync })` and `getGroupRoom(roomKey)` key the map by the durable key. The missing-room stub keeps today's shape and derives its fields from the key: `name:` → `{ name: key.slice(5), … }`; `id:` → `{ name: roomKey, roomId: roomKey.slice(3), … }`. Documented defensive path — the drive always has an adopted room.
- `recordGroupActivity(roomKey, event)`, `appendGroupChatEntry(roomKey, …)` (needs-you write `[roomKey]`), `adoptMirrorRoom(room: GroupRoom)` (keys by `room.key`, guard `all[room.key]`).
- `renameRoomState(previousKey, nextKey)`: moves `$groupActivity[previousKey]` → `[nextKey]` (append when the target already has entries), every `$groupPrompts` key with the `${previousKey}::` prefix → `${nextKey}::`, and `$groupNeedsYou[previousKey]` → `[nextKey]` — never overwriting a non-empty next-side entry.
- Storage: `STORAGE_KEY = 'hermes.group-chats.v3'`; `STORAGE_KEY_V2 = 'hermes.group-chats.v2'` is read only when v3 is absent and left in place as the rollback snapshot (the v1 chain and its constant are unchanged). The v3 loader runs no migration — the copy was written post-re-key, mirroring the v2 discipline. The v2 → v3 read re-keys map entries to durable keys (v2 copies are guaranteed post-member-re-key — the only build that wrote v2 always ran `rekeyRoomCoordination` at load — so no member pass runs); the v1 → v3 read runs the full chain: durable shape guards, member-coordination re-key, then the map re-key. The map re-key is `groupRoomKey(room.name, room)` per entry, guarded: skip the move when the canonical key already holds a room (two v2 rooms colliding on re-key is structurally impossible — roomIds are unique and names are unique per gateway — the guard documents the impossibility rather than inventing resolution policy).
- `durableGroupChatRooms` keeps entries under their map keys unchanged; `persistRooms` persists the durable-keyed map; `scheduleSync` receives map keys (group-store.ts:326), which `keysFor` (groups-sync.ts:309) already resolves.

### 3.4 The merge re-key (groups-sync.ts)

- `groupChatSyncSnapshot`: the compact room's `name` becomes `String(room.name).slice(0, 64)` (groups-sync.ts:219) and the envelope key becomes `groupRoomKey(room.name, room)` — together they fix defect 4; ranking, filtering, and the size-cap loops are unchanged.
- `mergeRemoteGroupChatSnapshotIntoRooms` keeps its algorithm and flips its local indexing from display names to durable keys: `localByRoomId` maps roomId → map key; the local-twin lookups become the envelope key (`rooms[key]` — added: today's fallback never tries it, so a name-keyed rename that rides the old key forks the room today, `'Old'` stranding beside a fresh stub), then `rooms['name:' + projected.name]`; `preserved`/`locallyDeleted` hold keys.
- The rename branch: for an id-keyed room the map key never changes — `room.name` updates to the projected display name in place (the comment at groups-sync.ts:532–534 changes from "moves the local record to the new display name" to "renames the room in place; nothing keyed by identity moves"). A name-keyed room arrives in one of two wire shapes and the branch must not conflate them:
  - The envelope still carries the old key with the new `name` field (rename as a same-key field update): the twin resolves via `rooms[key]`, the row's canonical key `groupRoomKey(displayName, room)` differs from the twin's map key, so the map entry moves `name:old` → `name:new` and `renameRoomState` sweeps the feed atoms.
  - The desktop re-keyed its own snapshot first (tombstone for `name:old` plus the room under `name:new`): no twin resolves, the row recreates from the projection at `name:new` and the tombstone removes `name:old` — exactly today's outcome; the feed atoms strand under `name:old` as today. Never pair a tombstone with a same-pass creation to synthesize a rename — a disband plus an unrelated create in one envelope would mis-sweep the atoms onto the wrong room.
  Tombstone resolution resolves targets through `localByRoomId` / `name:` prefixes as it does today for names.

### 3.5 The drive and the turn module (group-rounds.ts, group-turns.ts)

- Every `group: string` parameter becomes `roomKey: string`: the driver's `sendToGroupChat` (:338), `stopGroupThread` (:390), `runGroupChatRounds` (:231), `recordRoomCancellation`, `roomEpochIsCurrent` (:225); the turn module's `GroupTurnSpec.group` (:94) → `roomKey`, `GroupTurnInput.group` (:51), `TurnCapture.group` (:308), `roomOf` (:135), `syncGroupClarify`, the prompt key `` `${roomKey}::${groupMemberKey(member)}` `` (:338), `operationKey` (:413), and the answer-path cleanup key (`${entry.roomKey}::${entry.memberKey}`, :1014–1021). `publishTurn`'s leading `group` parameter (:716) follows the same swap.
- The turn payload's room label is NOT mechanical: `buildGroupChatTurnPrompt({ groupName: spec.group })` (:829) lands in the model-visible header `[Group chat: "…"]` — it must take the room's display name (`roomOf(spec.roomKey).name`), never the roomKey. The pure-helper pin (`[Group chat: "Launch"]`, group-turns.test.ts:119) keeps asserting the display name.
- The hidden plumbing session title (`Group: ${room.roomId || capture.group}`, :509) is not display-only: it doubles as a `session.resume` target (`for (const target of [known, title])`) and the stranded-harvest fallback (:896) resumes by the same convention. Both expressions keep `room.roomId || room.name` — the display name, never the roomKey — or a name-keyed room forks its plumbing session against the desktop's `Group: <name>` addressing. Id-keyed rooms are unaffected (the roomId short-circuits), and the e2e fixture pins the title shape (`Group: r-crew`, e2e/server.mjs:247).
- Token maps, marker versions, and the prompts atom are runtime-only — no persisted keys to migrate.

### 3.6 Facade and screens (group-engine.ts, group-screen.tsx, navigation)

- Facade: `sendToGroupChat(roomKey, …)`, `stopGroupThread(roomKey, …)`; `openGroupRoom(room)` calls `turns.harvestRoom(room.key, room.members)`; `createGroupChat` writes under `id:${roomId}`; `handleGatewayTransition` iterates map keys as today.
- Screen: `useGroupEngineState(roomId)` (group-screen.tsx:30) narrows `rooms[roomId]`, `activityAll[roomId]`, `promptsAll` filtered by `prompt.roomKey === roomId`, `needsYouAll[roomId]`; `send`/interrupt pass `room.key`; `getGroupRoom(room.key)`; the mount-once guard (`pulledRef`) keys by `room.key` instead of `room.name` so a rename cannot re-trigger the open effect's adopt half. Navigation, the route, and `app.tsx`'s `activeGroup` are untouched — they already key by `GroupRoom.key`.

## 4. Phases

**Phase 1 — the key (group-model.ts).** Add `groupRoomKey` with its doc contract; delete `groupChatRoomKey` from groups-sync.ts and point groups-sync and group-engine at the model import (group-engine's use, `groupRoomsView`, is re-keyed in Phase 2 but keeps recomputing until then). Move groups-sync.test.ts's `room keys` describe (it imports `groupChatRoomKey`; group-model.test.ts now owns it) — the phase is red without it. Add the key describe to group-model.test.ts. Green after this phase (pure addition; the function is behavior-identical to the one it replaces).

**Phase 2 — the store (group-store.ts + group-engine.ts + group-screen.tsx).** Re-key the rooms map and the three feed atoms; add `renameRoomState`; bump storage to v3 with the v2 rollback read and the v1 chain; re-key the facade verbs, `createGroupChat`, `adoptMirrorRoom`, `handleGatewayTransition`, `groupRoomsView` (map-key form), and the screen's `useGroupEngineState`. Three suites outside the cluster break here and update in this phase: create-group-chat-dialog.test.tsx (the created room's `$groupChats` and localStorage assertions move to the `id:` key — the storage file is v3 now), app-navigation.test.tsx (its `$groupChats` seed re-keys to `id:r-crew`: the route carries that key and `groupRoomsView` now trusts map keys), roster-screen.test.tsx (same seed re-key; the `onOpenGroup('id:r-new')` assertion then holds via the map key). The rounds/turns/sync suites stay red until Phase 3 — Phases 2 and 3 land as one commit.

**Phase 3 — the consumers (groups-sync.ts, group-rounds.ts, group-turns.ts).** The merge re-key per §3.4 (including the `compact.name` correction and the `renameRoomState` call), the driver and turn-module param swap, and the `GroupPrompt.roomKey` rename. After this phase the tree is green again.

**Phase 4 — suites and audit.** Update the eleven suites per §5, run the verification battery, run the audit greps.

## 5. Test plan

- **group-model.test.ts** — new `groupRoomKey` describe: an id-carrying room keys `id:<roomId>` whatever its name (the rename-immunity pin); a roomId-less room keys `name:<name>`; distinct roomIds never collide.
- **group-store.test.ts** — v3/v2 constants split; the v2 → v3 migration (a name-keyed room with a roomId re-keys to `id:…`; a roomId-less room stays `name:…`; the v2 copy is untouched as rollback; v3 loads verbatim); the v1 chain still ends in v3; `renameRoomState` moves activity lists, prompt entries (`${old}::mk` → `${new}::mk`), and the needs-you flag, appending when the next side already holds entries; the unknown-key stub derivation (`name:`/`id:` branches) and the map-key invariant; the needs-you write/clear cycle under keys (group-store.ts:405, group-rounds.ts:346).
- **group-rounds.test.ts** — fixtures pass room keys (each suite gains a `ROOM_KEY = 'id:r-test'`-style helper beside its `room()` factory); every behavioral assertion (holds, watermarks, rotation, caps) is unchanged; the needs-you clear assertion keys by the room key.
- **group-turns.test.ts** — same fixture swap; prompt-key assertions become `${ROOM_KEY}::${memberKey}`; alternation/watermark sessions keyed by room key; the prompt header stays display-named (`[Group chat: "Launch"]`, :119, fed from the room row, not the roomKey); everything else untouched.
- **groups-sync.test.ts** — the `room keys` describe moves to group-model.test.ts in Phase 1; the rename test (:293) now asserts the deeper property: an id-keyed room's map key never moves and only `name` changes; new: a name-keyed rename that rides the old envelope key moves the map entry and the feed atoms (via `renameRoomState`), and a tombstone-and-recreate rename recreates the row with the atoms stranding as today; `compact.name` uses `room.name` under a durable-keyed map; merge vectors survive; `keysFor` accepts durable-key labels.
- **groups-mirror.test.ts** — envelope assertions unchanged (already durable-keyed); scheduler-label assertions now pass keys; the roomId-carrying seeds keyed by display name (`'Gone'`, `'Old'`, `'Job'`) re-key to their `id:` keys.
- **group-engine.test.ts** — facade verbs and scheduler arguments re-keyed; the createGroupChat persistence pin lives in create-group-chat-dialog.test.tsx (below), not here; `groupRoomsView` pins the map-key form.
- **group-screen.test.tsx** — `useGroupEngineState` narrows by the route's durable key; prompts filter by `prompt.roomKey`.
- **create-group-chat-dialog.test.tsx** — the created room's map key and persisted-storage assertions (`['Research team']`, :66–67) move to the `id:` key `createGroupChat` now writes; the storage read targets v3.
- **app-navigation.test.tsx · roster-screen.test.tsx** — both seed `$groupChats` under display-name keys while the room carries a `roomId` (`'Research crew'` / `'Research team'`); after Phase 2 `groupRoomsView` trusts map keys, so the seeds re-key to `id:r-crew` / `id:r-new` (the roster's `onOpenGroup('id:r-new')` assertion then holds via the map key).
- Deletion discipline: assertions that only restate the old name-keyed format are updated in place, not layered alongside — the suites keep testing the same interfaces with truthful keys.

## 6. Verification

```bash
cd client
npm test          # vitest run — all suites green
npm run typecheck # tsc -p tsconfig.json --noEmit
npm run test:e2e  # playwright — the group open-and-send flow rides the unchanged route
```

Audit greps (expected outputs):

```bash
rg -n "groupChatRoomKey" client/src          # zero hits — moved and renamed (the groups-sync.test.ts describe moved in Phase 1)
rg -n "groupRoomKey" client/src/features     # definition in group-model.ts only; imports in group-store and groups-sync (+ suites); group-engine's `createGroupChat` writes the literal `id:${roomId}`
rg -n "hermes.group-chats" client/src        # v3 constant + v2 rollback read (group-store.ts) + suite constants
rg -n "prompt.group|GroupPrompt\b.*\bgroup:" client/src/features  # zero — renamed to roomKey
rg -n "useGroupEngineState" client/src/features/groups/group-screen.tsx  # exactly one call site, keyed by the route param
```

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A v2 storage copy with two rooms colliding on the map re-key | Structurally impossible (roomIds unique, names unique per room set); the loader skips the move when the canonical key is already occupied and the guard is documented |
| The `compact.name` correction changes wire output for any room whose map key ≠ display name | That mismatch is exactly the pre-existing latent defect; the mirror suite pins `name: room.name` under a durable-keyed map |
| Eleven suites churn on the key format | The churn is a seed-or-helper change per suite (`ROOM_KEY` beside the `room()` factory; the three suites outside the cluster re-key their seeds); behavioral assertions survive unchanged |
| Name-keyed desktop rooms still strand on rename | Accepted and explicit: that class keeps today's tombstone-and-recreate semantics and its stranded atoms. The sweep fires only where the wire still carries the old key (§3.4); making the class rename-immune would require minting ids the desktop doesn't know — forks shared identity (rejected in §2) |
| An in-flight drive during a rename lands between the map move and the atom sweep | For id-keyed rooms nothing keyed by identity moves — no window exists. A name-keyed recreate changes the map key; drives bail on the epoch/room changes they already detect (`roomEpochIsCurrent`), as today. When the sweep fires it runs inside the same synchronous merge computation as the map move; an aborted read-back can leave the atoms ahead of the store until the next successful pull re-applies the rename — bounded and self-healing |
| $groupPrompts entries keyed by the old key surviving a stop | Out of scope here (review candidate 4/§8): prompts stay consistent through renames after this plan; their stop/disband lifecycle is a separate decision |

## 8. Out of scope

- **Drive-liveness ownership** (review candidate 2), the **round-driver ↔ turn interface** and the publishTurn double watermark write (candidate 3), **publication policy in group-store** (candidate 4), the **mirror's twin shrink loops** (candidate 5), and **useGroupRooms' dual mode** (candidate 6) — separate candidates from the same review.
- **A stop/disband sweep for `$groupPrompts`** — behavior change beyond identity; filed for its own decision.
- **Desktop-side keying** — the desktop's Bot Mode storage lives in a separate codebase, absent from this repo.
- **`GroupPromptCard` resolving members by bare name** (group-screen.tsx GroupPromptCard) despite `prompt.memberKey` — display-level, noted for a follow-up.