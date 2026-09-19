# Plan — Deepen the Group member turn: collapse the turn drive

**Status:** finalized design, ready to implement · **Cluster:** `client/src/features/groups/`
**Origin:** architecture review 2026-09-20, candidate 1 ("Collapse the Group turn drive"), selected from a 7-candidate report. CONTEXT.md gained the **Group member turn** entry as part of this decision.

---

## 1. Problem (evidence)

Three consecutive commits landed in this cluster (`Guard group member turns with operation-token ownership`, `Refactor group member turns around captured lifecycles`, `Refactor Group mirror lifecycle`) — it is the codebase's active hot spot. The friction:

1. **The drive step is copy-pasted.** The per-member sequence — watermark delta → `markKey` → hold check/consumption → prompt build → turn indicator → `turns.run` → post-run policy → `publishTurnResult` — exists twice inside `group-rounds.ts` (main loop 421–464, continuation loop 483–514), ~35 duplicated lines plus a hand-built magic string `` `${thread}::${memberKey}` `` in both (423, 485), and a third construction in `harvest` (`group-turns.ts:723`).
2. **Publication interprets a lease it doesn't own.** `publishTurnResult` (`group-rounds.ts:296–367`) classifies the `commit()` lease produced by the turn module's token capture. The classification semantics (rejected `room-stopped` consumes the delta without appending; `newer-user` records supersession; rejected `engine-stopped` abandons the drive) are meaningless without the capture — the seam splits one concept.
3. **Staleness is derived at three levels with no single owner:** the driver's `driveIsLive()`/`roomEpochIsCurrent()` boundary checks, the module's `staleReason()`, and the lease classification inside `publishTurnResult`.
4. **The stranded-marker contract leaks across four modules:** written as `{ before, thread }` (`group-turns.ts:611–616`), read as `number | object` (`:640–643`), disambiguated by a module-private `markerVersions` map (`:325`), filtered by two driver loops (`group-rounds.ts:406–409, 477–478`), guarded on by the facade (`group-engine.ts:107`), carried opaquely by the mirror merge (`groups-sync.ts:554`), typed in `group-store.ts:46`.
5. **Understanding one turn = ~1,440 lines** (638 + 800) plus store fields; the pure helpers (`classifyGroupHoldDirective`, `pickGroupTurnReply`) are unit-tested but the buggy territory — the drive-step choreography and publication — was only reachable through full end-to-end runs with hand-built commit closures.

The current division ("the module owns member-session behavior and stale operation policy; the round driver owns room-log publication") is already half-fiction: the turn module's `harvest` appends to the room log and advances watermarks. This plan makes the real division explicit.

## 2. Design decisions (grilling record — user delegated recommended answers)

Design-it-twice ran three parallel interface designs (minimize-interface / maximize-flexibility / optimize-for-common-caller). All three converged on: publication + drive step move into the turn module; prompt assembly moves verbatim; a policy enum carries the round/continuation difference; `GroupMemberGateway` stays the only adapter; shared leaf types move to `group-model.ts`. Adjudicated hybrid:

