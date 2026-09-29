# Implementation Plan: Isolate Known rooms from Group lifecycle

**Status:** Ready to implement. This is a design and implementation plan only; no application source changes have been made in this task.

## Goal

Move the Known rooms read policy out of `client/src/features/groups/group-engine.ts` into a focused `client/src/features/groups/known-rooms.ts` module. This removes the React-hook dependency from the Group send engine module imported by `GatewayController`, while preserving the current room projection, retained roster, content-signature dedupe, synchronous hook view, and public read behavior.

The Group send engine remains responsible for lifecycle and room actions. The Known rooms module remains responsible for the shared read view. Both observe the same `$groupChats` state owned by `group-store.ts`; do not create a second store or duplicate the room data.

## Current evidence

- `client/src/features/groups/group-engine.ts:1–13` describes one public module for lifecycle, room actions, and Known rooms. Lines 15–17 import `useEffect`, `useMemo`, and `useStore` solely for the Known rooms hooks; `atom` and `computed` from `nanostores` are also used only by that policy, while `readonlyType` remains needed for the Group state handles.
- The Group lifecycle is implemented in `group-engine.ts:48–106`. `openGroupRoom` and `createGroupChat` are actions at lines 108–132; the Known rooms policy occupies lines 134–261; the remaining send/stop/prompt actions are at lines 267–285. `GroupChatRoom` is imported only for the projection and can leave `group-engine.ts` when that block moves.
- `client/src/state/gateway-controller.ts:16` imports `startGroupEngine` and `stopGroupEngine` from `group-engine.ts`. It does not use the read policy. Removing React imports from the lifecycle module will make that dependency more local; do not claim a bundle-size or runtime-performance gain, since React is used elsewhere in the application.
- Known rooms currently combines the projection (`groupRoomsView`), the retained roster atom, `$knownRooms`, complete-content signature generation, `publishRosterRooms`, `resetKnownRooms`, and both hooks. The projection is roster rooms ∪ local rooms by durable room key; roster rows win duplicate keys and empty local tombstones are filtered.
- The roster snapshot is module-retained, not owned by a mounted roster screen. `useGroupRooms` publishes complete ordered content, returns that render's merged view synchronously, and deduplicates by content rather than array identity. `useKnownRooms` reads the retained projection without requiring a roster publisher. The projection recomputes when the existing `$groupChats` atom changes.
- Production hook callers are `client/src/app.tsx:22,50`, `client/src/features/agents/roster-screen.tsx:6,62`, `client/src/features/groups/group-screen.tsx:22,81`, and `client/src/features/groups/create-group-chat-dialog.tsx:10,31`. The latter two also import room actions from `group-engine.ts` and will need imports from both modules.
- Direct test setup/publish callers are `client/src/app-navigation.test.tsx:66,73,77,206` and `client/src/features/agents/roster-screen.test.tsx:7,13,25`. In `group-engine.test.ts:764–1314`, `describe('groupRoomsView')` has 2 test declarations and `describe('known rooms')` has 19. The shared setup resets Known rooms alongside Group state.
- The `CONTEXT.md` entries for **Group send engine** and **Known rooms** currently assign the read surface to `group-engine.ts`. There is no `docs/adr/` directory or existing ADR to reconcile.

This is an **in-process** deepening: the behavior is local computation over in-memory Nanostores state. Keep the existing store as the dependency; no adapter, port, new domain term, or ADR is needed.

## Decisions settled with recommended defaults

