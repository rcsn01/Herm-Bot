# Implementation Plan: Session restore yields to newer user selection

**Status:** Implemented. The decision tree was settled using the recommended defaults; implementation and verification are complete.

## Goal

Prevent an in-flight connect or reconnect restore from replacing a session successfully selected by the user while that restore was opening. Keep the policy in the existing Session selection module. Preserve connection startup when an open succeeds but its session result has been superseded.

The intended order is: **Scope and reconnect lifecycle must still be current; then a user selection published after restore began takes precedence over restore publication.** A superseded restore must not adopt its session or touch the Session bookmark. A merely pending selection or one that fails before adoption does not discard a successful restore. A selection that adopts and then fails during bookmark storage or follow-up has already published and does supersede restore.

## Evidence and current behavior

- `client/src/state/session-selection.ts:194–212` increments the `selectionEpoch` private to each `createSessionSelection()` instance when a user selection begins. The branch-without-a-live-durable-session precondition returns before incrementing, so a no-op branch does not retire in-flight work. Warm `latest` requests do increment it, even when they adopt nothing.
- The five user-selection publication sites are `publish(session)` at lines 206, 216, 233, 257, and 269 (branch, create, resume, latest-resume, latest-create fallback); restore calls it separately at line 288. All currently share the same helper, which calls `Conversation.adopt` and then writes a bookmark for durable sessions.
- `client/src/state/session-selection.ts:278–289` captures a Scope, resolves `$chat.storedSessionId ?? bookmark`, awaits `open`, then checks Scope and the optional reconnect-generation callback. A current result may clear the scoped bookmark when its resolved target ID is non-empty and `opened.resumed` is false, then publish through `Conversation`. It does not inspect whether a user selection published while `open()` was pending.
- `client/src/state/gateway-controller.ts:112–145, 309–334` invokes restore from both `connect()` and `reconnect()`. Both return early when restore returns `undefined`; a successful restore normally allows connection setup to continue. `connect()` also starts the Group send engine and refreshes the Sessions list.
- `client/src/state/conversation.ts:375–408` reconciles the Conversation's current runtime session and discards history results if that session changes while history is loading.
- `client/src/state/session-selection.test.ts:936–949` covers a selection started before restore whose slower result publishes after restore. It does not cover restore opening first, a newer user selection publishing, and restore landing last.
- The `Session selection` entry in `CONTEXT.md` records the race as unchanged. No `docs/adr/` exists for this behavior.

## Decisions settled with recommended defaults

1. **Reuse `selectionEpoch` and record its successful publication.** Keep `selectionEpoch` as the request epoch private to each `createSessionSelection()` instance. Add a private `lastPublishedSelectionEpoch` watermark alongside it, set only when a user selection's `Conversation.adopt` succeeds. Capture that watermark when `restore()` begins and compare it after `open()` succeeds. This distinguishes a committed user choice from a pending request, a failure before adoption, or a no-op; it is not a second request counter. Neither value is shared across selection instances, and `restore()` increments neither.
2. **Only a newer published selection supersedes restore.** If a user selection publishes after restore starts, suppress restore publication. If the selection is merely pending when `open()` resolves, allow restore to publish; if the user selection later succeeds, its existing request epoch allows it to publish last. A failure before adoption leaves the valid restored session eligible to publish. A failure after adoption does not undo that publication, so restore remains superseded. A warm `latest` tap that adopts nothing does not change the publication watermark, so restore remains eligible to install the new runtime handle after reconnect. It still increments `selectionEpoch` and can retire an older in-flight user selection, as it does today. The no-op branch remains different: its precondition returns before incrementing `selectionEpoch`.
3. **Make the successful-open result explicit.** Add a small discriminated result so the controller can distinguish an adopted session from a successful open whose publication was superseded:

   ```ts
   export type RestoreOutcome<TOpen> =
     | { kind: 'published'; opened: TOpen }
     | { kind: 'superseded'; opened: TOpen }
   ```

   `restore()` resolves `undefined` only when the Scope or reconnect-generation guard is stale, and rejects when `open()` rejects. When a newer user selection has published since restore began, return `{ kind: 'superseded', opened }` without clearing the bookmark or publishing. Otherwise retain existing bookmark and publication behavior and return `{ kind: 'published', opened }`.