| Decision | Choice | Rationale |
|---|---|---|
| Seam placement | `group-turns.ts` becomes the **Group member turn** module: one member's turn end to end, including publication. `group-rounds.ts` keeps room sequencing only. | Publication classifies the lease; the lease semantics live with the token capture. Deletion test passes: deleting the drive step would re-scatter the sequence across both loops. |
| Interface outcome | **Report object `{ abandoned, spoke, stop }`** (D3) | Exactly today's `PublishedTurn` — the driver branches on nothing else. Flat 6-value enums (D1) invent distinctions (held/skip/silent) the caller collapses anyway. |
| Round vs continuation | **`policy: 'round' \| 'continuation'`** (D1 naming) | Carries all three real differences: failure-reason visibility (`true`/`false`), the post-run epoch gate (publish-and-let-lease-decide vs bail-before-commit), hold consumption vs silent hold skip. |
| Drive liveness | **No callback. `driveEpoch` in the spec; driver keeps its boundary checks** (D2) | The `driveIsLive()` half of the continuation post-run bail is unreachable in flight: `stopGroupEngine` calls `driver.deactivate()` then `turns.stop()` with no await between (no interleaving point), and in-loop abandonment returns immediately. Module-side epoch check is behavior-equivalent — documented in code, guarded by a migrated test. |
| `run()` | **Kept as the module's internal test seam** (D2's caution) | 18 existing `group-turns.test.ts` cases drive `run` directly over fake gateways. Internal seams are legitimate; re-routing them through the composed step would add store setup for no behavioral assertion. Never called by the driver after the move; never re-exported by the facade. |
| Stranded invariant | **Module-owned refusal** (D1's insight, made authoritative; D3's `isStranded()` probe rejected) | The module refuses a new turn while a marker stands for the member (pre-check *before* token claim, so it never invalidates an in-flight harvest). Both driver pre-filters are deleted; one invariant, one owner, race-free. Exposing even a boolean would leak the concept. |
| Facade stranded read | **`harvestRoom(group, members)`** on the turn module | `openGroupRoom`'s `local.stranded` shape read is replaced; the module filters who actually has a marker. The marker union becomes invisible outside `group-turns.ts` (groups-sync's merge carries the field opaquely and stays untouched). |
| Prompt assembly | **Moves verbatim to `group-turns.ts`**; `botHandle`, `EngineMember`, `GroupEngineRequest` move to the `group-model.ts` leaf | All three designs agree. Injecting a prompt builder would be a one-adapter hypothetical seam. `botHandle` has only in-cluster consumers (verified); `parseGroupChatMentions` stays in rounds (responder policy) and imports `botHandle` from the leaf — no `turns → rounds` edge. |
| `group-runtime.ts` | **Folded into `group-store.ts`**; `GroupEngineRequest` type → `group-model.ts` | All importers are in-cluster (verified). `$groupNeedsYou` already lives in the store; activity + prompt atoms join it. Tracing a turn then crosses two sibling modules (`store`, `model`), not three. |
| Scope guard | Candidate 2 (full identity module) **stays out**; only the incidental fixes land (roster dedup reuses the leaf key helper, `markKey` becomes module-private) | Keep the diff reviewable. The dedup key inline twin (`group-rounds.ts:564`, missing the `\|\| 'default'` guard) is fixed for free by reusing `groupDurableMemberKey`. |

## 3. Target design

### 3.1 Module division after the change

```
group-model.ts        (leaf)   + EngineMember, botHandle, GroupEngineRequest, groupDurableMemberKey
group-store.ts                 + $groupActivity, $groupPrompts, recordGroupActivity,
                                 GroupActivityEntry, GroupPrompt   (runtime.ts folded in; file deleted)
group-turns.ts        (DEEP)   Group member turn — see 3.2
group-rounds.ts       (slim)   round driver — see 3.3
groups-sync.ts        (merge untouched; Phase 1 swaps its member-key helper import)
group-engine.ts       (facade) unchanged verbs; openGroupRoom body simplifies
```

### 3.2 `group-turns.ts` — the Group member turn module

```ts
export type GroupTurnPolicy = 'round' | 'continuation'

export interface GroupTurnSpec {
  group: string
  thread: string
  member: EngineMember
  /** Room roster — feeds the prompt's peer list. */
  members: readonly EngineMember[]
  /** The drive's captured start epoch. 'continuation' bails on any change. */
  driveEpoch: number
  policy: GroupTurnPolicy
}

export interface GroupTurnReport {
  /** Rejected engine-stopped lease: the drive stops and skips its finalizer. */
  abandoned: boolean
  /** The member's reply was appended to the room log. */
  spoke: boolean
  /** The drive must stop: room-stopped, newer-user, invalidated operation,
   *  continuation epoch drift — and a rejected engine-stopped lease also sets
   *  it (abandoned implies stop; the driver checks abandoned first). */
  stop: boolean
}

export interface GroupTurnModule {
  /** One member's turn end to end. Never rejects for member-level failure
   *  (network error classifies as 'failed' ⇒ silent). Never claims a token
   *  when it returns a no-op outcome. */
  takeTurn(spec: GroupTurnSpec): Promise<GroupTurnReport>
  harvest(group: string, member: GroupMember): Promise<void>
  /** Harvest every member holding a stranded marker (engine facade: room open). */
  harvestRoom(group: string, members: readonly GroupMember[]): Promise<void>
  answer(entry: GroupPrompt, member: GroupMember, answers: Record<string, string> | string | undefined): Promise<void>
  interrupt(member: GroupMember, storedSessionId: string): Promise<void>
  stop(): void
  /** Internal test seam: the raw capture/lease machinery. The driver and the
   *  facade never call it; only this module's tests do (18 cases). */
  run(input: GroupTurnInput): Promise<GroupTurnResult>
}

export type GroupTurnInput = { group: string; member: GroupMember; prompt: string; thread: string }
export type GroupTurnResult = ... // unchanged
// createGroupTurnModule keeps producing run/harvest/answer/interrupt/stop.
```

