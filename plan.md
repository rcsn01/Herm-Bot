# Plan: give the chat read surface one owner — Conversation owns the session-info snapshot

> **Baseline:** this checklist describes the change from commit `04e987e` to `11c78ae`. The production refactor, fixture edits, and glossary update are already present in `11c78ae`. The Phase 1 edge assertions were outstanding on that source commit and are now added against semantic outputs; do not reintroduce raw-state fixtures. The raw-state characterization step applies only before the refactor, at the stated baseline.

## Goal

Deepen the Conversation's read surface so `$chat.info` and `$chat.pendingPrompt` expose semantic values, not raw gateway shapes. Today the desktop wire type `SessionRuntimeInfo` crosses the seam into `ChatState.info`. `ContextUsage` contains one usage-field fallback chain, `PromptCard` contains one prompt-field chain, and two title readers cast `chat.info` because its type omits `title`. The issue is not duplicated fallback code: each usage and prompt chain currently has one view consumer. The issue is that views interpret gateway vocabulary instead of receiving semantic state, while the title type mismatch forces casts.

This is an ownership refactor, not a wire-protocol or RPC change. It preserves the existing rendering for string titles and the usage and prompt cases described below. One deliberate exception is a truthy non-string title, which the projection changes to `''`. The client does not establish that such a title is wire-illegal; decision 7 records this as a behavior change for a shape the client does not validate. PWA update gating stays unchanged. The external interfaces of the Conversation (verbs), the GatewaySession (chat surface), and ChatInteraction do not change beyond the semantic types of `$chat.info` and `$chat.pendingPrompt`.

## Current state and friction

The leak has one root and four symptoms:

- **Root:** `client/src/lib/types.ts:173` types `ChatState.info` as `null | SessionRuntimeInfo` — the desktop compat wire type (`compat/hermes-types.ts:690`). `conversation.ts:86` cements it: `info: payload as unknown as ChatState['info']`. The compat type does not even declare `title`, so every title reader must cast.
- **Symptom 1:** `components/chat-screen.tsx:254` and `:287–292` — the call site casts `chat.info.usage as Record<string, unknown>`, and `ContextUsage` interprets `usage.total ?? usage.total_tokens` and `usage.context_limit ?? usage.max_tokens` with `Number()` coercions and an early return. None of `total_tokens`, `context_limit`, or `max_tokens` exist in `UsageStats`; this session-usage aliasing logic appears only in `ContextUsage`. `max_tokens` also occurs in unrelated model configuration types and is not a usage field there.
- **Symptom 2:** `components/chat-screen.tsx:314` — `PromptCard` resolves `String(pending.payload.question ?? pending.payload.message ?? pending.command ?? '')`, re-implemented prompt-card wire vocabulary beside the Group member turn's own parsing.
- **Symptom 3:** `components/chat-screen.tsx:190` and `app.tsx:153` — two independent `(chat.info as { title?: string } | null)?.title` casts with separate display fallbacks.
- **Symptom 4:** `state/conversation.ts:171–173` — `retitleActive` writes `info: { ...current.info, title } as typeof current.info`, a cast that exists only because the type lacks the field.

These interpretations are spread across `ChatScreen` and `App`, while the gateway adapter also types `RuntimeSession.info` through `ChatState`. Moving the single-use usage and prompt policies is not a deduplication win. It gives `$chat` one semantic contract, lets event reduction and adoption share the same projection, and keeps the wire adapter independent of state-layer types. A separate helper module would still have one owner and one consumer, so the projection belongs inside Conversation.

Test fixtures confirm the type is wrong, not the data: `chat-screen.test.tsx:198,378` and `app-navigation.test.tsx:88` set `$chat` info with `as never` casts because raw wire shapes do not fit the declared state type.

## Decisions settled

These are the recommended defaults adopted at the user's request:

1. **Owner:** the Conversation module (`state/conversation.ts`) owns the normalization in place, as private pure helpers beside its existing reduction. No new module: a helpers module would have exactly one consumer and fails the deletion test (deleting it just moves the helpers back into the reducer). The semantic state types live in `lib/types.ts` beside `ChatState` and `PendingPrompt`.
2. **State shape:** `ChatState.info` becomes `null | SessionInfoSnapshot`, a minimal semantic type — `{ title: string, running: boolean, usage: SessionUsage | null }` with `SessionUsage = { used: number, limit: number }`. Wire fields nothing reads today (`model`, `provider`, `cwd`, `tools`, `skills`, warnings, `version`, `yolo`, …) drop at the seam; `contractVersion` and `storedSessionId` are already extracted into their own `ChatState` fields and stay there. A future screen that needs more extends the projection in one place.
3. **Pending prompt:** `PendingPrompt` becomes `{ kind, requestId, question: string }`. The `payload` record collapses: `respond()` uses kind + requestId, `PromptCard` renders kind + question, and the PWA gates only test truthiness.
4. **Wire side stays raw:** `RuntimeSession.info` is typed `SessionRuntimeInfo` (imported from `~/compat/hermes-types` directly), removing `gateway/session-runtime.ts`'s reference to the state-layer `ChatState` type. The GatewaySession remains the wire seam — raw rows out, meaning elsewhere — exactly as `CONTEXT.md` already documents for history rows.
5. **Usage policy, preserved exactly:** `used = Number(raw.total ?? raw.total_tokens ?? 0)`, `limit = Number(raw.context_limit ?? raw.max_tokens ?? 0)`; the snapshot's `usage` is `null` iff raw usage is absent, `null`, non-object, or both coercions are falsy. This absorbs `ContextUsage`'s early return, so the view renders unconditionally. The progress-bar fallback `max={limit || used || 1}` is presentation and stays in the view. Do **not** start reading `UsageStats.context_max` / `context_used` / `context_percent`. The view never read them, and adding reads is a behavior change.
6. **Prompt question policy, preserved exactly:** `String(payload.question ?? payload.message ?? payload.command ?? '')`. Prompt-card presentation (titles per kind, sensitive masking for secret/sudo, text vs password input, allow/deny buttons for approval) stays in `PromptCard`.
7. **Title policy:** `text(raw.title)` (string or `''`). Each `session.info` event replaces the snapshot wholesale. Do not merge fields. A payload without `title` resets it to `''`, and the header falls back as it does today. Display fallbacks (`'New conversation'` in `app.tsx`, `|| ''` in the rename dialog) stay with their screens. One deliberate deviation: a *truthy non-string* `title` (say a number) previously reached the header and rename dialog as a number; `text()` now coerces it to `''`, so both screens use their fallbacks. `SessionRuntimeInfo` does not declare `title`, and `SessionRPCResponse.info` is only typed as `Record<string, unknown>`. The client does not validate this field or establish that a non-string is wire-illegal. Phase 1 pins the numeric case as an intentional behavior change, not an unreachable one.
8. **Test surface:** projection and response characterization goes through the Conversation's public interface (`reduceGatewayEvent`, `adopt`, `retitleActive`, `respond`); no normalization helper is exported for tests. Existing UI assertions already pin the `'25 / 100'` context pixel, approval question (`'rm file'`), rename dialog's initial value (`'Planning session'`), and header subtitle (`'Current chat'`). Phase 1 adds the missing usage edge pixels, empty-question rendering, and empty/non-string title fallbacks while preserving those existing assertions.
9. **Domain notes:** `CONTEXT.md` gains the term **Session info snapshot** (the Conversation-owned semantic projection) and its `Chat state ($chat)` / `Conversation` / `GatewaySession` entries are amended — at implementation time, alongside the code, as this plan's Phase 6 specifies.
10. **Scope:** no ChatInteraction changes (its hand-bound commands, StrictMode disposal, and `controller.request` scope guard are a separate candidate), no Group member-turn changes (its prompt cards ride a different wire and own their parsing), no Transcript, transcript-cache, wire-protocol, or GatewayController changes.