1. **Use the existing domain concept and a focused module.** Place `known-rooms.ts` beside `group-engine.ts` in `features/groups/`; do not create a new feature folder or new domain name.
2. **Keep the complete read policy together.** The new module owns the roster snapshot, merge/projection, content signature, computed `$knownRooms`, `publishRosterRooms`, `resetKnownRooms`, and both hooks. Do not split React hooks from projection/retention into multiple shallow modules.
3. **Reuse the existing room state.** Import `$groupChats` from `group-store.ts` inside `known-rooms.ts`. Preserve one shared atom and its lifecycle; do not create a read-side copy, factory, adapter, or reset tied to Group engine start/stop.
4. **Do not re-export the read module through `group-engine.ts`.** Update read callers to import directly from `known-rooms.ts`. A re-export would keep the React dependency in the import path used by `GatewayController` and would defeat the goal.
5. **Keep the useful read seam, not the test-only helper export.** Keep `$knownRooms`, `useGroupRooms`, `useKnownRooms`, `publishRosterRooms`, and `resetKnownRooms` as the Known rooms module's exports. Make `groupRoomsView` private and test its observable merge results through the module's read surface instead of importing the helper directly.
6. **Preserve behavior, not implementation structure.** Retain all room ordering, collision, timestamp, nested-content, tombstone, roster precedence, retention, and hook timing semantics. This is an import/locality refactor, not a policy redesign.
7. **Update the domain notes as part of implementation.** Amend the existing Group send engine and Known rooms entries in `CONTEXT.md` to record the split ownership. Add no new term. Do not change the glossary during this planning-only task while the code still has the old ownership.
8. **Do not add unrelated scope.** Leave GatewayController behavior, Group send/turn logic, mirror policy, persistence, wire behavior, and UI markup unchanged. Do not commit unless separately requested.

## Target module shape and dependency direction

The external read surface moves intact except that the pure `groupRoomsView` implementation becomes private. The interface also includes the existing behavioral invariants callers rely on:

- `useGroupRooms(rosterGroups)` publishes the full ordered roster content and returns the current merged view synchronously; array identity alone does not publish.
- `useKnownRooms()` reads the live retained projection without requiring a mounted roster publisher.
- `$knownRooms` is a read-only computed view over the retained roster and the same `$groupChats` atom used by the Group send engine. Keep its order: deduplicated roster rows stay at their first key position with the last duplicate row as the value, then non-colliding local rows follow `$groupChats`'s `Object.entries` order. A roster row wins a shared key. The local store key is authoritative; do not recompute it from `roomId` or `name`. Project local rows to `GroupRoom` fields only, never exposing runtime coordination fields.
- The projection filters local rows only when their log is empty and either `roomId` is falsy or `members` is empty. A local row with a transcript remains visible without a durable id. The projection does not filter roster inputs; the gateway parser already filters empty-log roster rows.
- All `useGroupRooms` callers publish into one module-level roster slot; there is no per-publisher aggregation. A later publication replaces the earlier one, including `[]` clearing the retained roster while another publisher remains mounted. Publishing equal content or another `[]` is a no-op. Unmounting a publisher does not clear its last publication. `resetKnownRooms` clears only the roster half and its signature, not local Group rooms.

Target dependency sketch:

```text
GatewayController ──lifecycle──> group-engine.ts ──> group-store.ts
                                        ├──────────> group-rounds / group-turns / groups-sync

React read callers ──hooks────────> known-rooms.ts ──> group-store.ts
React action callers ──actions────> group-engine.ts

No import or re-export: group-engine.ts ──X──> known-rooms.ts
```

`known-rooms.ts` may import React hooks and `@nanostores/react`; `group-engine.ts` must not. The Group engine mutates `$groupChats`; Known rooms reads that same atom and separately owns only its retained roster snapshot. The UI import path may include both modules when a screen needs actions and read state; the GatewayController lifecycle path must remain independent of the Known rooms module.

## Files in scope

### New

- `client/src/features/groups/known-rooms.ts` — extracted read module.
- `client/src/features/groups/known-rooms.test.ts` — focused projection, retention, signature, and hook tests moved from `group-engine.test.ts`.

### Update

- `client/src/features/groups/group-engine.ts` — remove the Known rooms read policy and React hook imports; retain Group lifecycle, actions, and the existing read-only `$groupChats`, `$groupActivity`, `$groupPrompts`, and `$groupNeedsYou` handles.
- `client/src/features/groups/group-engine.test.ts` — remove the Known rooms test block, roster reset from shared setup, and React test helpers that become unused; retain Group engine lifecycle, read-only-handle, and action coverage.
- `client/src/app.tsx` — import `useKnownRooms` from `known-rooms.ts`.
- `client/src/features/agents/roster-screen.tsx` — import `useGroupRooms` from `known-rooms.ts`.
- `client/src/features/groups/group-screen.tsx` — import `useGroupRooms` from `known-rooms.ts`; keep actions and Group state handles from `group-engine.ts`.
- `client/src/features/groups/create-group-chat-dialog.tsx` — import `useGroupRooms` from `known-rooms.ts`; keep `createGroupChat` and `GROUP_CHAT_MAX_MEMBERS` from `group-engine.ts`.
- `client/src/app-navigation.test.tsx` — import `publishRosterRooms` and `resetKnownRooms` from `known-rooms.ts`.
- `client/src/features/agents/roster-screen.test.tsx` — import `resetKnownRooms` from `known-rooms.ts`.
- `CONTEXT.md` — document Known rooms ownership in its new module and remove the read surface from the Group send engine interface description.

