# Implementation plan: deepen the Group mirror wire protocol

## Status

Implementation complete. Gateway routes and the Group chat UI were left unchanged.

Repository root: `/Users/mac/Syncthing/Projects/Moirasia/apps/standalone/Herm-Bot`

The existing root `plan.md` was deleted before this replacement, as requested. This plan covers the latest architecture-review Candidate 01: the **Group mirror**. It does not revive the older OAuth plan or repeat the already-landed Group send-engine work.

## 1. Objective

Give the Group mirror a real module interface and a captured gateway adapter without changing its wire contract or its display-projection semantics.

The finished module must:

- keep the existing v1/v2-to-v3 normalization, durable room keys, stable message keys, member merge, tombstone handling, bounded snapshots, gateway byte accounting, and local rich-copy preservation;
- keep the existing read → merge → CAS write → read-back protocol, including no-op detection and bounded exponential retry;
- stop the mirror from importing or calling the global `groupEngineRequest` slot;
- make each Group engine start create a fresh mirror instance that captures the transport it was given;
- make a stopped mirror instance unable to publish, issue another request, schedule a retry, or affect a later engine Scope;
- use an explicit semantic `GroupMirrorGateway` adapter so mirror behavior tests do not need to know RPC route names;
- preserve the exact production route vocabulary and request bytes: `profiles.list` with `{ include_sessions: false }`, the `default` profile lookup, and `profiles.configure` with `name: 'default'`, the `ui_meta` payload, and the optional `ui_meta_expected_revisions` map;
- leave the global runtime transport in place for `group-rounds.ts` and `group-turns.ts`, which still need it for member/session RPCs.

This is a deepening of the existing `groups-sync.ts` module, not a speculative new `group-mirror.ts` abstraction.

## 2. Settled design decisions

These are the recommended answers to the architecture-review questions. They are settled for implementation; do not reopen them during the coding pass unless repository evidence makes them impossible.

### 2.1 Scope

Deepen only the Group mirror's wire protocol and lifecycle. Do not redesign:

- the local Group send engine;
- the round-robin drive, member turns, prompts, holds, watermarks, stranded-reply harvest, or activity feed;
- the v3 snapshot format or its merge rules;
- the gateway backend or its `profiles.*` routes;
- the Group room UI;
- Scope management outside the signal plumbing needed to cancel mirror requests.

### 2.2 Module location

Keep the deep module in `client/src/features/groups/groups-sync.ts`.

Do not add `group-mirror.ts`. The current file already owns the snapshot vocabulary and merge semantics. The implementation should remove its module-global job state and put the stateful wire/lifecycle policy behind a factory in the same module. This gives the existing projection code locality with the policy that consumes it, without adding a shallow forwarding module.

The file will contain two layers:

1. **Pure/in-process projection layer** — the existing normalization, sizing, snapshot, merge, and local-store projection functions.
2. **Group mirror interface layer** — the new `GroupMirrorGateway` adapter seam and the `createGroupMirror(gateway)` lifecycle instance.

The raw `profiles.list` and `profiles.configure` mapping belongs to the production adapter in the same file. The mirror interface sees semantic remote state, not route-shaped response records.

### 2.3 Mirror interface

Expose a factory and a small lifecycle interface:

```ts
export interface GroupMirror {
  pull(): Promise<boolean>
  schedule(options?: GroupMirrorSchedule): void
  stop(): void
}

export function createGroupMirror(gateway: GroupMirrorGateway): GroupMirror
```

There is deliberately no restart method. A factory call creates one live instance. `stop()` is terminal and idempotent. A later Group engine start must call the factory again and must never reuse the stopped instance.

`pull()` preserves the current boolean meaning: `true` when a present remote snapshot, including an empty v3 envelope, was applied; `false` when there was no snapshot or the operation became stale/stopped. Active non-abort adapter errors remain rejected so existing callers can catch them.

A newly created mirror starts in an initial-pull state. The engine installs its scheduler before starting that pull so local changes can record their room markers, but `schedule()` queues those markers without writing until the first pull (or all concurrent first pulls) settles. The pull then merges with those queued markers and releases the queued work. This is the actual startup barrier that prevents a non-empty stale local cache from publishing before hydration. Direct mirror tests must prime the instance with a pull before asserting ordinary scheduled writes.

`GroupMirrorSchedule` carries the only marker currently produced by `group-store`:

```ts
export interface GroupMirrorSchedule {
  changedRooms?: string[]
}
```

`schedule()` is a no-op after `stop()`. It also refuses an empty local snapshot. The existing pure merge functions continue to accept explicit tombstone markers, but the repository has no production room-delete/disband caller that can supply them, so the new lifecycle interface does not expose an `allowEmpty` escape hatch or a dead `deletedRooms` option.

### 2.4 Gateway adapter interface

Use a semantic adapter, not a generic route callback inside the mirror:

```ts
export interface GroupMirrorRemoteState {
  snapshot: GroupChatSyncSnapshot | null
  revision: number
  supportsCas: boolean
}

export interface GroupMirrorWriteResult {
  applied: boolean
  revision?: number
}

export interface GroupMirrorGateway {
  read(signal: AbortSignal): Promise<GroupMirrorRemoteState>
  write(
    snapshot: GroupChatSyncSnapshot,
    expectedRevision: number | undefined,
    signal: AbortSignal
  ): Promise<GroupMirrorWriteResult>
}
```

The adapter owns one read or one write against the remote profile. The mirror owns the higher-level protocol:

- when to read;
- which local and remote snapshots to merge;
- when CAS is required;
- how to calculate and validate the next revision;
- when a read-back is mandatory;
- how to preserve changed local rooms while applying remote tombstones;
- how to debounce and retry;
- when a result is stale and must be discarded.

The production adapter owns raw wire mapping and response extraction. Its factory will be named `createGroupMirrorGateway(transport)` and will capture the injected `GroupEngineRequest`; it must not call the mutable `groupEngineRequest()` function from `group-runtime.ts`.

Tests will provide semantic in-memory and deferred adapters directly to `createGroupMirror()`. Separate adapter contract tests will exercise `createGroupMirrorGateway()` with a recording transport to pin the production request bytes.

### 2.5 Transport separation

`group-runtime.ts` remains the global transport slot for member/session RPCs used by `group-rounds.ts` and `group-turns.ts`.

The mirror must not import the `groupEngineRequest` function. It receives a captured transport through `createGroupMirrorGateway(transport)`. This is the critical seam: an old mirror cannot accidentally reach a new Scope merely because the global runtime slot was replaced.

The injected request type gains an optional signal-bearing third argument so the mirror can abort its own work while existing two-argument member RPC calls remain source-compatible:

```ts
export type GroupEngineRequest = (
  method: string,
  params?: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<unknown>
```

Only the injected callback type and the controller's callback need the third argument. `groupEngineRequest()` remains the two-argument member-RPC wrapper because no current member caller supplies a signal and the mirror must not use that mutable slot.

### 2.6 Lifecycle safety

Abort is a cancellation mechanism, not the correctness condition. `stop()` is terminal, so the correctness guard is the stopped flag plus the instance's private closure state. Every asynchronous boundary must check that flag and the instance signal before acting.

A stopped instance must not:

- replace `$groupChats` after a read or read-back resolves;
- issue a write after a stale read resolves;
- issue a read-back after a stale write resolves;
- requeue a failed job;
- create or honor a debounce/retry timer;
- reset retry or in-flight state in a later lifecycle;
- publish through a scheduler installed for a later engine start.

The implementation will use:

- an `AbortController` owned by the mirror instance and passed to every adapter method;
- a terminal `stopped` flag checked at every asynchronous boundary;
- per-instance pending, active-job, timer, in-flight, and retry state.

A generation counter is deliberately not added. Because a mirror cannot restart and a later engine start creates a different closure, a generation would duplicate the terminal stopped check without distinguishing any additional live case.

### 2.7 Glossary ownership

Update `CONTEXT.md` so the Group mirror entry names:

- `groups-sync.ts` as the owner;
- `createGroupMirror(gateway)` and its `pull`/`schedule`/`stop` interface;
- the semantic `GroupMirrorGateway` seam and captured production adapter;
- the fact that the member-turn transport remains in `group-runtime.ts` and is separate from the mirror adapter.

Update the Group send engine entry so “the injected transport is the engine's only seam to the wire” is no longer inaccurate. The injected transport remains the member-turn seam; the mirror has its own captured adapter seam.

## 3. Current evidence and seam to change

The implementation pass should begin from these repository facts rather than re-deriving a different boundary:

- `client/src/features/groups/groups-sync.ts` currently combines pure projection helpers with the stateful flush job.
- The file imports `groupEngineRequest` directly.
- The stateful section has module-global `disposed`, `inFlight`, `pending`, `debounceTimer`, `retryTimer`, and `retryCount` variables.
- `readRemoteSnapshot()` sends `profiles.list` with `{ include_sessions: false }`, finds `name === 'default'`, reads `ui_meta['hermes-bots-groups']`, and extracts `ui_meta_revisions`.
- `flushGroupChatSync()` sends `profiles.configure` with `name: 'default'`, `ui_meta`, and the expected revision only when CAS is supported.
- It validates `applied.ui_meta`, validates a CAS write revision, reads back the profile, checks the persisted revision, and merges the confirmed snapshot into the local store.
- `stopGroupChatSync()` clears timers and pending state but cannot cancel or neutralize async work already awaiting `groupEngineRequest`.
- `startGroupChatSync()` only changes `disposed`, so a late continuation can run after a later engine start has reopened the global transport slot.
- `client/src/features/groups/group-engine.ts` currently installs the global member transport, starts the global mirror job, installs the store scheduler, and fires the initial pull.
- `client/src/features/groups/group-runtime.ts` is still required by `group-rounds.ts` and `group-turns.ts`; its global slot cannot simply be removed.
- `client/src/state/gateway-controller.ts` currently passes `(method, params) => this.runtime.rpc(method, params)` and must forward the optional signal for mirror cancellation.
- Existing tests cover projection sizing, keys, v1 normalization, merge behavior, legacy threads, a normal engine-level read-back, a configure/revision failure that enters the retry path, no-empty scheduling, Group engine lifecycle, and full rounds. The current retry fixture fails before a successful read-back and never proves that a read-back revision race retries, so the migrated suite must add that coverage rather than describe the old test as a read-back retry test.
- `startGroupEngine()` currently installs the scheduler before an unawaited initial pull. A non-empty local cache can therefore publish before hydration; the empty-cache guard does not cover that case. The new per-instance mirror must queue scheduled markers and suppress writes until its first pull settles.
- A pull can overlap a flush after the flush has removed its job from `pending`. The mirror serializes their protocol operations, and read-back preservation still includes both the active captured job and the remaining pending markers so a remote tombstone cannot delete a room being written.
- There is no production caller for `allowEmpty` or `deletedRooms` in the old scheduler. Keep tombstone behavior in the pure merge functions, but do not carry a dead local-disband escape hatch into the new lifecycle interface or claim that an explicit final-room publish exists.
- `teardownGatewayScope()` and `dispose()` stop the Group engine before closing the runtime, but `logout()` closes the runtime before entering shared teardown and app-background handling calls `runtime.close()` without stopping the Group engine. Reconnect reopens the same runtime and does not call `startGroupEngine()` again. The plan must describe these paths accurately rather than claim that every runtime close stops the mirror.