## Intended module ownership

### `lib/types.ts` — semantic state vocabulary

- `SessionUsage { used: number; limit: number }` and `SessionInfoSnapshot { title: string; running: boolean; usage: null | SessionUsage }` are defined here.
- `PendingPrompt` gains `question: string` and drops `payload`.
- `ChatState.info` becomes `null | SessionInfoSnapshot`. The `SessionRuntimeInfo` import/re-export drops from this file. At the baseline, `lib/types.ts` is the only client import/re-export used to type `ChatState.info`; `compat/hermes-types.ts` declares the wire type, and no other module or test imports the `lib/types.ts` re-export. Phase 4 deliberately adds a direct compat import in `gateway/session-runtime.ts`.

### `state/conversation.ts` — the sole owner of session-info meaning

- Private `sessionInfoSnapshot(raw: object): SessionInfoSnapshot` — accepts the raw wire value structurally (the non-nullable `RuntimeSession.info` or the reduction's `record()` product; property reads go through the module's existing `record()` narrowing), so the state layer needs no compat import:
  - `title: text(raw.title)`
  - `running: Boolean(raw.running)`
  - `usage: null` when the raw usage value is not an object or both coercions are falsy, else `{ used, limit }` per decision 5.
- The private `pendingPrompt()` constructor resolves `question` per decision 6 and stops storing the raw record.
- `reduceGatewayEvent`'s `session.info` case returns `info: sessionInfoSnapshot(payload)` — the `as unknown as` cast disappears. The `desktop_contract` guard math and `stored_session_id` extraction are untouched.
- `adopt()` normalizes `session.info` (`RuntimeSession.info` arrives raw); the cached-transcript path, initial `running: false`, and every other field are unchanged.
- `retitleActive` writes `info: { ...current.info, title }` with no cast, still only for a matching stored id, still leaving `info` untouched (same object identity) otherwise.
- `reconcileHistory` reads `current.info?.running ?? false` — the semantic equivalent of today's `Boolean(current.info?.running)`.

### `gateway/session-runtime.ts` — the wire seam stays raw

