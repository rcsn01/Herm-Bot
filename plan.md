# Implementation plan: keep Group room snapshots fresh

## Status

Implemented. Focused tests passed (7 files, 140 tests), the full suite passed (82 files, 1,027 tests), and the Group browser regression passed in Chromium and WebKit. Typecheck and production build passed; Vite reported chunk-size and inlineDynamicImports warnings.

## Goal

Make the synchronous `useGroupRooms` view and the retained roster half compare the complete ordered `GroupRoom` snapshot, not only room keys and names. A `profiles.list` result can keep those keys and names while changing members, log entries, an image, or another typed field. Before this change, both key/name signatures treated that changed snapshot as equal: the hook retained its old roster array, and `publishRosterRooms` skipped its write. The roster row, the Group screen's roster-backed room name and members, the create dialog's duplicate-name check, and the app header could therefore stay stale.

Keep the existing projection in `client/src/features/groups/group-engine.ts`. Give `useGroupRooms` and `publishRosterRooms` one shared content-signature rule. Preserve the public exports, roster/local merge, roster precedence, ordering, retained snapshot, reset behavior, and caller behavior. This does not replace an existing local `$groupChats` room or refresh the transcript rendered from that local room in `GroupChatScreen`; local transcript freshness remains owned by the mirror and Group store.

## Data flow

```text
profiles.list
  -> createAgentsApi.list -> parseAgentRosterPage
  -> groupRoomsFromRoster -> parseGroupSnapshot
  -> roster.data.groups
       -> useGroupRooms
            -> groupRoomsView(roster groups, $groupChats)
                 -> roster screen, Group screen, create-group dialog
            -> effect: publishRosterRooms -> retained $rosterRooms
       -> $knownRooms = groupRoomsView($rosterRooms, $groupChats)
            -> useKnownRooms() -> app header
```

The roster screen, Group screen, and create-group dialog use the same unscoped roster query key and call `useGroupRooms`. The app header reads `useKnownRooms()`. Both paths use `groupRoomsView` to union roster and local rooms by durable room key, with the roster row winning a duplicate key. In `GroupChatScreen`, the selected roster row supplies the room name and members, but the transcript renders from the local engine room once one exists.

## Resolved design decisions

These decisions are final for this implementation plan.

| Decision | Adopted answer | Reason |
| --- | --- | --- |
| Where does the fix live? | Deepen the existing known-rooms projection in `group-engine.ts`. Add no new module. | It already owns the retained roster snapshot, content deduplication, and roster/local merge. Removing it would push those rules into its callers. |
| What counts as changed content? | Compare the complete ordered `GroupRoom` snapshot, including nested log and member values. Preserve room, member, and log order. | Room order controls roster ranking; member order controls display and recipient order; log order carries transcript meaning. |
| How is comparison shared? | Add one private canonical content-signature helper and use it in both `useGroupRooms` and `publishRosterRooms`. | The former partial signatures could drift apart. |
| How is hook memoization kept stable? | Derive the memo dependency from the full content signature, and memoize a fresh shallow array copy when that signature changes. | The hook must recompute its merged view and publish effect for changed content even if a caller reuses the outer array. Equal snapshots still avoid effect churn. |
| What stays public? | Keep `useGroupRooms`, `publishRosterRooms`, `resetKnownRooms`, `$knownRooms`, and `useKnownRooms` signatures and exports unchanged. Keep the helper private. | Callers already use the right seam; they should not learn a new rule or helper. |
| What is out of scope? | Leave parsing, query policy, sorting, group mirror, local room state, send/stop behavior, and screen component code/layout unchanged. Existing screens render the refreshed projection through their current code. | None of those owns this equality defect. |
| What documentation changes? | Update the Known rooms glossary entry and the relevant source comments. Add no new domain term or ADR. | Before this change, the Known rooms entry described the key-and-name-only signature. The Group send engine entry points readers to Known rooms, so repeating the equality rule there would duplicate it. No tracked ADR directory exists. |

## Snapshot equality contract

