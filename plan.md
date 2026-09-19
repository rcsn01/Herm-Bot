# Implementation plan: capture Group member turns behind one seam

## Status

The initial captured-lifecycle implementation landed in `9b3237a` (`Refactor group member turns around captured lifecycles`). The follow-up ownership, lifecycle, and coverage fixes are currently uncommitted in the working tree. This file is retained as the design and verification checklist.

This replacement plan covers architecture-review Candidate 01: **capture member turns behind one seam**. The previous repository-root `plan.md` was explicitly deleted before this replacement.

Repository root: `/Users/mac/Syncthing/Projects/Moirasia/apps/standalone/Herm-Bot`

The existing Group mirror deepening is already present at `17148bd` (`Refactor Group mirror lifecycle`). This plan starts from that implementation and deepens the remaining member-turn seam. It does not reopen the mirror refactor, the OAuth work, or the Group UI.

## 1. Objective

Make the member-turn module deep: one per-engine instance must own the captured member transport, session resolution, prompt submission, polling, interruption, prompt mirroring, timeout/stranded-reply handling, and stale-result policy.

The finished module must:

- capture the transport passed to one Group engine lifecycle instead of reading a mutable global request slot for every member RPC;
- keep all existing member wire vocabulary and parameter shapes unchanged: `session.resume`, `session.create`, `prompt.submit`, `clarify.respond`, `approval.respond`, and `session.interrupt`, with the member profile in the RPC params;
- keep member session identity, prompt, activity, watermark, epoch, hold, and stranded-reply semantics local to the existing Group modules;
- prevent a stopped engine lifecycle from starting new member requests or publishing late session, prompt, activity, stranded, or reply state into a later lifecycle;
- preserve the policy that an already-running member RPC is not immediately cancelled by this refactor;
- move late-result classification behind the member-turn seam, while preserving the intentional distinction between same-thread supersession and a cross-thread late result;
- leave `startGroupEngine`, `stopGroupEngine`, the Group screen actions, backend routes, and wire vocabulary stable to their callers;
- keep the Group mirror's separate captured adapter seam intact.

This is a deepening of `client/src/features/groups/group-turns.ts` and its callers. It is not a new generic task runner, a new Gateway lifecycle module, or a redesign of Group rounds.

## 2. Constraints and non-goals

### 2.1 Preserve

Do not change:

- backend routes, RPC method names, request parameter names, or profile routing;
- the Group screen's public action signatures or connected UI behavior; the explicit no-active fail-closed wrapper behavior in Section 6, Step 3 is the deliberate disconnected-boundary exception;
- the durable room snapshot format, mirror merge rules, or Group mirror lifecycle;
- member session recovery rules: stored-id/title lookup, code `4007` create fallback, and code `4001` one-shot submit recovery;
- the two-second poll cadence, 180-second base timeout, 20-minute hard cap, prompt mirroring, and stranded-reply harvest behavior except where lifecycle guards are required;
- room holds, epochs, watermarks, round caps, continuation policy, or activity vocabulary.

### 2.2 Explicitly do not add

- Group-module-initiated immediate cancellation or an abort signal for an already-running member RPC (the existing `SessionRuntime.close()` may still abort its scope as a separate controller behavior);
- a second mutable transport slot. The engine may keep active per-lifecycle instance references, like the existing `activeMirror`; those references are lifecycle handles, not a transport registry;
- a new backend endpoint or a new wire abstraction shared with unrelated features;
- app-background pause/restart choreography for the Group engine;
- automatic `session.interrupt` from `stopGroupEngine()`;
- a broad redesign of `SessionRuntime` or `GatewayController`.

The existing optional `GroupEngineRequest` signal argument remains available for the already-deep Group mirror adapter. Member-turn requests deliberately do not pass a signal through the new member adapter.

## 3. Current evidence and the seam to change

The implementation should start from these facts at `17148bd`:

- `client/src/features/groups/group-runtime.ts` owns a mutable `engineRequest` slot, `setEngineTransport()`, and `groupEngineRequest()`.
- `client/src/features/groups/group-turns.ts:121–124` has `memberRequest()`, which calls `groupEngineRequest()` for every session, submit, poll, answer, and harvest RPC. `session.interrupt` is the exception: `group-rounds.ts:580` calls `groupEngineRequest()` directly.
- A member turn spans session resume/create, baseline resume, prompt submission, repeated `session.resume` polling, pending clarify/approval mirroring, timeout, and possible late harvest. It therefore outlives the call site that started it.
- `client/src/features/groups/group-rounds.ts` owns room epochs and decides whether a late result may commit through `shouldCommitMemberTurn()` in the normal responder loop. The continuation loop has a separate strict `isCurrent()` check and currently drops every epoch change, including a cross-thread late result.
- `runGroupChatMemberTurn()` captures an epoch but does not own the transport or the final stale-result decision. `group-rounds.ts` has to inspect the room again after the turn returns. `clearGroupPrompts()` is a stateful definition with no caller in the current tree, so it is not a required interface to preserve.
- `stopGroupEngine()` clears the global transport and stops the mirror. A continuation already awaiting the old transport can nevertheless observe a later transport slot unless every continuation is tied to an instance.
- `GatewayController` stops the Group engine for explicit Scope teardown and dispose. App background handling currently closes `SessionRuntime` without stopping the Group engine; reconnect reopens that same runtime without reinstalling the Group engine.
- The current `GatewayController.installGroupEngine()` already forwards the optional request options to `SessionRuntime.rpc()` for the mirror adapter. That signal plumbing is not a member-turn cancellation contract.
- The Group mirror now captures its own adapter through `createGroupMirrorGateway(transport)`. Member turns should follow the same captured-dependency direction, but remain a separate module and policy.

