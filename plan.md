# Plan: give Group session provenance one owner

## Goal

Deepen the Group session-provenance policy behind one internal module so the rules governing a room's Gateway-owned session state are defined once, not reconstructed across `group-store.ts`, `group-turns.ts`, `group-engine.ts`, and `groups-sync.ts`.

This is an **ownership/locality refactor**, not a behavior change. The current behavior implemented in commit `8615ee2` remains the contract. The external Group engine interface, the v4 local-storage format, and the v3 Gateway mirror format do not change.

## Current state and friction

The provenance invariant is distributed:

- `group-store.ts` defines `GroupChatRoom.sessionConnectionKey`, `sessions`, and `stranded`; validates the persisted trio; strips it from v1–v3 migrations; writes v4; and clears foreign room state at engine startup.
- `group-turns.ts` independently decides whether a stored id is eligible (`scopedStoredSessionId`), tags the room after resume/create, stamps `GroupPrompt.connectionKey`, scopes harvest and interrupt, and rejects a foreign prompt in `answer`.
- `group-engine.ts` separately filters foreign prompt cards and must call both cleanup paths before creating the modules, installing the mirror scheduler, and starting the initial pull.
- `groups-sync.ts` explicitly preserves the local `sessions` and `stranded` maps while the tag rides through `...existing`; it must also avoid ever accepting those fields from the remote projection.

The deletion test passes: removing one of these local rules would move the same connection-ownership decisions into the remaining callers. The problem is not that the behavior is wrong; it is that the interface does not provide one place to learn, test, and change the provenance rule.

## Decisions settled

These are the recommended defaults adopted at the user's request:

1. **Owner:** add an internal pure module, `client/src/features/groups/group-session-provenance.ts`. Keep Nanostores and localStorage writes in `group-store.ts`; keep member-turn sequencing in `group-turns.ts`; keep lifecycle ordering in `group-engine.ts`.
2. **State covered:** session-id and stranded-marker provenance as one room-level trio, plus the connection tag on pending prompt cards. The room-level key scopes both maps; prompt cards are independently tagged with the producing connection.
3. **Acquisition:** a successful resume or create tags the room even if the Gateway returns no durable stored id. If acquisition changes the room's owner key, discard the old session and stranded maps before recording the new tag/id. If the key is unchanged, preserve other members' entries.
4. **Lifecycle sweep:** before a new Group lifecycle is armed, clear mismatched or untagged session provenance and foreign prompt cards. Preserve same-key state, shared room state, and the existing no-op/no-persist behavior for empty maps. The sweep schedules no mirror write.
5. **Formats:** retain `hermes.group-chats.v4`, its validation and v1/v2/v3 fallback rules, and the v3 Gateway mirror format. Session provenance remains local-only and is never imported from or projected to the Gateway.
6. **Test surface:** test pure provenance decisions through the new module's interface, persistence through Group store behavior, and wire/lifecycle guarantees through turn and engine flows. Preserve the convention that Group-owned tests may seed writable atoms; cross-feature tests use engine actions and public read handles.
7. **Scope:** do not also refactor general coordination maps, member/room key formats, GatewayController reconnect policy, ordinary socket reconnect behavior, or per-Gateway session caches.

## Intended module ownership

### `group-session-provenance.ts` — policy and pure transforms

This in-process module owns the session-provenance data type and the rules for manipulating it. It has no Nanostores, localStorage, Gateway RPC, React, or lifecycle dependency. Its small internal interface should cover these behaviors (final names can follow repository conventions during implementation):

- Validate/normalize an unknown persisted provenance value as an all-or-nothing trio: a non-empty connection key, valid non-empty stored ids, and valid stranded markers. A cursor of `0` remains valid.
- Return a stored id only when the room tag exactly matches the caller's captured `connectionKey` and that member's id is valid.
- Produce the next provenance value after successful acquisition. Same-key acquisition keeps other members' valid entries; changing keys clears the prior session and stranded maps before applying the new tag and optional id. A successful acquisition without an id still records the tag.
- Remove provenance that is not owned by the requested connection, while treating absent/empty maps as no session-bearing state and preserving the current no-op semantics.
- Stamp/check prompt-card provenance and filter cards to the active connection. A missing or foreign tag is never eligible for an answer.
- Preserve only the local provenance value during room merge/re-key operations; remote snapshot fields are never input to these transformations.

The module may own a type imported by `GroupChatRoom`, but it must not import `group-store.ts` at runtime. Prefer a structural input type or type-only imports so there is no module cycle. Do not export helpers merely for tests if they are not part of this policy interface.