Do not edit `group-screen.test.tsx`, `create-group-chat-dialog.test.tsx`, `roster-screen-local-room.test.tsx`, or `gateway-controller.test.ts`: none imports Known rooms exports directly. Run them because they exercise the affected components and lifecycle through existing imports. Do not edit `gateway-controller.ts`; its lifecycle import remains the same and becomes free of the read module's React dependency.

## Implementation sequence

### Phase 1 — Move read tests to a focused test module

1. Create `known-rooms.test.ts` and move the Known rooms coverage from `group-engine.test.ts`, including its React Testing Library helpers and read-specific setup. Keep behavior assertions, not incidental dependency wiring.
2. Set up the new test module by clearing `localStorage`, replacing the local room store with `{}`, and calling `resetKnownRooms()` before each case. Clean up rendered hooks after each case. Do not reset activity, prompt, lifecycle, or mirror state; none of the moved read-policy cases uses them.
3. Keep the existing local-room creation integration assertion: call the public `createGroupChat` action and assert its result appears in `$knownRooms`. It verifies that the read module observes the Group engine's existing shared store rather than a copied read model.
4. Convert the two tests that directly called `groupRoomsView` to drive the read surface: publish roster content through `publishRosterRooms`, seed local rooms with a small `GroupChatRoom` fixture local to the new test file, and assert exact `$knownRooms` output and order. Cover duplicate-roster position and value, roster-over-local precedence, the local map key winning over mismatched room fields, empty local rows with absent/null/empty-string `roomId`, an empty local row with a truthy id but no members, a valid empty-log room, and a transcript room without a durable id. Do not export the projection helper or import a fixture from `group-engine.test.ts`.
5. Preserve the rest of the current coverage: retention across local clears and hook unmount; content-equal no-ops; every nested log/member field; object property-order equality; timestamp special values (`NaN`, infinities, `-0`); delimiter collision resistance; roster/member/log ordering; reset and empty-publication semantics; reused array identity changes; updates from `$groupChats` without a roster publisher; and hook re-rendering. Strengthen the existing immediate-view test with an assertion during the first render, before passive effects run; a post-render DOM assertion alone does not prove synchronous return. Strengthen the existing two-publisher test to cover distinct hook publications with last-wins behavior and an empty publication clearing the shared roster while the other publisher remains mounted. Do not add per-publisher retained state.
6. Remove the moved Known rooms cases/imports and React test helpers from `group-engine.test.ts`. No rendered React tests remain there, so remove `act`, `cleanup`, `render`, and `screen`, the `createElement` import, and the `cleanup()` call in `afterEach`. Remove the `GroupMember` and `GroupRoom` test type imports; keep lifecycle, read-only-handle, action assertions, `GroupMessage`, and fixtures still used there. Avoid duplicating the same assertions in both files. The test file may temporarily import the not-yet-created `known-rooms.ts`; do not treat that intermediate state as a finished or verified change.

### Phase 2 — Extract the Known rooms implementation

1. Create `known-rooms.ts` and move the existing read implementation without semantic changes: `groupRoomsView`, retained roster atom, `$knownRooms`, timestamp/content signature, publish/reset functions, and both hooks.
2. Import `$groupChats` and `GroupChatRoom` from `group-store.ts`, and `GroupRoom` from `group-model.ts`. Import only the React hooks and Nanostores primitives used by the moved implementation. Do not import `group-engine.ts`; this prevents a cycle and makes the direction explicit. Preserve the exact existing shared `$groupChats` atom.
3. Keep `groupRoomsView` module-private. Export only the read handle, hooks, and roster publish/reset verbs listed above. Preserve its pure implementation and current merge ordering.
4. Remove the Known rooms block from `group-engine.ts`. Remove `useEffect`, `useMemo`, `useStore`, Nanostores imports (`atom`, `computed`), and the `GroupChatRoom` type import made unused by that block; retain `readonlyType` and model/store imports still used by Group actions or the existing public state handles.
5. Update the full `group-engine.ts` header comment to describe lifecycle, room actions, and its remaining read-only engine state handles, without claiming ownership of the Known rooms read policy. Do not import or re-export any symbol from `known-rooms.ts` there.