The root problem is not that member RPCs lack a route wrapper. It is that transport ownership, long polling, shared prompt state, stranded-reply state, and stale-result decisions are split across a mutable slot and two modules. The new seam must concentrate that policy rather than add another forwarding layer.

## 4. Settled design decisions

### 4.1 The deep module and its location

Keep the deep module in `client/src/features/groups/group-turns.ts`.

Do not add `group-member-turns.ts` or a generic async-operation module. `group-turns.ts` already owns the member session vocabulary, prompt projection, polling, timeout, and harvest behavior. Put the captured adapter and lifecycle factory in that file so the implementation has locality.

The module has two internal layers:

1. a small captured `GroupMemberGateway` adapter that turns a member-aware request into the existing raw `GroupEngineRequest` call; and
2. the deep `GroupTurnModule` implementation that owns all turn behavior and lifecycle guards.

The adapter is a real seam: production supplies the captured gateway transport, while tests supply an in-memory member-aware adapter. The Group engine and Group rounds see only `GroupTurnModule`, not route names or transport slots.

### 4.2 Final member-turn interfaces

Use these names and responsibilities unless TypeScript details require an equivalent spelling:

```ts
export interface GroupMemberGateway {
  request(
    member: GroupMember,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown>
}

export function createGroupMemberGateway(
  transport: GroupEngineRequest
): GroupMemberGateway

export interface GroupTurnInput {
  group: string
  member: GroupMember
  prompt: string
  thread: string
}

export type GroupTurnCancelReason =
  | 'engine-stopped'
  | 'room-stopped'
  | 'newer-user'

export type GroupTurnCommit =
  | { accepted: true }
  | { accepted: false; reason: GroupTurnCancelReason }

export type GroupTurnResult =
  | {
      kind: 'reply'
      text: string
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'pass'
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'timed-out'
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'failed'
      reason?: string
      commit: () => GroupTurnCommit
    }
  | {
      kind: 'cancelled'
      reason: GroupTurnCancelReason
      commit: () => GroupTurnCommit
    }

export interface GroupTurnModule {
  run(input: GroupTurnInput): Promise<GroupTurnResult>
  harvest(group: string, member: GroupMember): Promise<void>
  answer(
    entry: GroupPrompt,
    member: GroupMember,
    answers: Record<string, string> | string | undefined
  ): Promise<void>
  interrupt(member: GroupMember, storedSessionId: string): Promise<void>
  stop(): void
}

export function createGroupTurnModule(
  gateway: GroupMemberGateway
): GroupTurnModule
```

This is the module's interface, not a public engine API. `GroupEngine` may use the type internally; the Group screen continues to call its existing `sendToGroupChat`, `stopGroupThread`, and `answerGroupPrompt` functions.

Interface invariants:

- `createGroupTurnModule()` creates one terminal lifecycle. `stop()` is idempotent and there is no restart method; a later engine lifecycle creates a new instance.
- `run()` returns a substantive answer only as `kind: 'reply'`; pass text is normalized to `kind: 'pass'`. Expected member-gateway failures are returned as `kind: 'failed'` with the existing activity reason when available, so the module can classify staleness before the round driver records the existing failed-as-pass activity. The module may record only the current `working` activity after successful session resolution, at the existing point in the flow; result outcome activity is deferred to the round driver. `answer()` still rejects a failed response because the screen owns that action's error swallowing.
- Every `run()` result carries a commit lease. The round driver must call `commit()` immediately before any watermark, activity, or reply mutation. `commit()` rechecks the module lifecycle and room state at publication time; it is the last stale-result guard before synchronous store writes. The lease's return value is authoritative over any earlier result classification: an accepted `room-stopped` cancellation, or any result whose lease reports `room-stopped`, permits the current member watermark to be consumed but never permits a reply append; a lease reporting `engine-stopped` or `newer-user` rejects without result publication or watermark mutation.
- `interrupt()` is best effort at the caller's policy level. It sends one existing `session.interrupt` request while the module is active and does not cancel a different request already in flight.
- Calling any method after `stop()` starts no new member request. `answer()` and `harvest()` leave shared state unchanged when stale; `run()` returns `engine-stopped`; `interrupt()` resolves without issuing a request.