### `group-store.ts` — state and persistence adapter

The store remains the owner of the Nanostores atoms and localStorage. It applies the pure policy transforms to room/prompt state, persists resulting room state, and exposes semantic operations to Group modules rather than requiring each caller to re-implement the trio rules. Persistence, migration, and atom notification behavior remain here.

### Existing callers

- **Group member turn** owns RPC order and turn lifecycle, but asks the provenance policy for stored-id eligibility, acquisition updates, prompt ownership, harvest target, and interrupt target.
- **Group send engine** owns the required lifecycle order. It invokes one store-level preparation/sweep operation synchronously before module construction, scheduler installation, and `mirror.pull()`; it no longer implements prompt filtering itself.
- **Group mirror** merges only shared room data plus the already-local provenance value supplied by the store/policy. It never accepts a provenance trio from a remote room and never projects one.

There is no new remote adapter or fake Gateway adapter: the policy is pure in-process logic, and the existing store remains its state adapter.

## Invariants to preserve

1. **Atomic ownership:** `sessionConnectionKey`, `sessions`, and `stranded` are retained or discarded together. A stored id or stranded marker is usable only when its room's tag equals the current lifecycle's captured connection key.
2. **Acquisition:** successful resume/create writes the current tag even if the durable id is absent; a stored id is added only when present. Re-tagging to another key cannot leave entries from the former key in either map.
3. **Acquisition fallback order:** matching stored id → room title (`Group: <roomId-or-name>`) → create, with the existing `4007` classification and failure behavior unchanged.
4. **Turn semantics:** baseline, poll, harvest, timeout, stranded-marker, watermarks, round-wide holds, prompt payload, and failure taxonomy remain unchanged. Only the owner of the provenance decision moves.
5. **Prompt cards:** every card is tagged by the connection that produced it; same-key cards survive a same-key restart; foreign/untagged cards are removed before the new mirror pull; `answer` sends no request for a foreign card.
6. **Lifecycle order:** `stopGroupEngine()` still invalidates the previous lifecycle first. For the next lifecycle, local room/prompt cleanup runs synchronously before modules are created, before the scheduler is installed, and before the initial pull reaches `profiles.list`.
7. **Shared state:** the cleanup changes no room log, members, image, watermarks, holds, epoch/turn policy beyond existing teardown behavior, activity, needs-you state, or mirror payload. Matching provenance stays unchanged.
8. **Persistence:** valid tagged provenance round-trips in v4. Malformed v4 provenance drops only the trio, not the room. v1/v2/v3 session state remains unconditionally stripped because it has no recorded owner. A present malformed v4 value never falls back to a legacy key. Loading legacy data remains write-free until a later normal persist.
9. **Mirror:** `groupChatSyncSnapshot()` contains no `sessionConnectionKey`, `sessions`, or `stranded`; merge preserves only a local trio and ignores those fields if a remote payload carries them.
10. **Connection identity:** use the captured `connectionKey` (`remoteURL`), not the app-selected Profile. A Profile switch at the same remoteURL retains provenance; switching the Gateway clears it. An ordinary socket reconnect continues to keep the active Group engine lifecycle.
11. **No cache:** do not save per-Gateway session maps or restore them when switching back. Switching A→B→A clears the active map on each key change and reacquires by title.
12. **No mirror write from sweep:** the startup sweep persists changed local room data directly, without scheduling `profiles.configure`; an all-matching/no-data sweep does not notify or persist.

## Implementation sequence

### Phase 1 — Characterize the policy seam

- Add `group-session-provenance.test.ts` before moving code. Cover the intended pure policy through its eventual module interface:
  - valid tagged provenance, including empty maps;
  - malformed/missing/empty tags, malformed maps, empty stored ids, invalid marker shapes, and valid cursor `0`;
  - matching, foreign, and untagged stored-id lookup;
  - same-key acquisition preserving other members;
  - key-change acquisition clearing both old maps before recording a new id;
  - acquisition without a stored id still tagging ownership;
  - room and prompt sweeps preserving matching state and discarding foreign/untagged state;
  - room merge/re-key preserving only local provenance.
- Keep these tests on the module's supported interface. Do not export internal validators or expose a new adapter seam just to assert implementation details.

### Phase 2 — Move provenance policy into the new module