## 4. Target architecture

### 4.1 Ownership after the refactor

`groups-sync.ts` owns:

- `GroupChatSyncRoom` and `GroupChatSyncSnapshot`;
- the v1/v2-to-v3 normalization path;
- gateway byte sizing and snapshot bounding;
- durable room, message, and member identity keys;
- snapshot merge, tombstone, rename, and local rich-copy policy;
- the `GroupMirrorGateway` and `GroupMirror` interfaces;
- the production gateway adapter;
- the per-instance debounce, CAS, read-back, retry, abort, startup-barrier, and terminal-stop policy.

`group-engine.ts` owns:

- the active mirror instance reference for the current engine lifecycle;
- installing the mirror's `schedule` method into `group-store`;
- starting the initial `pull`;
- delegating `openGroupRoom` pulls to the current instance;
- the existing member-turn transport installation and engine teardown;
- the room epoch/running reset on gateway transition.

`group-runtime.ts` owns:

- the existing global member RPC transport slot;
- activity and prompt atoms;
- the optional signal forwarding on the injected request type.

`group-store.ts` remains the scheduler host. It does not learn route names or mirror protocol rules.

### 4.2 Production adapter mapping

Implement `createGroupMirrorGateway(transport)` next to the mirror interface in `groups-sync.ts`.

`read(signal)` must:

1. call `transport('profiles.list', { include_sessions: false }, { signal })`;
2. treat the result as the existing `{ profiles: [...] }` profiles-list shape;
3. select the row whose `name` is exactly `default`;
4. read the `hermes-bots-groups` value only when that row's `ui_meta` is a non-null, non-array object and the value is a non-null, non-array object;
5. return `snapshot: null` when the default row, usable `ui_meta`, or snapshot is absent;
6. normalize the revision key to a non-negative finite number when the wire value is a number; use `0` for `undefined`, null, non-numeric, negative, `NaN`, `Infinity`, or a missing key;
7. set `supportsCas` only when the default row has its own `ui_meta_revisions` property, even if that property's value is null or the map's key is absent. This preserves the current capability detection, which is property-presence based rather than value based.

`write(snapshot, expectedRevision, signal)` must:

1. build exactly `{ name: 'default', ui_meta: { 'hermes-bots-groups': snapshot } }`;
2. add exactly `{ 'hermes-bots-groups': expectedRevision }` under `ui_meta_expected_revisions` only when `expectedRevision !== undefined`;
3. call `transport('profiles.configure', params, { signal })`;
4. map `result.applied.ui_meta === true` to `applied`;
5. map the returned revision to a number only when the wire value is a finite non-negative number; otherwise leave `revision` undefined. Invalid acknowledgements must not satisfy the mirror's exact `writeRevision` check.

Do not move merge policy into this adapter. Do not make the adapter retry, read back, or update `$groupChats`.

### 4.3 Mirror instance state

Move the current module-global state into the closure created by `createGroupMirror()`:

```ts
let stopped = false
let initialPullSettled = false
let initialPulls = 0
let inFlight = false
let activeJob: SyncPending | null = null
let pending: SyncPending | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
const controller = new AbortController()
```

The exact names may differ, but the ownership must be per instance. Constants such as the debounce duration and retry ceiling can remain module constants because they are policy constants, not mutable lifecycle state.

`isCurrent(signal)` must require both `!stopped` and `!signal.aborted`. The captured signal is always the instance controller's signal. `activeJob` is separate from `pending`: it keeps the markers of a flush that has been removed from the pending queue visible to a concurrent pull.

`stop()` must be idempotent and must, in this order or an equivalent order that preserves the same invariants:

1. mark the instance stopped;
2. abort the instance controller;
3. clear the debounce and retry timers;
4. clear pending and active job state and reset retry/in-flight bookkeeping;
5. leave the instance permanently stopped.

A later call to `schedule()` must return before taking a snapshot. A later call to `pull()` must resolve as stale/no-op rather than touching the adapter or store. A stopped instance is never made ready again.

### 4.4 Pull behavior

`pull()` keeps the current receive-half behavior, with the startup and concurrent-flush guards made explicit:

1. return `false` immediately if the instance is stopped;
2. count the call as one of the initial pulls while `initialPullSettled` is false, and capture the instance signal;
3. call `gateway.read(signal)`;
4. check `isCurrent(signal)` after the await;
5. return `false` for no snapshot;
6. preserve the union of `activeJob.changedRooms` and the current `pending.changedRooms` while merging into `$groupChats`;
7. check `isCurrent(signal)` immediately before `replaceGroupChats()`;
8. replace the local rooms and return `true`;
9. in a `finally`, mark the initial phase settled only after all pulls that began before settlement have finished, then flush queued work if the instance is still current.

If an active adapter read fails, reject it as today so the caller can decide whether to swallow it. If the operation is stopped or aborted, suppress the stale/abort failure and resolve `false`; do not create a retry for the explicit pull. A scheduled job queued during a failed initial pull may still run after the initial phase settles, using its normal read/merge/retry policy.