### 4.3 Production adapter mapping

`createGroupMemberGateway(transport)` captures the function value passed to that factory. Its only production mapping is:

```ts
request(member, method, params = {}) {
  return transport(method, { ...params, profile: member.name })
}
```

The member name must overwrite any accidental `profile` value in `params`, matching the current `memberRequest()` behavior. The adapter must not call `groupEngineRequest()` or read any mutable slot.

The adapter does not:

- add an `AbortSignal` to member requests;
- retry, classify, poll, or mutate Group stores;
- change method names, parameter names, session ids, or response shapes.

The raw `GroupEngineRequest` type may continue to carry `options?: { signal?: AbortSignal }` because `groups-sync.ts` uses it. The member adapter calls the raw transport with the existing two arguments, preserving the no-immediate-cancellation decision.

### 4.4 Captured lifecycle ownership

`startGroupEngine(transport)` creates both:

- a new `GroupTurnModule` from a new captured member gateway; and
- the existing new Group mirror from its captured mirror gateway.

The engine stores the current turn module in a private `activeTurns` reference. `stopGroupEngine()` detaches and terminally stops it. No later engine start reuses it. This reference is paired with the captured round driver and mirror as one lifecycle; it is not another place from which a turn looks up transport.

A round drive captures the `GroupTurnModule` instance when the drive starts. This applies to the delayed chained drive created by `sendToGroupChat`, too. A delayed callback must never look up `activeTurns` again, because doing so would let an old drive use a later Scope's adapter.

Lifecycle matrix:

| Event | Turn-module behavior |
| --- | --- |
| Initial connect/start | Create a fresh captured module. New sends use it. |
| Repeated `startGroupEngine()` | Stop the old module first, bump room epochs through existing transition logic, then create the new module. |
| Explicit Scope teardown, profile switch, configure-URL teardown, logout teardown, dispose | `stopGroupEngine()` terminally stops the module and detaches the lifecycle. Its own `stop()` does not abort an already-handed member promise. The controller's following `SessionRuntime.close()` or `dispose()` may still abort that promise through the runtime's existing scope signal. `logout()` currently calls `runtime.close()` before its shared teardown calls `stopGroupEngine()`; preserve that order and do not claim the module protects the interval between those calls. |
| Explicit `stopGroupThread()` | The room driver bumps the epoch and applies holds as today, then calls `turns.interrupt()` for the current member session. This is the existing explicit interrupt action, not automatic lifecycle cancellation. |
| App background | Preserve current behavior: `GatewayController` closes `SessionRuntime` without stopping the Group engine. That runtime close may abort the raw RPC already in flight; the turn module remains alive and later calls use the same `SessionRuntime` object. |
| Reconnect after background or a transport drop | Preserve current behavior: the same captured callback still points at the same `SessionRuntime` object, whose later calls use the reopened runtime. Reconnect does not reinstall the Group engine and the callback does not capture a `SessionRuntime` generation. |
| User send in the same engine | Reuse the module, but capture a fresh room epoch/thread/anchor for that member turn. |

The module's `stop()` is a correctness guard, not an immediate-cancellation mechanism. An already-running raw promise may reject or resolve later. The implementation must wait for that promise to settle and then discard its effects.

### 4.5 Stale-result policy

Move the current epoch decision into the turn module and make the policy explicit:

1. Capture the engine instance, room epoch, thread, and last-entry anchor **before the first asynchronous session-resolution call**.
2. If the module is stopped, the operation is stale regardless of room state; return `engine-stopped` and never publish.
3. If the room epoch is unchanged, the result is current.
4. If the epoch changed and a newer user entry exists in the captured thread after the anchor, return `newer-user`. This has priority even when that newer send also placed a hold on the member, matching the current `shouldCommitMemberTurn()` decision after `runGroupChatMemberTurn()` returns.
5. If the epoch changed, there is no newer same-thread user entry, and the current room holds this member, return `room-stopped`. The normal responder loop must consume that member's current watermark without appending a reply, matching the current stop path. The continuation loop must retain its existing strict epoch guard and drop the result before that watermark mutation.
6. If the epoch changed but there is no newer same-thread user entry and no hold for this member, preserve the existing normal-loop cross-thread late-result policy: the result may still commit into its original thread.

Use the current entry-id anchor technique so front-trimming the bounded room log does not make an index stale. Capture only a non-empty string id as the anchor; if the last entry has no usable id, or that valid id is absent after trimming, use the current implementation's conservative tail scan over the retained log rather than comparing `undefined` ids. `GroupMessage.id` is optional for legacy and mirrored entries; this fallback is a deliberate boundary case.