- `RuntimeSession.info: SessionRuntimeInfo`, imported from `~/compat/hermes-types`; the module's `ChatState` import drops — `session-runtime.ts` uses it nowhere else (only the `RuntimeSession.info` field at :41 and the `sessionFromResponse` cast at :304, both rewritten here).
- `sessionFromResponse()` keeps building `info` from `response.info ?? {}`; the cast target becomes `SessionRuntimeInfo` (`Record<string, unknown> as SessionRuntimeInfo` type-checks, as verified against the repo's tsconfig). `RuntimeSession.info` is non-nullable at the type level. The fallback handles missing info by contract and `null` at runtime. It does not validate a non-null RPC value of the wrong shape. Nothing else in the module changes.

### Consumers — render only

- `components/chat-screen.tsx`:
  - `ContextUsage({ usage }: { usage: SessionUsage })` — the call site's `as Record<string, unknown>` cast, the `Number(...)` chains, and the early return move behind the Conversation; `max={limit || used || 1}` stays.
  - Rename dialog: `initialValue={chat.info?.title || ''}` — cast gone.
  - `PromptCard`: renders `pending.question`; the payload-interpretation line is deleted.
- `app.tsx`: `const headerSubtitle = chat.info?.title || 'New conversation'` — cast gone.
- `pwa/lifecycle.ts` and `pwa/PwaStatus.tsx`: unchanged; both gate on `pendingPrompt` truthiness, which a `question: ''` object still satisfies exactly as an empty-payload object does today.

There is no new adapter. `SessionRuntime.sessionFromResponse()` already creates `RuntimeSession` from raw RPC info; tests exercise that path with `MemoryGateway` as its `GatewayTransport`. Conversation remains the single owner of the projection. The existing handoff is the seam, so this refactor adds no producer or adapter layer.

## Invariants to preserve

1. **session.info reduction:** `desktop_contract` handling (undefined marker preserves prior contractVersion; non-finite resets to prior; numeric updates) and `stored_session_id` capture (`text(...) || state.storedSessionId`, same-context reset rule) are byte-identical.
2. **Wholesale replacement:** every `session.info` event replaces the snapshot in full — a payload without `title` resets `title` to `''`; the header falls back to `'New conversation'` exactly as today. No merging of old and new fields.
3. **Usage pixels:** every case renders identically — `{ context_limit: 100, total: 25 }` → `25 / 100` progress; total-only → `max = used`; limit-only → `0 / <limit>`; absent usage, `{}`, non-object usage, all-zero, or garbage in *both* coercions (`Number` → `NaN`, falsy like `0`) → nothing rendered. Garbage in one field beside a truthy partner still renders with `NaN` embedded (`{ total: 'x', context_limit: 100 }` → `NaN / 100`) — the snapshot stores coerced values as-is. Do not "fix" either NaN edge.
4. **Prompt card pixels:** question text for `question`/`message`/`command` field variants; empty question renders no `<p>`; kind titles, sensitive clearing (value cleared on submit and in `finally`), disclaimer line, and approval allow/deny buttons unchanged.
5. **Respond wire:** `${kind}.respond` with `request_id` + kind-specific field (`answer` / `choice` / `password` / `value`) unchanged; card cleared only when the landed scope is current and the requestId still matches.
6. **retitleActive:** retitles only a matching stored id; a non-matching call leaves `info` referentially identical (asserted today at `gateway-controller.test.ts:148–150`).
7. **adopt:** initial `running: false` regardless of raw info (reconcile refreshes it); cached-transcript adoption rule unchanged; `session.info` normalized at adoption.
8. **PWA gating:** `pwa/lifecycle.ts:98` and `PwaStatus.tsx:11` keep blocking reload on `chat.pendingPrompt` truthiness — a pending prompt with an empty question still blocks.
9. **Wire fixtures stay raw:** memory-gateway `session.create` / `session.resume` handlers keep returning raw `info` payloads; only `$chat` state is semantic.
10. **No exported test helpers:** normalization functions stay private; tests cross the module's public interface only.
11. **transcript-cache:** untouched — it persists transcript entries and a stored id, never info or prompts.
12. **Gateway layer independence:** after the change, no `gateway/` file references chat state types; `gateway/session-runtime.ts` owns its wire vocabulary.

## Implementation sequence

### Phase 1 — Complete characterization on the current semantic surface

The refactor is already present in the current tree. Complete the remaining tests against the Conversation's public interface and semantic outputs; do not reintroduce raw `$chat` fixtures or exported test helpers.

- In `state/conversation.test.ts`, drive `reduceGatewayEvent` with `session.info` payloads covering: usage absent, `null`, a primitive, an array, `{}`, current names, legacy names, and conflicting current/legacy names (current fields win). Pin nullish fallback separately from falsy values: `null` current fields fall back to legacy fields, while `''`, `false`, and `0` do not because the policy uses `??`. Also cover total-only, limit-only, all-zero, numeric-string coercion, garbage yielding no usage, and one `NaN` value beside a valid partner (the snapshot stores `NaN`, without clamping). Cover `title` as a string with surrounding whitespace / truthy non-string / absent and `running` as `true`, `false`, and a truthy non-boolean. Start one reduction from a populated snapshot and send a payload without title or usage; assert wholesale replacement resets them instead of merging. Assert semantic `info: { title, running, usage }` and separate `state.running`.
- Drive all four `.request` kinds through the question chain. Pin precedence (`question` before `message` before `command`), nullish fallthrough at each level, empty-string and other falsy non-nullish values suppressing lower-priority fields, no fields, non-string conversion at each selected field, and unchanged surrounding whitespace in a selected string. Assert kind, requestId, and the resolved question per decision 6.
- Drive `Conversation.respond()` for all four kinds through `MemoryGateway`. Assert the exact method and params (`clarify.respond`/`answer`, `approval.respond`/`choice`, `sudo.respond`/`password`, `secret.respond`/`value`, each with `request_id` and `session_id`, and no question/payload fields). Resolve an in-flight response after a different prompt replaces it and after the Scope changes; neither stale response may clear the current prompt. Keep the existing current-scope failure case, which leaves the prompt pending.
- Keep the `adopt()` tests through a raw `RuntimeSession`: one `info` with title, `running: true`, and usage, and a bare `info: {}`. Assert the semantic snapshot and the initial `running: false` state flag.
- Keep the existing `'25 / 100'` usage pixel, approval question (`'rm file'`) assertion, rename dialog initial value (`'Planning session'`) assertion, and `'Current chat'` header assertion. Drive additional usage pixel cases from reduced state: total-only (`25`, progress max `25`), limit-only (`0 / 100`, max `100`), absent/empty/all-zero usage (no context row), and `{ used: NaN, limit: 100 }` (`NaN / 100`, without clamping). Assert that an empty resolved question renders no `<p>`. In `app-navigation.test.tsx`, pass empty and numeric titles through `reduceGatewayEvent` and assert the `'New conversation'` header fallback. In `chat-screen.test.tsx`, pass those same titles through the reducer and assert the rename dialog's initial value is `''`. These pin the current semantic output and the deliberate title behavior change without seeding raw wire state into `$chat`.

### Phase 2 — Semantic types in `lib/types.ts`

- Add `SessionUsage` and `SessionInfoSnapshot`; add `question: string` to `PendingPrompt` and drop `payload`; change `ChatState.info` to `null | SessionInfoSnapshot`.
- Drop the `SessionRuntimeInfo` import/re-export from `lib/types.ts`. The compiler will flag direct accesses to the removed `pending.payload`, but it will not find every affected site: `as never` suppresses fixture errors, and title casts may still type-check after `title` is added. Use the explicit grep inventory and Phase 6 fixture list as well as TypeScript; do not silence newly exposed errors with more casts.

### Phase 3 — Conversation owns the normalization

- Add the private `sessionInfoSnapshot` helper and the usage policy; rewrite the private `pendingPrompt()` constructor to resolve `question`.
- Route `reduceGatewayEvent`'s `session.info` case and `adopt()` through the helper; delete the `as unknown as` and `as typeof current.info` casts; switch `reconcileHistory` to `current.info?.running ?? false`.
- Update Phase 1's characterization assertions from raw to semantic expectations: `info: { running, title, usage }` (NaN stored as-is), the resolved `question` on each request kind, and adopt's snapshot. Update the `title: 42` UI assertions from the baseline number to the deliberately changed screen fallbacks.

### Phase 4 — GatewaySession stays raw

- In `gateway/session-runtime.ts`: type `RuntimeSession.info` as `SessionRuntimeInfo` (import from `~/compat/hermes-types`), fix the `sessionFromResponse` cast target, and remove the `ChatState` import — its only uses were the two sites just rewritten.

### Phase 5 — Consumers render only

- `chat-screen.tsx`: `ContextUsage` takes `SessionUsage` (delete the call site's `as Record<string, unknown>` cast, the `Number` chains, and the early return; keep the `limit || used || 1` max fallback and the `toLocaleString` formatting); rename dialog reads `chat.info?.title || ''`; `PromptCard` reads `pending.question`.
- `app.tsx`: header subtitle reads `chat.info?.title || 'New conversation'`.
- No changes to `pwa/lifecycle.ts` or `pwa/PwaStatus.tsx`, the composer, viewport, or dialog components. (The `pwa/lifecycle.test.ts` fixture edit belongs to Phase 6.)

### Phase 6 — Fixtures, suite inventory, and domain notes

- `conversation.test.ts`: `$chat.set` fixtures (retitle test at lines 27 to 43, respond test at lines 216 to 225) become semantic; the retitle assertion becomes semantic object equality. `adopt` fixtures stay raw and cast-free, with one mechanical edit: the seven `info: null` literals (lines 313, 326, 349, 370, 478, 491, 524) become `info: {}`. `null` violates the declared non-nullable `RuntimeSession.info` type; `sessionFromResponse()` defaults absent/nullish info to `{}`, but does not validate a non-null RPC value's shape. `session-selection.test.ts` already uses `info: {}`.
- `chat-screen.test.tsx`: :198 → `info: { running: false, title: '', usage: { limit: 100, used: 25 } }`; :378 → `info: { running: false, title: 'Planning session', usage: null }`; :423 → `{ kind: 'approval', question: 'rm file', requestId: 'approval-1' }`. The two info fixtures drop their `as never` casts; the approval fixture had no cast and only changes shape. Keep the unrelated `as never`s at :100 and :271. Existing pixel assertions stay unchanged; add the new edge assertions from Phase 1.
- `app-navigation.test.tsx:88` → `info: { running: false, title: 'Current chat', usage: null }`; header assertion unchanged.
- `gateway-controller.test.ts`: wire fixtures untouched; `:143` / `:330` `toMatchObject({ title: 'Renamed' })` still pass against the semantic snapshot; verify the `:148–150` identity assertion still holds.
- `gateway/session-runtime.test.ts`, `chat-interaction.test.ts`, `session-selection.test.ts`, and `pwa/policy.test.ts` / `push.test.ts` / `push-payload.test.ts`: expected to pass untouched — verify, don't edit preemptively (`session-runtime.test.ts` drives only raw wire responses and never reads `info`).
- `pwa/lifecycle.test.ts:61`: `{ kind: 'secret' } as never` becomes `{ kind: 'secret', question: '', requestId: '' }` with its cast deleted. The empty question still blocks the reload, which is exactly the gate this test pins. There are four targeted `as never` casts across these three test files: the two info fixtures in `chat-screen.test.tsx`, the info fixture in `app-navigation.test.tsx`, and this PWA prompt fixture. The approval-prompt fixture in `chat-screen.test.tsx` had no cast; it only changes shape. Keep the unrelated casts in `chat-screen.test.tsx:100,271` and `app-navigation.test.tsx:47`.
- Update `CONTEXT.md`:
  - Add the term **Session info snapshot** — the Conversation-owned semantic projection of the gateway's `session.info` payload (title, running, context usage); field-name fallbacks (`total ?? total_tokens`, `context_limit ?? max_tokens`) are the Conversation's implementation, not caller knowledge; `PendingPrompt.question` is resolved there too.
  - Amend **Chat state ($chat)** — `info` is the session-info snapshot and `pendingPrompt` carries the resolved question; the view renders, it never interprets gateway payloads.
  - Amend **Conversation** — it owns the session-info projection beside event reduction.
  - Amend **GatewaySession** — note that `RuntimeSession.info` stays raw wire vocabulary, like history rows.
  - Keep every other entry untouched and consistent with the implementation.

### Phase 7 — Verify and review

Run focused suites first, then all checks from `client/`:

```sh
npx vitest run \
  src/state/conversation.test.ts \
  src/components/chat-screen.test.tsx \
  src/app-navigation.test.tsx \
  src/state/gateway-controller.test.ts \
  src/features/chat/chat-interaction.test.ts \
  src/pwa/lifecycle.test.ts
npx tsc -p tsconfig.json --noEmit
npm test
npm run build
npx playwright test e2e/pwa-foundation.spec.ts \
  --grep 'password cookie authenticates a real WebSocket chat session'
```

The browser test exercises the real user-visible chat flow (WebSocket session, rendered conversation) and should run in both configured projects (Chromium and WebKit) when their browsers are installed. If browser execution is unavailable, report that explicitly; typechecking and unit tests are not a substitute for the user-visible flow.

Before considering the plan implemented, also run `git diff --check`, inspect `git status --short`, and review the final diff for unrelated changes. Do not stage or commit unless separately requested.

**Verification after completing Phase 1:** the focused six-file Vitest command passed (216 tests), `npx tsc -p tsconfig.json --noEmit` passed, `npm test` passed (83 files / 1,101 tests), `npm run build` passed (Vite reported an 842.67 kB minified chunk warning), and the selected Playwright chat test passed in Chromium and WebKit (2 runs). `git diff --check` passed, and the intended modified paths are the three targeted test files plus `plan.md`.

## Risks and guardrails

- **Behavior-drift risk:** the usage and question chains are the contract — Phase 1 pins them through `reduceGatewayEvent` before any code moves. Do not normalize "better" (no `context_max` reads, no NaN clamping, no trimming).
- **Type-ripple risk:** the `ChatState.info` change can break typed production reads, and removing `PendingPrompt.payload` breaks its direct view access. `tsc` will not enumerate all affected fixtures because `as never` bypasses checking, and title casts can remain type-correct. Fix each site at its layer using the source inventory plus compiler output (Phase 4 wire, Phase 5 views); do not add compatibility shims or new `as never` casts.
- **Fixture-churn risk:** the baseline has four targeted `as never` fixture casts across three test files (`chat-screen.test.tsx:198,378`, `app-navigation.test.tsx:88`, `pwa/lifecycle.test.ts:61`). Remove those four; the approval fixture changes shape but had no cast. Keep unrelated casts (`chat-screen.test.tsx:100,271`, `app-navigation.test.tsx:47`) and preserve the pixel assertions. If a pixel assertion needs to change, stop and determine whether it is one of the explicitly recorded title or NaN deviations before changing it.
- **Over-abstraction risk:** keep the helpers private and specific. If a second module ever needs session-info meaning, that is the moment to extract — one consumer does not justify a new seam.
- **Scope-creep risk:** ChatInteraction's construction/disposal and `controller.request`'s hand-rolled Scope guard stay untouched (separate candidate); so do the session-roster slice and Group prompt parsing.

## Acceptance criteria

- `$chat.info` and `$chat.pendingPrompt` are semantic types; no component or app-level file imports a compat wire type or casts to read chat state. The five view-side leak sites are gone: the `ContextUsage` call-site cast, the single usage parser (its used and limit field chains at `chat-screen.tsx:254 and 287 to 292`), the `PromptCard` question chain at `:314`, and the two title casts at `:190` and `app.tsx:153`. The separate `retitleActive` cast is also removed in Phase 3.
- `state/conversation.ts` is the only module that projects gateway title/running/usage and request-question fields into `$chat`; its existing `desktop_contract` and `stored_session_id` handling stays in place. `gateway/session-runtime.ts` references no state-layer type.
- All preserved-behavior invariants pass: reduction math, wholesale replacement, usage/question/title chains, respond wire, retitle identity, PWA gating.
- Phase 1 characterization plus the semantic normalization table are green, the focused suites, full `npm test`, typecheck, build, and the e2e chat flow have real recorded results, and `git diff --check` is clean.
- `CONTEXT.md` names the Session info snapshot and its owner without contradicting the implementation.

## Explicit non-goals

- No ChatInteraction refactor: command binding, StrictMode disposal choreography, `Conversation.attach` reference normalization, and the `controller.request` scope-guard migration are a separate candidate.
- No new usage semantics: `context_max`, `context_used`, `context_percent`, and cost fields stay unread; no new UI for usage.
- No PromptCard presentation changes (titles, masking, disclaimer, buttons) and no change to prompt-response wire shapes.
- No Group member-turn changes — its prompt cards ride the Group mirror wire and own their parsing, per the glossary.
- No Transcript, transcript-cache, workspace-navigation, PWA, or GatewayController changes; no session-roster extraction; no new atoms or state fields.
- No wire-protocol, storage-format, or e2e-harness changes.