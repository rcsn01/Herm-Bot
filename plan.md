# Plan — Deepen session selection out of the GatewayController

Candidate 1 from the 2026-09-20 architecture review (`Strong`). All clarification decisions were
settled with the recommended answers (user pre-authorized). Design was chosen via design-it-twice
(three parallel interface designs; hybrid adopted — see Decision record).

**Repo**: Herm-Bot (Hermes mobile PWA) · **Area**: `client/src/state/`, `client/src/gateway/`

---

## 1. Goal

`GatewayController` is the composition root, but its interface leaks: five methods hand-roll a
stale-guard pair (a private generation counter — the selection epoch in
`newSession`/`resumeSession`/`branchSession`, the reconnect generation in `connect`/`reconnect` —
plus the Gateway Scope), seven sites read
`$chat` internals to make selection decisions, bookmark plumbing hides in private helpers, and the
ordering invariants (select-before-paint, adopt-never-loads-history, reconcile-only-when-resumed,
create-must-refresh-the-roster) live only in comments and call shapes. Its tests observe selection only by spying
on the controller's own methods.

Deepen: one **Session selection** module owns *which session is live* — the selection epoch, the
Scope-guarded publish, bookmarks, the roster-tap pick, and the connect/reconnect restore path —
behind a small interface. The controller keeps transport lifecycle, connection phases, and session
list paging. Tests cross the module's interface instead of spying.

## 2. Non-goals (explicitly out of scope)

- **Session mutation workflow** (rename/archive/delete policy split across chat-screen and
  sessions-menu) — architecture review candidate 4. `deleteSession`/`refreshSessions` keep their
  policy; they only switch to the module's read predicates.
- **ChatInteraction fold into Conversation** — candidate 3.
- `controller.request<T>()` — stays; one consumer (chat-screen slash completion), removing it
  would push scope-checking onto callers.
- `teardownGatewayScope` calling `resetWorkspace()` — separate decision, untouched.
- `loadMoreSessions`/`refreshSessions` paging and query-cache policy — stays on the controller.

## 3. Decision record (grilling rounds, recommended answers adopted)

| # | Decision | Chosen | Rejected alternatives & why |
|---|----------|--------|------------------------------|
| Q1 | Module shape | Standalone `state/session-selection.ts`, constructed by the controller, beside `Conversation` | Fold into Conversation (would widen an already-deep module with non-content policy); merge into SessionRuntime (mixes wire machinery with user-intent policy) |
| Q2 | Interface shape | One `select(request)` union + atomic `restore(open)` + `invalidate()` + two read predicates | Per-verb methods (guard discipline must be re-documented per verb); design-2's `open(intent)` with two-phase `settled` promise (speculative: no second consumer of the deferred phase — YAGNI) |
| Q3 | Error modes | Preserve today's: stale ⇒ resolves `undefined` silently; transport failures ⇒ classified `GatewayError` propagates | Design-2's never-rejects outcome object (every call site would gain a `status` branch; changes deep-link/cron call semantics for no gain) |
| Q4 | Guard axes | **Two axes preserved**: the module owns the *selection epoch* (user-initiated selects); the controller keeps `reconnectGeneration` (transport lifecycle). `restore` does **not** bump the selection epoch | Design-3's single shared epoch — an automatic reconnect (foreground return, transport `closed`) landing mid-flight would eat an in-flight user tap; today the user tap resolving later wins, and that behavior is correct |
| Q5 | Dependencies | Inject `runtime`, `conversation`, and a `refreshSessions` callback; read `$sessions`/`$chat` directly | Design-1's `KeyValue` bookmark-store and `SessionSourceLookup` adapters — one adapter each = hypothetical seams (one-adapter rule); the module sits beside the stores it reads over, like `Conversation` does |
| Q6 | Roster-tap profile switch | Stays in `openProfile` (controller); the module's `latest` intent takes a `freshen: boolean` carrying the switch context (`!switched`) | Design-2's `switchScope` adapter inside the module — drags transport teardown/`$profileSwitching` back behind the seam, the exact shallowness being removed |
| Q7 | SessionRuntime pass-throughs | Delete `subscribe`, `subscribeState`, `connect` from `SessionRuntime`; the controller subscribes on its own transport reference | Keeping them (fail the deletion test: one-line delegations, nothing else calls them) |
| Q8 | Test strategy | Replace, don't layer: new interface tests for the module; spy-based selection tests rewritten to assert gateway traffic + store state | Keeping self-spies (they test past the interface) |
| Q9 | Domain record | Add **Session selection** to `CONTEXT.md`; amend **Conversation** and **Session bookmark** entries | — (applied already, see §9) |
| Q10 | Naming | "Session selection" — matches the phrase already in `CONTEXT.md` ("owns session selection") and keeps controller/Conversation entries coherent | `SessionSelector`/`SessionCoordinator` (no existing domain word) |

