# Plan: keep cross-feature Group UI tests behind the Group send engine

**Repository:** Herm-Bot, Hermes mobile PWA
**Area:** Group send engine test surface
**Selected candidate:** Keep UI fixtures behind the Group send engine
**Status:** Implemented and verified. This file records the agreed implementation; source changes are in the listed files.

## 1. Goal

Stop UI tests outside `client/src/features/groups/` from importing and writing the Group store's raw `$groupChats` atom. Set up each test through the Group send engine's existing room or roster behavior, then assert through the same read surface used by callers.

Keep the production interface and runtime unchanged. Do not add a test reset action, a new adapter, a new store, or a dependency. Keep direct writable-store access in tests that own the Group implementation and need precise internal setup.

This is a test-seam and locality change, not a production deepening project. The Group send engine, Group member turn, and Group mirror already have separate responsibilities and behavior tests. `group-store.ts` owns the local room state, persistence, migrations, and store-level mutation helpers; this pass leaves that ownership unchanged.

## 2. Evidence and scope

The app already consumes the Group send engine's interface:

- `client/src/app.tsx` imports `useKnownRooms` from `features/groups/group-engine.ts` and uses it for the header room title.
- `client/src/features/agents/roster-screen.tsx` imports `useGroupRooms` from the Group send engine to merge gateway rooms with local rooms.
- `client/src/features/groups/create-group-chat-dialog.tsx` creates local rooms through `createGroupChat` and reads the merged room list through `useGroupRooms`.

Two cross-feature UI test files bypass that interface:

- `client/src/app-navigation.test.tsx` imports writable `$groupChats` from `group-store.ts` to clear state and seed the room used by the header test.
- `client/src/features/agents/roster-screen.test.tsx` imports writable `$groupChats` to clear state and seed a newly created local room.

`client/src/features/groups/create-group-chat-dialog.test.tsx` also imports the writable atom. It is a Group-owned setup test that verifies room creation and local persistence. Keep raw state access there for setup, but assert the room through the read-only `$groupChats` handle exported by `group-engine.ts`.

`client/src/features/groups/group-engine.test.ts` already resets Group-owned state through internal store helpers and tests known-room merge behavior. Add coverage there for `createGroupChat` writing a new empty local room that immediately appears through the known-rooms read surface.

The gateway and local paths treat an empty log differently. `groupRoomsFromRoster()` calls `parseGroupSnapshot()`, which drops every gateway room whose log is empty. `groupRoomsView()` keeps a local empty room when it has a durable `roomId` and at least one member; `createGroupChat()` creates exactly that shape. Do not fabricate an empty room in a `profiles.list` fixture.

`client/vitest.config.ts` does not override Vitest isolation; `package-lock.json` pins Vitest 4.1.10, whose default `isolate` is `true`. Each test file gets a separate environment and module graph. This is why the app and shared roster suites can drop their local atom reset once they stop creating local rooms, while the local-room UI case can contain its persisted fixture in a separate file.

No relevant ADRs exist. `CONTEXT.md` already documents the Group send engine interface, its read-only atom handles, and the convention that raw writable atoms remain available to internal modules and setup tests. Sharpen that wording so it distinguishes Group-owned setup from cross-feature UI tests.

## 3. Settled decisions

The user asked to use the recommended answer for every clarification. These defaults settle the design tree for this plan.

| Decision | Selected answer | Reason |
|---|---|---|
| Which tests change? | Remove raw-store access from cross-feature UI tests in `app-navigation.test.tsx` and `roster-screen.test.tsx`. Keep fixture writes in Group-owned implementation tests. | These are the two callers outside the Group feature that currently seed the writable atom directly. |
| How should the app-header test seed a room? | Publish a non-empty `GroupRoom` with the existing `publishRosterRooms` verb, then reset the retained roster with `resetKnownRooms`. | The header reads the retained roster half through `useKnownRooms`; a message keeps the fixture valid for the actual gateway roster parser, and no local room state is written. |
| How should the roster UI test cover a newly-created empty room? | Keep the local-room rendering case in a separate `roster-screen-local-room.test.tsx` file and seed it through `createGroupChat`. Keep the regular roster suite focused on gateway-backed rows. | The gateway parser drops empty-log rooms as tombstones. `createGroupChat` is the real local path, and its durable room is visible to `RosterScreen` through `useGroupRooms`. Vitest's configured default isolates test files, containing the persistent fixture without a reset API. |
| Where should local room creation be verified? | Add an integration test in `group-engine.test.ts` that calls `createGroupChat` and observes the room in `$knownRooms` and the read-only `$groupChats` handle. | The existing Group test setup already resets internal state and can test the local creation-to-projection path without adding a reset interface. |
| What should the dialog test do? | Keep its internal writable atom for setup/reset, but read the created room from `$groupChats` imported from `group-engine.ts`. | Setup remains inside the Group feature; caller-visible reads cross the existing seam. |
| Should the production interface change? | No. Use the current actions, roster publication verbs, and read handles. | A new reset or test-only method would make a low-confidence test concern part of the production interface. |
| Should a new domain term be added? | No. Clarify the existing Group send engine and read-surface wording in `CONTEXT.md`. | The design names no new domain concept. |