**`takeTurn` order of operations (moved verbatim, single copy):**

1. Refuse if a stranded marker stands for `memberKey` — `Object.prototype.hasOwnProperty.call(room.stranded, memberKey)` (a legacy numeric marker `0` is a valid marker and must count; do not truthiness-test) → report `{ false, false, false }`. **Before any token claim.**
2. Compute `markKey = watermarkKey(thread, memberKey)` — module-private helper; the string format gets exactly one owner.
3. `seen = room.watermarks[markKey] || 0`; delta = log slice filtered to thread; empty → report `{ false, false, false }`.
4. Hold branch: `policy: 'round'` → consume delta exactly once (`heldMemberWatermarkAdvance`, moves with the step), mark hold `noted`, record `held` activity once, report `{ false, false, false }`. `policy: 'continuation'` → silent skip, no consumption (preserves `group-rounds.ts:489`).
5. `buildGroupChatTurnPrompt` (byte-faithful template, moved verbatim) over the last `GROUP_CHAT_HISTORY_LIMIT` delta lines via `formatGroupChatLine`.
6. Turn indicator: `updateGroupChat(group, r => ({ ...r, turn: member.name }), { sync: false })`.
7. `result = await run({ group, member, prompt, thread })` (the module's own capture/lease machinery, unchanged).
8. Post-run policy:
   - `'continuation'`: if `(room.epoch || 0) !== driveEpoch` → return `{ stop: true }` **before** the lease is committed (today's `group-rounds.ts:503`, with the comment explaining the deliberate strictness and the stopGroupEngine-ordering equivalence).
   - both: `publishTurnResult` (moved wholesale) classifies lease + result kind → activity, watermark advance, append-with-source-labels, failure-reason visibility (`'round'` shows `result.reason`, `'continuation'` hides it).

**Invariants to preserve (the must-list):**
- Token ownership semantics: `claimToken`/`latestTokens`/`owns`; `memberRequest` throws `TurnStoppedError` at all three check sites; `commitFor` memoizes one decision.
- `staleReason` precedence: `engine-stopped` → scan anchor tail for same-thread newer user → `newer-user`; else hold → `room-stopped`; else null.
- Publication: lease-rejected `room-stopped` consumes the watermark without appending; `newer-user` records supersession activity and advances nothing; accepted lease → reply appended, watermark = `log.length` after append; non-reply → watermark advanced; the cancelled-with-reason branch maps exactly as today (including "a live module can invalidate one operation — stop, not abandon").
- Watermark writes ride `{ sync: false }`; hold-note and session/stranded writes stay synced. One exception preserved verbatim: the hold branch advances the watermark inside the SAME synced write as the hold-note (one `updateGroupChat` with default `sync: true`, today `group-rounds.ts:433–440`) — do not split it into a separate `{ sync: false }` write.
- The drive finalizer (settled/capped activity + `running: false, turn: null`) stays in the driver and keeps its `driveIsLive() && roomEpochIsCurrent()` guard.
- Harvest keeps: `markerIsCurrent` double-check, "only clear the request this operation actually observed", ownership-checked append, `sync: false` watermark advance.
- `sendToGroupChat` keeps: needs-you clear, roster dedup (now via `groupDurableMemberKey`), hold application from user text, epoch bump, 250 ms chaining.

### 3.3 `group-rounds.ts` — the round driver (slim)

Keeps: `parseGroupChatMentions`, `resolveGroupResponders`, `rotateGroupSpeakers`, `unaddressedGroupMentions`, hold *application* (`classifyGroupHoldDirective`, `applyGroupHoldDirective`, `heldMemberWatermarkAdvance` — the last moves to `group-turns.ts` with its consumer), `sendToGroupChat`, `stopGroupThread`, `deactivate`, the drive loop skeleton — explicitly including the round-start late-reply harvest sweep over every member and its boundary checks (`group-rounds.ts:389–402`; no test asserts the sweep, so dropping it would pass the suite silently: keep it when rewriting the loops), `startDrive` catch, finalizer.

The loops collapse to:

```ts
// main loop
for (const member of responders) {
  if (!driveIsLive()) return
  if (!roomEpochIsCurrent(group, startEpoch) || posted >= GROUP_CHAT_MAX_MESSAGES) {
    if (!roomEpochIsCurrent(group, startEpoch)) recordRoomCancellation(group, thread)
    else exitKind = 'capped'
    return
  }
  const outcome = await turns.takeTurn({ group, member, members, thread, driveEpoch: startEpoch, policy: 'round' })
  if (outcome.abandoned) { abandoned = true; return }
  if (outcome.stop) return
  if (outcome.spoke) { posted += 1; spokeThisRound += 1 }
}
// continuation loop: identical, policy: 'continuation', existing for-header guard kept
```

Deleted from rounds: both stranded pre-filters (module refuses now), both duplicated drive-step bodies, `publishTurnResult`, `PublishedTurn`, prompt assembly, `formatGroupChatLine`, `botHandle`, `heldMemberWatermarkAdvance`, the inline dedup-key twin, `markKey` construction.

### 3.4 Facade

`openGroupRoom`: `adoptMirrorRoom(room)` → `mirror.pull()` → `turns.harvestRoom(room.name, room.members)`. The `local.stranded && Object.keys(...)` shape read disappears. All other verbs unchanged.

## 4. Implementation phases

Every phase ends with the verification suite green (§6). Commits are suggested; nothing is committed without explicit request.

### Phase 1 — Leaf moves (mechanical, zero behavior)
1. Move `EngineMember` (from `group-rounds.ts`), `botHandle` (from `group-rounds.ts`), `GroupEngineRequest` (from `group-runtime.ts`) to `group-model.ts`.
2. Add `groupDurableMemberKey(member: GroupMember): string` to `group-model.ts` (body = today's `groups-sync.ts` `groupChatSyncMemberKey`: `` `${member?.connectionId || 'legacy'}::${member?.name || 'default'}` ``). `groups-sync` imports it (its local export is deleted); `sendToGroupChat`'s roster dedup uses it (the missing `|| 'default'` guard is unreachable for `EngineMember` — `name` is required — so this is a no-op for behavior).
3. Update imports in `group-rounds.ts`, `group-turns.ts`, `group-engine.ts`, `groups-sync.ts`, tests.
4. Verify: `vitest run`, `typecheck`.

### Phase 2 — Prompt assembly moves into the turn module
1. Move `buildGroupChatTurnPrompt`, `formatGroupChatLine`, `heldMemberWatermarkAdvance` to `group-turns.ts` verbatim (byte-faithful template untouched); `formatGroupChatLine` imports `groupSpeakerLabel` from the store as today.
2. Rounds drops those exports; its import list shrinks. `heldMemberWatermarkAdvance`'s consumer moves in Phase 3, so keep it exported from turns meanwhile.
3. Migrate the prompt template test (byte-faithful assertions) from `group-rounds.test.ts` "mention and prompt helpers" to `group-turns.test.ts` "pure helpers"; the mention-parse and responder tests stay in rounds. The bundled test "rotates speakers and formats source-qualified transcript lines" splits: rotation assertions stay, `formatGroupChatLine` assertions migrate.
4. Verify: suite green — this phase must be a pure relocation.

### Phase 3 — The drive step and publication move (the core)
1. In `createGroupTurnModule`: add `watermarkKey(thread, memberKey)` (module-private), `takeTurn` (order per §3.2), and absorb `publishTurnResult` from rounds as a private `publishTurn(...)` — byte-identical logic, `includeFailureReason` derived from `policy`. `harvest`'s watermark write (`group-turns.ts:723`, the third `` `${thread}::${memberKey}` `` construction) switches to `watermarkKey` too, so the format has exactly one owner.
2. Add the stranded-refusal pre-check before token claim; add `harvestRoom(group, members)` (internally: for each member with a current marker, `await harvest(group, member)`).
3. Rewrite the module header comment: the module owns the turn end to end including publication; the driver owns room sequencing.
4. `group-rounds.ts`: replace both loop bodies with the `takeTurn` call shape from §3.3; delete `publishTurnResult`, `PublishedTurn`, both stranded pre-filters, the duplicated blocks; keep boundary checks, caps, counters, finalizer, `startDrive` catch, chaining, hold application; rewrite the header comment.
5. `GroupTurnModule` interface gains `takeTurn` + `harvestRoom`; `run` stays (internal seam — note it in the header).
6. Test migration (§5).
7. Verify: suite green, then `rg -n "publishTurnResult|markKey|stranded" group-rounds.ts` shows `stranded` only in the finalizer comment (the "stranded until the next send" note) — no marker reads, no `markKey`, no `publishTurnResult` hits.

### Phase 4 — Facade
1. `openGroupRoom` → `harvestRoom`; drop the `stranded` shape read.
2. Adapt `group-engine.test.ts:369–404` ("harvests an opened room through its captured lifecycle") to the new path: seed marker via store, open, expect harvest consumed it (or marker persists when the member is unreachable — mirror today's assertions).
3. Verify: suite green; `rg -n "\.stranded" --type ts -g '!*groups/group-turns*'` shows exactly: `group-store.ts` (the `durableGroupChatRooms` passthrough), `groups-sync.ts` (opaque passthrough), and `group-engine.test.ts` (the adapted test's assertion). The `stranded?:` type declaration itself has no leading dot and does not match.

### Phase 5 — Fold `group-runtime.ts` into `group-store.ts`
1. Move `$groupActivity`, `recordGroupActivity` (+ limit), `$groupPrompts`, `GroupActivityEntry`, `GroupPrompt` into `group-store.ts` (epoch read stays local). `GroupEngineRequest` already left in Phase 1.
2. Delete `group-runtime.ts`; update the 7 in-cluster import sites (verified list: `group-rounds.ts`, `group-turns.ts`, `group-engine.ts`, `groups-sync.ts`, `group-rounds.test.ts`, `group-turns.test.ts`, `group-engine.test.ts`) and the facade re-exports. Also drop `group-runtime` from the facade header's internal-seams list (`group-engine.ts:10`) — otherwise the audit grep below hits the comment.
3. Verify: suite green; `rg -n "group-runtime" client/src` → no hits.

### Phase 6 — Documentation
1. CONTEXT.md is already updated (done during design): verify the **Group member turn** entry matches the shipped interface exactly; adjust if any signature drifted during implementation.
2. `group-turns.ts` / `group-rounds.ts` / `group-engine.ts` header comments state the new division; keep the desktop-port parity note (`group-turns.ts:6–8`; lines 10–12 are the module-division comment Phase 3 rewrites) and add: "publication is a documented PWA divergence from the desktop's group-rounds.ts — the desktop keeps publication in its round driver".

### Phase 7 — Full verification
`cd client && npm test && npm run typecheck`; `npm run test:e2e` if the environment allows — note the e2e suite has NO group-chat specs (cron, profile-create, pwa-foundation only), so it is a generic regression smoke only; the manual smoke of one group send → reply → hold → stop → reopen-harvest cycle is the integration boundary check for the changed seams.

## 5. Test plan (replace, don't layer)

**Migrate 1:1 from `group-rounds.test.ts` "round driver publication" (plus the hold-consumption test from "round lifecycle and guards") to `group-turns.test.ts`** (real module over the existing fake-gateway harness; no more hand-built commit closures — the real lease runs):

| Today (rounds test) | Becomes |
|---|---|
| publishes only after an accepted reply lease and advances the member watermark | `takeTurn` 'round' → `{ spoke: true }`, watermark + log asserted |
| settles an all-pass round and treats a failed result as silence | failed-as-silence half → module test (`{ spoke: false }`); settle/finalizer half → stays in rounds with an outcome-fake |
| records a failed reason in the normal loop but hides it for continuation failures | module test, both policies asserted |
| does not append or advance on a rejected newer-user lease, but records supersession | module test |
| consumes a room-stopped watermark without appending a reply | module test |
| suppresses result activity when a room-stopped lease rejects | module test |
| keeps a normal-loop cross-thread late reply in its original thread | module test (`'round'`, epoch bumped mid-run) |
| drops a continuation after any epoch change before commit or publication | module test (`'continuation'` — commit never called, nothing published) |
| settles a live driver when an operation is invalidated without publishing | invalidated-op half → module test; settle/finalizer half → rounds outcome-fake |
| does not publish an invalidated failure or timeout | module test (`turns.stop()` then late result → nothing written) |
| holds a member on a stop send and consumes its delta once | hold-consumption half → module test; hold stamping on user send stays in rounds |

**New module tests:** stranded refusal (marker stands → `{ false, false, false }`, zero gateway calls, no token claim — prove via a subsequent harvest still owning the marker); delta-empty skip; turn indicator set `{ sync: false }` before run; continuation hold-skip without consumption; `harvestRoom` filters to marker holders.

**Rounds tests after:** `fakeTurns` becomes an outcome-fake (`takeTurn: vi.fn(async () => ({ abandoned: false, spoke: false, stop: false }))`); keep caps/rounds/continuation-bound tests, send chaining (250 ms), stop/interrupt, epoch bump, hold application from user text. Coverage gaps to close while in the file (one assert each — none has a test today): needs-you clear on send, roster dedup, and the `capped` finalizer activity kind (only `settled` is asserted, in engine tests). End-to-end flavor where cheap: build the REAL turn module over a fake gateway inside rounds tests (both are in-process) so caps tests exercise the real pipeline.

**Untouched:** the 18 `group-turns.test.ts` cases driving `run` directly (session resolution, ownership, stale results, fake-timer timeouts, harvest races) — the internal seam survives precisely so these don't churn.

## 6. Verification commands

```bash
cd client
npm test          # vitest run — all suites green at every phase
npm run typecheck # tsc --noEmit
```
Audit greps after Phase 3/4/5 (§4 expected outputs). `npm run test:e2e` (playwright) for the group flow if the environment allows.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Publication semantics drift (lease classification is subtle) | Byte-identical move; publication tests migrate 1:1 by name; no "improvements" mixed into the move |
| Continuation strict-epoch policy regression | Dedicated migrated test (`drops a continuation after any epoch change before commit or publication`) + the moved comment explaining why continuations never inherit cross-thread acceptance |
| Stranded-refusal changes harvest/turn interplay | Refusal precedes token claim (no invalidation); migrated `group-engine.test.ts` open-harvest test; harvest's own race tests (fake timers) untouched |
| `deactivated`-without-`stopped` window in continuation bail | Argued unreachable (synchronous `deactivate` → `stop` sequence, no await between); comment in code; the strict-epoch test plus existing engine-stop tests cover both reachable paths |
| Test churn cascade | `run` retained as internal seam keeps the 727-line turns suite stable; only the publication describe block migrates |
| Scope creep into candidate 2 (identity) | Only `groupDurableMemberKey` lands; the full identity module stays a separate candidate |

## 8. Out of scope (recorded, not scheduled here)

Full member-identity module (candidate 2) · mirror byte-budget dedup · screen-action policy hook (candidate 7) · route registry (candidate 5) — none of them block this deepening; the smaller-frictions notes from the review report that touch this cluster (`group-runtime` fold, `markKey` ownership) are absorbed above.