## 4. Target interface

New file `client/src/state/session-selection.ts` (no React, no wire imports beyond types — safe
beside `conversation.ts`):

```ts
import type { CurrentGatewayScope } from '~/gateway/scope-guard'
import type { RuntimeSession } from '~/gateway/session-runtime'
import type { Conversation } from '~/state/conversation'

/** What a selection published. `session: null` ⇒ warm-tap (nothing adopted;
 *  reconcile already ran inside when `freshen` was set). */
export interface SelectionOutcome {
  session: RuntimeSession | null
  resumed: boolean
}

export type SelectionRequest =
  | { kind: 'create' }                                // newSession
  | { kind: 'resume'; storedSessionId: string }       // sessions menu, deep links, cron run → session
  | { kind: 'branch' }                                // branch the open conversation
  | { kind: 'latest'; freshen: boolean }              // roster tap pick (openProfile)

export interface SessionSelection {
  /**
   * One user-initiated selection. Bumps the selection epoch at entry (after the
   * `branch` precondition check — a no-op branch must not retire in-flight work).
   * Publish order: source lookup → conversation.adopt → bookmark write → follow-up.
   * Resolves `undefined` when the epoch or captured Scope went stale, or when the
   * request is a no-op (branch without an open durable conversation): nothing is
   * adopted, nothing bookmarked, nothing thrown. Transport failures reject with the
   * classified GatewayError.
   * Follow-up policy per kind: create ⇒ best-effort list refresh (failure swallowed);
   * branch ⇒ awaited list refresh (failure rethrows); resume ⇒ awaited reconcileHistory
   * on the captured scope (failure rethrows); latest ⇒ see below.
   */
  select(request: SelectionRequest): Promise<SelectionOutcome | undefined>

  /**
   * Connect/reconnect restore. Resolves the restore target
   * (`$chat.storedSessionId ?? scope bookmark`), runs `open(target)`, then — only if
   * the captured Scope is current AND `isCurrent()` (the caller's reconnect-epoch
   * callback) — clears the bookmark when `resumed === false` and adopts the opened
   * session through the I2 publish (source lookup → adopt → bookmark write, so the
   * next cold start restores this session). Does NOT touch the selection epoch: an automatic reconnect must never
   * supersede an in-flight user selection. Resolves `undefined` when stale.
   * Reconcile/refresh stay caller policy (paint happens between).
   */
  restore<TOpen extends { resumed: boolean; session: RuntimeSession }>(
    open: (storedSessionId: null | string) => Promise<TOpen>,
    isCurrent?: () => boolean
  ): Promise<{ opened: TOpen } | undefined>

  /** Retire every in-flight selection (dispose). Logout/switchProfile/configure keep
   *  scope-based guarding — their teardown changes the Scope itself. */
  invalidate(): void

  /** The sanctioned `$chat` reads outside the Conversation. */
  activeStoredSessionId(): null | string              // $chat.storedSessionId
  hasLiveSession(): boolean                           // Boolean($chat.runtimeSessionId)
}

export function createSessionSelection(deps: {
  runtime: SessionRuntime
  conversation: Conversation
  refreshSessions: (scope: CurrentGatewayScope) => Promise<void>
}): SessionSelection
```

### Module invariants (implementation, not comments)

- **I1 — One epoch for user selections.** `select` captures `beginScopedTask()`-style scope +
  its epoch at entry; a publish requires `epoch === current && isCurrentGatewayScope(scope)`.
  Replaces the hand-rolled pair in `newSession`/`resumeSession`/`branchSession`.
- **I2 — Adopt-never-loads-history; publish order fixed in code.** Source lookup from `$sessions`
  (the same lookup `selectSession` does today) → `conversation.adopt(session, source)` → bookmark
  write when `session.storedSessionId` → per-kind follow-up. Replaces the private
  `selectSession` + its call-site comments.
- **I3 — `latest` pick.** `humanSessions($sessions.get())`, max `started_at`, first-list tiebreak.
  Warm-tap (`latest.id === $chat.storedSessionId && $chat.runtimeSessionId`): if `freshen`,
  `await conversation.reconcileHistory()` (errors propagate), return `{ session: null, resumed:
  false }`; else return immediately. Otherwise resume-with-fallback-to-create: a resume failure
  (classified) falls back to `create` **re-verifying epoch + Scope before the create**; the create's
  failure propagates.