`GroupRoom` currently contains `key`, optional `image`, `log`, `members`, `name`, and optional `roomId`. Each log entry has `at`, `from.kind`, `from.name`, optional `from.source` (`GroupMessageAuthor`), optional `id`, `text`, and optional `thread`. Each member has `name`, optional `handle`, `connectionId`, `connectionKind`, `connectionLabel`, and optional `sourceScoped`.

The private signature must include every field above. Build ordered nested tuples with fixed field positions, then serialize the tuples with `JSON.stringify`. This avoids property-insertion-order sensitivity and delimiter collisions in the current `key::name`/`|` encoding. Encode every optional field as `value ?? null`; keep `false` distinct from an absent `sourceScoped`. Preserve room, log, and member order.

Do not pass `at` directly to `JSON.stringify`. `coerceGroupMessage` can produce `Infinity` from a numeric overflow or a string such as `"Infinity"`, and it preserves `-0`; `JSON.stringify` maps non-finite numbers to `null` and `-0` to `0`. Encode finite timestamps as `["finite", at]`, `NaN` as `["nan"]`, positive infinity as `["+infinity"]`, negative infinity as `["-infinity"]`, and negative zero as `["-zero"]`. This keeps the signature lossless for the typed `number` field without changing parser coercion.

Use one private helper named `groupRoomsContentSignature(rooms)` in both paths. Its empty-array signature is the reset signature: initialize `rosterSignature` from `groupRoomsContentSignature([])` and restore that same value in `resetKnownRooms()`. Do not use array identity as content equality.

`useGroupRooms` must derive its memo dependency from this signature. When it changes, memoize a new shallow copy of the roster array so `groupRoomsView` sees a new reference and the publish effect runs, even when the caller reuses the outer array. When content is equal, retain the previous copy. `publishRosterRooms` must compute the same signature for direct callers, keep its equal-content no-op, and replace `$rosterRooms` only when the signature changes. Preserve the current shallow-copy behavior; do not deep-clone room values.

The gateway path produces plain typed rooms through `parseGroupSnapshot`, but its timestamp coercion is not guaranteed finite. The public `publishRosterRooms` path also accepts typed arrays without runtime validation. The mirror writer trims logs, drops images, and removes rooms against a 48,000-unit gateway JSON budget, but tombstone keys are only count-limited and can still exceed the budget. The roster read path does not enforce the budget at all, so it is not a hard bound on signature input size. Signature creation is O(total roster content), which is required to detect full-content changes. Do not add a dependency, a generic deep-equality package, caching, or cycle handling for values outside the well-formed typed roster contract.

This preserves the distinction between the synchronous merged view returned by `useGroupRooms` and the retained roster snapshot consumed by `useKnownRooms`. A changed roster reaches the retained store through the existing effect. The retained roster still outlives its publishers. The Group screen's displayed transcript remains the local engine room, as described above.

## Existing behavior to preserve

1. `groupRoomsView(rosterGroups, localRooms)` remains the pure merge. Roster rows stay first and win over local rows with a shared key. Duplicate roster keys keep the current `Map` behavior: the last row supplies the value at the key's first insertion position. Eligible local-only rooms follow in local map order. Empty runtime tombstones remain filtered.
2. `parseGroupSnapshot` keeps its current coercion, room identity rules, and sort by newest room-log timestamp descending. It leaves each room's log order unchanged.
3. A new array with equal full content remains a no-op. A same-key, same-name room with any changed typed field publishes.
4. For a roster with unique keys, changed room order publishes and the projection returns rooms in that order. Duplicate keys remain collapsed by the merge as described above.
5. Publishing `[]` clears a non-empty retained roster. Publishing the same empty snapshot again is a no-op.
6. `resetKnownRooms()` clears the retained roster and its comparison state. Local room reset remains owned by `group-store.ts`.
7. Multiple publishers keep last-publish-wins behavior for changed snapshots. Equal snapshots from the roster, Group screen, and create dialog do not cause repeat writes.
8. Changes to `$groupChats` still recompute `$knownRooms` without a roster publisher.
9. No caller begins importing raw writable atoms or bypassing `groupRoomsView`.
10. `GroupChatScreen` continues to render an existing room's transcript from its local `$groupChats` room. This change updates the roster projection, not local transcript adoption or mirror policy.

## Evidence and constraints