- Add `client/src/features/groups/group-session-provenance.ts` with the focused type and pure transforms described above.
- Move the current provenance validation/normalization logic from `group-store.ts` into this module without changing accepted v4 data or the all-or-nothing rule.
- Move `scopedStoredSessionId` semantics out of `group-turns.ts`; callers must pass the captured connection key explicitly.
- Put the prompt tag/eligibility/filter rule in the same policy module. Keep prompt question/approval decoding and response payload construction in `group-turns.ts`; those are turn protocol, not provenance.
- Keep exact string comparison for keys. Do not add URL normalization, Profile derivation, fallback ownership, or a second cache.

### Phase 3 — Make the store the state adapter

- Update `GroupChatRoom` to use the provenance type owned by the new module; keep the field names and v4 JSON shape stable.
- Update `durableGroupChatRooms`, `rehydrateSessionProvenance`, and v1/v2/v3 legacy migration paths to delegate their provenance decision to the pure module.
- Keep all current non-provenance durability guards and room-key/member-key migrations unchanged.
- Add/adjust semantic store operations for:
  - reading an eligible member stored id for a supplied connection key;
  - recording a successful acquisition as one state transition;
  - storing/removing a prompt through connection-aware policy;
  - preparing store state for a new connection by transforming both the room map and prompt map.
- A store acquisition update must preserve existing `updateGroupChat` persistence and scheduling behavior; do not optimize mirror scheduling as part of this refactor. The startup sweep must retain its special local-only persistence path and must not call the mirror scheduler.
- Keep no-op behavior: matching state and empty maps do not cause needless atom notifications or v4 writes.

### Phase 4 — Route member-turn behavior through the policy

- In `group-turns.ts`, remove the private duplicate eligibility helper.
- In resume/create success paths, use the store/policy acquisition operation. Preserve turn ownership checks (`owns(capture)`) around the awaited request and write; stale operations must not tag state.
- In harvest and interrupt, resolve the target only through the matching-key lookup. Keep the current title fallback for harvest and the current no-request behavior for an absent eligible interrupt id.
- In prompt mirroring, ask the policy/store to stamp the card from the captured `GroupMemberGateway.connectionKey`; remove the empty-string default from `syncGroupClarify` so a missing captured key cannot silently produce an unowned card. Preserve request-id comparison and stale-poll protections.
- In `answer`, use the policy's prompt-ownership check before the first RPC. Keep all clarify/approval wire shapes, member profile routing, and post-response card deletion behavior unchanged.
- Keep `syncGroupClarify`'s prompt parsing and turn-local request sequencing in the turn module; move only the ownership decision/tag rule.

### Phase 5 — Route lifecycle and mirror through the policy

- In `group-engine.ts`, remove `dropForeignGroupPrompts` and replace the separate room/prompt cleanup calls with one store preparation call.
- Keep the call synchronous and in the same startup position: after stopping any previous lifecycle, but before creating turns/rounds/mirror, installing the sync scheduler, or invoking the initial pull.
- Keep `connectionKey` captured by `startGroupEngine(transport, connectionKey)`; do not key provenance to Profile.
- In `groups-sync.ts`, remove direct provenance-specific reconstruction where possible. Delegate local-trio carry/re-key to the store/policy; continue building the wire snapshot field-by-field so provenance is excluded.
- Do not let a remote room's extra `sessionConnectionKey`, `sessions`, or `stranded` properties flow into a local room, even if the remote object is cast or malformed.
- Split the session/stranded re-key policy out of `rekeyRoomCoordination`; leave its holds/watermark/member-enrichment behavior unchanged. This plan does not broaden into the general coordination-key refactor.

### Phase 6 — Update tests and domain notes