- **I4 — Never writes `$chat`.** All adoption goes through `Conversation` (sole writer preserved).
- **I5 — Bookmarks.** Key format + localStorage read/write/clear move from the controller's private
  helpers (`sessionBookmarkKey`, `readSessionBookmark`, `clearSessionBookmark`, `scopeSnapshot`)
  into the module, byte-identical.

## 5. GatewayController surgery (`client/src/state/gateway-controller.ts`)

Constructor: keep the transport reference (`private readonly transport`) — subscriptions move off
`SessionRuntime` (Q7); construct `this.selection = createSessionSelection({ runtime, conversation:
this.conversation, refreshSessions: scope => this.refreshSessions(scope) })`.

| Method | After |
|--------|-------|
| `connect()` | `const restored = await this.selection.restore(stored => this.runtime.open({ profile: scope.profile, storedSessionId: stored }, () => this.connection.probe()), () => this.isCurrentReconnect(generation))` inside the existing try/catch; `if (!restored) return` (restore resolves `undefined` when the captured Scope or the reconnect generation went stale — no separate post-open guard remains). Then with `const { opened } = restored`: `savePreferences({ authMode })` → `connected` paint (carries `authMode` + `status` from `opened.preparation`) → `installGroupEngine()` → `if (opened.resumed) reconcileHistory(scope)` → `refreshSessions(scope)` (existing try/catch + guard). Today's intermediate `phase: 'connecting'` + `status` paint (between `savePreferences` and the adopt) is dropped: it ran in the same synchronous block as the `connected` paint, nothing subscribes to `$connection` synchronously there (verified — no `$connection.listen` subscribers; UI reads are React-batched), and the `connected` paint carries the same fields. The "paint the destination now" comment becomes structural: adopt+bookmark already happened inside `restore` before resolve. |
| `reconnect(reconcile)` | Same shape over `runtime.reopen`. `hasCachedSession` uses `this.selection.hasLiveSession()`. |
| `newSession()` | `const sel = await this.selection.select({ kind: 'create' }); if (!sel) return` — refresh policy lives in the module; the method body drops the guard pair, the comment, and the try/catch. |
| `resumeSession(id)` | `const sel = await this.selection.select({ kind: 'resume', storedSessionId: id }); return sel` (reconcile policy lives in the module). |
| `branchSession()` | `await this.selection.select({ kind: 'branch' })`. |
| `openProfile(profile)` | Switch check (unchanged) → `return this.selection.select({ kind: 'latest', freshen: !switched })`. Newest-pick, warm-tap check, and resume-failure fallback move into the module (I3). The doc comment moves with them. |
| `deleteSession(id)` | `if (this.selection.activeStoredSessionId() === id) await this.newSession()` replaces the `$chat.get()` read. |
| `refreshSessions(scope)` | Active-source propagation keeps today's shape, read through the predicate: `const activeId = this.selection.activeStoredSessionId(); if (activeId) { const source = sessions.find(session => session.id === activeId)?.source; this.conversation.setSessionSource(activeId, typeof source === 'string' ? source : null) }`. The clear-when-the-list-omits-the-active-session case (source `null`) is load-bearing — the transcript-provenance tests pin it; a `sessions.find(s => this.selection.isActiveSession(s.id))`-shaped replacement would skip the `setSessionSource` call when the active session is absent from the list and leave stale provenance behind. |
| `dispose()` | `this.selection.invalidate()` replaces `++this.sessionSelectionGeneration`. |
| `logout`/`switchProfile`/`configure` | Unchanged (scope-based guarding survives teardown). |
| Deleted | `selectSession`, `sessionBookmarkKey`, `readSessionBookmark`, `clearSessionBookmark`, `scopeSnapshot`, `sessionSelectionGeneration`. |
| `subscribeRuntime()` | `this.transport.subscribe(...)` / `this.transport.subscribeState(...)` instead of `this.runtime.*`. |
| Unchanged | `request`, `refreshSessions` paging internals, `loadMoreSessions`, rename/archive, `applyConnectionError`, `teardownGatewayScope`, `installGroupEngine`, lifecycle flags, `MINIMUM_CONTRACT`. |

## 6. SessionRuntime deletions (`client/src/gateway/session-runtime.ts`)

Delete `subscribe`, `subscribeState`, `connect` (verified: the controller is the only caller of the
first two, and `connect` has zero callers anywhere — tests included). Verify with
`rg -n 'runtime\.(subscribe|subscribeState|connect)' client/src` before/after.