The pull must read markers from the same mirror instance, including the captured active job. It must not read a module-global queue that a later instance could reuse. This active-job union is required because flush removes its job from `pending` before its first read. Pull and flush protocols are serialized through one per-instance operation queue, so an older pull or read-back cannot publish after a newer operation; the active-job union remains the read-back protection while a captured job is in flight. Calls made during the initial phase still count toward the startup barrier.

### 4.5 Flush behavior

Keep the existing protocol in the mirror closure, changing only its dependencies and lifecycle guards:

1. Return if the instance is stopped, the initial pull has not settled, already in flight, an existing retry timer is active, or there is no pending job.
2. Capture the instance signal.
3. remove one `SyncPending` job from the instance queue, copy it to `activeJob`, and mark the instance in flight;
4. read remote state through `gateway.read(signal)`;
5. check `isCurrent(signal)` before using the result;
6. create the local bounded snapshot from `$groupChats`;
7. compute `writeRevision = remote.revision + 1`;
8. merge remote and local snapshots with the job's changed rooms and write revision;
9. if there are no changed-room markers and the payload matches the remote payload, avoid a write; if a remote snapshot exists, pull it back through the same current instance, check currentness again, then reset retry count;
10. call `gateway.write(snapshot, remote.supportsCas ? remote.revision : undefined, signal)`;
11. check `isCurrent(signal)` before validating or issuing anything else;
12. require `applied === true`;
13. when CAS is supported, require the returned revision to equal `writeRevision`;
14. read back through `gateway.read(signal)`;
15. check `isCurrent(signal)` before validating or publishing;
16. when CAS is supported, require the confirmed revision to be at least `writeRevision`;
17. merge the confirmed snapshot into the local store while preserving the union of the current `activeJob.changedRooms` and any current `pending.changedRooms`;
18. check `isCurrent(signal)` immediately before `replaceGroupChats()`;
19. reset retry count only for the current instance.

The catch path must:

- suppress all stale or aborted errors;
- increment the retry count only while the same instance is current;
- when the count is at or below `MAX_RETRIES`, requeue the captured job, preserve the existing backoff ladder (`1s`, `2s`, `4s`, `8s`, `16s`, capped at `30s`), and install one retry timer;
- when the count exceeds `MAX_RETRIES`, reset the count and drop the captured job exactly as the current implementation does. This is a bounded best-effort mirror, not a durable offline queue;
- have a retry timer check `isCurrent(signal)` before invoking another flush;
- never let a stopped operation install a retry timer or requeue into a later instance.

The finally path must:

- check `isCurrent(signal)` before mutating `activeJob`, `inFlight`, or starting pending work;
- clear `activeJob` and `inFlight` for the current instance;
- immediately flush current pending work when no retry timer is active;
- do nothing when the instance is stopped. `stop()` already clears the old instance's bookkeeping, and the old instance must never be reused.

Preserve the current behavior that local mutations arriving while a flush is awaiting the gateway are merged into `pending` and handled by the next flush rather than being lost or folded into the already-captured job. This guarantee applies while the bounded retry window remains; after retry exhaustion the current policy deliberately abandons the captured job.

### 4.6 Schedule behavior

`schedule(options)` must preserve the current policy while making it instance-local:

1. no-op when stopped or timers are unavailable;
2. build a bounded local snapshot;
3. refuse to schedule an empty snapshot;
4. merge `changedRooms` into this instance's pending queue;
5. if the initial pull has not settled, leave the markers queued and do not start a write timer;
6. otherwise clear and replace the debounce timer;
7. have the callback clear its own timer reference and call flush only when `isCurrent(controller.signal)` is true.

The initial-pull gate protects a freshly installed client from publishing a non-empty stale local cache over the remote mirror. The empty-snapshot guard remains a second defense. There is no current production local-room deletion/disband path, so do not add an `allowEmpty` escape hatch or describe one as a supported publish.

## 5. File-by-file implementation steps

### Step 1 — Extend the injected request only for cancellation

File: `client/src/features/groups/group-runtime.ts`

- Extend `GroupEngineRequest` with an optional `{ signal?: AbortSignal }` third argument.
- Keep `groupEngineRequest()` as the existing two-argument member-RPC wrapper. The mirror never calls it, so widening that wrapper would add no current behavior.
- Keep `setEngineTransport()` and the mutable runtime slot because member-turn modules still depend on it.
- Update the module comment to state that the Group mirror receives a captured request through its adapter and does not call this global request function.
- Do not move `$groupActivity`, `$groupPrompts`, or member RPC helpers.

File: `client/src/state/gateway-controller.ts`

- Change `installGroupEngine()` to forward the third argument:

  `startGroupEngine((method, params, options) => this.runtime.rpc(method, params, options))`

- Do not reorder the controller lifecycle in this plan. `teardownGatewayScope()` and `dispose()` already stop the Group engine before closing or disposing the runtime. `logout()` currently closes the runtime before entering shared teardown, and app-background handling calls `runtime.close()` without stopping the Group engine; reconnect reopens that same runtime and does not call `startGroupEngine()` again. The mirror's terminal-stop guarantees apply when `stopGroupEngine()` runs, while `SessionRuntime`'s own Scope guard handles in-flight runtime RPCs across a runtime close/reconnect without terminating the mirror instance. Test the signal-forwarding boundary without claiming that every runtime close stops the mirror.

The third argument is optional, so existing two-argument test transports and member-turn calls remain valid.