### Phase 3 — Retarget consumers and test setup

1. Update the four production read callers to import hooks from `known-rooms.ts`. In `group-screen.tsx` and `create-group-chat-dialog.tsx`, keep room actions, constants, and engine state handles imported from `group-engine.ts`; use separate module imports rather than adding a façade. Update the merge-ownership comments in `group-screen.tsx` and `roster-screen.tsx`, which currently say the engine owns the merge, to name `known-rooms.ts`.
2. Update `app-navigation.test.tsx` to import the roster publish/reset verbs from `known-rooms.ts` and preserve the group-room header title assertion.
3. Update `roster-screen.test.tsx` to reset the read module directly in setup/teardown. Keep the actual roster screen tests exercising the `useGroupRooms` call through the screen.
4. Search all `client/src` references to `useGroupRooms`, `useKnownRooms`, `$knownRooms`, `publishRosterRooms`, `resetKnownRooms`, and `groupRoomsView`. Confirm no caller still imports read exports from `group-engine.ts`, no unintended direct helper consumers remain, and no read module is re-exported by the lifecycle module.

### Phase 4 — Update the architecture notes

Update only the Group send engine and Known rooms entries in `CONTEXT.md`:

- **Group send engine:** remove Known rooms hooks/projection/publish/reset from its interface list. Keep `$groupChats`, `$groupActivity`, `$groupPrompts`, and `$groupNeedsYou` as its read-only state handles, along with lifecycle ordering, room actions, feed behavior, and Group member turn ownership. State that the engine and the Known rooms read module share the local room store; do not transfer the store's ownership to the read module.
- **Known rooms:** keep the current domain semantics (gateway roster ∪ local rooms, durable key, roster precedence, content signature, hook behavior, retained roster) and change ownership from `group-engine.ts` to `features/groups/known-rooms.ts`. State that the gateway parser drops empty-log roster rows, while the projection filters a local row only when its log is empty and either its `roomId` is falsy or it has no members; durable local empty-log rooms remain visible. Note that it reads the existing `$groupChats` atom from `group-store.ts`, so the room list remains live without a mounted publisher.
- Add no new domain entry or ADR. Do not rewrite unrelated Group terminology.

### Phase 5 — Verify the seam and behavior

Run focused tests first, then the broader client checks. Do not claim implementation completion unless each command passes and record any real warnings/results in the implementation record.

From `client/`:

```sh
npx vitest run \
  src/features/groups/known-rooms.test.ts \
  src/features/groups/group-engine.test.ts \
  src/features/groups/group-screen.test.tsx \
  src/features/groups/create-group-chat-dialog.test.tsx \
  src/features/agents/roster-screen.test.tsx \
  src/features/agents/roster-screen-local-room.test.tsx \
  src/app-navigation.test.tsx \
  src/state/gateway-controller.test.ts
npm test
npm run build # runs typecheck before Vite build
```

From the repository root:

```sh
rg -n "from ['\"](react|@nanostores/react)|known-rooms" \
  client/src/features/groups/group-engine.ts client/src/state/gateway-controller.ts
rg -n '(useGroupRooms|useKnownRooms|\$knownRooms|publishRosterRooms|resetKnownRooms|groupRoomsView)' client/src
git diff --check
git status --short
```

Review the import search manually: the first command should show no React / React-hook or `known-rooms` dependency in either Group engine or GatewayController; the second should show all read calls importing from `known-rooms.ts` and no stale `group-engine.ts` read exports. Run the existing component tests above to verify the hook-based read flow; no markup or wire behavior changes are planned, so do not add E2E fixture controls solely for this extraction.

## Test ownership and deletion test

The current read-test tail has 21 declared test blocks: 2 in `describe('groupRoomsView')` and 19 in `describe('known rooms')`. The two `fieldChanges` tables each have 17 rows, and the timestamp table has 3, so the suite expands to 55 test executions (53 Known rooms and 2 projection). Move or convert all 21 blocks to `known-rooms.test.ts`; strengthen the existing immediate-view case in place rather than adding a duplicate suite. The engine's lifecycle and send/action tests remain in `group-engine.test.ts`.