**GatewayPort fallout (verified; resolve in step 3).** `SessionRuntime implements GatewayPort`, and
`GatewayPort` declares `connect`/`subscribe`/`subscribeState`, so the deletions break the type
contract at three sites: the `implements` clause, the controller's `this.gateway = this.runtime`
(`readonly gateway: GatewayPort`), and `createGatewayApi(this.runtime, scope.profile)` (parameter
`gateway: GatewayPort`). Resolution — `GatewayPort` stays the transport contract; the lifecycle
members become optional and the full-transport shape gets a name:

- `gateway-port.ts`: mark `connect?` / `subscribe?` / `subscribeState?` optional and add
  `export type GatewayTransport = Required<GatewayPort>` (a transport carrying the lifecycle
  members).
- `session-runtime.ts`: type the constructor's `transport` field as `GatewayTransport` (it calls
  `transport.connect` internally). The class keeps `implements GatewayPort` — with the three members
  gone it still satisfies the interface.
- `gateway-controller.ts`: the constructor's `gateway?` parameter and the promoted
  `private readonly transport` field are `GatewayTransport`. `this.gateway = this.runtime`,
  `createGatewayApi(this.runtime, ...)`, `<GatewayProvider gateway={controller.gateway}>`, and the
  `ChatMediaConnection` default all still typecheck: the runtime keeps
  `close`/`request`/`rpc`/`upload`, and every real transport implements all members.

No behavior change: the optionality only records that the session-scoped runtime is not a transport,
and no call site needs `?.` (the controller and the runtime hold `GatewayTransport`; verified: no
other site calls `connect`/`subscribe`/`subscribeState` through a `GatewayPort`-typed value).

**Tests (verified — no adjustment needed).** `gateway/gateway-foundation.test.ts` calls
`gateway.subscribe` on a `MemoryGateway` — the GatewayPort transport surface, not `SessionRuntime`.
`gateway/session-runtime.test.ts` never references `runtime.subscribe`/`subscribeState`/`connect`;
its `connect` matches are recorded `gateway.calls` entries of transport connect RPCs. Both files
pass untouched.

## 7. Tests

### 7a. New: `client/src/state/session-selection.test.ts` (interface is the test surface)

Fakes for `SessionRuntime` (recording RPC calls), `Conversation` (spy on `adopt`/`reconcileHistory`),
and an injectable `refreshSessions`; real `$chat`/`$sessions`/localStorage (jsdom, as existing tests do).

1. `create` publishes: adopt called with source from `$sessions`; bookmark written; best-effort refresh (refresh rejects ⇒ still published).
2. `resume` publishes: reconcile awaited on the captured scope; no list refresh.
3. `branch` publishes: awaited refresh rethrows; precondition no-op resolves `undefined` without bumping the epoch (a concurrent select still publishes).
4. `latest` newest-pick: skips cron rows (`humanSessions`), resumes the newest.
5. `latest` warm-tap + `freshen: true`: no resume RPC, reconcile awaited.
6. `latest` warm-tap + `freshen: false`: no resume RPC, no reconcile.
7. `latest` resume-failure ⇒ create fallback; create failure propagates; a newer select started during the failed resume ⇒ the fallback create publishes nothing (pins the I3 re-check).
8. Epoch discipline: two concurrent selects — the first to resolve after the second started publishes nothing.
9. Scope discipline: `$preferences` scope change between RPC and publish ⇒ `undefined`, no adopt, no bookmark.
10. `restore` target resolution: `$chat.storedSessionId` wins over bookmark; bookmark used when `$chat` empty.
11. `restore` clear-if-not-resumed; `isCurrent` false ⇒ `undefined`, no adopt.
12. `restore` does not bump the selection epoch: an in-flight `select` still publishes after a `restore`.
13. `invalidate()` retires an in-flight select.
14. `activeStoredSessionId` / `hasLiveSession` read-throughs (null when `$chat` is empty, the stored id otherwise).

### 7b. Rewrite: `client/src/state/gateway-controller.test.ts`

Assert gateway traffic via the existing `MemoryGateway.handle` recording + store state instead of
controller self-spies (the rewrite removes 21 spy sites — 19 controller self-spies + 2 conversation
`reconcileHistory` spies — leaving 11: 7 `connect` spies in the profile-switching, switch-flag, and
authentication-lifecycle tests, `gateway.close`, and the three `gateway.connect` spies in the
connection-restoration tests).

- **`roster tap flow` (9 of its 11 tests)** — rewrite: script `session.resume`/`session.create`/`session.list`
  on `MemoryGateway`, drive `controller.openProfile(...)`, assert the recorded `session.resume` calls
  + `$chat.get().storedSessionId`. Covers: switch+resume, cron-row skip, fresh create,
  create-then-tap freshness, resume-failure fallback, same-profile tap without a redundant switch,
  warm-tap no-re-resume, switch-already-landed, connected-before-list (gate `session.list` and
  assert `phase === 'connected'` while pending — the refreshSessions mock becomes a direct test of
  I2). The Group-mirror-signal and switch-flag tests in the same describe stay untouched.
