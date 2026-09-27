# Plan: give the chat read surface one owner — Conversation owns the session-info snapshot

## Goal

Deepen the Conversation's read surface so `$chat` carries semantic state only. Today the desktop wire type `SessionRuntimeInfo` crosses the seam into `ChatState.info`, and three consumers re-implement gateway field-shape fallbacks — `usage.total ?? usage.total_tokens`, `payload.question ?? message ?? command`, and two independent `info as { title }` casts — that the glossary already promises the view never does.

This is an **ownership/locality refactor**, not a behavior change. The wire protocol, the RPC vocabulary, every rendered pixel for wire-legal payloads, and the PWA update gating stay exactly as they are (decision 7 records the one deviation, reachable only from a contract-violating payload). The external interfaces of the Conversation (verbs), the GatewaySession (chat surface), and ChatInteraction do not change shape beyond the two state fields this plan deepens.

## Current state and friction

The leak has one root and four symptoms:

- **Root:** `client/src/lib/types.ts:173` types `ChatState.info` as `null | SessionRuntimeInfo` — the desktop compat wire type (`compat/hermes-types.ts:690`). `conversation.ts:86` cements it: `info: payload as unknown as ChatState['info']`. The compat type does not even declare `title`, so every title reader must cast.
- **Symptom 1:** `components/chat-screen.tsx:254` and `:287–292` — the call site casts `chat.info.usage as Record<string, unknown>`, and `ContextUsage` interprets `usage.total ?? usage.total_tokens` and `usage.context_limit ?? usage.max_tokens` with `Number()` coercions and an early return. None of `total_tokens`, `context_limit`, or `max_tokens` exist in `UsageStats`; they are legacy gateway field names known only to the view.
- **Symptom 2:** `components/chat-screen.tsx:314` — `PromptCard` resolves `String(pending.payload.question ?? pending.payload.message ?? pending.command ?? '')`, re-implemented prompt-card wire vocabulary beside the Group member turn's own parsing.
- **Symptom 3:** `components/chat-screen.tsx:190` and `app.tsx:153` — two independent `(chat.info as { title?: string } | null)?.title` casts with separate display fallbacks.
- **Symptom 4:** `state/conversation.ts:171–173` — `retitleActive` writes `info: { ...current.info, title } as typeof current.info`, a cast that exists only because the type lacks the field.

The deletion test fails for each fallback chain: remove one and it reappears in the next consumer of `$chat` (the chains already exist in three files). The friction is not wrong behavior — it is that the interface does not provide one place to learn, test, and change what a session's info and a pending prompt *mean*. `gateway/session-runtime.ts:41,304` compounds it by typing `RuntimeSession.info` as `ChatState['info']`: the wire adapter references a state-layer type instead of owning its own wire vocabulary.

Test fixtures confirm the type is wrong, not the data: `chat-screen.test.tsx:198,378` and `app-navigation.test.tsx:88` set `$chat` info with `as never` casts because raw wire shapes do not fit the declared state type.

## Decisions settled

These are the recommended defaults adopted at the user's request:

1. **Owner:** the Conversation module (`state/conversation.ts`) owns the normalization in place, as private pure helpers beside its existing reduction. No new module: a helpers module would have exactly one consumer and fails the deletion test (deleting it just moves the helpers back into the reducer). The semantic state types live in `lib/types.ts` beside `ChatState` and `PendingPrompt`.
2. **State shape:** `ChatState.info` becomes `null | SessionInfoSnapshot`, a minimal semantic type — `{ title: string, running: boolean, usage: SessionUsage | null }` with `SessionUsage = { used: number, limit: number }`. Wire fields nothing reads today (`model`, `provider`, `cwd`, `tools`, `skills`, warnings, `version`, `yolo`, …) drop at the seam; `contractVersion` and `storedSessionId` are already extracted into their own `ChatState` fields and stay there. A future screen that needs more extends the projection in one place.
3. **Pending prompt:** `PendingPrompt` becomes `{ kind, requestId, question: string }`. The `payload` record collapses: `respond()` uses kind + requestId, `PromptCard` renders kind + question, and the PWA gates only test truthiness.
4. **Wire side stays raw:** `RuntimeSession.info` is typed `SessionRuntimeInfo` (imported from `~/compat/hermes-types` directly), removing `gateway/session-runtime.ts`'s reference to the state-layer `ChatState` type. The GatewaySession remains the wire seam — raw rows out, meaning elsewhere — exactly as `CONTEXT.md` already documents for history rows.
5. **Usage policy, preserved exactly:** `used = Number(raw.total ?? raw.total_tokens ?? 0)`, `limit = Number(raw.context_limit ?? raw.max_tokens ?? 0)`; the snapshot's `usage` is `null` iff the raw usage value is absent/non-object or both coercions are falsy — absorbing `ContextUsage`'s early return, so the view renders unconditionally. The progress-bar fallback `max={limit || used || 1}` is presentation and stays in the view. Do **not** start reading `UsageStats.context_max` / `context_used` / `context_percent` — the view never read them, and adding reads is a behavior change.
6. **Prompt question policy, preserved exactly:** `String(payload.question ?? payload.message ?? payload.command ?? '')`. Prompt-card presentation (titles per kind, sensitive masking for secret/sudo, text vs password input, allow/deny buttons for approval) stays in `PromptCard`.
7. **Title policy:** `text(raw.title)` (string or `''`); each `session.info` event still replaces the snapshot wholesale — no field merging, so a payload without `title` resets it to `''` and the header falls back exactly as the raw replacement does today. Display fallbacks (`'New conversation'` in `app.tsx`, `|| ''` in the rename dialog) stay with their screens. One recorded deviation: a *truthy non-string* `title` (say a number) previously leaked straight through the cast into the header pixels (React rendered `42`); `text()` now coerces it to `''`, so the screen fallbacks apply. The wire sends string-or-absent, so no real payload hits this — Phase 1's non-string title case documents the change instead of preserving the junk render.
8. **Test surface:** characterization goes through the Conversation's interface (`reduceGatewayEvent`, `adopt`, `retitleActive`, `respond`) — the interface is the test surface. No normalization helper is exported for tests. Of the cross-seam reads, the `'25 / 100'` context-usage pixel and the header subtitle (`'Current chat'`, asserted in `app-navigation.test.tsx:179,211`) are pinned today; the prompt question text and the rename dialog's initial value have **no** assertion anywhere — the approval test checks only allow/deny wiring and the rename test only the changed value. Phase 1 adds those two assertions, and all four become the cross-seam behavior contract and stay green.
9. **Domain notes:** `CONTEXT.md` gains the term **Session info snapshot** (the Conversation-owned semantic projection) and its `Chat state ($chat)` / `Conversation` / `GatewaySession` entries are amended — at implementation time, alongside the code, as this plan's Phase 6 specifies.
10. **Scope:** no ChatInteraction changes (its hand-bound commands, StrictMode disposal, and `controller.request` scope guard are a separate candidate), no Group member-turn changes (its prompt cards ride a different wire and own their parsing), no Transcript, transcript-cache, wire-protocol, or GatewayController changes.

## Intended module ownership

### `lib/types.ts` — semantic state vocabulary