4. **Keep transport success separate from session publication.** A superseded successful open still proves that the current connection opened. `GatewayController` must complete the applicable connection lifecycle rather than leave `$connection.phase` at `connecting` or `reconnecting`. It uses the open's preparation/status, performs existing connection setup, and does not adopt the stale result.
5. **Skip restore-specific history reconciliation when superseded.** The user selection owns its follow-up policy (resume/latest reconciles; create/branch retain their existing behavior). Do not let a superseded restore run a reconciliation as though its session were adopted. For a published restore, retain existing reconcile conditions. Keep the connect path's Group engine startup and Sessions list refresh after either kind of current successful open.
6. **Keep failures and cancellation unchanged.** Do not abort `open()` when a user selection starts. If `open()` rejects, retain existing rejection and connection-error policy even if a user selection published. Keep Scope changes, stale reconnect generations, and newer reconnects governed by their existing guards; they still produce no local restore publication. The remote open may already have resumed a session or created a fresh session before it is superseded; this change discards only local publication and does not attempt remote cleanup.
7. **Update both affected domain notes, not the domain model's vocabulary.** Amend the `Session selection` glossary entry in `CONTEXT.md` to say restore records the last successful user-selection publication when it starts, does not advance the request epoch, and declines local publication when a later user selection publishes first. Qualify the `Session bookmark` entry too: a current restore clears the old bookmark before publication only when its resolved target ID is non-empty, `opened.resumed` is false, and no later user selection published during the open. The target may have come from `$chat` or the bookmark; normal publication may then write a new durable ID. A superseded open leaves bookmark state untouched; the controller continues the successful connection lifecycle. Add no new domain term and no ADR.
8. **Keep the scope narrow.** No UI, wire protocol, GatewaySession, SessionRuntime, bookmark format, or Conversation ownership changes. `$chat` remains writable only by Conversation. No additional dependency.

## Intended behavior

### Restore decision sequence

1. `restore()` captures its existing `ScopedTask` and the current `lastPublishedSelectionEpoch` watermark synchronously before resolving the target or calling `open()`.
2. Resolve the target exactly as today: `$chat.storedSessionId ?? readSessionBookmark(scope)`. Preserve the boundary behavior: no target passes `null`; a null `$chat.storedSessionId` falls back to the bookmark; a non-null stored session id wins; an empty-string bookmark is passed through as `''`.
3. Await `open(target)` with no new cancellation behavior.
4. Check `task.isCurrent()` and the optional reconnect-generation callback first. If either is false, return `undefined` and perform no local side effect, as today.
5. Compare the captured publication watermark with the current `lastPublishedSelectionEpoch`. If it changed, a user selection adopted a session after restore captured its baseline and before restore publication (normally while `open()` was pending). Return `{ kind: 'superseded', opened }` before clearing a bookmark, looking up a source, adopting through Conversation, or writing a bookmark.
6. If the watermark is unchanged, preserve existing behavior: clear the scoped bookmark only when the resolved target ID is truthy and `opened.resumed` is false; then publish the session through the existing restore path and return `{ kind: 'published', opened }`. An empty-string bookmark is passed to `open()` but is not removed by the existing truthiness guard; `SessionRuntime` also treats it as no stored id.
7. Pass the request's `selectionEpoch` to the existing `publish()` helper at all five user-selection commit sites (branch, create, resume, latest-resume, latest-create fallback). The helper marks `lastPublishedSelectionEpoch` immediately after `Conversation.adopt` returns successfully and before bookmark storage, even when the adopted session has no stored id. Restore calls `publish()` without an epoch; warm latest and no-op branch paths do not call it. A throwing `Conversation.adopt` does not mark publication. Keep open rejections unchanged. A selection that rejects before adoption leaves the watermark unchanged; one that rejects after adoption keeps its watermark update.