The module must check this policy:

- before mirroring a poll snapshot that belongs to a superseded/held turn;
- before recording a timeout marker or clearing its prompt mirror;
- before converting a member-gateway failure into a `failed` result;
- when constructing every result; and
- again in the result's `commit()` closure immediately before the round driver mutates the room.

The final `commit()` check is required even though `run()` checked once: another queued continuation can change the room after the promise resolves and before the caller's `await` continuation publishes the result. The round driver must not append, record result activity, or advance a watermark until the lease is accepted. A lease that loses the final race specifically to `room-stopped` is the controlled exception: the driver consumes the watermark only for that stop classification and still never appends the stale reply. A rejected `newer-user` lease may record the one current `cancelled` activity entry that explains the supersession, but it must not publish the old result or advance its watermark.

The normal responder loop uses this per-turn lease for cross-thread acceptance. The continuation loop keeps its current `if (!isCurrent()) return` guard before publication, so it continues to drop every epoch change. This is a drive-level policy distinction, not a second implementation of the entry-anchor/token classification.

### 4.6 Prompt and stranded-reply ownership

Keep the current prompt shape and stranded marker shape. Add only instance-local ownership guards:

- Every stateful member operation that can write prompt or marker state, including `run()` and a non-empty `harvest()`, claims a monotonically increasing per-module operation token keyed by `group + memberKey`. A harvest that finds no current marker returns without claiming a token, so a no-op open/round harvest cannot invalidate an active turn. The token is shared across non-no-op `run()` and `harvest()` operations: the latest claimant owns prompt/marker writes, and a later `run()` reclaims ownership if it starts after a harvest. This ordering is intentional for concurrent open/send boundaries. Prompt mirror writes, prompt clears, and timeout-marker writes require both an active module and the latest token for that group/member. An older continuation may finish its RPC but cannot overwrite or clear a newer turn's prompt or stranded marker. `answer()` does not claim a turn token; it uses the active-module check and request-id comparison below.
- When a prompt is cleared, compare the request id that the operation observed with the current stored prompt. An old poll or answer must not delete a newer request's card. A poll must also hold the latest operation token before it writes a replacement prompt.
- `harvest()` captures an existing marker's `before` and `thread` values, then claims its operation token before its read. Before clearing the marker or appending the late reply, require the module to remain active, the token to remain current, and the current marker to still represent the captured marker. Use object identity when the marker is an object; for a legacy numeric marker, the token/version check is the discriminator because equal numbers have no identity.
- All session-id persistence, prompt-store writes, `$groupNeedsYou` writes, and stranded updates after an await must check the module's active state and operation ownership. Result activity entries and normal-turn room appends after an await must go through the result commit lease; harvested replies use the marker/token ownership check instead. The old module must never publish into a later engine lifecycle.
- A module stop does not erase already-committed local markers or prompt entries. It only prevents old continuations from changing them. Existing store reset/Scope policy remains outside this plan.

The token is local lifecycle bookkeeping, not a new persisted wire field and not a cancellation mechanism.

## 5. Target ownership after the refactor

### `group-turns.ts` — deep member-turn module

Owns:

- `GroupMemberGateway` and the captured production adapter;
- `GroupTurnModule`, input/result types, and terminal lifecycle state;
- session resolution and session-id persistence;
- prompt submission and one-shot runtime-session recovery;
- baseline reads and polling;
- pass/reply selection and prompt projection;
- the current `working` activity at the same post-session-resolution point as today; result outcome activity stays with the round driver;
- prompt answers and member interruption;
- timeout, hard-cap, stranded marker creation, and late harvest;
- per-turn prompt/marker ownership and stale-result commit leases.

It may continue to export pure helpers that have independent callers or useful pure tests, such as `isGroupPassText`, `pickGroupTurnReply`, and `isSessionGoneError`. Stateful turn operations must be reached through `GroupTurnModule` rather than free functions that consult a global transport.

### `group-rounds.ts` — room policy and sequencing

Owns:

- mention parsing, responder selection, speaker rotation, prompt construction, holds, room epoch changes, round/continuation caps, and activity policy at round boundaries;
- synchronous publication of an accepted `GroupTurnResult` into the room log and watermark;
- publication of accepted result activity (`replied`, `passed`, `timed-out`, or `failed`) at the round boundary; the module keeps the existing post-session-resolution `working` activity point;
- creating a round-drive closure around one captured `GroupTurnModule`;
- the existing drive-level distinction between the normal responder loop's cross-thread acceptance and the continuation loop's strict epoch cancellation.

It must not import `groupEngineRequest`, call a raw gateway, or reimplement the turn module's entry-anchor, hold, or operation-token classification.

### `group-engine.ts` — public Group engine and lifecycle owner

Owns:

- `activeTurns` and the current round-drive closure;
- creating and stopping one turn module per engine lifecycle;
- installing the existing Group mirror scheduler;
- delegating the existing public actions to the current captured module/round driver;
- existing room epoch transition behavior.

The public function signatures used by `group-screen.tsx` remain unchanged.

### `group-runtime.ts` — runtime-only Group state and shared type

Keeps:

- `$groupActivity`, `recordGroupActivity`, `$groupPrompts`, and the `GroupPrompt` type;
- the raw `GroupEngineRequest` type shared by the mirror adapter and member adapter.

Removes the mutable request slot and its setter/wrapper. The file comment must no longer describe a global member transport.

### `groups-sync.ts` — existing independent mirror module

No protocol redesign. It continues to use its own captured semantic adapter and must not depend on the member-turn module. The same raw transport may be passed to two separate adapters at engine start, but neither adapter may retrieve it from a global slot.

### `GatewayController` and `SessionRuntime`

No lifecycle expansion is planned. Keep:

- `installGroupEngine()` forwarding the optional transport options to `runtime.rpc()` for mirror cancellation;
- explicit Scope teardown stopping the Group engine;
- app-background close without Group-engine stop;
- reconnect reopening the existing runtime without reinstalling the Group engine.

Only type-level adjustments should be made if the removed setter/wrapper was imported.

## 6. File-by-file implementation steps

### Step 1 — Define the captured member adapter and module interface

File: `client/src/features/groups/group-turns.ts`

1. Import `GroupEngineRequest` as a type from `group-runtime.ts`; do not import `groupEngineRequest`.
2. Add the finalized `GroupMemberGateway`, `GroupTurnInput`, `GroupTurnResult`, commit, cancellation, and `GroupTurnModule` types.
3. Implement `createGroupMemberGateway(transport)` so it captures the callback and adds `profile: member.name` exactly once per request.
4. Implement `createGroupTurnModule(gateway)` with all mutable lifecycle state in its closure:
   - terminal `stopped` flag;
   - operation-token counter and latest-token map keyed by `group + memberKey`, claimed by both `run()` and `harvest()`;
   - only the local marker/version bookkeeping needed to distinguish a legacy numeric marker from a later replacement;
   - no module-global transport or mutable per-operation/session/prompt/timeout/marker state; the shared room atoms remain the runtime state owners.
5. Move the current `memberRequest()` behavior into the captured gateway path. All private helpers (`ensureGroupChatSession`, `submitGroupTurnPrompt`, polling, prompt sync, answer, harvest) must receive/use the captured gateway or the factory closure.
6. Capture room epoch, thread, and entry-id anchor before `ensureGroupChatSession()` begins. Implement the settled stale policy and the commit lease described in Section 4.5.
7. Place active and ownership checks after every awaited member request and timer boundary before:
   - starting another member request;
   - persisting a session key;
   - changing `$groupPrompts` or `$groupNeedsYou`;
   - recording activity;
   - writing a stranded marker;
   - clearing a marker;
   - appending a harvested reply.
8. Preserve the existing wire/error decisions for `4007`, `4001`, and transient resume/poll handling. Keep baseline and poll resume failures best-effort and continue polling as today; convert errors that currently escape session resolution or prompt submission into `kind: 'failed'` after stale classification. The round driver still records `failed` activity and treats those failures as a pass when current. Do not let a stale same-thread/held/engine-stopped failure leak a late failure activity entry.
9. Make `stop()` terminal and idempotent. It must not abort a member request already handed to the gateway. It must prevent subsequent polls, prompt updates, answer cleanup, harvest publication, and retry-like continuation.
10. Make `interrupt()` use the captured gateway and preserve the exact `{ session_id, profile }` wire params. If the module is already stopped, it must not call the gateway.
11. Hide stateful free functions behind the factory. Remove or make private the old global-dependent exports (`ensureGroupChatSession`, `answerGroupPrompt`, `runGroupChatMemberTurn`, `harvestStrandedGroupReply`, `syncGroupClarify`, and `memberRequest`) after their callers and tests migrate. Delete `clearGroupPrompts()` as well: the current grep inventory has no caller, and keeping an unowned prompt-store mutator would violate this interface. Retain pure helpers only where they still have a legitimate in-process interface.

### Step 2 — Make the round driver capture the turn module

File: `client/src/features/groups/group-rounds.ts`

