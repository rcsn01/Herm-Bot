# Deepen the Group send engine

Candidate 1 from the architecture review (September 15, 2026). This plan covers only that candidate. The report lives at `/var/folders/th/_8dpnzf515n6h74y89jpky5h0000gn/T/architecture-review-20260915-225230.html`; the design vocabulary (module, interface, implementation, depth, seam, adapter, leverage, locality) comes from the codebase-design skill; domain terms come from `CONTEXT.md`, which this plan extends with the Group entries (already applied — see *Side effects applied*).

## Problem

The group send engine — the only part of the app that autonomously sends turns at a live gateway — has no interface. Its control plane is scattered across eight files and two mutable globals:

- **The GatewayController reaches in through three globals.** `gateway-controller.ts` imports seven group symbols: `setGroupEngineRequest` (`group-engine.ts:21`), `setGroupSyncScheduler` (`group-store.ts:189`), and five sync functions from `groups-sync.ts` (`handleGatewayTransition`, `pullGroupChatState`, `scheduleGroupChatSync`, `startGroupChatSync`, `stopGroupChatSync`). It calls them eleven times across `dispose()` (:339-341), `teardownGatewayScope()` (:377-380), and `installGroupEngine()` (:397-400) — twelve call expressions counting the `scheduleGroupChatSync` inside the scheduler callback (:399). Both setters exist only to break import cycles; neither is a seam, they are global mutable slots.
- **`group-store.ts` is shallow: interface as wide as implementation.** 25 exports (6 limit constants, 3 types, 2 atoms, 14 functions) mix the room record shape, identity minting (`mintGroupThreadId`, `mintGroupRoomId`), name uniqueness, UI copy (`normalizeGroupChatText`; its `GROUP_EMPTY_FRIENDLY` companion is private), member keys, log trimming, localStorage persistence, the mirror-sync scheduler slot, and the two atoms — with no test file. The duplicate-append guard (#93127), `GROUP_LOG_RETAIN` trimming with watermark adjustment, and the durable persistence shape all ship untested.
- **`groups-store.ts` fails the deletion test.** It is a 9-line file holding one atom, `$groups`, written by `group-screen.tsx:50-52` (an effect) and `app.tsx:222` (a synchronous write inside the `openCreatedGroup` handler, not an effect), and read back by `roster-screen.tsx:64-86` and `create-group-chat-dialog.tsx:125-133` as a redundant source beside their own re-merge of the same data. The known-rooms merge (roster snapshot ∪ local rooms by durable key) is duplicated nearly line-for-line in `roster-screen.tsx:66-86` and `group-screen.tsx:34-52`; the empty-room filter exists only in the roster-screen copy (see *Behavior deltas accepted* 2).
- **Engine wiring is global callback registries, untested.** `setGroupEngineRequest` and `setGroupSyncScheduler` are two parallel mutable globals the controller installs and tears down; `group-engine.ts:81` re-exports `$groupNeedsYou` (defined at `group-store.ts:57`) explicitly to dodge an import cycle. `group-store.ts` and `group-engine.ts` have zero tests; the full round (send → rounds → member turns → replies → mirror flush) has no test anywhere.
- **Dead code.** `harvestRoomStranded` (`groups-sync.ts:808`, with its dynamic-import cycle workaround) and `clearGroupNeedsYou` (`group-engine.ts:83`) have no callers.

Deletion-test verdicts: delete `$groups` → complexity vanishes (derived pass-through). Delete the two setters → complexity vanishes (the controller is their only production caller; the three unit suites also seed the transport through `setGroupEngineRequest` — see *Tests*). Delete `group-store` → complexity reappears in N callers (it earns its keep, but its interface must shrink to what callers actually need).

## Goal

One home for the group send engine, inside `features/groups/`, with the interface in `group-engine.ts` — the name the domain already uses ("group send engine", commit 80f0150). After the refactor:

- The GatewayController touches exactly two verbs: `startGroupEngine(transport)` on connect, `stopGroupEngine()` on scope teardown and dispose.
- Screens act through five room actions and read through one hook plus the engine's atoms.
- The known-rooms merge lives in one pure function behind one hook; `$groups` and `groups-store.ts` are deleted.
- The room store, mirror sync, and round drive become internal seams, each testable alone; the injected transport remains the engine's only seam to the wire (two adapters justify it: the real runtime RPC in production, a scripted fake in tests).

A screen reads: `useGroupRooms(rosterGroups)` for the list, `useGroupEngineState(name)`-style atom reads for one room, `sendToGroupChat` / `stopGroupThread` / `answerGroupPrompt` to act. Which room to open and what to draft stay with the screens, exactly as `CONTEXT.md` splits engine plumbing from call-site policy.

## Side effects applied

- `CONTEXT.md` gained four domain terms (this was done before writing the plan, as the grilling side effect): **Group chat**, **Group send engine**, **Group mirror**, **Known rooms**. No existing terms were changed.
- `plan.md` (the September 12 review's candidate plan, landed) was deleted at the user's request before writing this file.

## Decisions (grilling tree, settled)

The user authorized recommended answers for all clarification questions. The tree, walked and settled:

**Q1. Where does the deepened module's interface live?**
Options: (A) a new `group-send-engine.ts` facade beside the existing files; (B) `group-engine.ts` becomes the interface, with the runtime state it hosts today moving to a new internal `group-runtime.ts`; (C) `group-store.ts` becomes the interface.
Recommended: **B**. The file already bears the engine's name and holds the transport slot; a facade importing `groups-sync` + `group-rounds` + `group-turns` + `group-store` becomes acyclic precisely once the transport slot and the activity/prompt atoms leave it. (C) would make a store the engine — the wrong seam. (A) adds a file when the name already exists.
Settled: B.

**Q2. What is the exact external interface?**
Recommended (the full surface, below in *The deepened module*):
- Lifecycle: `startGroupEngine(transport)` / `stopGroupEngine()` — controller-only.
- Actions: `openGroupRoom(room)`, `createGroupChat(baseName, members, takenNames)`, `sendToGroupChat(...)`, `stopGroupThread(...)`, `answerGroupPrompt(...)` (renamed from `answerGroupClarify` — it answers clarify *and* approval prompts; `GroupPrompt` is the existing domain noun).
- Reads: `useGroupRooms(rosterGroups?)` hook owning the known-rooms projection; the pure `groupRoomsView(rosterGroups, localRooms)` beside it; the atoms `$groupChats`, `$groupActivity`, `$groupPrompts`, `$groupNeedsYou` re-exported, plus `getGroupRoom` (group-screen's engineRoom fallback) and `GROUP_CHAT_MAX_MEMBERS` (the dialog's member cap) so screens and the dialog keep the one-import-path rule.
- Types: `GroupEngineTransport` (the existing `GroupEngineRequest` alias renamed at the interface), `GroupChatRoom`, `GroupPrompt`, `GroupActivityEntry`.
The bodies of `sendToGroupChat` / `stopGroupThread` / `answerGroupPrompt` stay in `group-rounds.ts` / `group-turns.ts` and are re-exported by the facade — moving ~1,100 lines of tested-adjacent engine logic buys nothing.
Settled: as listed.

**Q3. What happens to the two mutable globals and the eleven controller calls?**
Recommended: the setters stop being interface. `setEngineTransport` moves to `group-runtime.ts` (file-exported so the facade can reach it, never re-exported); `setGroupSyncScheduler` stays in `group-store.ts` under the same discipline. The controller's `installGroupEngine()` body becomes `startGroupEngine((method, params) => this.runtime.rpc(method, params))`; `dispose()` and `teardownGatewayScope()` each call `stopGroupEngine()`. Eleven calls across three methods (twelve counting the scheduler callback) become two verbs.
Settled: yes.

**Q4. What happens to `$groups` and the duplicated known-rooms merge?**
Options: (a) delete `$groups` and have every consumer derive from the hook; (b) keep an engine-internal `$knownRooms` atom that `useGroupRooms(rosterGroups)` publishes.
Recommended: **(b), with the atom internal (never exported)**. Callers holding roster data (`roster-screen`, `group-screen`, `create-group-chat-dialog`) call `useGroupRooms(rosterGroups)` — the hook runs the one merge and publishes it; provider-free callers (the app header) call `useGroupRooms()` and read the last published view. This preserves the deep-link header behavior — `app-navigation.test.tsx:143-152` exercises exactly this flow (fallback title, then the room name once the published view lands; `RosterScreen` is always mounted, verified: `mobile-shell.tsx` renders the roster unconditionally) — while the merge exists in exactly one place. Pure option (a) would regress the app-header name for a mirror-only room reached by deep link. The two residual deltas (one-frame name lag on create, ghost-row fix on the roster) are recorded in *Behavior deltas accepted*.
Settled: (b).

**Q5. What happens to the dead exports?**
Recommended: delete `harvestRoomStranded` (`groups-sync.ts:808`) and `clearGroupNeedsYou` (`group-engine.ts:83`) — both caller-free; the dynamic `import('./group-turns')` cycle workaround dies with the first.
Settled: delete both.

**Q6. What does `startGroupEngine` / `stopGroupEngine` actually do?**
Recommended — byte-for-byte today's choreography:
- `startGroupEngine(transport)`: install the transport (`setEngineTransport(transport)`), `startGroupChatSync()`, register the scheduler (`setGroupSyncScheduler(changedRoom => scheduleGroupChatSync({ changedRooms: [changedRoom] }))`), and fire the initial pull `void pullGroupChatState().catch(() => undefined)` — the receive half of the sync contract, before any local publish, exactly as the current `installGroupEngine()` comment requires.
- `stopGroupEngine()`: `setEngineTransport(null)`, `setGroupSyncScheduler(null)`, `handleGatewayTransition()` (bump every room's epoch so live loops bail at their next member boundary), `stopGroupChatSync()`.
Consequence accepted: `dispose()` today does *not* call `handleGatewayTransition`; unifying stop adds the epoch bump on dispose. That is a safety improvement (a StrictMode remount's stale drive loop now bails instead of failing RPCs), not a regression — see *Behavior deltas accepted*.
Settled: yes.

**Q7. What is the test surface, and which tests survive?**
Recommended (per the DEEPENING rule — replace, don't layer; the interface is the test surface):
- Survive unchanged (verified): `group-model.test.ts`, `group-screen.test.tsx` (mocks the gateway, not the hooks), `roster-screen.test.tsx` (seeds `$groupChats`; its just-created-room seed carries `roomId` + members, so it passes the new uniform empty-stub filter), `gateway-controller.test.ts` (zero group references).
- Adjusted — the three transport-seeding unit suites re-point the raw setter (verified: `groups-sync.test.ts` import at :4, seeds at :328/:358/:402; `group-rounds.test.ts` import at :15, seeds at :62/:389; `group-turns.test.ts` import at :3, nine seed sites plus a `setGroupEngineRequest(null)` teardown at :41). They import `setEngineTransport` from `./group-runtime` — the file seam, NOT `startGroupEngine`, which would also arm the sync scheduler and fire the initial pull and change what these suites exercise. Only the new engine suite drives the interface.
- Adjusted — atom-seeding swaps: `create-group-chat-dialog.test.tsx` (delete the `$groups.set([])` at line 23; `$groupChats.set({})` already runs at :22) and `app-navigation.test.tsx` (`$groups` seeds at :71 and :151 — see the seed-shape warning in *Tests*).
- New: `group-engine.test.ts` — lifecycle, full-round integration through the injected fake transport, scope-teardown semantics, `groupRoomsView`.
- New: `group-store.test.ts` — duplicate-append guard, trimming, persistence shape, adopt idempotence, needs-you on append.
- Nothing existing is deleted; no test is written past the interface (rounds/turns internals stay reachable through scripted transport behavior, not by poking internals).
Settled: as listed.

**Q8. Naming.**
Recommended: the deepened module is **the Group send engine**; the wire projection is **the Group mirror**; the rendered list is **Known rooms**; the room concept is a **Group chat** / **Group room**. All four now in `CONTEXT.md`. No existing term changed.
Settled: yes.

## The deepened module

### External interface (`group-engine.ts` — the only import path for callers outside `features/groups/`; one verified carve-out: `features/agents/agents-api.ts` consumes `groupRoomsFromRoster` and the `GroupRoom` type from the shared `group-model.ts` leaf, unchanged)

```ts
// Lifecycle — the GatewayController is the only caller.
export function startGroupEngine(transport: GroupEngineTransport): void
export function stopGroupEngine(): void

// Actions — call-site policy (which room, which draft) stays with screens.
export function openGroupRoom(room: GroupRoom): void
  // adoptMirrorRoom + pullGroupChatState + stranded harvest — the body of the
  // group-screen open effect moves here.
export function createGroupChat(
  baseName: string,
  members: GroupMember[],
  takenNames: ReadonlySet<string>
): GroupRoom            // mintGroupRoomId + uniqueGroupChatName + updateGroupChat; throws when no free name
export function sendToGroupChat(group: string, members: EngineMember[], text: string, thread?: null | string): null | string   // re-exported from group-rounds.ts
export function stopGroupThread(group: string, thread: null | string, members?: EngineMember[] | null): Promise<void           // re-exported from group-rounds.ts
export function answerGroupPrompt(entry: GroupPrompt, member: GroupMember, answers: Record<string, string> | string | undefined): Promise<void   // renamed from answerGroupClarify (group-turns.ts), re-exported

// Reads.
export function useGroupRooms(rosterGroups?: GroupRoom[]): GroupRoom[]
  // Runs groupRoomsView(rosterGroups ?? [], $groupChats.get()); when called WITH
  // rosterGroups it publishes the merged view to the internal $knownRooms atom
  // (an effect, replacing today's writers at group-screen.tsx:50-52 and
  // app.tsx:222). Key the merge memo and the publish effect on a CONTENT
  // signature of rosterGroups (the room-key list), never array identity —
  // callers pass freshly built `roster.data?.groups ?? []` arrays (see Risks).
export function groupRoomsView(rosterGroups: GroupRoom[], localRooms: Record<string, GroupChatRoom>): GroupRoom[]   // pure; the one merge
export function getGroupRoom(group: string): GroupChatRoom   // re-exported from group-store; group-screen's engineRoom fallback reads it

// Read surface (re-exported atoms + the one action constant — writers stay inside the engine).
export { $groupChats, $groupNeedsYou, GROUP_CHAT_MAX_MEMBERS } from './group-store'
export { $groupActivity, $groupPrompts } from './group-runtime'

// Types.
export type { GroupEngineTransport, GroupChatRoom, GroupPrompt, GroupActivityEntry }
```

`GroupEngineTransport` is today's `GroupEngineRequest`: `(method: string, params?: Record<string, unknown>) => Promise<unknown>`. One adapter in production (the controller's `runtime.rpc` closure), one in tests (a scripted fake) — a real seam.

### Internal seams (file-exported, never re-exported by the facade)

- `group-store.ts` — rooms only: record shape, minting/identity helpers, name uniqueness, message-normalization copy, trimming, localStorage persistence, `updateGroupChat`/`getGroupRoom`/`replaceGroupChats`/`appendGroupChatEntry`/`adoptMirrorRoom`, `$groupChats`/`$groupNeedsYou`, `setGroupSyncScheduler`. The durable-shape part of persistence is extracted as a pure `durableGroupChatRooms(all)` so tests need no import gymnastics (see Tests).
- `group-runtime.ts` (new) — the engine's runtime state: the transport slot (`setEngineTransport` + `groupEngineRequest`), `$groupActivity` + `recordGroupActivity`, `$groupPrompts`. Moved verbatim out of today's `group-engine.ts`.
- `groups-sync.ts` — the mirror protocol (sizes, keys, v1→v3 normalization, snapshot build/merge, merge-into-rooms) and the flush job (debounced read-merge-CAS-write with read-back, retry ladder). `startGroupChatSync`/`stopGroupChatSync`/`handleGatewayTransition` stay file-exports; only the facade imports them.
- `group-rounds.ts`, `group-turns.ts` — the drive; imports re-pointed from `group-engine` to `group-runtime`; no logic changes.

### Import map (acyclic by construction)

```
group-model.ts      ← nothing                (shared model leaf: types + parseGroupSnapshot/groupRoomsFromRoster)
group-store.ts      → group-model (types)
group-runtime.ts    → group-store            (recordGroupActivity reads the room epoch)
groups-sync.ts      → group-store, group-runtime
group-turns.ts      → group-store, group-runtime
group-rounds.ts     → group-store, group-runtime, group-turns
group-engine.ts     → all of the above       (facade: interface only)
gateway-controller / screens / dialog / app.tsx → group-engine only (GroupRoom types from group-model)
```

Today's cycles are gone structurally: the scheduler slot is registered by the facade (which imports both `group-store` and `groups-sync`), and the transport slot lives beside the atoms that read it.

## Implementation

Ordered so every step typechecks and the suite stays green. `npm run typecheck && npm run test` after each batch.

**Batch 1 — extract `group-runtime.ts` (pure move).**
1. Create `client/src/features/groups/group-runtime.ts` with the transport slot (`GroupEngineRequest` type alias kept here; `setEngineTransport` replacing the exported `setGroupEngineRequest`; `groupEngineRequest` unchanged) and, moved verbatim from `group-engine.ts`: `GroupActivityEntry`, `$groupActivity`, `recordGroupActivity` (with its `getRoomEpoch` read of `$groupChats`), `GroupPrompt`, `$groupPrompts`.
2. Re-point EVERY importer of the moved symbols in this batch — the `setGroupEngineRequest` → `setEngineTransport` rename means the old name no longer exists, so anything still importing it breaks the batch's typecheck guarantee. Source files: `groups-sync.ts` (`groupEngineRequest`), `group-rounds.ts` (`groupEngineRequest`, `recordGroupActivity`), `group-turns.ts` (`$groupPrompts`, `groupEngineRequest`, `recordGroupActivity`, `GroupPrompt`), `gateway-controller.ts` (`setGroupEngineRequest` at :339/:377/:397 → `setEngineTransport`). Test files (verified consumers of the raw setter): `group-turns.test.ts` (import :3; sites :22/:41/:218/:252/:298/:321/:364/:390/:428/:446), `group-rounds.test.ts` (import :15; sites :62/:389), `groups-sync.test.ts` (import :4; sites :328/:358/:402) — import from `./group-runtime` and rename the calls; a null teardown stays a null teardown. `group-store.ts` keeps `$groupNeedsYou` where it is (written by the append path; re-exported by the facade).
3. Delete the moved declarations from `group-engine.ts`. The file keeps only the `$groupNeedsYou` re-export (:81) and `clearGroupNeedsYou` (:83, deleted in Batch 2) so it still typechecks; no re-exports of the moved symbols are needed — every importer was re-pointed in step 2.

**Batch 2 — build the facade in `group-engine.ts`.**
1. Implement `startGroupEngine(transport)` / `stopGroupEngine()` per Q6 (the facade imports `setEngineTransport` from `group-runtime`, `setGroupSyncScheduler` + `updateGroupChat` from `group-store`, and `handleGatewayTransition`/`startGroupChatSync`/`stopGroupChatSync`/`scheduleGroupChatSync`/`pullGroupChatState` from `groups-sync`).
2. Move the known-rooms merge into the facade: `groupRoomsView(rosterGroups, localRooms)` — the roster-first union by `groupChatRoomKey` with the empty-stub filter (`log.length === 0 && (!roomId || members.length === 0)`), then `useGroupRooms(rosterGroups?)` = `useStore($groupChats)` + merge + (when `rosterGroups !== undefined`) an effect publishing the view to the internal `$knownRooms` atom (replacing `group-screen.tsx:50-52` and the `openCreatedGroup` write at `app.tsx:222`). Key both the memo and the effect on a content signature of `rosterGroups`, not identity (see Risks). `groupChatRoomKey` stays owned by `groups-sync.ts`; the facade imports it.
3. Add `openGroupRoom(room)` — the whole body of the `group-screen.tsx:113-124` effect moves here: `adoptMirrorRoom`, `void pullGroupChatState().catch(() => undefined)`, and the stranded-harvest guard + `Promise.all(harvestStrandedGroupReply …)` (the guard moves inside so the screen imports nothing from `group-turns`). And `createGroupChat(baseName, members, takenNames)` (the minting/write of `create-group-chat-dialog.tsx:72-77`, returning `GroupRoom` with `key: 'id:<roomId>'`); widen `uniqueGroupChatName`'s `taken` param to `ReadonlySet<string>` (it only calls `.has`) so the facade can accept a `ReadonlySet`.
4. Re-export the read surface and the round/turn actions per Q2; rename `answerGroupClarify` → `answerGroupPrompt` in `group-turns.ts` (update its test import).
5. Delete `clearGroupNeedsYou` (the setters no longer exist as exports after Batch 1's re-point — nothing to stop re-exporting).

**Batch 3 — re-point consumers; delete the pass-through.**
1. `gateway-controller.ts`: imports collapse to `{ startGroupEngine, stopGroupEngine } from '~/features/groups/group-engine'`; `installGroupEngine()` → `startGroupEngine((method, params) => this.runtime.rpc(method, params))`; `dispose()` and `teardownGatewayScope()` call `stopGroupEngine()`; the five `groups-sync` imports and the two setter imports go — seven imported symbols collapse into the two verbs.
2. `group-screen.tsx`: delete the local `useGroupRooms` hook (:29-54) and the `$groups` effect (:50-52); the screen calls the engine's `useGroupRooms(roster.data?.groups ?? [])` (its roster query stays — route vocabulary with the call site); the open effect (:113-124) shrinks to the `pulledRef` mount-once guard + `openGroupRoom(room)`; imports of `adoptMirrorRoom`/`pullGroupChatState`/`groupChatRoomKey`/`harvestStrandedGroupReply`/`answerGroupClarify` go — `getGroupRoom` stays for the `engineRoom ?? getGroupRoom(room.name)` fallback, now imported from the facade, and `answerGroupPrompt` replaces the renamed import.
3. `roster-screen.tsx`: the hand-rolled merge (:64-86 — three sources: roster, `$groupChats`, `$groups`) becomes `useGroupRooms(roster.data?.groups ?? [])` (two sources; the stale-`$groups` fallback term goes — see delta 6); drop the `groupChatRoomKey` and `$groupChats` imports.
4. `create-group-chat-dialog.tsx`: `useStoreGroupNames` (:125-133) becomes `useGroupRooms(roster.data?.groups ?? [])` → names; the create path (:72-77) calls `createGroupChat(...)`; drop `mintGroupRoomId`/`uniqueGroupChatName`/`updateGroupChat`/`$groups`/`$groupChats` imports; `GROUP_CHAT_MAX_MEMBERS` re-points to the facade re-export.
5. `app.tsx`: `const groups = useGroupRooms()` (replaces `useStore($groups)`); `openCreatedGroup` keeps the dialog closes + `pushRoute` and drops the `$groups.set(...)` write — the room is already in `$groupChats` (the dialog wrote it at create-group-chat-dialog.tsx:76), so the published view picks it up one painted frame later (delta 5).
6. Delete `groups-store.ts`.

**Batch 4 — dead-code sweep + interface shrink inside the cluster.** Delete `harvestRoomStranded` (`groups-sync.ts:808`). Consumer check (verified by grep): `groupThreadOf`, `mintGroupThreadId`, `groupSpeakerLabel` → `group-rounds.ts`; `groupMemberKey` → `group-rounds.ts` + `group-turns.ts`; limits → `group-rounds.ts` (`GROUP_CHAT_HISTORY_LIMIT`, `GROUP_CHAT_MAX_*`) with `GROUP_CHAT_MAX_MEMBERS` re-exported by the facade for the dialog; `mintGroupRoomId`/`uniqueGroupChatName` → the facade's `createGroupChat` only (after Batch 3). `normalizeGroupChatText` and `trimGroupChatLog` have no consumers outside `group-store.ts` — un-export both (the store test exercises trimming through `updateGroupChat` and normalization through `appendGroupChatEntry`). Keep `GROUP_LOG_RETAIN` exported for the store test. Everything kept stays exported from `group-store.ts` for those in-cluster files only.

**Batch 5 — tests** (next section), then full verification.

## Tests

New files under `client/src/features/groups/`. Store tests reset modules + `localStorage.clear()` in `beforeEach` (the store hydrates `$groupChats` at import time).

**`group-store.test.ts`** (new — the store earns tests at its write API):
- Duplicate-append guard #93127: same member text back-to-back within the 10-minute window returns the prior entry and leaves the log unchanged; a user entry is never deduped; the same text after the window is kept; different thread is kept.
- `updateGroupChat` at `GROUP_LOG_RETAIN` (96): log is bounded and every watermark shifts by the drop, staying index-consistent (`trimGroupChatLog` is private after Batch 4; exercised through `updateGroupChat`).
- Persistence: `updateGroupChat` writes the durable shape via `durableGroupChatRooms` (extracted pure helper — `running: false`, `turn: null`, empty-log stubs without identity dropped); `adoptMirrorRoom` is idempotent and seeds watermarks at zero.
- `appendGroupChatEntry` sets `$groupNeedsYou` for member entries addressing `@user` and never for user entries.

**`group-engine.test.ts`** (new — the interface is the test surface):
- Lifecycle: `startGroupEngine(fakeTransport)`; a subsequent `updateGroupChat(...)` (debounce 350 ms, fake timers) reaches the gateway through the injected transport — `profiles.list` read, `profiles.configure` CAS write, read-back. `stopGroupEngine()` clears pending work and the transport; a later `groupEngineRequest` throws `'Group engine transport is not connected.'`.
- Scope teardown: a room with `running: true`, `epoch: 5` → `stopGroupEngine()` → `running: false`, `epoch: 6`.
- Full round, scripted transport (session.create/session.resume/prompt.submit fixtures): `sendToGroupChat(group, members, 'hello @ada')` → the member's reply lands in the log, watermarks advance, activity records queued → working → replied → settled, and the mirror flush fires; a `"(pass)"` reply records `passed` and appends nothing.
- `stopGroupThread`: epoch bump, every member held, `running` false, `session.interrupt` sent with the member's profile in the params.
- `groupRoomsView`: roster ∪ local union keyed by durable key, no duplicate rows for shared keys, empty stubs filtered, just-created rooms (roomId + members, empty log) retained.
- `useGroupRooms`: rendering through `@nanostores/react` — with rosterGroups it publishes `$knownRooms`; without, it reads the last published view (covers the app-header contract).

**Adjusted** (mechanical; the transport-seeding re-points happen in Batch 1):
- `groups-sync.test.ts` — import :4 and seeds :328/:358/:402 → `setEngineTransport` from `./group-runtime` (NOT `startGroupEngine` — that would arm the scheduler and fire the initial pull, changing what the suite exercises).
- `group-rounds.test.ts` — same re-point (import :15, sites :62/:389).
- `group-turns.test.ts` — verified it seeds via the raw setter (import :3; nine seeding sites plus a `setGroupEngineRequest(null)` teardown at :41): same re-point; atom-seeded cases stay.
- `create-group-chat-dialog.test.tsx` — delete the `$groups.set([])` at line 23 (`$groupChats.set({})` already runs at :22); assertions on `onCreated` unchanged.
- `app-navigation.test.tsx` — `$groups` seeds at lines 71 and 151 → seed `$groupChats`. The :151 room must carry `roomId: 'r-crew'` (so `groupChatRoomKey` yields the asserted `id:r-crew`) and a non-empty `members` array — an empty-log room with neither is dropped by the uniform empty-stub filter and the header-name assertion (:152) would fail. The fallback-then-name flow at :148-152 already models the effect-based publish.

**Deleted:** none — the surviving suites describe behaviour that does not change.

## Behavior deltas accepted

1. `dispose()` now bumps room epochs (unified `stopGroupEngine()`). A stale drive loop from a torn-down controller bails at its next boundary instead of failing RPCs; no user-visible change.
2. The known-rooms view applies the empty-stub filter uniformly (today `group-screen`'s copy omits it). Log-empty rooms with neither `roomId` nor members stop rendering in the room list — the create dialog always sets both, so no real room is affected.
3. `answerGroupClarify` is renamed `answerGroupPrompt` at the interface (same behavior, honest name).
4. The app header's room-name lookup reads the engine's published known-rooms view instead of the `$groups` atom — same data, one writer fewer, same freshness (`RosterScreen` is always mounted; verified: `mobile-shell.tsx` renders the roster unconditionally).
5. The header name for a just-created room lags one painted frame behind today: `openCreatedGroup` currently writes `$groups` synchronously (name on first paint); after the change the name arrives when `RosterScreen`'s `useGroupRooms` effect republishes `$knownRooms`. One frame of the `'Group chat'` fallback — the same two-step flow the deep-link test already asserts (`app-navigation.test.tsx:148-152`).
6. `roster-screen` drops its `$groups` fallback term (the third merge source). A room deleted gateway-side and tombstoned locally could ghost-render from a stale `$groups` publish until the next group-screen mount republished; the two-source view removes the ghost. Strictly narrower — it can only drop rooms absent from both live sources.

## Risks

- **Import cycles** — the whole point of the two globals today. Mitigation: the import map above is acyclic; after Batch 2, run `npx madge --circular client/src` (or equivalent) once as a guard.
- **Store hydration in tests** — `$groupChats` hydrates from localStorage at module import; every store-touching test must reset modules and clear storage, or seeds leak across cases.
- **Debounce timing** — the flush job's 350 ms debounce and retry ladder need `vi.useFakeTimers()` in the lifecycle test; advance timers rather than flushing manually.
- **Hook in a `.ts` facade** — `useGroupRooms` needs no JSX; `group-engine.ts` stays `.ts`. No change to the render layer.
- **Publish loop on unstable roster-array identity** — callers pass `roster.data?.groups ?? []`, a fresh array every render while the roster query is pending (and forever on error, since `retry: false`; the dialog's query is `enabled: open`, so its pending window coincides with being mounted). An identity-keyed merge memo + publish effect would emit a new view each render; the `$knownRooms.set` notifies the app header, whose re-render re-renders the publisher, spinning the effect loop until the query resolves. Key both on a content signature (`rosterGroups?.map(room => room.key).join('|') ?? ''`) holding a stable identity for equal signatures.

## Verification

Per batch: `npm run typecheck && npm run test` (vitest). After Batch 5:

1. `npm run typecheck` — clean.
2. `npm run test` — full suite green, including the two new suites.
3. Cycle guard — no `features/groups/*` import cycle (madge or manual check against the map).
4. Manual smoke (needs a gateway with Bot Mode): `npm run dev` against the Hermes gateway; open a group chat, send `hello @<bot>`, watch the round run and the mirror publish (second client sees the reply); stop the thread; switch profile and confirm the room stops and re-arms on return. The desktop should still see the same rooms — the mirror protocol is untouched.

## Out of scope

- The mirror protocol itself (v1→v3 migration, CAS, byte budget) — unchanged, still covered by `groups-sync.test.ts`.
- The round-drive logic (`group-rounds.ts`, `group-turns.ts`) beyond the rename and import re-pointing — pure helpers already tested.
- Workspace navigation (candidate 2), the chat-viewport scroller seam (candidate 3), and the error-banner sweep (candidate 4).
- Desktop Bot Mode parity — the PWA stays protocol-compatible byte-for-byte.