The deletion test supports the extraction: removing Known rooms policy would make the app header and three roster-carrying screens each need to combine roster rooms with local rooms, maintain ordering/retention, and avoid identity-based stale updates. Keep the deep read module. The refactor changes its location and callers, not the amount or meaning of room policy.

The external read seam is the test surface: tests should observe `$knownRooms`, the two hooks, and roster publish/reset behavior. `groupRoomsView` stays private. The existing Group store remains the in-process dependency, not a second test-only or production-only adapter.

## Risks and guardrails

- **React remains reachable from the lifecycle module:** do not re-export hooks/read state from `group-engine.ts`; re-exporting `known-rooms.ts` would defeat import locality even if individual imports tree-shake in production.
- **Two room stores drift:** `known-rooms.ts` must import the existing `$groupChats` from `group-store.ts`; never create a duplicate atom or copy that needs synchronization.
- **Roster retention changes accidentally:** keep one roster snapshot and content signature at module level, independent of mounted hooks and Group lifecycle start/stop. Unmounting does not clear the last publication, but a later publisher's `[]` does, even while another publisher remains mounted.
- **Merge behavior changes accidentally:** preserve first-key roster order with the last duplicate value, local append order, roster precedence, and the local store key as the room key. Keep the exact local tombstone predicate (empty log and either falsy `roomId` or no members); non-empty local transcripts still render without a durable id. Roster rows are not filtered in this projection. Keep the timestamp encoding and complete ordered snapshot signature unchanged.
- **Synchronous UI view changes:** `useGroupRooms` must still return the current merged view in the same render, while publishing the retained roster in its effect. Do not change it to effect-delayed UI data; the moved test must check the result during initial render, before effects.
- **Signature misses nested data:** preserve the fields covered by `groupRoomsContentSignature`, its treatment of special numeric timestamps, and array order. Keep the edge-case tests.
- **Interface becomes shallow:** keep the read policy cohesive in one module and do not add a one-method wrapper around the existing computed store. Do not introduce a new adapter for this in-process dependency.
- **Group action imports break:** several screens need both Known rooms reads and Group engine actions. Update each import independently without moving actions into the read module.
- **Test setup becomes coupled:** read tests should reset the retained roster explicitly and seed the local room store deliberately. Do not make production Known rooms state follow test lifecycle or Group engine stop/start.
- **Overclaiming benefit:** the verified benefit is source-level locality and removal of React imports from the Group engine/GatewayController path, not an assumed bundle-size or runtime improvement.
- **Scope creep:** no redesign of the room read interface, group-store, Group mirror, app navigation, room persistence, room domain model, or GatewayController lifecycle.

## Acceptance criteria

- `known-rooms.ts` owns the existing projection, retained roster state, complete content signature, publish/reset verbs, computed read handle, and both hooks.
- `group-engine.ts` no longer imports `react` or `@nanostores/react`, and does not import or re-export `known-rooms.ts`.
- `GatewayController` continues importing and invoking Group lifecycle verbs without acquiring the Known rooms read module through that import path.
- All four UI read callers import from `known-rooms.ts`; screens needing Group actions continue to import those from `group-engine.ts`.
- The same `$groupChats` atom drives the engine and Known rooms projection. No second store, synchronization path, adapter, or lifecycle reset is added.
- Existing observable room merge, exact local filtering and field projection, ordering, retention and empty-publication behavior, dedupe, special timestamps, reset, synchronous-hook, and local-room update behavior remains covered at the Known rooms read interface.
- Known rooms tests live in the focused test file; Group engine lifecycle/action tests remain in the engine test file; no duplicate old read suite remains.
- The Group send engine and Known rooms entries in `CONTEXT.md` and the merge-ownership comments in `group-screen.tsx` and `roster-screen.tsx` accurately describe the ownership split.
- Focused tests, full client tests, and `git diff --check` pass; `npm run build` passes its typecheck step and the Vite build. Record actual results after implementation; this plan itself does not claim those checks have run.
- The change stays limited to the listed Group read extraction and its direct imports, tests, and domain notes; no unrelated files are staged or committed.