- `client/src/features/groups/group-engine.ts:131-149` implements the roster/local merge. `group-engine.ts:163-219` builds and uses the retained full-content signature. `group-engine.ts:229-249` uses the same signature for hook memoization and its shallow snapshot.
- `client/src/features/agents/roster-screen.tsx:51-62`, `client/src/features/groups/group-screen.tsx:79-81`, and `client/src/features/groups/create-group-chat-dialog.tsx:22-31` use the same unscoped `['agents', 'roster']` query key. `client/src/gateway/scope-guard.ts:107-145` passes that key to TanStack Query.
- `client/src/app.tsx:47-51` reads `useKnownRooms()` for the Group header. The roster screen, Group screen, and create dialog consume the separate immediate `useGroupRooms()` return value.
- `client/src/features/groups/group-screen.tsx:81-83,105-138` reads the room name and membership from `room`, but renders messages from `engineRoom.log`. `client/src/features/groups/group-store.ts:496-515` adopts a mirror row only when the local key does not already exist, so this plan does not make an existing local transcript follow a changed roster log.
- `client/src/features/groups/groups-sync.ts:18,73-89,169-195,250-284` trims outgoing rooms against a 48,000-unit gateway JSON budget; tombstone keys are only count-limited, not length-limited. The `profiles.list` read path does not enforce the budget.
- `client/src/app-navigation.test.tsx:66,71-89,182-202` directly publishes a roster row and verifies that `useKnownRooms()` updates the app Group header; keep this test unchanged and include it in focused verification.
- `client/src/features/groups/group-model.ts:14-39` defines `GroupMessageAuthor`, `GroupMessage`, and `GroupMember`; `group-model.ts:111-120` defines `GroupRoom`. `group-model.ts:124-152` parses and sorts rooms. `group-model.ts:159-188` normalizes log and member fields; line 164 can still return `Infinity` from a numeric overflow or a string such as `"Infinity"`.
- `client/src/features/agents/agents-api.ts:234-243,342-350` turns `profiles.list` into `AgentRosterPage` and carries parsed groups through the same result.
- `client/src/features/agents/roster-screen.tsx:51-67,102-118` consumes room key, image, member names/count, name, and latest log author, text, and time.
- `client/src/features/groups/group-screen.tsx:79-83,105-125` finds the room by key, shows its name and members, and passes the room's member list to the send path at `112-117`.
- `client/src/features/groups/create-group-chat-dialog.tsx:22-32` uses known room names to prevent duplicate names.
- `client/src/features/groups/group-engine.test.ts:687-933` covers full-content equality, every scalar field, timestamp and delimiter boundaries, and room/member/log order. `group-engine.test.ts:1016-1134` covers empty/reset behavior, multiple publishers, same-array rerenders, and retained reads after unmount.
- `client/src/features/groups/group-engine.test.ts:585-616,961-1015` covers duplicate-key merge behavior, local-room projection, creation, and reset.
- `client/src/features/groups/group-model.test.ts:37-90` covers parser coercion, tombstones, and room ordering. Parsing stays unchanged.
- `CONTEXT.md:35` now documents full ordered snapshot equality. The Group send engine entry at `CONTEXT.md:30` points to Known rooms without duplicating its equality rule.
- The existing API and screen caller tests still cover their initial-result paths. The new same-key/name refresh cases live in `group-engine.test.ts`.
- No tracked ADR directory exists.

## File-by-file work

### `client/src/features/groups/group-engine.ts`

- Add the private `groupRoomsContentSignature(rooms)` helper next to the retained signature state. Serialize fixed-position nested tuples for every field in the equality contract. Encode timestamps losslessly, optional values consistently, and preserve room, log, and member ordering.
- Use this helper in `publishRosterRooms` instead of `room.key + room.name`, and in `useGroupRooms` instead of its second key/name signature.
- When the signature changes, memoize a fresh shallow array copy of the roster input. This makes `groupRoomsView` and the publish effect observe changed content even if the caller reuses its outer array. When the signature is equal, retain the previous copy.
- Initialize and reset `rosterSignature` to `groupRoomsContentSignature([])`. This makes an empty publish after initialization or reset an equal-content no-op.
- Keep the `publishRosterRooms` equal-content short circuit and replace `$rosterRooms` only when the signature changes.
- Update both function comments to say that equality covers the complete ordered room snapshot, not only keys and names.
- Do not change `groupRoomsView`, exported functions, writable-store visibility, deep-copy behavior, or lifecycle behavior.