### Connection lifecycle after a superseded result

- In `GatewayController.connect()`, `undefined` remains an early return for a stale Scope/reconnect. For either current outcome, use `opened.preparation` for `authMode` and `status`, transition to connected, start the Group send engine, and refresh the Sessions list. Reconcile history only for a `published` restore when `opened.resumed` is true. Update the existing comment that currently says every returned restore has already selected its session.
- In `GatewayController.reconnect()`, `undefined` remains an early return. For a `published` result, keep the current optional history reconciliation. For a `superseded` result, skip restore-specific history reconciliation but continue through the existing final Scope/reconnect checks and set the connection phase to connected. The user selection performs its own follow-up if it succeeds.
- Do not treat `superseded` as a reconnect lifecycle invalidation: a later reconnect generation or changed Scope still wins through the existing guards.

## Files in scope

- `client/src/state/session-selection.ts` — track the last successful user-selection publication using its existing request epoch; add `RestoreOutcome`; preserve target resolution, Scope guards, bookmark ordering, and restore publication.
- `client/src/state/session-selection.test.ts` — pin both interleavings and the absence of bookmark/Conversation side effects for superseded opens.
- `client/src/state/gateway-controller.ts` — handle the two successful restore outcomes without short-circuiting connection setup.
- `client/src/state/gateway-controller.test.ts` — verify successful superseded restore completes initial connect and reconnect while preserving the user-selected session.
- `CONTEXT.md` — revise the `Session selection` and `Session bookmark` entries to document the settled restore precedence and conditional bookmark clearing.

No other file is in scope unless a failing focused test proves an integration dependency that cannot be corrected within these paths. Ask before expanding scope.

## Implementation sequence

### Phase 1: Pin Session selection outcomes

Add the Session selection tests below before changing production code. Make the restore/user-publication orderings explicit, including both bookmark clear/write protections, every user-selection publication site, a publication whose later follow-up or bookmark write fails, a selection rejected before adoption, and warm latest/no-op behavior. Update successful-restore expectations to the discriminated outcome. Run the focused test file and confirm failures are limited to the new return shape and missing publication watermark behavior.

### Phase 2: Track successful selection publication in Session selection

In `client/src/state/session-selection.ts`:

- Add `lastPublishedSelectionEpoch` beside `selectionEpoch` inside `createSessionSelection()`; both remain private to that instance.
- Extend the existing `publish(session)` helper with an optional publishing epoch. In the helper, call `conversation.adopt`, record the supplied epoch immediately after it returns, then write the bookmark. Pass the current request epoch from all five user-selection commit sites; call the helper without an epoch from `restore()`. Do not mark warm latest taps or no-op branches.
- Add the `RestoreOutcome` discriminated union and update the `SessionSelection.restore` return type and documentation.
- Capture the publication watermark at restore entry. Preserve the current target resolution, including `null` and empty-string behavior, and the `open()` call. After successful `open()`, retain the Scope and reconnect checks first; return `superseded` if the publication watermark changed; otherwise keep current fresh-bookmark cleanup and `publish()` behavior.
- Keep open rejections unchanged. A user selection that rejects before `Conversation.adopt` leaves the watermark unchanged; one that rejects after adoption keeps its watermark update. Do not cancel an open when a selection begins.

Run `npx vitest run src/state/session-selection.test.ts` and inspect the race cases before changing the controller.

### Phase 3: Preserve GatewayController connection lifecycle

Update both restore callers in `client/src/state/gateway-controller.ts`:

- Continue to return early for `undefined` (stale Scope or reconnect lifecycle).
- For either successful outcome, finish the existing connection setup using the open result. In `connect()`, set auth/status, start the Group send engine, and refresh the Sessions list.
- Run restore-specific history reconciliation only for `kind: 'published'`, preserving the existing `opened.resumed` condition in `connect()` and the `reconcile` condition in `reconnect()`.
- For `kind: 'superseded'`, skip Conversation reconciliation but complete the existing final connection-phase transition. Update comments to distinguish a successful connection open from a published restore.