### Step 2 — Replace the global mirror job with the captured interface

File: `client/src/features/groups/groups-sync.ts`

- Replace the value import of `groupEngineRequest` with a type-only import of `GroupEngineRequest` if needed by the production adapter.
- Leave the pure projection functions and their behavior unchanged unless a type adjustment is required.
- Add the `GroupMirrorRemoteState`, `GroupMirrorWriteResult`, `GroupMirrorGateway`, `GroupMirrorSchedule`, and `GroupMirror` interfaces near the stateful section.
- Add `createGroupMirrorGateway(transport)` with the exact route mapping described above.
- Add `createGroupMirror(gateway)` and move `SyncPending`, mutable state, timers, debounce, initial-pull barrier, active-job preservation, pull, flush, retry, and stop logic into its closure.
- Keep `mergePending()` and `syncPayloadEqual()` private to this module or the factory; they do not need to become public protocol vocabulary.
- Remove the old module-global `disposed`, `inFlight`, `pending`, timers, and retry count.
- Remove the old global `readRemoteSnapshot()`, `pullGroupChatState()`, `flushGroupChatSync()`, `scheduleGroupChatSync()`, `startGroupChatSync()`, and `stopGroupChatSync()` exports. Their behavior is now behind the factory interface.
- Do not import or call `groupEngineRequest` anywhere in the file after the change.
- Keep the meta key, byte limits, debounce duration, and retry constants local to this module.

The production adapter and mirror must remain in this file so the interface has useful depth: callers receive lifecycle operations, while raw route mapping, projection semantics, CAS policy, read-back, retry policy, startup hydration, and stop isolation stay local to the module.

### Step 3 — Make the engine own one active mirror instance

File: `client/src/features/groups/group-engine.ts`

Add a module-local active mirror reference typed by the new `GroupMirror` interface.

`startGroupEngine(transport)` must:

1. if an active engine exists, run the same teardown choreography first so the old mirror is stopped and old member loops receive the existing epoch invalidation before the new transport replaces the global member slot;
2. install the captured transport for member turns with `setEngineTransport(transport)`;
3. create a fresh production adapter with `createGroupMirrorGateway(transport)`;
4. create a fresh mirror with `createGroupMirror(adapter)` and store it as the active instance;
5. install `setGroupSyncScheduler(changedRoom => mirror.schedule({ changedRooms: [changedRoom] }))` so local durable mutations target this instance;
6. fire `void mirror.pull().catch(() => undefined)`. The scheduler is intentionally installed before this pull so mutations during hydration are recorded, but the mirror's initial-pull barrier prevents any write until hydration settles.

`stopGroupEngine()` must:

1. take the active mirror out of the module reference so later callers cannot reach it;
2. clear the store scheduler;
3. call `mirror.stop()` to abort and invalidate all mirror work;
4. clear the member-turn transport with `setEngineTransport(null)`;
5. bump room epochs and clear `running` so live member loops stop at their existing boundaries.

The exact ordering may be implemented with equivalent sequencing, but the active mirror must be invalidated before a later start can install a new scheduler or transport. A repeated `startGroupEngine()` without an explicit stop must also invalidate the prior engine lifecycle, not only its mirror.

Move the current `handleGatewayTransition()` room-state update into a private Group-engine helper. Its behavior must not change: clone every room, increment its epoch, and set `running: false`. Do not retain a public lifecycle helper in `groups-sync.ts`.

The epoch bump is the existing member-loop boundary, not cancellation of a member RPC already awaiting `groupEngineRequest()`. This plan keeps that member transport behavior unchanged; only the mirror gets captured-request abort and stale-result guards.

Update `openGroupRoom()` to call `activeMirror?.pull()` instead of the removed global `pullGroupChatState()`. Keep the existing error swallowing and stranded-reply harvest policy. Opening a room while the engine is stopped must not issue a gateway request.

Keep all existing facade exports and all member-turn action implementations unchanged.

### Step 4 — Update the domain glossary

File: `CONTEXT.md`

Update the **Group send engine** and **Group mirror** entries as described in the settled decisions.

Use the repository's existing terms:

- the Group mirror is a deep module;
- `GroupMirrorGateway` is its semantic adapter seam;
- the production adapter captures the engine transport and owns raw `profiles.*` mapping;
- the mirror owns normalization/merge consumption, debounce, CAS, read-back, retry, abort, startup-barrier, and terminal-stop policy;
- stopped instances are never restarted or reused;
- `group-runtime.ts` remains the member-RPC transport seam.

Do not add a new glossary concept for every internal helper or timer.

## 6. Test migration and additions

### 6.1 Preserve the projection suite

File: `client/src/features/groups/groups-sync.test.ts`

Keep the existing tests for:

- gateway byte sizing;
- durable room keys;
- stable entry keys and legacy-family collapse;
- bounded v3 snapshots;
- empty runtime tombstone filtering;
- member/text/image limits;
- the existing v1 normalization case, plus an explicit v2 name-keyed snapshot and its revisioned tombstone case;
- log union, revision ordering, member ties, tombstones, and rename behavior;
- local rich-copy preservation, runtime-state preservation, remote rename, and local deletion/preserve guards;
- legacy thread assignment.

These tests should continue to exercise the pure projection layer without installing a global engine transport. The v2 and malformed-input cases are additions, not claims about coverage that the current file does not have.

Remove the current `stopGroupChatSync()`/`startGroupChatSync()` setup and the direct `setEngineTransport()` dependency from the mirror tests.