No decision remains open. The existing `publishRosterRooms`, `resetKnownRooms`, `createGroupChat`, and read handles cover every fixture; no production verb or export needs to change.

## 4. Intended test shape

```text
Before
  app / roster UI test ───────────────► Group send engine read surface
          │
          └── fixture write / reset ──► writable group-store atom

After
  app UI test ── publishRosterRooms ─► Group send engine ──► retained roster projection
  roster UI test ── profiles.list ───► roster screen (gateway rooms have messages)
  local-room UI test ── createGroupChat ► local store ──────► roster screen
  Group engine test ── createGroupChat ► local store ──────► known-rooms projection

  Group-owned implementation tests keep their internal setup seam.
```

The division makes the test surface match the production call paths. UI tests verify caller-visible behavior. Group engine tests verify local room creation and projection. Group store tests continue to verify persistence and migration details.

## 5. File-by-file changes

### `client/src/app-navigation.test.tsx`

- Remove the import of `$groupChats` from `features/groups/group-store.ts`.
- Import `publishRosterRooms` and `resetKnownRooms` from `features/groups/group-engine.ts`.
- Remove the `$groupChats.set({})` fixture reset. Call `resetKnownRooms()` in `beforeEach`. Replace `afterEach(cleanup)` with `afterEach(() => { cleanup(); resetKnownRooms() })` so cleanup runs before clearing the retained roster half. The app suite does not otherwise mutate local room state, and its isolated jsdom file starts with an empty store, so it needs no local-store reset.
- In the group URL/header test, publish a valid room with key `id:r-crew`, room id `r-crew`, name `Research crew`, one member, and one user log entry such as `{ at: 1_700_000_000_000, from: { kind: 'user', name: 'You' }, text: 'Research notes' }`. `groupRoomsFromRoster()` drops empty-log gateway rooms, so do not use an empty log for this roster-shaped fixture. Keep the publish inside React `act`, as the header subscribes through `useKnownRooms`.
- Keep the existing route, fallback-title, and back-navigation assertions. The test should still prove that the header first shows its fallback title, updates when the retained room appears, and returns to the roster on Back.
- Do not create a local room in this test. The non-empty roster publish exercises the header's retained-roster read path without writing durable local room state.

The app test's mocked roster and Group chat screen do not mutate the local Group store. A source check should confirm no other test in this file depends on clearing `$groupChats`.

### `client/src/features/agents/roster-screen.test.tsx`

- Remove the writable `$groupChats` import and its `$groupChats.set({})` setup.
- Import `resetKnownRooms` from `features/groups/group-engine.ts`; call it in `beforeEach`. Replace `afterEach(cleanup)` with `afterEach(() => { cleanup(); resetKnownRooms() })` so roster publication from a mounted screen cannot leak between tests. It does not reset local rooms. This isolated file starts with an empty store and, after moving the local-room case out, no longer creates or mutates local rooms.
- Remove `lists a newly-created local group before its first message` from this shared suite; its local-room UI assertions move to the isolated test file below.
- Leave the existing gateway group rendering test, profile rendering tests, and query behavior tests otherwise unchanged. The gateway group fixture must retain a non-empty log because `parseGroupSnapshot()` filters empty-log rooms before `RosterScreen` receives them.

### `client/src/features/agents/roster-screen-local-room.test.tsx` (new)

