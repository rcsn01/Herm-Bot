# Plan: make the Group send engine's exported state read-only

**Repository:** Herm-Bot, Hermes mobile PWA
**Area:** `client/src/features/groups/`
**Selected candidate:** Candidate 01 from the architecture review, "Make the Group send engine's read surface read-only."
**Status:** Implemented. Client typecheck, the focused Group tests, the full Vitest suite, and production build pass.

## 1. Goal

Narrow the Group send engine's TypeScript interface so consumers can observe its room and feed state but cannot call `.set()` on the four exported Nanostores:

- `$groupChats`
- `$groupActivity`
- `$groupPrompts`
- `$groupNeedsYou`

Keep the existing store objects, values, update behavior, and export names. Use Nanostores' `readonlyType` helper at the existing seam in `group-engine.ts`. Keep writable atom imports in the Group implementation and setup tests by convention; `group-store.ts` will continue to export the raw atoms, so TypeScript does not enforce that import boundary.

The guarantee is narrow: callers importing these four handles from `group-engine.ts` will not see `.set()` in their TypeScript types. `readonlyType` is an identity function at runtime, and a direct import from `group-store.ts`, JavaScript, or a type cast can still reach `.set()`. The `ReadableAtom` type also retains Nanostores' `notify()` and `off()` methods, and `.get()` still returns mutable values. This is not runtime enforcement, deep immutability, or a security control. No current production consumer writes through the engine exports or imports raw atoms outside the Group implementation. If a stronger boundary becomes a requirement, reopen the design rather than claiming this plan provides it.

## 2. Why this change is limited

The Group send engine is the documented interface for group-chat behavior. Its file header presents `group-engine.ts` as the import path for callers outside `features/groups/` and lists `agents-api.ts` as the one carve-out. The source also imports the `GroupRoom` type directly from `group-model.ts` in `app.tsx`, so update the header's carve-out list when revising that comment. The header says writers stay inside the engine, but direct atom writes live across `group-store.ts`, `group-turns.ts`, and `group-rounds.ts`; describe that boundary as the internal Group implementation.

The four state stores do not match the documented read surface today:

- `group-engine.ts:215-218` labels the exports a read surface, then re-exports the writable atoms directly from `group-store.ts`.
- `group-screen.tsx:30-38` subscribes to all four stores with `useStore`; it does not write to them.
- The other production importers use room hooks, engine actions, or lifecycle verbs. A source search found no production `.set()` call through the Group send engine exports and no production raw-store import outside `features/groups/`.
- `group-store.ts:383-399` owns the `$groupChats` update path. `updateGroupChat` clones and trims a room, writes the atom, persists the rooms, and schedules mirror synchronization. A direct outside `.set()` skips that path.
- The other atoms also have write rules that a direct setter bypasses: `recordGroupActivity` stamps entries with time and room epoch and caps each activity list at 30; `renameRoomState` migrates activity, prompts, and needs-you state; `appendGroupChatEntry` and `group-turns.ts` set needs-you for member mentions or pending prompts; `group-turns.ts` creates and clears prompts; `group-rounds.ts` clears needs-you on send.
- `group-engine.test.ts` currently has five fixture `.set()` calls on `$groupActivity`, `$groupPrompts`, and `$groupNeedsYou` (one, three, and one respectively). Move those setup writes to raw imports from `group-store.ts`; its public-handle reads remain unchanged.

The current export type gives external callers a `.set()` method they do not need; no external production caller currently writes through the export. Keep the existing modules and write paths, and narrow only the handle types exported from `group-engine.ts`.

## 3. Settled decisions

The following decisions define the selected design and should not be reopened during implementation.