### 6.2 Test the semantic mirror with deferred/in-memory adapters

Migrate the current “flush job” tests to `createGroupMirror()` using a test-local adapter that stores semantic `snapshot`, `revision`, and `supportsCas` state. The fake should not know `profiles.list` or `profiles.configure` names.

Cover at least:

1. **Pull** — a remote snapshot merges into local rooms and preserves local sessions, watermarks, epochs, running flags, rich entries, and pending changed-room markers.
2. **No remote snapshot** — `pull()` returns `false` and does not replace local state.
3. **CAS write and read-back** — after priming the mirror with its initial pull, `schedule()` debounces, writes the merged snapshot with the remote revision as the expected revision, performs the required read-back, and merges the confirmed state without overwriting the captured local room.
4. **Applied-revision race** — a fake write returns `applied: true` with a revision other than `writeRevision`; the job retries after the existing backoff with a fresh read.
5. **Read-back revision race** — a fake write succeeds, but the next read reports a revision below `writeRevision`; the job retries after the existing backoff with a fresh read.
6. **Non-CAS gateway** — the adapter receives `undefined` for the expected revision and the mirror does not require a CAS revision response.
7. **No-empty-publish** — scheduling an empty local cache never calls `write()`; there is no current `allowEmpty` override or local disband producer.
8. **Concurrent local mutation** — a change arriving while a write/read-back is in flight remains in the instance's pending queue and is flushed after the captured job.
9. **Pull/flush overlap** — a pull requested after flush captured its job is serialized behind that protocol, while read-back preserves both the active job's changed room and any remaining pending marker, so a remote tombstone cannot delete the room being written.
10. **Read-back no-op** — when the merged payload matches the remote payload and there are no changed-room markers, no write occurs, but a remote snapshot is still pulled into local state.
11. **Retry exhaustion** — repeated active failures use exactly the bounded backoff and then drop the captured job, reset the retry count, and do not retry that job without a new schedule; separately queued markers may still flush.

Use fake timers for debounce and retry assertions. Stop every created mirror in test cleanup.

### 6.3 Test lifecycle races and stop guards

Add deferred adapter tests that prove the lifecycle safety, not only the final happy state:

1. **Initial-pull write barrier** — schedule a non-empty local change before the first read resolves; assert that no write occurs, resolve the read, and assert that the pull preserves the marker and only then releases the flush.
2. **Initial-pull failure still settles the barrier** — reject the first read, assert that no write happened before it settled, then assert queued work follows the normal fresh-read/retry path rather than being abandoned or publishing stale local state.
3. **Concurrent initial pulls settle together** — start two first pulls with separate deferred reads, resolve one, and assert queued work remains blocked until the other settles; after both settle, release exactly the queued work.
4. **Stopped pull cannot publish** — start `pull()`, stop the mirror before `read()` resolves, resolve with a valid snapshot, and assert that `$groupChats` is unchanged and `pull()` resolves stale/false.
5. **Stopped flush cannot write after read** — schedule a job, let its remote read resolve, stop before the write boundary, and assert that `write()` is never called.
6. **Stopped in-flight write cannot read back or publish** — stop while `write()` is deferred, resolve it as applied, and assert there is no read-back and no local replacement.
7. **Abort signal is delivered** — assert that `stop()` aborts the signal passed to the adapter and that an abort rejection does not create a retry.
8. **Retry suppression** — make an active write fail, stop before the backoff timer, advance timers, and assert there is no second write.
9. **Stopped timer guard** — capture a scheduled debounce or retry callback, stop the instance, and invoke or advance it; it must not call the adapter.
10. **Stop/restart isolation** — start one mirror with a deferred old adapter, stop it, create a second mirror with a new adapter, then resolve the old adapter. The old snapshot and old retry must not alter the local store or call the second adapter.
11. **Finalizer guard** — resolve an old operation after the next mirror has been created and assert that the old `finally` path cannot reset or drain the new instance's pending work.
12. **Instance non-reuse** — after `stop()`, `schedule()` and `pull()` are no-ops; a new factory instance starts with empty pending/retry state and accepts fresh work.

These tests should use deferred promises and explicit call counters, not sleeps. The terminal stop flag and private closure state are the guard; there is no generation counter to test.

### 6.4 Pin the production adapter's wire contract

Add adapter-focused tests in `groups-sync.test.ts` or a clearly named adjacent test file without adding a production module.

Use a recording `GroupEngineRequest` and assert:

- `read(signal)` calls exactly `profiles.list` with `{ include_sessions: false }` and forwards the same signal;
- the adapter selects the row named exactly `default` rather than another profile;
- no default row, or a default row with unusable `ui_meta` or snapshot metadata, maps to `snapshot: null` and revision `0`; CAS support is false when there is no default row or no own `ui_meta_revisions` property;
- a usable snapshot remains present even when the default row has no `ui_meta_revisions` property, with revision `0` and `supportsCas: false`;
- a default row whose own `ui_meta_revisions` property is present still has `supportsCas: true` even when its value is null or the key is absent, matching the property-presence capability rule;
- array-valued `ui_meta` or snapshot metadata is rejected as absent; array-valued revision metadata yields revision `0` without discarding an otherwise usable snapshot, while its own-property capability remains `supportsCas: true`;
- invalid read revisions normalize to `0`, while finite non-negative numeric revisions survive unchanged;
- `write(snapshot, undefined, signal)` calls exactly `profiles.configure` with `name: 'default'` and the one-key `ui_meta` object, omitting `ui_meta_expected_revisions`;
- `write(snapshot, 7, signal)` adds exactly `{ 'hermes-bots-groups': 7 }` under `ui_meta_expected_revisions`;
- the adapter maps `applied.ui_meta` and a finite non-negative numeric returned revision without doing merge or retry policy;
- a missing, negative, nonnumeric, or infinite returned revision maps to `undefined`;
- the adapter forwards the signal to both route calls.