- **`session selection lifecycle`** — the stale-selection test already drives two
  `controller.resumeSession` calls through the public verbs: keep, adapt assertions.
- **`conversation delegation`** — assert `$chat` + `session.*` traffic (today's test asserts `$chat` alone — there is no conversation spy to remove; the rewrite adds the traffic assertion).
- **`transcript provenance`** — unchanged: the active-source propagation keeps today's shape
  (including clear-when-omitted), only the `$chat` read moves behind `activeStoredSessionId`;
  `$chat` assertions stay.
- **Unchanged** — `profile-scoped session mutations`, `incremental session loading`,
  `profile switching`, `connection restoration` (only the hasCachedSession assertions read through
  the new path), `backend compatibility`, `authentication lifecycle`, the roster-tap
  Group-mirror-signal and switch-flag tests, `session selection lifecycle`'s unsubscribe test, and
  `roster tap into a desktop conversation`.

## 8. Behavior-preservation notes (verified against today's code)

- Stale results resolve silently (`undefined`), never throw — matches today's early `return`s.
- `connect`'s guard sits *before* bookmark-clear/adopt (inside `restore`), so a stale open cannot
  publish a dying scope's session.
- A resume-failure fallback create re-verifies epoch + Scope (today's fallback bumped a fresh
  generation via `newSession`, which retires even a newer in-flight selection; with one epoch the
  re-check lets the newer selection win instead — §12's one intentional tightening).
- `openProfile` after a switch skips the warm-tap reconcile (`freshen: !switched`) — preserves the
  `if (!switched)` nuance; `connect` inside the switch already reconciled when resumed.
- Fresh-session bookmark staleness (create does not clear the old bookmark) is preserved as-is;
  `$chat.storedSessionId` masks it while the session stays open.
- `branchSession`'s refresh rethrow and `resumeSession`'s reconcile propagation preserved.

## 9. Documentation (already applied)

- `CONTEXT.md`: added the **Session selection** entry; **Conversation** now says the Session
  selection module owns which session is live; **Session bookmark** names the module as owner.
- Update the `Conversation` class doc-comment in `state/conversation.ts` (same sentence) during
  step 2 (matching §10), and write a module header comment on `session-selection.ts` in the same voice.

## 10. Implementation order

1. **`session-selection.ts` + `session-selection.test.ts`** — module and interface tests
   (fakes for runtime/conversation/refresh; module not yet wired into the controller).
2. **Controller rewiring** — §5 table, including transport-based subscriptions, doc-comment update.
3. **SessionRuntime deletions** — §6, fix references.
4. **Controller test rewrite** — §7b.
5. **Verification** (below), fix fallout.
6. **CONTEXT.md** — already applied (§9); re-read for accuracy after implementation and adjust
   wording if the built interface drifted.

## 11. Verification

```bash
cd client
npm run typecheck                     # tsc --noEmit
npm test                              # full vitest suite
rg -n '\$chat\.get\(\)' src/state/gateway-controller.ts          # expect: no matches
rg -n 'sessionSelectionGeneration|selectSession|SessionBookmark' src/state/gateway-controller.ts  # expect: no matches
rg -n 'runtime\.(subscribe|subscribeState|connect)' src          # expect: no matches (subscriptions read this.transport)
rg -n 'this\.selection\.' src/state/gateway-controller.ts        # expect: 10 call sites (+ the constructor assignment), all through the interface
```

- All pre-existing non-selection tests pass unmodified (mutations, paging, auth, compatibility).
- The new interface tests (7a) pass without touching the controller.
- `npm run dev` + a manual smoke against a gateway (connect → roster tap → new session → branch)
  is the final check; Playwright e2e (`npm run test:e2e`) if the environment allows.

## 12. Risks

- **TS generics on `restore<TOpen>`** — if inference fights the call sites, degrade to returning the
  full open result (`{ opened } | undefined` with `opened` carrying `resumed`/`session`; no
  `Omit` gymnastics).
- **Test-harness assumptions** — some roster-tap tests may currently rely on spy ordering rather
  than gateway traffic; the rewrite restores behavior assertions but may surface latent coupling.
- **Subtle staleness semantics** — the fallback-create re-check (I3) is the one intentional
  tightening; called out here so a behavior diff during review is traceable to a decision, not an
  accident.