- Import `createGroupChat` and `$groupChats` from `group-engine.ts`. Assert `$groupChats.get()` is empty before setup, then preserve the existing local-room UI scenario by calling `createGroupChat('Research team', [{ name: 'default' }, { name: 'work' }], new Set())`, not by writing an atom.
- In this file, copy the small render wrapper from the existing `renderRoster` helper; it is file-local, so do not import or extract it just for reuse. Create a `QueryClient` with query retries disabled, wrap `RosterScreen` in `QueryClientProvider` and `GatewayProvider`, and pass `vi.fn()` callbacks for `onOpenAgent` and `onOpenGroup`.
- Set `$preferences` to `{ authMode: 'token', profile: null, remoteURL: 'https://gateway.example', theme: 'system' }` and `$connection` to `{ authMode: 'token', error: null, phase: 'connected', status: { auth_required: false, profiles: [{ is_default: true, name: 'default' }, { name: 'work' }] } as unknown as GatewayStatus }`, matching `roster-screen.test.tsx`. Use `MemoryGateway`'s `profiles.list` response `{ profiles: [{ is_default: true, name: 'default' }, { name: 'work' }] }`, with no gateway groups. Assert the local room row appears, its preview says `No messages yet`, and clicking it calls `onOpenGroup` with the returned `room.key`.
- Keep this case in its own test file and explicitly clean up the rendered tree after the test. `createGroupChat()` persists the room and updates module-scoped state; the current Vitest 4.1.10 config leaves `isolate` at its default `true`, so this file gets a separate test environment and module graph. Do not merge this case into the shared roster suite or use `resetKnownRooms()` as a local-room reset.

The shared roster suite continues to test gateway-backed rows. The isolated local-room test exercises the real local create-to-screen path; the Group engine suite separately checks that creation updates the local read handles and known-room projection.

### `client/src/features/groups/group-engine.test.ts`

- Import `createGroupChat` from `group-engine.ts`.
- In the `known rooms` coverage, add a case that calls `createGroupChat('Research team', [{ name: 'default' }, { name: 'work' }], new Set())` with no active roster snapshot.
- Assert that the returned room has a durable `id:` key matching its `roomId`, contains the selected members, and has an empty log.
- Assert through the exported read-only `$groupChats` handle that the room is stored, and through `$knownRooms` that the newly created room is immediately present in the local known-room projection. Describe this as a local-store update, not a roster publish.
- Use the room's returned key in assertions. Do not depend on the time/random-generated room id or add a deterministic id injection seam.
- Rely on the suite's existing `beforeEach` reset and do not replace or trim it: it calls `localStorage.clear()`, `replaceGroupChats({})`, `resetKnownRooms()`, clears the activity/prompt/needs-you atoms, and empties `calls`. `replaceGroupChats({})` persists an empty room map after the clear, so the atom and durable room data are empty. Preserve the existing `afterEach` (`cleanup()`, `stopGroupEngine()`, and `vi.useRealTimers()`) as well. This is a Group implementation test, so its internal fixture reset remains appropriate.

This case verifies the local create-to-projection path. Existing `groupRoomsView` tests continue to cover roster/local key union, inclusion of an empty local room with durable identity and members, and filtering of identity-less empty tombstones.

### `client/src/features/groups/create-group-chat-dialog.test.tsx`

- Import `$groupChats` for reads from `group-engine.ts`.
- Keep a clearly named writable alias such as `$groupChatsState` from `group-store.ts` only for the existing internal setup reset.
- Change the assertion after dialog creation from `$groupChats.get()` on the raw store to the read-only engine export. Keep the `localStorage` persistence assertion; it observes the existing durable behavior.
- Clear `localStorage` and reset the internal atom in setup so the dialog test begins from an empty Group state. Do not create a public reset action for this test.
- Keep the test's current user flow through the dialog: select members, name the room, create, and verify callbacks.

The writable import remains justified as fixture setup inside the Group feature. The test's read assertion should cross the same interface ordinary callers use.

### `CONTEXT.md`

Refine the Group send engine entry to say:

- Cross-feature UI tests set up local rooms through existing Group engine actions or roster publication, and gateway-backed rows through gateway fixtures; they observe behavior through caller-facing read paths rather than raw writable atoms.
- Raw writable atoms remain available for Group implementation modules and Group-owned setup tests.
- Cross-feature raw-store imports bypass this convention; this is not runtime access control.

Keep the current limitations accurate: `readonlyType` changes the TypeScript view only, leaves runtime behavior unchanged, retains `notify()` and `off()`, and does not make values returned by `.get()` deeply immutable. Do not add a new domain term or imply a stronger guarantee.

### `client/src/features/groups/group-engine.ts`

Do not edit this file. Its existing actions, roster verbs, read handles, and module header already support the plan; there is no runtime or export change.

## 6. Implementation order

1. Record `git status --short` and preserve all pre-existing changes, including this plan. Confirm the existing target files have no unexpected edits before touching them, and confirm `roster-screen-local-room.test.tsx` does not already exist before creating it; unrelated worktree changes are not a reason to stop.
2. Change `app-navigation.test.tsx` to publish and reset the retained roster through the Group send engine, using a non-empty roster room.
3. Remove raw-store setup from `roster-screen.test.tsx`, reset only the retained roster there, and move its local empty-room UI case into the new isolated `roster-screen-local-room.test.tsx`, seeded through `createGroupChat`.
4. Add the local-create-to-known-rooms test to `group-engine.test.ts`, using the existing internal reset path and the public read handles for assertions.
5. Change the dialog test to use the public read-only handle for its state assertion while retaining a Group-owned raw atom only for setup/reset; clear `localStorage` in its setup.
6. Update the Group send engine wording in `CONTEXT.md`. Do not edit `group-engine.ts` or change runtime state ownership.
7. Run the targeted tests first. Fix only failures caused by these fixture and test-surface changes. Do not add a public reset operation or alter runtime state ownership to make the tests pass.
8. Run the full client test suite and typecheck. Review source imports and the final diff.