These assertions are the byte-level guardrail. The semantic mirror tests must remain independent of route vocabulary.

### 6.5 Update Group engine lifecycle tests

File: `client/src/features/groups/group-engine.test.ts`

- Remove the direct import of `pullGroupChatState` from `groups-sync.ts`.
- Keep the existing test that starts the engine, mutates a room, observes the CAS configure and the required read-back list, stops the engine, confirms no later scheduler write, and confirms `groupEngineRequest()` is disconnected after stop. Do not treat the immediate read-back merge of a preserved changed room as advancing that room's local `syncRevision`; replace the existing test's later direct `pullGroupChatState()` call with an engine facade path such as `openGroupRoom()` that delegates to the active mirror.
- Keep the epoch/running teardown test.
- Add an engine-level initial-pull barrier test: defer the first read, mutate a non-empty local room, assert no configure occurs before the read resolves, then resolve the read and assert the queued change flushes.
- Add an engine-level stop/restart test with two captured transports: resolve a read from the first start after `stopGroupEngine()` and a second `startGroupEngine()`, then assert the first result cannot land in the new lifecycle or call the second transport.
- Add a repeated-start test without an intervening explicit stop so the defensive start choreography invalidates the old mirror and bumps the old room lifecycle before installing the new transport.
- Keep full-round tests and `stopGroupThread` coverage. Their member/session calls must continue to use the global `group-runtime` transport and must not be routed through `GroupMirrorGateway`; the existing epoch boundary, not mirror abort, remains their teardown behavior.

File: `client/src/state/gateway-controller.test.ts`

- Add one controller-boundary assertion that the initial mirror `profiles.list` receives a signal through `installGroupEngine()`. When the controller tears down the Group engine, the request's effective signal must be aborted; the test should assert forwarding and eventual cancellation, not object identity or whether the mirror or `SessionRuntime` signal supplied the abort. The mirror-specific test remains the authority for direct `stop()` cancellation.

Files: `client/src/features/groups/group-rounds.test.ts` and `client/src/features/groups/group-turns.test.ts`

- Keep their direct `setEngineTransport()` test setup. It is testing the separate member-RPC seam.
- Do not migrate these suites to the mirror adapter or add member-turn signal cancellation as part of this plan.

### 6.6 Test cleanup requirements

Every test that creates a mirror must stop it in `afterEach`, even when the test fails. Semantic mirror tests must explicitly perform the initial pull before ordinary scheduled-write assertions, and deferred startup tests must leave that pull unresolved until they assert the write barrier. Fake timers must be restored. The test setup must reset `$groupChats`, localStorage, activity, prompts, and needs-you state as it does today.

Do not rely on module-global mirror state between tests. The purpose of this refactor is for each test and each engine start to own its own lifecycle instance. Member-RPC suites may continue to seed the separate global `group-runtime` transport, but must clear it in their existing cleanup.

## 7. Verification sequence after implementation

Run the narrow checks first, then the broader suite:

```bash
cd client
npm run test -- src/features/groups/groups-sync.test.ts src/features/groups/group-engine.test.ts src/state/gateway-controller.test.ts
npm run test -- src/features/groups
npm run typecheck
npm run test
npm run build
```

Also run repository hygiene checks from the repository root:

```bash
git diff --check
git status --short --branch
```

Use the narrow test command to diagnose mirror behavior, the full `src/features/groups` command to catch member-turn regressions, and the full test/typecheck/build commands to verify the changed transport type and controller boundary.

Before considering the work complete, inspect the diff for these structural assertions:

```bash
rg -n "groupEngineRequest" client/src/features/groups/groups-sync.ts
rg -n "startGroupChatSync|stopGroupChatSync|scheduleGroupChatSync|pullGroupChatState" client/src
rg -n "createGroupMirror|GroupMirrorGateway" client/src/features/groups
```

The first search must return no value import or call from `groups-sync.ts`; the second must show no stale global mirror API references; the third must show the new interface and its engine/adapter tests.

## 8. Acceptance criteria

The implementation is complete only when all of the following are true:

### Interface and locality

- `groups-sync.ts` exposes `createGroupMirror(gateway)` with `pull`, `schedule`, and `stop`.
- The mirror's mutable state is per factory instance; no module-global pending queue, in-flight flag, timer, disposed flag, or retry count remains.
- The production adapter is captured at factory construction and maps semantic reads/writes to the existing wire contract.
- The mirror owns merge, debounce, CAS, read-back, retry, abort, startup-barrier, active-job preservation, and terminal-stop policy; the adapter does not.
- `group-engine.ts` creates a new mirror on every engine start and never restarts a stopped instance.

### Wire compatibility

- Reads still use `profiles.list` with `{ include_sessions: false }`.
- The `default` profile and `hermes-bots-groups` key are unchanged.
- Writes still use `profiles.configure` with `name: 'default'` and the same `ui_meta` shape.
- CAS expected revisions are sent only when the remote advertises `ui_meta_revisions` support.
- No backend or route changes are required.

### Lifecycle correctness