Add the controller integration tests below with the restore `session.resume` handler gated only after transport `connect()` has succeeded. Verify `connected` state, user-selected session/bookmark retention, and the expected list/reconcile follow-up. Run the focused selection and controller suites together.

### Phase 4: Update domain notes and verify

Amend only the `Session selection` and `Session bookmark` entries in `CONTEXT.md`. Record the successful-publication watermark rule, the `published`/`superseded` restore outcomes, and that only a current, non-superseded fresh open with a non-empty resolved target removes the old bookmark before publication; a new durable opened session may then be written. The target can come from `$chat` or localStorage. Keep Scope, reconnect-generation, Conversation sole-writer, and bookmark ownership language accurate. Then run focused tests, the full client suite, typecheck, build, and final diff checks. Record real results after implementation; this planning pass does not claim those checks have run.

## Test plan

### Session selection module tests

Use the existing `createSelection` fixture and the public `restore()` / `select()` methods. Keep unit assertions at the Session selection interface: return outcome, `Conversation` calls, and localStorage bookmark. If a unit test needs `$chat` to reflect adoption, give the fake Conversation that behavior explicitly; use GatewayController integration tests for actual `$chat` state. Do not inspect `selectionEpoch` or the publication watermark directly.

1. **Normal restore and target boundaries.** Update existing restore tests to assert `kind: 'published'`; preserve target precedence (`$chat` over bookmark), normal adoption, and bookmark writes. Cover no target (`null`), a null `$chat` falling back to a bookmark, and an empty-string localStorage bookmark: `??` passes `''` to `open()`, and the existing truthy cleanup guard leaves that empty value in storage after a fresh open. Also cover a non-empty target that opens fresh as a new durable session: restore removes the old bookmark, then publication writes the new id.
2. **A later publication wins on every selection path.** Hold restore `open()`, then publish through each of the five current selection sites: branch, create, direct resume, latest-resume, and latest-create fallback. Seed a live durable `$chat` before branch; make latest-resume choose a different newest human row; make latest-create fallback's resume RPC reject before adoption. Resolve restore afterward and assert `kind: 'superseded'`, only user-selected sessions are passed to `Conversation.adopt`, and the user's bookmark remains. For the bookmark-clear case, make the user create adopt a session with no stored id, then let restore return a fresh session for an older non-empty target; that result must not clear the existing bookmark. For the bookmark-write case, let the user create publish a new durable id, then let restore return `resumed: true` with the old id; it must not overwrite the user's bookmark.
3. **Restore resolves while a newer selection is pending.** Begin a selection after starting restore, then resolve restore before releasing the selection RPC. Assert restore returns `kind: 'published'` and performs its normal adoption/bookmark policy. Then release the user selection and assert it publishes last. Add the failure-before-adoption variant: if the pending user selection's RPC rejects before `Conversation.adopt`, the successful restore remains active and its bookmark policy is applied. These cases prevent uncommitted intent from discarding the only established session.
4. **Publication remains committed when later work fails.** Start restore, then let a user `resume` adopt its session while `Conversation.reconcileHistory` is held and later rejects. Even though `select()` rejects after publication, restore must return `kind: 'superseded'`; assert the selected user's bookmark remains. In a separate case, make bookmark `setItem` throw once after `Conversation.adopt`; restore must still be superseded because adoption already committed. Let any later restore write succeed so the assertion distinguishes a wrongly published restore, and assert the failed user write and restore leave the original bookmark untouched. This pins the marker between `adopt` and bookmark storage, not merely before follow-up work.
5. **Selection starts before restore.** Retain the existing case where restore publishes first and the still-current earlier selection publishes last. Add the missing reverse landing order: start the user selection, start restore while it is pending, let the user selection adopt first, and assert restore returns `kind: 'superseded'`. Do not add a second copy of the existing publish-first case.
6. **No-op branch.** Exercise both branch precondition failures (`runtimeSessionId` missing and `storedSessionId` missing) while restore is pending; each leaves restore eligible to return `kind: 'published'`. Retain the existing check that a no-op branch does not retire an in-flight user selection. Do not inspect either counter directly.
7. **Warm latest tap.** While restore is pending, select `latest` when the active runtime and stored id already match the newest loaded human session. It adopts nothing and leaves the publication watermark unchanged, so restore remains `published`. Keep the existing behavior that this request still advances `selectionEpoch` and can retire an older pending selection; the existing warm-tap test pins that behavior.
8. **Existing stale guards take precedence.** If Scope changes, or the supplied reconnect-generation callback becomes false, while restore is pending, return `undefined` even if a user selection has already published. In the new Scope-stale race test, assert no additional `Conversation.adopt` beyond the user's publication, no bookmark clear/write from restore, and retention of the user's bookmark. In the existing callback-false test, reseed a non-empty bookmark before the blocked fresh open and assert it remains. The current suite has no restore Scope-stale test.
9. **Open rejection remains an error.** Start restore, publish a user selection while `open()` is pending, then reject `open()`. Assert `restore()` rejects rather than returning `kind: 'superseded'`; preserve the existing controller error classification and do not swallow the rejection.