1. Remove the `groupEngineRequest` import.
2. Import `GroupTurnModule` and `GroupTurnResult` as internal types.
3. Replace direct imports of `runGroupChatMemberTurn` and `harvestStrandedGroupReply` with a small `createGroupRoundDriver(turns)` factory. Export this factory only from `group-rounds.ts` for in-cluster tests; do not re-export it from the public engine facade. Its returned `sendToGroupChat` and `stopGroupThread` methods retain the current public action shapes for the engine, while their closures capture `turns`. Define the internal `GroupRoundDriver` shape as those two methods plus a non-public `deactivate()` lifecycle hook; the hook only marks delayed drives inactive and is not part of the engine facade's action signatures.
4. Keep `runGroupChatRounds` private to that driver or give it the captured module as an explicit internal dependency. It must not look up the current module inside the loop.
5. In the normal responder loop:
   - call `turns.harvest()` at the existing harvest boundary;
   - call `turns.run({ group, member, prompt, thread })`; the module records the existing `working` activity only after session resolution succeeds and the active check passes, rather than moving that activity earlier than today;
   - handle `reply`, `pass`, `timed-out`, and `failed` as typed outcomes without interpreting raw pass text. A `failed` result carries the existing reason and is a pass for room sequencing;
   - call the result's `commit()` immediately before any result activity, watermark, or reply mutation. The module must not record `replied`, `passed`, `timed-out`, or `failed` before this classification;
   - on an accepted reply/pass/timed-out/failed lease, record the corresponding result activity and preserve the current watermark and append behavior;
   - after inspecting the lease result, consume the current member watermark only when the lease is accepted for a `room-stopped` cancellation or reports `reason: 'room-stopped'`; append nothing and exit. If the lease instead reports `newer-user` or `engine-stopped`, make no watermark mutation. This preserves the current explicit-stop behavior without trusting an obsolete result reason;
   - on `newer-user`, record the existing member-level `cancelled` activity, do not advance the old watermark, and exit;
   - on `engine-stopped`, publish no further activity or room state and exit; any `working` activity already recorded after session resolution is the existing operation-start record, not a stale result outcome. A drive-abandoned/deactivated flag must also suppress its `finally` settled/running cleanup if the module stopped before the room epoch transition ran.
6. In the continuation loop, retain the current strict `if (!isCurrent()) return` check before result activity or `commit()`. It must continue to drop every epoch change, including a cross-thread result, rather than inheriting the normal responder loop's cross-thread acceptance; a dropped continuation publishes no result activity, watermark, or reply. For a current result, use the same failed/pass, watermark, and publication behavior as above, but preserve the current continuation activity shape: a continuation `failed` activity does not gain the normal loop's optional error reason unless the existing policy is deliberately changed and tested.
7. Keep the existing `isCurrent()` room-epoch checks at round boundaries. They protect the round driver; the turn module protects the long-lived member operation and its publication lease. Neither replaces the other. Do not add a generic `!isCurrent()` check to the normal responder loop that would erase its existing cross-thread late-reply behavior.
8. Delete `shouldCommitMemberTurn()` from the round module once its per-turn classification lives in the turn module. Do not leave a second entry-anchor/token policy in the rounds module; the continuation guard is a drive-level policy, not a duplicate classifier.
9. In `stopGroupThread`, retain the current synchronous epoch/hold/local activity mutation. After that mutation, call `turns.interrupt(onTurn, storedSessionId)` when an active speaker and stored session id exist, and preserve the best-effort catch. A missing/stopped module must not prevent the local hold/epoch stop. `GroupChatRoom.turn` stores only `member.name`, so preserve the existing name-based lookup; duplicate source-qualified members with the same name remain an existing ambiguity and do not get a new persisted identity shape in this refactor.
10. Ensure the immediate and delayed `runGroupChatRounds(...).catch(...)` wrappers capture the same round-driver/turn instance. They must never call a later active transport by lookup, and their rejection cleanup must check the captured driver's `deactivate()` state and current room epoch so an old drive cannot set a new lifecycle's `running` flag to `false` after a restart. The drive `finally` block uses the same guard before recording settled/clearing `running`.

### Step 3 — Make `group-engine.ts` own the active instance

File: `client/src/features/groups/group-engine.ts`

1. Import `createGroupMemberGateway`, `createGroupTurnModule`, and the turn-module type.
2. Add a private `activeTurns` reference and a private captured round-driver reference next to `activeMirror`. Set and detach them as one lifecycle; do not let one reference outlive the other. The driver has an internal `deactivate()` hook for the short interval between detachment and module stop.
3. In `startGroupEngine(transport)`:
   - stop the previous engine first when any active lifecycle reference exists;
   - create a new member gateway from `transport`;
   - create a new turn module and a new round driver from that module;
   - install the new references before the existing mirror pull/scheduler work;
   - keep the existing mirror construction and startup barrier unchanged.
4. In `stopGroupEngine()`:
   - detach the active round driver and turn module so new public calls cannot use the old instance;
   - call the detached driver's internal `deactivate()` hook before stopping the turn module, so delayed drives and outer rejection cleanup become inert immediately;
   - stop the turn module and mirror;
   - clear the scheduler;
   - keep the existing room epoch/running transition;
   - remove the `setEngineTransport(null)` call because the global slot no longer exists.