- Stop marks the instance terminal, aborts adapter work, clears its timers and queued/active bookkeeping, and prevents later reuse.
- Every post-await store publication, subsequent adapter request, retry timer, retry requeue, and finalizer is guarded by the instance's stopped flag and captured abort signal.
- A stopped in-flight operation cannot publish into a later engine Scope.
- A stale failure cannot schedule a retry.
- Member-turn RPCs still use the global runtime transport; engine teardown bumps room epochs and clears `running` so member loops stop at their existing boundaries, but it does not cancel an already awaited member RPC.

### Behavioral compatibility

- Existing v3 snapshot size, normalization, merge, tombstone, rename, read-back, and no-empty-publish behavior remains intact.
- Local rich log entries and runtime coordination fields remain protected from compact remote projections.
- Local markers arriving during an in-flight mirror operation remain queued through the configured retry window; after retry exhaustion, the captured job is deliberately dropped as in the bounded best-effort policy, so this is not an at-least-once guarantee.
- Full Group round behavior and prompt/activity tests remain green.

### Documentation and verification

- `CONTEXT.md` describes the new Group mirror seam and the remaining member transport seam accurately.
- The projection suite, semantic mirror suite, lifecycle race suite, adapter wire-contract suite, Group engine suite, controller signal-forwarding test, typecheck, tests, build, and `git diff --check` pass.
- The diff contains only the intended Group mirror implementation/test/documentation changes once implementation begins.

## 9. Risks and mitigations

### Old work reaches the new runtime

A late continuation could call the mutable global runtime slot after a restart. Mitigation: the mirror never imports `groupEngineRequest`; it captures the transport adapter at creation, aborts on stop, and checks its stopped flag and captured signal before every next action and publication.

### Abort rejection is mistaken for a retryable gateway failure

Mitigation: check the stopped flag and `signal.aborted` in pull/flush catches before requeueing. Add a test whose fake rejects because its signal was aborted.

### A stale finalizer affects a fresh instance

Mitigation: keep all mutable state in the old instance's closure, guard the finalizer with that instance's stopped/current check, clear the active engine reference before stopping, and never reuse the object. Add a deferred stop/restart test.

### Extending `GroupEngineRequest` breaks callers

Mitigation: make the signal options third argument optional. Existing two-argument functions remain valid; run the Group suites and full typecheck.

### Route bytes drift while extracting the adapter

Mitigation: keep the adapter mapping in one function and add exact request-shape tests for both CAS and non-CAS writes.

### Pending local changes are overwritten by read-back

Mitigation: preserve both the captured `activeJob` markers and the remaining pending markers while a flush is in flight; use the existing local-store `preserveRooms` behavior when publishing read-back; check the stopped/current guard immediately before publication. Pure projection functions retain their explicit tombstone arguments, but the lifecycle scheduler does not expose an unused local `deletedRooms` option.

### A new instance publishes before its initial pull

Mitigation: install the fresh mirror and its scheduler, issue the initial `pull`, and hold queued writes behind the mirror's initial-pull barrier until all first pulls settle. Keep the no-empty-publish guard as a second line of defense.

### Reconnect reuses the engine instance

A runtime close followed by the existing reconnect path does not call `startGroupEngine()` again, so the captured controller callback does not freeze one particular `SessionRuntime` operation or create a new mirror for every temporary connection. That is intentional in this scope: `SessionRuntime` combines its current scope signal into each RPC and rejects an operation that began in a closed scope, while the mirror remains alive to retry on the reopened runtime. If reconnect isolation requires a terminal mirror per runtime reopen, the controller must stop and recreate the engine, which is outside this plan; do not claim captured transport alone provides that stronger guarantee.

## 10. Explicitly out of scope

- Adding or changing gateway backend routes, CAS semantics, metadata keys, or byte-budget rules.
- Replacing `group-runtime.ts`'s global member transport with a second lifecycle system.
- Adding immediate cancellation or signal plumbing to already in-flight member-turn RPCs; their existing epoch-boundary teardown remains unchanged.
- Refactoring `group-rounds.ts`, `group-turns.ts`, prompt handling, session plumbing, or activity state.
- Moving the mirror into a new file solely to rename the module.
- Persisting pending mirror jobs across a Scope teardown.
- Increasing retry limits or adding a durable offline queue.
- Adding a local room-delete/disband producer or an `allowEmpty`/`deletedRooms` scheduler API absent from current production callers.
- Changing how rooms are rendered, named, opened, or created.
- Rewriting the existing pure projection algorithms without a failing test that requires it.
- Running a migration or publishing a deployment.

## 11. Implementation checklist

1. Extend the request type and controller signal forwarding.
2. Add the semantic adapter and factory interfaces to `groups-sync.ts`.
3. Move the flush state into per-instance closure state.
4. Add stopped-flag and abort checks at every listed asynchronous boundary.
5. Preserve the existing read/merge/CAS/read-back/retry algorithm, including bounded retry exhaustion.
6. Wire a fresh mirror instance into `group-engine.ts` start, open, scheduler, repeated-start, and stop paths.
7. Keep member-turn calls on `group-runtime.ts` and update only their compatible types.
8. Migrate stateful tests to semantic fakes.
9. Add initial-barrier, active-job race, lifecycle-stop, abort, retry suppression, restart-isolation, repeated-start, controller-forwarding, and adapter wire-contract tests.
10. Update `CONTEXT.md`.
11. Run the narrow tests, Group tests, typecheck, full tests, build, diff check, and status check.
12. Review the final diff for stale global mirror exports/imports and unrelated changes.
