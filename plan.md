# Plan: give the composer's lifecycle one owner — the Chat interaction module behind a semantic interface and a React entry

> **Baseline:** this checklist describes the change from commit `190e1da` (clean tree). It is the candidate the previous plan (the Conversation read-surface cycle, completed in `190e1da`) explicitly deferred in its decision 10, non-goals, and scope-creep guardrail: "ChatInteraction's construction/disposal and `controller.request`'s hand-rolled Scope guard stay untouched (separate candidate)." This plan is that candidate.

## Goal

Deepen the **Chat interaction module** so its interface is semantic and its lifecycle is owned by one place. Today the module forces its callers to know its wiring: `ChatInteractionCommands.request` is a raw RPC passthrough used once, the module's construction/disposal/session-feed choreography lives in `ChatScreen`, and three hand-rolled generation counters guard its async work. The deepening: the commands seam becomes semantic (`completeSlash` replaces the raw `request`; `attach` returns a ready reference), the wire vocabulary moves to the Conversation (the chat-surface route owner), and a React entry owns adapter assembly, the StrictMode-safe lifecycle, and the session feed. The module's own async guards consolidate internally. Deleting `GatewayController.request` — whose sole production caller was this passthrough — falls out at the end.

This is an ownership refactor. No wire-protocol, RPC-shape, `$chat`-shape, or rendering change. One deliberate behavior change is recorded (decision 8): starting a media verb discards an in-flight slash completion that today can leave a stale suggestions popover.

## Current state and friction

The leak has one root and four symptoms:

- **Root:** `client/src/features/chat/chat-interaction.ts:28–33` types `ChatInteractionCommands` with a raw `request<T>(method, params)` RPC passthrough; the sole use is `'complete.slash'` at `:86`. Wire vocabulary sits in a UI-side module, and the view must know how to feed the module: `chat-screen.tsx:37–42` hand-binds four methods per mount ("A fresh literal, not the live instances: every method must be bound…"), `:70–84` owns the StrictMode disposal choreography (pendingDisposals map + `queueMicrotask`), and `:86–92` feeds session identity via effect.
- **Symptom 1 — wire vocabulary inside the module:** `SlashCompletionResponse { items, replace_from }` (`chat-interaction.ts:37–40`, consumed at `:86–93`), and the attach reference chain `result.ref_text ?? result.text ?? '@file:' + file.name` with its `as { ref_text?: string; text?: string } | undefined` cast (`:181–183`). The Conversation already owns the attach RPCs (`conversation.ts:326,328`) but returns the raw response; the *field interpretation* leaks back out to the interaction module.
- **Symptom 2 — lifecycle in the view:** construction `useMemo` (`chat-screen.tsx:43`), the StrictMode rehearsal dance (`:70–84`), and the session feed effect (`:86–92`). Tests must reassemble this wiring: `chat-interaction.test.ts:25–39` builds a 4-method command + 2-method media adapter; `conversation.test.ts:258–260` hand-binds again; the StrictMode choreography is only reachable through a mounted `ChatScreen` (`chat-screen.test.tsx:164–175`), and the real-unmount disposal leg is untested everywhere.
- **Symptom 3 — triplicated epoch plumbing:** `sessionEpoch`, `mediaGeneration`, `slashCompletionGeneration` (`chat-interaction.ts:55–58`) are bumped together at every draft mutation (`:68–70, :78–79, :105–106, :112–113, :125–126, :142–143`) and in `dispose()` (`:239–245`); only their op-start captures differ (slash captures `updateDraft`'s `++` at `:78`; media ops `++` at start, `:195` and `:222`).
- **Symptom 4 — the dead-after-refactor controller guard:** `gateway-controller.ts:272–277` `request()` hand-rolls a Scope guard that throws `DOMException('Gateway scope changed.', 'AbortError')` beside the Scope toolkit. Its sole production caller is the ChatScreen adapter (`chat-screen.tsx:39`); `grep controller.request` across `src/` confirms no other. No `gateway-controller.test.ts` case asserts it.

The module's behavior, by contrast, is already excellent and thoroughly tested (session-switch semantics, stale-discard across resolve *and* reject, snapshot/restore submission, sequential attachment uploads, media invalidation, disposal inertness — `chat-interaction.test.ts`, 22 cases, verified green at the baseline). The refactor moves ownership; it does not redesign the state machine.

## Decisions settled

These are the recommended defaults adopted at the user's request:

1. **Owner — core plus React entry, not a merge.** The Chat interaction module stays its own deep module (DOM-free core in `features/chat/chat-interaction.ts`) and gains a thin React entry (`features/chat/use-chat-interaction.ts`). It does **not** merge into the Conversation: the Conversation owns session *content* (`$chat`, transcript, prompt submission, prompt responses); the Chat interaction module owns the *composer surface* (draft, edit target, attachment refs, slash suggestions, submit choreography, audio verbs). Two concepts, two deep modules. Precedent: Workspace navigation (DOM-free core + `use-workspace-navigation.ts`), Profile workflow (`profile-workflow.ts` + `use-profile-workflow.ts`).
2. **The commands seam goes semantic.** `ChatInteractionCommands` becomes `{ send(text), retryFrom(rowId, text), attach(file): Promise<string | undefined>, completeSlash(draft): Promise<SlashCompletionPayload> }`. The raw `request` drops from the interface. `SlashCompletionPayload = { items: Array<Omit<ChatSuggestion, 'insertText'>>, replaceFrom?: number }` is defined in `chat-interaction.ts` beside its consumer (the module defines its port, per the `GroupMirrorGateway` pattern). `ChatMediaConnection = Pick<GatewayPort, 'request' | 'upload'>` is unchanged — chat audio riding the GatewayPort directly is documented domain policy (CONTEXT.md, Files API entry) and stays in `transcribe`/`speak`.
3. **Slash-completion wire vocabulary moves to the Conversation.** New `Conversation.completeSlash(draft): Promise<SlashCompletionPayload>` owns the `'complete.slash'` RPC and response interpretation, mirroring the controller guard **exactly**: capture `currentGatewayScope()` before the call, `await this.runtime.rpc('complete.slash', { text: draft })`, then `if (!isCurrentGatewayScope(scope)) throw new DOMException('Gateway scope changed.', 'AbortError')`. Rejecting — not swallowing — is deliberate: ChatInteraction's catch clears `slashItems` on AbortError today, and that stays the behavior. The private wire interface `SlashCompletionResponse` moves from `chat-interaction.ts:37–40` to `conversation.ts`. `insertText` computation (`completionInsertion`) stays private in the Chat interaction module — it is draft-apply logic, not wire vocabulary. `conversation.ts` type-imports `ChatSuggestion` and `SlashCompletionPayload` from `~/features/chat/chat-interaction` (type-only; `chat-interaction.ts` imports nothing from `state/`, so there is no cycle; precedent for state→features imports: `gateway-controller.ts` imports the Group engine).
4. **Attachment reference resolution moves to the Conversation.** `Conversation.attach(file): Promise<string | undefined>` — `undefined` signals the silent skips, both the pre-RPC stale-scope case and the falsy response (today both feed the same `!result` early return). The two-line interpretation `result.ref_text ?? result.text ?? '@file:' + file.name` moves **verbatim**, cast and nullish chain included, so every edge is byte-identical: a truthy response without fields → `'@file:' + file.name`; `ref_text: ''` → `''` (nullish, not falsy, chain); a falsy response → silent skip that also stops the remaining files (today's `return`, not `continue`). The Chat interaction module receives a ready reference, stops interpreting attach responses, and stops the loop only on `undefined` — an empty-string reference is a real reference today (it appends and the loop continues) and must stay appenable.
5. **The React entry owns lifecycle.** `useChatInteraction({ conversation, mediaConnection })` in `features/chat/use-chat-interaction.ts` owns: the commands adapter (the four bound methods and their binding comment move from `chat-screen.tsx:35–42`; deps become `[conversation]` — the controller drops out because `completeSlash` is now a Conversation verb, and the comment's owner list narrows to `(Conversation)`), instance creation (`useMemo(() => new ChatInteraction(commands, mediaConnection), [commands, mediaConnection])`), the StrictMode disposal choreography (verbatim from `:70–84`), the session feed effect (`interaction.setSession(chat.runtimeSessionId)` on deps `[chat.runtimeSessionId, chat.storedSessionId, interaction]`, from `:86–87`), and the state subscription. It returns `{ interaction, state }` with `state = useStore(interaction.$state)`. `ChatScreen` keeps its default `mediaConnection = controller.gateway` prop and its own effect for the four dialog-local resets (`sessionActionError`, `showSessionActions`, `renameSession`, `archiveSession` — rendering policy, deps `[chat.runtimeSessionId, chat.storedSessionId]`). `app-navigation.test.tsx` is insulated (it mocks `~/components/chat-screen` wholesale).
6. **`GatewayController.request` is deleted.** Its sole production caller was the ChatScreen adapter; the guard idiom relocates to `Conversation.completeSlash` (decision 3). No controller test asserts `request` (verified); the screen-test stub drops the member.
7. **`setSession` and `dispose` stay public.** The React entry is their sole caller, exactly as the Session selection module is `Conversation.adopt`'s. The interface honestly carries the lifecycle verbs; what changes is that the view no longer drives them.
8. **Guard consolidation — two counters, one recorded deviation.** `sessionEpoch` stays (session identity: `setSession` bump; stale discard across switch-away-and-back, pinned by existing tests). `mediaGeneration` + `slashCompletionGeneration` merge into one `draftRevision`: today they are bumped together at every draft mutation, `setSession`, and `dispose` — only their op-start captures differ. **One deliberate deviation:** the media verbs' start bump (`++draftRevision` in `transcribe`/`speak`) now also discards an in-flight slash completion. Today that completion can land mid-recording and leave a suggestions popover keyed to a draft the transcription is about to replace. The merge fixes that race. Every other mapping is behavior-identical (table below); the deviation is pinned by a new post-merge test. Do not "fix" anything else: draft mutations must **not** invalidate a pending `submit` or the `attach` loop (submit/attach capture the session epoch only — the mapping table leaves both guards untouched, and the existing stale-epoch tests pin the epoch leg).
9. **Test surface — characterization first, then semantic fakes.** Phase 1 pins the missing edges on the current surface before any code moves. After the seam changes, `chat-interaction.test.ts`'s fakes become semantic (`completeSlash` resolves a payload; `attach` resolves a reference string), `conversation.test.ts` gains the wire-interpretation tests through the Conversation's interface (MemoryGateway handles `'complete.slash'` and the attach RPCs), the hand-built interaction at `conversation.test.ts:258–260` adapts its commands literal, and a new `features/chat/use-chat-interaction.test.tsx` covers the three lifecycle legs that live in the entry: StrictMode rehearsal survival (draft preserved, verbs live), true-unmount disposal (callbacks inert), and the `$chat`-driven session feed.
10. **Domain notes — at implementation time.** `CONTEXT.md` gains a **Chat interaction** entry (the deep module between the composer UI and the Conversation/GatewaySession; owns draft, edit target, attachment refs, slash suggestions, submit choreography, and the audio verbs; the React entry owns adapter assembly, the StrictMode-safe lifecycle, and the session feed) and amends the **Conversation** entry (owns slash completion and the attachment reference resolution alongside its existing chat-surface vocabulary). The update lands alongside the code in Phase 6, per the repo's convention from the previous cycle.
11. **Scope fences.** No PromptCard changes (it calls Conversation verbs directly), no chat-viewport changes (that leak is its own speculative candidate), no media/audio route changes, no app.tsx changes, no GatewaySession/SessionRuntime changes, no `$chat` shape changes, no Group changes, no changes to `Conversation.send/retryFrom/interrupt/steer/redirect/respond` policies.

### Guard mapping table (decision 8)

| Site | Today | After |
|---|---|---|
| `setSession` `:68–70` | `sessionEpoch += 1` + both revisions `+= 1` | `sessionEpoch += 1`, `draftRevision += 1` |
| `updateDraft` `:78–79` | slash capture `++slashCompletionGeneration`, `mediaGeneration += 1` | `const revision = ++this.draftRevision` (captured) |
| `chooseCompletion` `:105–106` | both `+= 1` | `draftRevision += 1` |
| `beginEdit` `:112–113` / `cancelEdit` `:125–126` | both `+= 1` | `draftRevision += 1` |
| `submit` `:141–143` | captures `sessionEpoch`; both revisions `+= 1` | captures `sessionEpoch`; `draftRevision += 1` |
| `attach` loop `:176` | captures `sessionEpoch` only | unchanged |
| `transcribe` `:195` / `speak` `:222` | `const generation = ++this.mediaGeneration` (slash untouched — the deviation) | `const revision = ++this.draftRevision` (also invalidates in-flight slash completions) |
| `dispose` `:239–245` | all three `+= 1` | `sessionEpoch += 1`, `draftRevision += 1` |
| guards `:247–253` | `isCurrent(epoch)` + `isMediaCurrent(epoch, generation)` | `isCurrent(epoch)` + `isRevisionCurrent(epoch, revision)` |

## Intended module ownership

### `features/chat/chat-interaction.ts` — the deep core (semantic interface)

- Public: `ChatInteractionState`, `ChatSuggestion`, `EditTarget`, **`SlashCompletionPayload`** (new), `ChatInteractionCommands` (semantic — `send`, `retryFrom`, `attach(file): Promise<string | undefined>`, `completeSlash(draft)`), `ChatMediaConnection` (unchanged), `class ChatInteraction`.
- `updateDraft` calls `this.commands.completeSlash(value)`, maps `payload.items` to suggestions with `insertText: completionInsertion(value, item.text, payload.replaceFrom)`, and clears `slashItems` on rejection while current. `SlashCompletionResponse` is deleted from this file.
- `attach` consumes the ready reference: `const reference = await this.commands.attach(file); if (!this.isCurrent(epoch) || reference === undefined) return; this.patch({ attachmentRefs: [...this.$state.get().attachmentRefs, reference] })`. The stop test is `=== undefined`, not falsiness: an empty-string reference is real today (Phase 1 test c) and must still be appended, with the loop continuing to the next file. The response cast and field chain are gone.
- Private: `disposed`, `sessionEpoch`, `sessionId`, `draftRevision`, `isCurrent`, `isRevisionCurrent`, `patch`, `completionInsertion`, `fileToBase64`. No RPC method names and no attach response fields remain; `/api/audio/*` paths in `transcribe`/`speak` remain by documented policy.

### `features/chat/use-chat-interaction.ts` — the React entry (new, thin)

- `interface UseChatInteractionResult { interaction: ChatInteraction; state: ChatInteractionState }`.
- `useChatInteraction({ conversation, mediaConnection }: { conversation: Conversation; mediaConnection: ChatMediaConnection })`: commands `useMemo` (bound to `conversation`, deps `[conversation]`, with the binding comment — its `(Conversation / GatewayController)` owner list narrowed to `(Conversation)`), instance `useMemo`, the disposal effect (verbatim pendingDisposals + `queueMicrotask`), the session feed effect (`useStore($chat)` → `interaction.setSession(chat.runtimeSessionId)`), and `state = useStore(interaction.$state)`.

### `state/conversation.ts` — owns the chat-surface wire vocabulary

- New private wire interface `SlashCompletionResponse { items?: Array<Omit<ChatSuggestion, 'insertText'>>; replace_from?: number }` (moved from the interaction module) and new **`completeSlash(draft: string): Promise<SlashCompletionPayload>`** per decision 3: scope capture, `runtime.rpc('complete.slash', { text: draft })`, post-await stale-scope `DOMException` throw, and the payload map (`items: response.items ?? []`, `replaceFrom` when `typeof response.replace_from === 'number'`, else `undefined`).
- `attach(file: File): Promise<string | undefined>` per decision 4: unchanged size caps, `fileToDataURL`, and pre-RPC stale-scope skip; the post-RPC return becomes the verbatim two-line interpretation on the cast response, with a falsy response (the cast's `| undefined` arm) returning `undefined` before the chain is read — byte-preserving today's `!result` early return, which also fed the falsy case. The class doc comment gains slash completion and attachment reference resolution to its ownership list.

### `state/gateway-controller.ts` — `request` deleted

- `:272–277` removed wholesale. Nothing else changes.

### `components/chat-screen.tsx` — renders and dispatches

- Calls `useChatInteraction({ conversation, mediaConnection })` instead of assembling commands, constructing the instance, choreographing disposal, and feeding sessions. Keeps: the `mediaConnection = controller.gateway` prop default, its four dialog-local resets effect, session actions, viewport wiring, rendering from `state`, and all verb dispatch (`interaction.updateDraft(…)`, `interaction.submit()`, `interaction.attach(…)`, `interaction.transcribe(…)`, `interaction.speak(…)`, `interaction.beginEdit(…)`, `interaction.cancelEdit()`, `interaction.removeAttachment(…)`, `interaction.chooseCompletion(…)`).

## Invariants to preserve

1. **Session switch semantics:** `setSession` with the current id is a no-op; a different id preserves `draft`, clears `attachmentRefs`, `editTarget`, `error`, `slashItems`, `submitting`, and invalidates all in-flight work — including a switch away and back to the same id (the epoch does not rewind).
2. **Submission:** `combined = [draft.trim(), ...attachmentRefs].filter(Boolean).join('\n')`; empty submits nothing; `editTarget` routes to `retryFrom(rowId, combined)` and plain to `send(combined)`; duplicate submits blocked while `submitting`; success while current clears `editTarget` and `submitting`; failure while current restores the exact pre-submit snapshot (untrimmed draft, refs, edit target, suggestions) and surfaces `errorMessage`; stale resolve/reject patches nothing. Draft mutations during a pending submit do **not** invalidate it.
3. **Attachments:** sequential uploads, successful order preserved, the loop continues after a per-file failure (error surfaces, later files still start), a session change mid-file stops the loop, and an `undefined` reference is a silent full stop (no ref, no error, no next file) — while an empty-string reference is a real reference that appends and lets the loop continue.
4. **Slash completion:** only for `/`-prefixed drafts; non-slash keystrokes clear `slashItems`; latest request wins (older resolve and reject both discarded); a rejection while current clears `slashItems`; `chooseCompletion` writes `${insertText} ` and clears suggestions; `completionInsertion` honors `replaceFrom` only when `typeof number && > 1 && <= draft.length`, else the text is returned slash-prefixed with an already-`/`-prefixed text passing through unchanged.
5. **Scope staleness:** `completeSlash` rejects with the `AbortError` DOMException when the Scope changed during the RPC (clearing `slashItems` through the catch), byte-mirroring today's `controller.request`.
6. **Media verbs:** 25 MB audio cap errors before upload; missing `transcript`/`data_url` surface module errors; a newer draft edit, a newer media verb, a session change, or disposal invalidates an in-flight media result; speech plays the returned `data_url`.
7. **Lifecycle:** the instance survives StrictMode's effect rehearsal (draft and verbs live), is disposed on true unmount (pending callbacks inert), and the session feed follows `$chat.runtimeSessionId` (the `storedSessionId` dep re-fires `setSession`, a same-value no-op).

## Implementation sequence

### Phase 1 — Characterize the current surface (tests only, no production changes)

Add to `features/chat/chat-interaction.test.ts`: (a) attach response without `ref_text`/`text` → `'@file:' + file.name` reference appended; (b) attach resolving a falsy value → silent full stop (no ref, no error, second file never starts); (c) `ref_text: ''` → an empty-string reference appended and the loop continuing (nullish-chain edge); (d) `complete.slash` rejection while current → `slashItems` cleared. Inventory `state/conversation.test.ts` attach coverage (RPC selection `image.attach_bytes` vs `file.attach`, size caps, stale-scope `undefined`) and add what is missing on the current raw-return surface — the inventory result at the baseline is zero: no test in that file exercises `Conversation.attach`, so all three legs are added. Run the focused suites; record results in this section.

**Results:** the four interaction-level edges (a)–(d) and the three conversation-level legs are in place against the current raw-return surface; `npx vitest run src/features/chat/chat-interaction.test.ts src/state/conversation.test.ts` is green (26 + 65 cases).

### Phase 2 — Conversation owns the attachment reference

`Conversation.attach` returns `string | undefined` with the verbatim interpretation (decision 4); `ChatInteraction.attach` consumes the reference and stops only on `undefined`; adapt `chat-interaction.test.ts` attach mocks to resolve references — Phase 1 (b) and (c) become `undefined` → silent full stop and `''` → appended with the loop continuing — and re-pin the moved interpretation edges through `Conversation.attach` with MemoryGateway (a truthy response without fields → `'@file:' + file.name`; `ref_text: ''` → `''`; a falsy response → `undefined`), alongside the Phase 1 conversation-level legs (RPC selection, size caps, pre-RPC stale scope) now asserting the returned reference; the `conversation.test.ts:259` literal keeps `attach: vi.fn()`.

### Phase 3 — Conversation owns slash completion

Add `SlashCompletionResponse` (private) + `completeSlash` to `conversation.ts` (decision 3); replace `ChatInteractionCommands.request` with `completeSlash`; `updateDraft` maps the payload. The interface change must reach its one adapter in the same phase: swap `request: controller.request.bind(controller)` for `completeSlash: conversation.completeSlash.bind(conversation)` in the `chat-screen.tsx` commands literal (that literal moves wholesale into the React entry in Phase 4), and swap `request: vi.fn()` for `completeSlash: vi.fn()` in the `conversation.test.ts:258–260` interaction literal. Adapt `chat-interaction.test.ts` fakes to the payload shape; add `conversation.test.ts` cases through MemoryGateway: wire shape → payload, `'complete.slash'` receives `{ text }`, stale-scope → `AbortError` (following the file's existing scope-guard test idiom).

### Phase 4 — React entry; screen slim-down; controller guard deletion

Create `features/chat/use-chat-interaction.ts` (decision 5); `ChatScreen` consumes it and drops the moved choreography; delete `GatewayController.request`. New `features/chat/use-chat-interaction.test.tsx`: StrictMode rehearsal survival, true-unmount disposal inertness, `$chat`-driven `setSession` feed. Adapt `chat-screen.test.tsx` (`controllerStub` drops `request`; `conversationStub` gains `completeSlash`; existing StrictMode and wiring tests keep passing as integration coverage). Confirm `app-navigation.test.tsx` needs no change (ChatScreen is mocked there).

### Phase 5 — Guard consolidation

Merge the two revision counters per the mapping table (decision 8); add the pinned deviation test (transcribe start discards an in-flight slash completion); every pre-existing guard test passes unmodified.

### Phase 6 — Domain notes

`CONTEXT.md` gains the **Chat interaction** entry and amends the **Conversation** entry per decision 10.

### Phase 7 — Verify and review

Run focused suites first, then all checks from `client/`:

```sh
npx vitest run \
  src/features/chat/chat-interaction.test.ts \
  src/features/chat/use-chat-interaction.test.tsx \
  src/components/chat-screen.test.tsx \
  src/state/conversation.test.ts \
  src/state/gateway-controller.test.ts \
  src/app-navigation.test.tsx
npx tsc -p tsconfig.json --noEmit
npm test
npm run build
npx playwright test e2e/pwa-foundation.spec.ts \
  --grep 'password cookie authenticates a real WebSocket chat session'
```

The browser test exercises the real user-visible composer flow (type, send, WebSocket session) and should run in both configured projects when their browsers are installed. If browser execution is unavailable, report that explicitly; typechecking and unit tests are not a substitute for the user-visible flow. Before considering the plan implemented, run `git diff --check`, inspect `git status --short`, and review the final diff for unrelated changes. Do not stage or commit unless separately requested. Record the real results in this section.

**Results:** The focused six-file run passed (225 tests); `npx tsc -p tsconfig.json --noEmit` passed; `npm test` passed (84 files, 1,116 tests); `npm run build` passed (typecheck included; Vite reported the large-chunk advisory and deprecated `inlineDynamicImports` option); the requested Playwright flow passed in both Chromium and WebKit (2 tests). `git diff --check` passed.

## Risks and guardrails

- **Behavior-drift risk:** the counters, the `??` chain, and the AbortError-clears-suggestions semantics are the contract. Phase 1 pins the missing edges before anything moves. The only sanctioned deviation is decision 8's (media start discards an in-flight slash completion) — pinned, documented, nothing else "improved."
- **Fixture-churn risk:** the exact fixture edits are enumerated (Phases 2–4): `chat-interaction.test.ts` command/media adapters become semantic; `conversation.test.ts:258–260` literal swaps `request` for `completeSlash`; `chat-screen.test.tsx` stubs adapt; `app-navigation.test.tsx` is insulated by its ChatScreen mock. Keep unrelated stubs and pixel assertions untouched.
- **Cycle risk:** `conversation.ts` type-imports from `features/chat/chat-interaction`; verified acyclic (`chat-interaction.ts` imports only nanostores and `~/gateway/*`), and type-only imports erase at runtime.
- **Hook-identity risk:** commands deps shrink from `[conversation, controller]` to `[conversation]`; the instance still keys on `[commands, mediaConnection]`. In production both are stable singletons (the controller constructs one Conversation); no churn. The disposal choreography moves verbatim — same declaration order as today (disposal effect before session-feed effect), so cleanup ordering is unchanged.
- **Over-abstraction risk:** no new seam beyond the React entry. The entry is the one adapter the seam needs (prod assembly + tests get the module directly); a standalone adapter module would fail the deletion test.
- **Dead-code risk:** `GatewayController.request` must actually be deleted, not left "just in case" — grep after Phase 4 to confirm zero references.

## Acceptance criteria

- `features/chat/chat-interaction.ts` contains no RPC method names and no attach response fields (`'complete.slash'`, `ref_text`, `replace_from` gone; `/api/audio/*` remains by documented policy). `ChatInteractionCommands` is semantic: `send`, `retryFrom`, `attach → string | undefined`, `completeSlash → SlashCompletionPayload`.
- `components/chat-screen.tsx` no longer imports `ChatInteraction`, hand-binds methods, constructs the instance, choreographs disposal, or calls `setSession`.
- `GatewayController.request` is gone; the post-await Scope-guard idiom exists in exactly one new place (`Conversation.completeSlash`).
- One deliberate behavior change is on record and pinned by a test (media start discards an in-flight slash completion); every other invariant above passes unchanged.
- All suites green with recorded results: focused six-file run, full `npm test`, `tsc --noEmit`, `npm run build`, the e2e chat flow; `git diff --check` clean.
- `CONTEXT.md` names the Chat interaction module and the amended Conversation ownership without contradicting the implementation.

## Explicit non-goals

- No PromptCard / `pendingPrompt` changes and no prompt-response wire changes.
- No chat-viewport changes (its implicit DOM seam is a separate, speculative candidate).
- No `ChatMediaConnection` or `/api/audio/*` route changes — the documented chat-audio exception stays.
- No app.tsx changes; no GatewaySession, SessionRuntime, or GatewayPort changes; no `$chat` shape or atom changes.
- No Group changes and no changes to `Conversation.send/retryFrom/interrupt/steer/redirect/respond` policies.
- No wire-protocol, storage-format, or e2e-harness changes.