5. Change `openGroupRoom()` to capture the current mirror and current turn module at call time. Pull through the captured mirror and harvest through the captured turn module when one exists; with no active turn module, skip the harvest rather than consulting a fallback. A later engine start must not change the adapter used by that open operation.
6. Replace direct re-exports of `sendToGroupChat`, `stopGroupThread`, and `answerGroupPrompt` with thin public wrappers that delegate to the active captured driver/module while preserving their current signatures. Define the fail-closed behavior exactly: with no active lifecycle, `sendToGroupChat()` returns `null`, `stopGroupThread()` resolves without a local mutation, and `answerGroupPrompt()` resolves without sending or clearing a prompt. With an active but terminally stopped module, `answerGroupPrompt()` also resolves without sending or clearing; with an active driver whose turn module is already stopped, `stopGroupThread()` still performs its synchronous local epoch/hold/activity mutation before the best-effort interrupt no-op. No wrapper may fall back to a global transport.
7. Keep the `GroupEngineTransport` type alias available from the engine's existing type surface, pointing to the shared raw `GroupEngineRequest` type. Do not expose `GroupTurnModule` through the public Group engine facade unless a compile-time need proves it necessary.

### Step 4 — Remove the mutable transport slot

File: `client/src/features/groups/group-runtime.ts`

1. Delete `engineRequest`, `setEngineTransport()`, and `groupEngineRequest()`.
2. Keep `GroupEngineRequest` as the raw callback type used by both captured adapters. Keep its optional signal-bearing options argument for the mirror path.
3. Rewrite the module comment to say that the Group engine creates per-lifecycle member and mirror adapters from this type, while this file owns only runtime atoms and activity/prompt state.
4. Do not move activity or prompt atoms into the turn module; the turn module owns their policy, while the existing runtime file remains their state owner.

Files: `client/src/state/gateway-controller.ts`, `client/src/gateway/session-runtime.ts`

- Make no behavioral changes. Verify that `installGroupEngine()` still forwards `(method, params, options)` to `runtime.rpc()` for the mirror adapter.
- At this revision, `GatewayController.logout()` calls `runtime.close()` before `teardownGatewayScope()` stops the Group engine. Preserve that order; the module's stop guard does not cover the interval before the stop call, and `SessionRuntime.close()` remains the existing mechanism that may abort its in-flight RPCs.
- Do not stop/restart the Group engine on app background, transport-drop reconnect, or background reconnect as part of this work.

### Step 5 — Migrate tests through the new seam

File: `client/src/features/groups/group-turns.test.ts`

Replace global `setEngineTransport()` setup with a fake `GroupMemberGateway` and a `createGroupTurnModule()` instance per test or per lifecycle. Keep a small raw-transport contract suite for `createGroupMemberGateway()`.

Retain coverage for:

- profile injection and member-aware request mapping;
- stored-id/title session resolution and session creation params;
- non-`4007` resume failure becoming a `failed` result without an unintended session create;
- `4001` submit recovery through the stored id;
- normal reply, pass, poll cadence, prompt mirroring, clarify/approval answers, and batch answers;
- explicit hold/stop abandoning the next poll;
- timeout at the hard cap and stranded marker creation;
- late harvest into the original thread and marker retention on unreachable/working sessions;
- expected failure reason extraction in the `failed` result, while unexpected answer failures still reject; the round-driver activity assertions live in the rounds suite.

Add coverage for:

- a deferred member request that resolves after `turns.stop()` does not persist a session, update prompts, create a marker, append a reply, or issue another request;
- stopping a module does not abort or interrupt the deferred request; its promise is allowed to settle and the result is discarded;
- an old stopped module and a newly created module use different captured gateways even when the raw callback function is otherwise identical;
- a newer same-thread user entry produces `newer-user` and cannot commit the old reply;
- an explicit member hold produces `room-stopped`, including the case where the poll RPC was already in flight when the hold was written;
- a cross-thread epoch bump preserves the existing late-reply commit behavior in the normal responder loop;
- the commit lease rejects a result if the room changes after `run()` decides but before the caller invokes `commit()`;
- an older prompt poll cannot clear or overwrite a newer prompt request;
- an answer that settles after stop or after a newer request id leaves the current prompt intact;
- a harvest with no current marker does not claim a token or invalidate an active run;
- a non-empty harvest cannot clear or overwrite a newer stranded marker or prompt owned by a newer run;
- stopping the module after a failure or timeout suppresses the corresponding stale result activity and publication.

Pure helper tests for pass text, reply selection, and error classification may remain direct because they are in-process functions rather than transport tests. Do not recreate a global transport slot in the migrated suite.

File: `client/src/features/groups/group-rounds.test.ts`