- **New module tests:** cover pure policy transitions and validation table.
- **`group-store.test.ts`:** retain tests for v4 durability, v1/v2/v3 migration, malformed v4 behavior, no-op cleanup, and local persistence. Move only assertions that duplicate the new policy-module contract; preserve integration coverage at the store interface.
- **`group-turns.test.ts`:** keep wire-observable tests for stored-id/title/create order, foreign-id non-use, tag-on-resume/create (with and without durable id), failed acquisition, harvest scoping, stale prompt/answer, and interrupt scoping. Avoid relying on private helper names.
- **`group-engine.test.ts`:** keep the A→B and A→B→A lifecycle checks, same-key prompt retention, foreign prompt removal, sweep-before-initial-pull observation, immediate open/harvest protection, and no `profiles.configure` from cleanup. Keep lifecycle tests through `startGroupEngine` and engine actions.
- **`groups-sync.test.ts` / `groups-mirror.test.ts`:** keep the snapshot-excludes-provenance and merge-keeps-local/ignores-remote assertions. Test through snapshot/merge behavior, not the internal pure helper.
- **`group-screen.test.tsx`:** retain the rendered prompt-card test proving same-key restart retains the card and connection-key change drops it.
- **`gateway-controller.test.ts`:** retain the Profile-switch-at-same-remoteURL test proving the engine restarts but tagged state survives and member RPC still uses the member Profile.
- **Cross-feature convention:** do not import writable Group atoms into gateway-controller, screen, or app-navigation tests. Use `createGroupChat`, `sendToGroupChat`, engine start/stop actions, and public read handles. Group-owned setup tests may still use writable atoms for malformed persistence and focused store state.
- Update `CONTEXT.md` alongside implementation to name the Group session-provenance policy owner and distinguish its pure rules from `group-store` persistence, Group member turn protocol, and Group engine lifecycle ordering. Keep the existing terms `Group chat`, `Group send engine`, `Group member turn`, `Group mirror`, `Member key`, and `Room key` consistent; do not change unrelated glossary entries.

### Phase 7 — Verify and review

Run focused suites first, then all checks from `client/`:

```sh
npx vitest run \
  src/features/groups/group-session-provenance.test.ts \
  src/features/groups/group-store.test.ts \
  src/features/groups/group-turns.test.ts \
  src/features/groups/group-rounds.test.ts \
  src/features/groups/group-engine.test.ts \
  src/features/groups/groups-sync.test.ts \
  src/features/groups/groups-mirror.test.ts \
  src/features/groups/group-screen.test.tsx \
  src/state/gateway-controller.test.ts
npx tsc -p tsconfig.json --noEmit
npm test
npm run build
npx playwright test e2e/pwa-foundation.spec.ts \
  --grep 'desktop group chats list on the main screen and open with sending'
```

The Group browser test should run in both configured projects (Chromium and WebKit) when their browsers are installed. If browser execution is unavailable, report that explicitly; typechecking and unit tests are not a substitute for the user-visible flow.

Before considering the plan implemented, also run `git diff --check`, inspect `git status --short`, and review the final diff for unrelated changes. Do not stage or commit unless separately requested.

## Risks and guardrails

- **Pass-through risk:** do not create a new file that merely renames existing helpers. The new module must own complete pure decisions (validation, exact-key eligibility, owner transition, and prompt ownership) while the store owns only atom/localStorage effects.
- **Dependency-cycle risk:** keep the policy module independent of store runtime imports. Define its structural data types there or use type-only imports; `group-store.ts` may depend on the policy module, never the reverse at runtime.
- **Behavior-drift risk:** characterize the v4/legacy matrix and the resume/title/create ordering before moving code. Preserve those tests as behavior contracts, not implementation snapshots.
- **Split-update risk:** room and prompt atoms are separate stores. The Group engine must call the combined preparation operation synchronously before the mirror lifecycle can read state; verify ordering at the `profiles.list` adapter in the lifecycle test.
- **Over-scope risk:** leave general coordination-map key formats, write scheduling optimization, and unrelated engine/controller deepening for separate work.

## Acceptance criteria

- One internal policy module is the sole definition of provenance validation, connection-key eligibility, acquisition ownership transition, prompt ownership, and local-only preservation.
- `group-store.ts` is the sole state/persistence adapter; Group engine/turn/sync code no longer duplicates or reconstructs the provenance rule.
- The startup sweep remains synchronous, local-only, no-op when unchanged, and ordered before module creation/scheduler/pull.
- All invariants above pass, including the existing fallback/failure taxonomy, Profile-vs-Gateway distinction, mirror exclusion, and no-cache behavior.
- Focused tests, full tests, typecheck, build, browser test, and `git diff --check` have real recorded results.
- `CONTEXT.md` describes the resulting ownership without contradicting the implementation.

## Explicit non-goals

- No new storage version or migration rewrite beyond routing existing provenance validation through the new module.
- No wire or snapshot version change; no session field is added to Gateway mirror payloads.
- No per-Gateway session cache, Profile-based session key, or session restoration when switching back to a prior Gateway.
- No change to `4007` stored-id → title → create order, baseline/poll/harvest failure taxonomy, watermarks, holds, room-wide log, prompt payloads, or socket reconnect lifecycle.
- No broad rewrite of Group feed atoms, member/room key formats, `group-store` persistence generally, GatewayController reconnect flow, or unrelated candidates from the architecture review.