## 7. Verification plan

Run from `client/`:

```bash
npm test -- src/app-navigation.test.tsx src/features/agents/roster-screen.test.tsx src/features/agents/roster-screen-local-room.test.tsx src/features/groups/create-group-chat-dialog.test.tsx src/features/groups/group-engine.test.ts
npm run typecheck
npm test
```

Run from the repository root:

```bash
rg -n "from ['\"].*group-store" client/src --glob '*.test.*'
rg -n 'group-store|\$groupChats(State)?\.set|replaceGroupChats' client/src/app-navigation.test.tsx client/src/features/agents/roster-screen.test.tsx client/src/features/agents/roster-screen-local-room.test.tsx
git diff --check
git status --short
```

The targeted source audit must return no `group-store`, `$groupChats`/`$groupChatsState` setter, or `replaceGroupChats` hits in the three listed cross-feature UI test files. The global import search should return only these seven Group-owned test files: `create-group-chat-dialog.test.tsx`, `group-engine.test.ts`, `group-rounds.test.ts`, `group-store.test.ts`, `group-turns.test.ts`, `groups-mirror.test.ts`, and `groups-sync.test.ts`. The dialog test keeps a writable alias only for setup; Group implementation tests may use internal state for behavior they own. `$groupChats.set()` in `group-engine.test.ts` remains only in the four `@ts-expect-error` compile-time contract assertions, not as an executed fixture write.

The changed production behavior is zero. `tsconfig.json` includes all of `src`, so `npm run typecheck` checks the changed tests as well as production source. Omit `npm run build`: the build script reruns typecheck and bundles production files that this plan does not change. Browser automation is not required for this test-surface-only pass. The targeted jsdom suites must still exercise the header update, the gateway and local room row previews/open actions, and the dialog creation path. If a runtime or visible regression appears, investigate before accepting the plan's no-browser assumption.

## 8. Acceptance criteria

- `app-navigation.test.tsx` no longer imports or writes `$groupChats` from `group-store.ts`; its header fixture crosses `publishRosterRooms` and `useKnownRooms`.
- `roster-screen.test.tsx` no longer imports or writes `$groupChats`; its existing non-empty gateway-room case continues to cover the gateway row, preview, and durable-key open behavior. `roster-screen-local-room.test.tsx` uses `createGroupChat` to cover the empty local preview and open behavior.
- `group-engine.test.ts` proves `createGroupChat` writes a new local room visible through the known-rooms projection and public read handles.
- `create-group-chat-dialog.test.tsx` reads the created room through the Group send engine; its raw writable-store access is limited to Group-owned setup/reset.
- `CONTEXT.md` describes the test convention and preserves the exact limits of the TypeScript-only read surface.
- No production runtime behavior, public export, persistence shape, synchronization policy, room identity, or gateway behavior changes.
- No dependency, adapter, test-only public operation, or new domain term is introduced.
- Typecheck, focused tests, full tests, source audit, and `git diff --check` pass.

## 9. Risks and stop conditions

- **A created local room persists.** `createGroupChat()` writes through `updateGroupChat()`, which updates the module atom and localStorage. Keep the local-room UI test in its own file; the current Vitest configuration uses the default per-file isolation. Do not try to represent this empty local room in `profiles.list`, because the parser drops empty-log gateway rows.
- **Roster publication is retained.** Always call `resetKnownRooms()` around tests that publish a roster. It clears only the roster half; do not mistake it for a local-room reset.
- **The Group test suite retains internal access.** This is intentional. Internal setup is not the same as a caller crossing the seam. Keep raw atom imports in Group-owned tests that need exact internal state.
- **Do not add a reset method to `group-engine.ts`.** The existing test-file isolation contains the one cross-feature UI test that creates a local room. `resetKnownRooms()` clears only roster state and is not a substitute for resetting `$groupChats`.
- **Do not overstate enforcement.** The raw atoms remain importable from `group-store.ts`; TypeScript's read-only type does not prevent deliberate bypasses. The plan establishes a test convention and makes cross-feature tests use the existing interface, not a security guarantee.
- **No ADR conflict.** No Group ADR exists to reopen.