- `SessionUsage { used: number; limit: number }` and `SessionInfoSnapshot { title: string; running: boolean; usage: null | SessionUsage }` are defined here.
- `PendingPrompt` gains `question: string` and drops `payload`.
- `ChatState.info` becomes `null | SessionInfoSnapshot`. The `SessionRuntimeInfo` import/re-export drops from this file: a grep over `client/src` confirms this file is the type's only referencer (the import at :32, the re-export at :70, and the `ChatState.info` field at :173); no other module or test imports it.

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
- The `openSession` path keeps building `info` from `response.info ?? {}`; the cast target becomes `SessionRuntimeInfo` (`Record<string, unknown> as SessionRuntimeInfo` type-checks — verified against the repo's tsconfig). `RuntimeSession.info` is deliberately non-nullable: the adapter's `?? {}` always yields an object. Nothing else in the module changes.

### Consumers — render only

- `components/chat-screen.tsx`:
  - `ContextUsage({ usage }: { usage: SessionUsage })` — the call site's `as Record<string, unknown>` cast, the `Number(...)` chains, and the early return move behind the Conversation; `max={limit || used || 1}` stays.
  - Rename dialog: `initialValue={chat.info?.title || ''}` — cast gone.
  - `PromptCard`: renders `pending.question`; the payload-interpretation line is deleted.
- `app.tsx`: `const headerSubtitle = chat.info?.title || 'New conversation'` — cast gone.
- `pwa/lifecycle.ts` and `pwa/PwaStatus.tsx`: unchanged; both gate on `pendingPrompt` truthiness, which a `question: ''` object still satisfies exactly as an empty-payload object does today.

There is no new adapter: the production GatewaySession and the memory-gateway fixtures both already feed raw `info` over `RuntimeSession`, and the semantic snapshot is produced by one pure projection. Two producers across the wire seam, one consumer of meaning — the seam is real and already proven.

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

### Phase 1 — Characterize the read surface

Add characterization tests before moving anything, through the Conversation's interface only:

- In `state/conversation.test.ts`, drive `reduceGatewayEvent` with `session.info` payloads covering: usage `{ context_limit, total }`; legacy names `{ max_tokens, total_tokens }`; usage absent; usage `{}`; usage a non-object; total-only; limit-only; all-zero; a numeric-string `total` (coerces); a non-numeric `total` alone (NaN path); a non-numeric `total` beside a valid `context_limit` (renders `NaN / 100` today — the snapshot must store `NaN`, not clamp); `title` as string / non-string / absent; `running` true/false/truthy-non-boolean. Assert the **current** raw state shape now — these assertions become the semantic expectations in Phase 3.
- Drive the four `.request` kinds with payloads where the question rides `question`, `message`, `command`, none, empty string, and a non-string; assert kind and requestId as today, **and** assert the resolved question per decision 6 — that chain is the policy Phase 3 moves, so it must be pinned now, not just the fields that survive unchanged.
- Drive `adopt()` with a raw `RuntimeSession` whose `info` carries a title, `running: true`, and usage, plus a bare `info: {}`; assert today's raw copy (and the initial `running: false` state flag) — these become the semantic snapshot expectations in Phase 3.
- Keep `chat-screen.test.tsx:195–209` (context-usage pixels `'25 / 100'`) exactly as it is. Add the two missing read assertions before anything moves: in the approval-prompt test (`:420–430`) assert the rendered question text (`rm file`, riding `payload.command` today), and in the rename test (`:375–393`) assert the dialog's initial value (`Planning session`). These plus `'25 / 100'` and the header subtitle are the cross-seam contract.

### Phase 2 — Semantic types in `lib/types.ts`

- Add `SessionUsage` and `SessionInfoSnapshot`; add `question: string` to `PendingPrompt` and drop `payload`; change `ChatState.info` to `null | SessionInfoSnapshot`.
- Drop the `SessionRuntimeInfo` import/re-export — the grep confirms no other user (tests included). TypeScript errors now mark every site the later phases fix — do not silence them with casts.

### Phase 3 — Conversation owns the normalization

- Add the private `sessionInfoSnapshot` helper and the usage policy; rewrite the private `pendingPrompt()` constructor to resolve `question`.
- Route `reduceGatewayEvent`'s `session.info` case and `adopt()` through the helper; delete the `as unknown as` and `as typeof current.info` casts; switch `reconcileHistory` to `current.info?.running ?? false`.
- Update Phase 1's characterization assertions from raw to semantic expectations — `info: { running, title, usage }` (NaN stored as-is), the resolved `question` on each request kind, and adopt's snapshot.

### Phase 4 — GatewaySession stays raw

- In `gateway/session-runtime.ts`: type `RuntimeSession.info` as `SessionRuntimeInfo` (import from `~/compat/hermes-types`), fix the `sessionFromResponse` cast target, and remove the `ChatState` import — its only uses were the two sites just rewritten.

### Phase 5 — Consumers render only

- `chat-screen.tsx`: `ContextUsage` takes `SessionUsage` (delete the call site's `as Record<string, unknown>` cast, the `Number` chains, and the early return; keep the `limit || used || 1` max fallback and the `toLocaleString` formatting); rename dialog reads `chat.info?.title || ''`; `PromptCard` reads `pending.question`.
- `app.tsx`: header subtitle reads `chat.info?.title || 'New conversation'`.
- No changes to `pwa/lifecycle.ts` or `pwa/PwaStatus.tsx`, the composer, viewport, or dialog components. (The `pwa/lifecycle.test.ts` fixture edit belongs to Phase 6.)

### Phase 6 — Fixtures, suite inventory, and domain notes

- `conversation.test.ts`: `$chat.set` fixtures (retitle test at :27–43, respond test at :216–225) become semantic; the retitle assertion becomes semantic object equality. `adopt` fixtures stay raw and cast-free, with one mechanical edit: the seven `info: null` literals (:313, :326, :349, :370, :478, :491, :524) become `info: {}` — a real `RuntimeSession` always carries an object (`sessionFromResponse` does `response.info ?? {}`), so the raw type is non-nullable and those nulls were fixture lies (`session-selection.test.ts` already uses `info: {}`).
- `chat-screen.test.tsx`: :198 → `info: { running: false, title: '', usage: { limit: 100, used: 25 } }`; :378 → `info: { running: false, title: 'Planning session', usage: null }`; :423 → `{ kind: 'approval', question: 'rm file', requestId: 'approval-1' }` — these three fixtures drop their `as never` casts (the file's unrelated `as never`s at :100 and :271 stay), all pixel assertions unchanged.
- `app-navigation.test.tsx:88` → `info: { running: false, title: 'Current chat', usage: null }`; header assertion unchanged.
- `gateway-controller.test.ts`: wire fixtures untouched; `:143` / `:330` `toMatchObject({ title: 'Renamed' })` still pass against the semantic snapshot; verify the `:148–150` identity assertion still holds.
- `gateway/session-runtime.test.ts`, `chat-interaction.test.ts`, `session-selection.test.ts`, and `pwa/policy.test.ts` / `push.test.ts` / `push-payload.test.ts`: expected to pass untouched — verify, don't edit preemptively (`session-runtime.test.ts` drives only raw wire responses and never reads `info`).
- `pwa/lifecycle.test.ts:61`: the third `as never` fixture, `{ kind: 'secret' } as never`, becomes the semantic `{ kind: 'secret', question: '', requestId: '' }` with the cast deleted — the empty question still blocks the reload, which is exactly the gate this test pins. With it, the three-file `as never` inventory is fully retired.
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

## Risks and guardrails

- **Behavior-drift risk:** the usage and question chains are the contract — Phase 1 pins them through `reduceGatewayEvent` before any code moves. Do not normalize "better" (no `context_max` reads, no NaN clamping, no trimming).
- **Type-ripple risk:** the `ChatState.info` change intentionally breaks every consumer; let `tsc` enumerate them and fix each at its layer (Phase 4 wire, Phase 5 views). Do not introduce intermediate compat shims or `as never` casts — their removal is the point.
- **Fixture-churn risk:** `as never` in three test files today (`chat-screen.test.tsx:198,378`, `app-navigation.test.tsx:88`, `pwa/lifecycle.test.ts:61`) means fixtures were already lying about the type; all three become semantic fixtures (Phase 6), while their pixel assertions stay identical. If a pixel assertion needs to change, stop — that is a behavior change.
- **Over-abstraction risk:** keep the helpers private and specific. If a second module ever needs session-info meaning, that is the moment to extract — one consumer does not justify a new seam.
- **Scope-creep risk:** ChatInteraction's construction/disposal and `controller.request`'s hand-rolled Scope guard stay untouched (separate candidate); so do the session-roster slice and Group prompt parsing.

## Acceptance criteria

- `$chat.info` and `$chat.pendingPrompt` are semantic types; no component or app-level file imports a compat wire type or casts to read chat state; the five leak sites (the `ContextUsage` call-site cast and its chains at `chat-screen.tsx:254,287–292`, the `PromptCard` chain at `:314`, and the two `title` casts at `:190` and `app.tsx:153`) are gone.
- `state/conversation.ts` is the only module that knows the gateway's session-info and prompt field names; `gateway/session-runtime.ts` references no state-layer type.
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