### GatewayController integration tests

Use the existing in-memory/connection-aware transport fixtures and deferred RPC gates; assert state and requests through the controller's public methods and stores.

1. **Initial connect superseded by a new session.** Seed the current-scope bookmark with an old durable id so `connect()` calls `session.resume`; leave `$chat.storedSessionId` null so the bookmark path is exercised. Gate that resume handler, and wait until it is entered after `ConnectionAwareGateway.connect()` has set `connected` before calling `controller.newSession()`. Return a distinct durable id from the create handler, complete the user selection, then release the old resume with a sentinel transcript row. Assert the new runtime/stored ids and bookmark remain; `$connection` reaches `connected` with the auth mode and status from `opened.preparation`; and the sentinel is neither adopted nor reconciled (no history request for the old id). The user create refreshes the Sessions list once; assert the controller's own post-connect refresh also runs, for two successful `session.list` calls total. Provide a `profiles.list` handler and assert it runs after release: `startGroupEngine()` performs this initial mirror pull, pinning Group startup on the superseded path.
2. **Reconnect superseded by a session selection.** Start from a connected controller whose active session has a durable id and bookmark. Trigger transport close and defer the reconnect's `session.resume` response. Wait for that handler to start after transport connect, select a new durable session, then release the old resume. Assert the new session and bookmark remain, the phase advances from `reconnecting` to `connected`, and the superseded restore issues no history request for the old id. The user's create refresh remains intact.
3. **Warm latest tap during reconnect.** Ensure the active chat and loaded latest human row have the same stored id. Have the reconnect resume return a runtime id different from the active pre-reconnect id, and provide a successful history handler for the old session. While reconnect restore is pending, call `openProfile()` for the current Profile and await its `freshen` history reconciliation before releasing the gated resume. The warm tap does not adopt, so restore must still return `published` and install the newly reopened runtime handle in `$chat`. If its reconciliation remains pending across restore, `Conversation.reconcileHistory` must discard its result when the runtime session changes, as it does today.
4. **Lifecycle stale paths.** Retain the existing newer-reconnect-generation, Scope-change, authentication-failure, and disposal/event-unsubscribe tests. The current disposal test does not cover disposal during a pending restore; do not cite it as coverage for that race. Ensure stale `undefined` outcomes still short-circuit and cannot mark an obsolete connection as connected.
5. Keep ordinary connect/reconnect success tests to pin unchanged `published` behavior, including restore after a selection that published before restore began. Avoid duplicating the Session selection race matrix in GatewayController tests; the controller suite covers composition and lifecycle continuation.

### Verification commands

From `client/`:

```sh
npx vitest run src/state/session-selection.test.ts src/state/gateway-controller.test.ts
npm test
npm run typecheck
npm run build
```

The focused unit and controller tests are the primary verification for this lifecycle race. No UI markup changes. Do not add a browser test: `client/e2e/server.mjs` has no existing controls to pause a WebSocket session-resume reply and trigger a deterministic transport reconnect, so using Playwright would require widening the fixture solely for this race. The controller integration tests exercise the relevant lifecycle through the existing transport fixture.