### `client/src/features/groups/group-engine.test.ts`

Extend the existing Group projection and known-rooms tests through the public read and publish paths.

1. Strengthen the equal-content no-op case to use separately allocated room, log, author, and member objects, with object properties inserted in a different order. Assert that `$knownRooms` receives no notification.
2. Add table-driven direct-publish cases that change every scalar field in the equality contract independently: room `key`, `name`, `image`, and `roomId`; message `at`, author `kind`, `name`, and `source`, message `id`, `text`, and `thread`; member `name`, `handle`, `connectionId`, `connectionKind`, `connectionLabel`, and `sourceScoped`. For every optional field, cover absent versus present values; for optional fields with multiple valid values, also cover a changed present value. Include an empty string as a present optional-string value and assert it differs from absence. Assert each changed snapshot updates the retained value.
3. Pin the JSON-signature boundaries: publish pairs with finite timestamps, `NaN` versus `0`, positive versus negative infinity, and negative zero versus `0`; assert distinct typed timestamp values publish separately. Add one pair of rooms whose `key::name` strings collide at the `::` boundary and one two-room-versus-one-room pair whose `|`-joined signatures collide. Assert each second snapshot still publishes.
4. Reorder members and log entries and assert each ordering change publishes without reordering returned values. Reorder two distinct-key rooms and assert `$knownRooms` returns the new room order. Keep the parser's newest-room-first room sort test unchanged.
5. Add a focused same-key/name regression case that changes both a recipient-relevant member field and log text plus an optional log field. The field matrix in step 2 covers `image` and every other scalar independently.
6. Render a publisher using `useGroupRooms`, then rerender with a changed same-key/name room by replacing its element in the same outer array. Make the publisher render the hook result and assert its immediate merged view and `$knownRooms` contain the new fields. Unmount, render a reader using `useKnownRooms`, and assert the updated fields remain available.
7. Mount two publishers with separately allocated but content-equal snapshots and assert their effects produce only one retained-store update. Publish two changed snapshots directly in sequence and assert the last one is retained.
8. Pin empty behavior with `$knownRooms.listen` (not `subscribe`): publishing `[]` clears a populated roster with one notification, a second `[]` does not notify, and after `resetKnownRooms()` attach a fresh listener before publishing `[]` and assert no notification.
9. Retain the existing roster-over-local duplicate-key precedence, local-room updates, reset, creation, and unmount-retention assertions. Add a `groupRoomsView` case for duplicate keys within the roster: the last row supplies the value at the key's first insertion position. Do not assert that a changed roster log replaces an already-existing local Group transcript; that is outside this projection's ownership.

Do not add a test-only production export. Test through `publishRosterRooms`, `useGroupRooms`, `$knownRooms`, and `useKnownRooms`.

### `CONTEXT.md`

- Update only the Known rooms entry to say roster publishers deduplicate by the complete ordered room snapshot, including nested member and log values, rather than by room keys and names alone.
- Keep its current ownership, durable-key merge, roster precedence, local-room behavior, and retention description. The Group send engine entry already points to Known rooms; do not repeat the equality rule there.

### Intentionally unchanged

- `client/src/features/groups/group-model.ts` and its parser, coercion, sorting, and room identity behavior.
- `client/src/features/agents/agents-api.ts` and the `profiles.list` query/result shape.
- `client/src/features/agents/roster-screen.tsx`, `client/src/features/groups/group-screen.tsx`, `client/src/features/groups/create-group-chat-dialog.tsx`, and `client/src/app.tsx`.
- `groupRoomsView` merge order and precedence.
- Group send, stop, member-turn, room-key, mirror, and scope lifecycle policy.
- Public `group-engine.ts` exports, dependencies, package manifests, and wire contracts.
- No ADR, new domain term, general-purpose equality module, new browser fixture, or UI redesign.

## Implementation sequence