| Decision | Chosen answer | Reason and rejected alternatives |
|---|---|---|
| Which state is covered? | All four exported state stores. | They form one documented read surface and production consumers only subscribe. Restricting `$groupChats` alone would leave the same accidental write capability on activity, prompt, and needs-you state. No broader Group state redesign is included. |
| What does "read-only" guarantee? | Imports from `group-engine.ts` have no `.set()` in their TypeScript type. | The installed Nanostores 1.4.0 declaration returns `ReadableAtom<Value>`. The raw atoms remain directly importable from `group-store.ts`, and runtime writes remain possible; this is a narrow typed seam, not enforced access control. |
| Which Nanostores primitive? | Use `readonlyType` for each exported handle. | It retains the current atom identity and subscription behavior, adds no derived state, and removes `set` from the exported type. Do not use `computed` for this purpose: this installed version constructs its computed store from an atom, and the returned runtime object still has `.set()`. Do not build a custom read-only store facade for a TypeScript-only caller contract. |
| Where does the seam live? | Keep the read-only views in `group-engine.ts`. | This is already the documented external interface. A new module would add another import path without concentrating behavior or improving locality. `group-store.ts` remains the internal owner of writable state and mutation rules. |
| Do values become deeply immutable? | No. | `readonlyType` narrows the store handle, not the object graph returned by `.get()`. Do not freeze state, introduce a recursive readonly type, or change `getGroupRoom` in this pass. No production caller mutates returned values today. |
| How are tests arranged? | Assert the public type contract through `group-engine.ts`; arrange internal state through raw imports from `group-store.ts`. | The interface is the test surface for caller capability. Tests inside the Group feature may still use internal seams to prepare state. Existing behavior tests continue to exercise observable Group actions and projections. |
| Is a new domain term needed? | No. | Keep the existing "Group send engine" and "read surface" vocabulary. `CONTEXT.md` records the read-only TypeScript contract and its write ownership; implementation must preserve that contract. |

No ADR conflicts were found; the repository has no `docs/adr/` entries relevant to this decision. A separate interface-design exercise is unnecessary here: the selected approach uses an existing Nanostores helper at the existing Group engine seam.

## 4. Intended module shape

Keep the four writable atoms in `group-store.ts`. Import them under internal names in `group-engine.ts`, then define the same public names with `readonlyType`. The pseudocode below shows the intended ownership split; retain the existing types and imports where possible.

```ts
import { readonlyType } from 'nanostores'
import {
  $groupChats as $groupChatsState,
  $groupActivity as $groupActivityState,
  $groupPrompts as $groupPromptsState,
  $groupNeedsYou as $groupNeedsYouState
} from './group-store'

const $groupChats = readonlyType($groupChatsState)
const $groupActivity = readonlyType($groupActivityState)
const $groupPrompts = readonlyType($groupPromptsState)
const $groupNeedsYou = readonlyType($groupNeedsYouState)
```

In the existing read-surface section, export the four local typed handles, not the raw atoms from `group-store.ts`:

```ts
export { $groupChats, $groupActivity, $groupPrompts, $groupNeedsYou }
export { GROUP_CHAT_MAX_MEMBERS, getGroupRoom } from './group-store'
```

This replaces the current direct re-exports of the four atom names. Keep the public names unchanged and keep `GROUP_CHAT_MAX_MEMBERS` and `getGroupRoom` exported from `group-store.ts`. Do not create replacement stores or copy state into a second atom.

`group-engine.ts` also writes `$groupChats` during `handleGatewayTransition`. That internal write must keep using the raw import, for example `$groupChatsState.set(...)`. Read-only aliases may be used for `get()` and subscriptions, but a write must use the internal writable name. The `$knownRooms` projection and `useGroupRooms` hook should continue to observe the same underlying room atom. No change to room identity, serialization, mirror policy, transition epochs, or runtime data is intended.

Verified against the installed declarations: `@nanostores/react` 1.1.0 defines `useStore<SomeStore extends Store>`, and Nanostores 1.4.0 defines `Store` to include `ReadableAtom<Value>`. `group-screen.tsx` can keep its existing `useStore` calls and imports; the implementation's typecheck will also compile those call sites.

## 5. Scope

### Files to change

1. **`client/src/features/groups/group-engine.ts`**
   - Import `readonlyType` from `nanostores`.
   - Import all four raw atoms under internal names for `readonlyType`; keep `$groupChatsState` available for the engine's `handleGatewayTransition` write.
   - Create read-only typed handles under the existing public names.
   - Preserve the current external export names. Export the four local read-only handles from the read-surface section and keep `GROUP_CHAT_MAX_MEMBERS` and `getGroupRoom` as direct re-exports from `group-store.ts`.
   - Update the file header to name the `app.tsx` type-only `GroupRoom` import as well as the `agents-api.ts` `group-model.ts` carve-out, and to say the raw writers belong to the internal Group implementation.
   - Keep `handleGatewayTransition` writing through the raw room atom.

2. **`client/src/features/groups/group-engine.test.ts`**
   - Move fixture `.set()` calls for activity, prompts, and needs-you state to raw imports from `./group-store`, using names that make their test-only writable role clear.
   - Keep assertions against the public read-only handles when testing what engine callers observe. Add a public `$groupNeedsYou.get()` assertion after setting `$groupNeedsYouState` from the raw fixture import; the current engine tests do not otherwise read that handle, so this catches an alias accidentally wired to the wrong atom.
   - Add compile-only assertions showing `.set()` is absent from all four `group-engine.ts` exports. Put those assertions in a function or dead-code block that is typechecked but never executed. Use `@ts-expect-error` so typechecking fails if a writable method becomes publicly visible again.
   - Do not use runtime assertions that expect `readonlyType` to remove `.set()`. It does not.