- Remove the `group-turns` mock that replaces free global-dependent functions and remove `setEngineTransport()` setup.
- Build a small fake `GroupTurnModule` with scripted `run`, `harvest`, `answer`, `interrupt`, and `stop` behavior; return typed `GroupTurnResult` values with controllable commit leases.
- Exercise `createGroupRoundDriver(fakeTurns)` or the equivalent internal dependency seam.
- Preserve coverage for mentions, holds, prompt construction, round sequencing, continuation rounds, failed-result-as-pass, normal failed-activity reasons, continuation no-reason failed activity, watermarks, caps, chained sends, and explicit interruption.
- Add outcome/lease cases proving that a rejected `newer-user` result does not append a member reply or advance the old watermark; an accepted `room-stopped` result consumes the current member watermark without appending; an accepted cross-thread result lands in its original thread in the normal loop; and the continuation loop drops a cross-thread epoch change before result activity, commit, watermark, or append.
- Verify result activity is published only after an accepted lease (with the explicit `newer-user` supersession-cancellation activity exception), while the normal loop still records that member-level `cancelled` activity and the room-level cancellation activity at a boundary.

File: `client/src/features/groups/group-engine.test.ts`

Keep the existing mirror/lifecycle/full-round coverage and add the scope-capture cases:

- start an old engine and begin a deferred member turn;
- stop and start a new engine with a different transport;
- resolve the old operation and assert that it makes no new old/new transport call and does not mutate the new lifecycle's room state;
- verify a send after the restart uses the new captured module;
- verify a delayed chained round drive retains the old module and becomes stale instead of consulting the new active module, and its finalizer/outer rejection cleanup cannot change the new lifecycle's `running` state;
- verify `stopGroupThread` still changes epoch/holds locally and uses the current module's captured `session.interrupt` adapter;
- verify member actions route through the captured module by recording old/new adapter calls; a repository search and typecheck must show that no engine code uses `groupEngineRequest`;
- verify the no-active wrappers fail closed with their defined `null`/resolved-no-op behavior, while an active stopped driver still performs the local stop mutation;
- verify `openGroupRoom()` harvests through the turn module captured by that lifecycle, not the currently active module.

Update existing tests that currently assert the global transport is cleared. Their replacement assertion is lifecycle isolation, not a mutable-slot error message.

File: `client/src/state/gateway-controller.test.ts`

- Keep the existing optional-signal forwarding coverage for the mirror.
- Add no new background/reconnect lifecycle contract unless an existing test needs a type adjustment; this plan intentionally preserves the current behavior that the Group engine remains installed across `SessionRuntime.close()` and reconnect.

### Step 6 — Update the glossary

File: `CONTEXT.md`

Update the Group send engine entry to say:

- the engine creates a per-lifecycle `GroupTurnModule` from a captured `GroupMemberGateway`;
- the member-turn module owns session resolution, polling, prompt/stranded behavior, interruption, and stale-result policy;
- the Group mirror has its separate captured adapter;
- no mutable global member transport remains.

Update the Group mirror entry's final sentence from a global member transport to a separate per-lifecycle `GroupMemberGateway` captured by the engine. Its adapter and lifecycle remain separate from member turns. Add a `Group member-turn module` glossary entry only if the existing entries cannot state these ownership facts clearly without a new term.

## 7. Verification and definition of done

Run checks in increasing scope after implementation:

1. `cd client && npx vitest run src/features/groups/group-turns.test.ts src/features/groups/group-rounds.test.ts src/features/groups/group-engine.test.ts src/features/groups/groups-mirror.test.ts src/state/gateway-controller.test.ts`
2. From the repository root: `rg -n "groupEngineRequest|setEngineTransport" client/src --glob '*.{ts,tsx}' --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` and confirm there are no production references after the migration (test fixtures should use the captured seams, not suppress the search).
3. `cd client && npm run typecheck`
4. `cd client && npm test`
5. `cd client && npm run build`
6. From the repository root: `git diff --check`

Definition of done:

- No production file imports or calls `groupEngineRequest` or `setEngineTransport`.
- The only raw member transport call path is the captured `GroupMemberGateway` adapter created for one engine lifecycle.
- Every delayed round drive and every long-lived turn uses the module instance captured when it began.
- Stopping an engine prevents old continuations from starting new member RPCs or publishing stale state, while an already-running RPC is not actively cancelled by this refactor.
- Same-thread newer-user results are cancelled without advancing the old watermark; an explicit room stop produces no reply but consumes the current member watermark in the normal loop; a normal-loop cross-thread late result retains its existing commit behavior, while the continuation loop still drops every epoch change.
- Expected member-gateway failures become stale-aware `failed` results and preserve failed-as-pass sequencing/activity only when current.
- Prompt and stranded markers cannot be cleared or overwritten by an older continuation.
- The no-active public wrappers have the defined fail-closed `null`/resolved-no-op behavior.
- Backend routes, wire params, Group screen imports/signatures, and mirror behavior remain unchanged.
- Focused tests, typecheck, full suite, build, and diff whitespace checks pass. Do not claim any of these checks passed until they are actually run.