1. Confirm `git status --short`. The root `plan.md` replacement is expected. Preserve any other uncommitted work.
2. Add one private canonical signature helper in `group-engine.ts` and route both hook memoization and retained publication through it. Initialize and reset the stored signature to the empty-array signature.
3. Extend the direct-publish and projection tests for deep equality, each typed field, timestamp and delimiter boundaries, room/member/log order, duplicate-key merge behavior, empty behavior, and last-publish-wins behavior.
4. Extend the hook tests for same-outer-array rerenders, immediate and retained reads, multiple equal publishers, and retention after unmount.
5. Update the Known rooms glossary text and both Group engine function comments to describe full ordered content equality.
6. Run the focused client tests, the existing Group browser regression, the full client suite, and the production build.
7. Review the diff for unrelated changes and run `git diff --check`.

## Verification plan

Run from `client/`.

### Focused tests

```sh
npm test -- \
  src/features/groups/group-engine.test.ts \
  src/features/groups/group-model.test.ts \
  src/features/agents/agents-api.test.ts \
  src/features/agents/roster-screen.test.tsx \
  src/features/groups/group-screen.test.tsx \
  src/features/groups/create-group-chat-dialog.test.tsx \
  src/app-navigation.test.tsx
```

The Group engine tests cover full-content equality and hook rerenders; the model tests cover parser behavior. The API list-adapter and caller tests guard unchanged paths. The controlled hook rerender test covers the same-key/name freshness boundary.

### Browser regression

```sh
npm run test:e2e -- e2e/pwa-foundation.spec.ts \
  --grep 'desktop group chats list on the main screen and open with sending'
```

Run this existing flow in Chromium and WebKit. It checks that the roster row opens the Group screen and that sending still works. The same-key/name update itself is covered by the controlled hook rerender test; do not add a browser fixture or new UI flow for this projection-only change.

### Full client verification

```sh
npm test
npm run build
```

The build runs TypeScript before Vite. Run the full suite because the retained Group room projection is consumed by multiple screens and the app header.

### Ownership audit

After implementation, inspect `git status --short`, `git diff --check`, and the final diff. Confirm:

- `useGroupRooms` and `publishRosterRooms` use the same full-content comparison, including tagged timestamps and optional values.
- Changes to every typed scalar field and to room, member, and log order reach the immediate hook view and retained `$knownRooms`.
- Equal deep content avoids redundant publication, including across two hook publishers. A changed direct publish remains last-publish-wins.
- Empty roster clearing, empty publication after reset, retention, and local-room recomputation remain unchanged.
- `groupRoomsView` still preserves roster-over-local precedence and its duplicate-key Map behavior. Roster parsing, sorting, query shape, and UI caller code did not change. Existing local Group transcripts still come from `$groupChats`.
- The helper remains private. No dependency, new module, new export, ADR, or unrelated edit was added.
- `CONTEXT.md` matches the new equality rule.

## Risks and stop conditions

- **Comparison drift:** Do not leave separate key/name signatures in the hook and publisher. Both paths must use the same helper.
- **Ordering drift:** Do not sort rooms, members, or log entries inside the signature. Their current order is observable and intentional.
- **Merge drift:** Do not alter roster-wins precedence or local-only room filtering to make freshness tests pass.
- **Mutable inputs:** Current callers pass parser-created query snapshots and treat them as immutable. Recomputing the signature on render detects changed or reordered elements even when a caller reuses the outer array. The memoized copy is shallow and does not isolate nested objects; React also will not rerender solely because an object was mutated. Do not add deep cloning or rely on mutation as an update mechanism.
- **Cost:** Signature creation is O(total roster content). The mirror writer's room-trimming budget is not a hard limit on every outgoing value and does not cap incoming `profiles.list` data. Do not add caching or a generic equality module without measured need.
- **Schema changes:** If `GroupRoom`, `GroupMessage`, `GroupMessageAuthor`, or `GroupMember` gains a field, include it in the canonical signature when it is part of the typed snapshot. Keep the field list and table-driven tests aligned.
- **Scope:** Do not change the agents query, parser, mirror protocol, local transcript adoption, member-turn policy, or screen components to implement this equality fix. Those owners are unchanged; if a separate requirement needs one of them, revise the scope rather than including it implicitly.