3. **`CONTEXT.md`**
   - State precisely that imports of the four handles from `group-engine.ts` have a `ReadableAtom` type with no `.set()`. The raw atoms remain exported from `group-store.ts` for internal modules and setup tests; direct imports are outside this type boundary.
   - Keep the limit accurate: `readonlyType` does not change runtime behavior, remove `notify()`/`off()`, or make `.get()` values deeply immutable.
   - Leave the separate Known rooms, Group member turn, and Group mirror definitions unchanged.

### Files not expected to change

- `client/src/features/groups/group-store.ts`: the writable atoms and existing update functions remain the internal implementation.
- `client/src/features/groups/group-turns.ts` and `group-rounds.ts`: these modules import raw atoms for prompt and needs-you writes. Their activity updates go through `recordGroupActivity()` in `group-store.ts`; they do not set `$groupActivity` directly.
- `client/src/features/groups/groups-sync.ts`: it reads the raw `$groupChats` atom and applies remote merges through `replaceGroupChats`; neither path changes.
- `client/src/features/groups/group-screen.tsx`: it reads the four exported atoms through `useStore` and does not call `.set()`; the installed React declaration accepts `ReadableAtom`.
- `client/src/app.tsx`, `client/src/features/agents/roster-screen.tsx`, and `client/src/features/groups/create-group-chat-dialog.tsx`: keep their existing room hooks/actions; `app.tsx` also keeps its type-only `GroupRoom` import from `group-model.ts`.
- `client/src/features/agents/agents-api.ts`: keep its existing `GroupRoom` type and `groupRoomsFromRoster` imports from `group-model.ts`; this is the other documented model-leaf carve-out.
- Existing test fixtures outside the Group folder in `app-navigation.test.tsx` and `features/agents/roster-screen.test.tsx`: both import raw `$groupChats` from `group-store.ts` for setup. Keep these test-only imports; they do not use the public engine read surface.

If typechecking finds an unlisted production `.set()` caller through `group-engine.ts`, stop and inspect it. Route a legitimate write through an existing Group action or ask whether it requires a missing engine operation. Also flag any new production import of raw atoms from `group-store.ts` outside `features/groups/`; the type wrapper does not block that bypass.

## 6. Test plan

### Compile-time contract

In `group-engine.test.ts`, add a non-executed type-check block with one `@ts-expect-error` assertion per public store. Each line attempts `.set()` on the import from `group-engine.ts`. `npm run typecheck` must accept the expected errors. If a setter becomes visible later, TypeScript reports an unused `@ts-expect-error`, making the contract regression visible.

Because `readonlyType` is an identity function at runtime, do not call those lines in a test. Runtime assertions such as `expect($groupChats.set).toBeUndefined()` would encode a false guarantee.

### Behavioral coverage

- Keep the existing lifecycle and round tests that observe room, feed, and prompt updates through the Group engine's public read handles. Add one focused assertion that a value written through raw `$groupNeedsYouState` is visible through public `$groupNeedsYou`; the current engine tests do not assert that public read path.
- Move fixture writes to `group-store.ts`; this is setup at the existing internal seam, not a new production dependency.
- Keep the existing `group-store` tests for room-log trimming/retention, persistence, key migration, activity/prompt/needs-you key migration, and needs-you marking. No current test covers the 30-entry activity cap; this change leaves that path untouched, so do not claim the suite verifies that limit or expand scope to add an unrelated test.
- `npm run typecheck` compiles `group-screen.tsx` and verifies that `useStore` accepts the `ReadableAtom` exports. The screen tests cover the mirrored room log and missing-room state; they do not render activity or prompt state. The engine lifecycle/round tests cover observable feed and prompt updates through the public handles.
- Run the complete Vitest suite. This type-surface change has no intended UX change, so a browser or Playwright flow is not required unless typechecking or the UI tests reveal a runtime issue.

### Source audit

Before calling the work complete, search production source for writes to the four public names and the planned `$groupChatsState` alias, then inspect raw-store import paths. Remaining writes should stay in `group-store.ts`, `group-turns.ts`, `group-rounds.ts`, and the engine's private `handleGatewayTransition`. `group-screen.tsx` must remain a subscriber, not a writer, and production modules outside `features/groups/` must not import raw atoms from `group-store.ts`.

## 7. Implementation order