From the repository root, finish with:

```sh
git diff --check
git status --short
git diff -- plan.md CONTEXT.md client/src/state/session-selection.ts client/src/state/session-selection.test.ts client/src/state/gateway-controller.ts client/src/state/gateway-controller.test.ts
```

**Implementation results:** From `client/`, the focused Session selection and GatewayController suites passed (2 files, 120 tests), `npm test` passed (84 files, 1,152 tests), `npm run typecheck` passed, and `npm run build` passed. The build emitted Vite's `inlineDynamicImports` deprecation warning and a main-chunk size warning. From the repository root, `git diff --check` passed. No browser test was run: there are no UI changes and the E2E fixture lacks controls for this deterministic race.

## Risks and guardrails

- **Connection left in a transitional phase:** returning `undefined` for a superseded user selection would make both controller call paths take their existing stale early return. Use an explicit successful `superseded` outcome and continue the connection lifecycle. Test both `connect()` and `reconnect()`; hold the restore RPC only after transport connection succeeds so the competing user selection can complete.
- **Discarding a successful open on an uncommitted or no-op request:** compare successful-publication state, not request-start state. A create that fails before adoption or a warm latest tap must not leave reconnect with only an obsolete runtime handle. A selection that fails after adoption is committed and still supersedes restore.
- **Bookmark corruption:** compare the publication watermark before bookmark clearing and before restore publication. The user's bookmark must remain untouched by the stale open.
- **Accidental restore reconciliation:** do not use the opened session's `resumed` flag to reconcile after supersession. That result was not adopted; the user-selection module owns its follow-up. Preserve the controller's transport/phase setup.
- **Scope/reconnect regression:** retain the existing checks and their ordering before selection-epoch classification. A stale connection is not a successful superseded open.
- **Changing error policy:** only a successful `open()` can return `superseded`. Keep failures rejected and classified by existing controller logic.
- **Changing user-selection policy:** do not bump either epoch from restore. Do not make a no-op branch bump `selectionEpoch`. A warm latest tap still bumps `selectionEpoch` and may retire older in-flight selections, but it must not change the publication watermark. Do not alter create/resume/branch/latest follow-up behavior or the winner among user selections.
- **Remote open side effects:** `SessionRuntime.open()` can resume a stored session or create a fallback session before the selection watermark is checked. The resulting runtime session is not locally adopted when superseded; do not add speculative delete/cleanup behavior for the remote result.
- **Over-expanding the candidate:** do not add cancellation, a separate restore module, a second request epoch, a new adapter, an ADR, or unrelated `$chat`/Conversation changes.

## Acceptance criteria

- Restore records the last successful user-selection publication when it starts and cannot publish if a later user selection adopts a session before the open lands. A selection that published before restore started is part of the captured baseline and does not suppress restore.
- A superseded successful restore returns an explicit outcome but does not clear/write the Session bookmark or call `Conversation.adopt`.
- Pending selections, failures before adoption, and no-op requests do not suppress a successful restore; a pending selection that later succeeds remains the final publication. A selection that fails after adoption still supersedes restore.
- `undefined` continues to mean stale Scope/reconnect lifecycle; `open()` errors continue to reject.
- Initial connect and reconnect both complete their successful connection lifecycle after a superseded restore, while leaving the selected session in the Conversation.
- No restore-specific history reconciliation runs for a superseded result; normal published-restore reconciliation remains unchanged.
- Existing restore target resolution (`$chat` first, then bookmark, with `null`/empty-string behavior preserved), conditional bookmark clearing, Scope protection, reconnect-generation protection, and user-selection epoch ordering remain covered.
- The `Session selection` and `Session bookmark` glossary entries document the new precedence and conditional bookmark clearing without inventing a domain term.
- Focused tests, full tests, typecheck, build, and `git diff --check` pass, with real results recorded.
- The diff is limited to the plan and files in scope; no unrelated changes are staged or committed.