1. Inspect `git status` before editing. Preserve the existing user changes to `plan.md` and `CONTEXT.md`; confirm the application files named below have no unrelated edits. Do not require the whole worktree to be clean or restore the previous plan.
2. Add the compile-only `.set()` contract assertions and update `group-engine.test.ts` fixture writes to import the raw atoms from `group-store.ts`.
3. Run `cd client && npm run typecheck`. Before the interface change, the `@ts-expect-error` directives should fail as unused. This confirms the tests detect the current writable export.
4. In `group-engine.ts`, alias each writable import and create the four `readonlyType` handles. Export those local aliases from the read-surface section, while continuing to re-export `GROUP_CHAT_MAX_MEMBERS` and `getGroupRoom` from `group-store.ts`. Update `handleGatewayTransition` to use the raw room atom for its internal `.set()` call. Keep all public names stable.
5. Re-run typechecking. It should pass, including the `useStore` call sites and compile-only contract assertions.
6. Confirm `CONTEXT.md` states the exact contract: imports from `group-engine.ts` lack `.set()` in TypeScript, raw `group-store.ts` imports remain writable, and runtime methods and returned values are not made immutable.
7. Run focused Group tests, then the full unit suite and production build. Review the diff and source audit for accidental state or call-site changes.

## 8. Verification commands

Run from `client/`:

```bash
npm run typecheck
npm test -- src/features/groups/group-engine.test.ts src/features/groups/group-screen.test.tsx src/features/groups/group-store.test.ts
npm test
npm run build
```

Then from the repository root:

```bash
rg -n '\$(groupChats|groupActivity|groupPrompts|groupNeedsYou)(State)?\.set' client/src --glob '!**/*.test.*'
rg -n 'from .+group-(engine|store)' client/src --glob '!**/*.test.*'
git diff --check
git status --short
```

Interpret the searches by import ownership. Expect `$groupChatsState.set()` only for the engine's private lifecycle write; other raw writes stay in `group-store.ts`, `group-turns.ts`, and `group-rounds.ts`. Inspect every production `group-store.ts` import to ensure no new consumer outside `features/groups/` bypasses the engine interface. `group-screen.tsx` should only subscribe. The compile-only assertions are intentionally excluded from the production search.

The build is included because this changes an imported Nanostores helper and a shared TypeScript export. Playwright is not part of the default verification: there is no changed navigation, network, persistence, or visible interaction. Add it only if the actual implementation causes a UI regression that unit tests do not cover.

## 9. Acceptance criteria

- The four public state exports retain their existing names and remain usable with `useStore`.
- Their TypeScript types do not expose `.set()`.
- Compile-only assertions fail if any of the four public types becomes writable again.
- Existing Group behaviors, values, update order, persistence, mirror scheduling, room keys, and UI rendering remain unchanged.
- `handleGatewayTransition` and internal Group writers still use their writable atoms through internal imports.
- Production consumers do not write through the Group send engine's read surface.
- The Group send engine documentation and `CONTEXT.md` agree about who may write.
- No new package, state store, module, runtime copy, or deep-freeze policy is introduced.
- The documented boundary remains explicit: only imports from `group-engine.ts` lose `.set()` in TypeScript. Direct imports from `group-store.ts`, runtime `.set()`, `notify()`/`off()`, and mutation of `.get()` values remain possible.

## 10. Risks and follow-up triggers

- **The type boundary is convention-based.** `readonlyType` returns the original atom, so runtime `.set()` remains available and a TypeScript consumer can bypass the engine by importing from `group-store.ts`. `ReadableAtom` also retains `notify()` and `off()`; the contract only removes `.set()` from imports of these four handles through `group-engine.ts`. If stronger isolation becomes a requirement, design it separately rather than bolting on a partial facade here.
- **Returned objects are not deeply immutable.** A caller can still mutate an object reached through `.get()` or `getGroupRoom()` without calling `.set()`. No current production caller does so. Deep readonly types, cloning, or freezing would broaden the change and are deferred.
- **Fixture imports become more explicit.** Group engine tests that prepare internal prompt/feed state will depend on `group-store.ts`. That is acceptable for setup tests in the same feature cluster; public behavior assertions should continue to read through the engine interface.
- **No production caller currently violates the intended rule.** The benefit is a smaller and more honest interface, with a type-level guard against future accidental writes. Keep the recommendation low priority if the implementation grows beyond the three focused files above.
- **No domain-model term is added.** If the implementation changes the meaning of "read surface" beyond the typed store capability recorded here, revisit the `CONTEXT.md` wording before expanding scope.
