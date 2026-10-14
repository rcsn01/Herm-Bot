# Herm PWA improvement plan

Status: Items 1, 2, and 3 have application implementations. Items 4 through 7 remain proposed. Item 3 adds local Privacy settings, installation-wide regular-chat history opt-out, and account-scoped conversation-data cleanup. Legacy shared group-room logs are explicitly excluded.

## Goal and scope

Make Herm more dependable during everyday phone use before adding more features. Preserve the bot-first layout and existing streaming chat, grouped tool activity, session branching, profile management, push support, and lazy-loaded screens.

These recommendations come from source inspection, not a hands-on visual review. Validate the current behavior before implementing each item.

Herm remains a standalone app. Do not embed it in, launch it from, or give Moirasia control over it. Use shared Moirasia UI controls and conventions. Keep app-specific behavior in Herm; changes intended for all apps belong in the shared packages and must be verified in both integrated and standalone contexts.

## 1. Protect unfinished messages

Priority: First implementation batch. The following is the full implementation plan for this item. Items 2 through 7 remain separate work.

### Required outcome

An ordinary message draft belongs to one verified account, gateway, profile, and conversation. Navigating away, switching sessions, reconnecting, refreshing, or updating the PWA must not silently lose that draft or put it in another conversation. A failed or uncertain submission must remain recoverable without automatic resubmission.

Save text and completed attachment metadata locally. Do not persist raw files, audio recordings, generated speech, slash suggestions, transient errors, or secret and administrator-password responses. Local persistence is best effort, not a backup guarantee. Report storage failures instead of claiming a draft was saved.

### Source findings that determine the implementation

- `client/src/features/chat/chat-interaction.ts` owns composer state. `setSession()` compares only the runtime session ID, resets attachment and edit state, and carries the current text into the next session. `submit()` clears the composer before awaiting a command and restores the old snapshot on failure. That restoration can overwrite text typed during the request.
- `client/src/features/chat/use-chat-interaction.ts` creates the interaction for the mounted chat screen. Its effect watches both session IDs but passes only `runtimeSessionId`. Unmounting discards the instance. The StrictMode disposal guard must remain intact.
- `client/src/state/conversation.ts` is the sole writer of `$chat`. It exposes both runtime and stored session IDs. Uploads use session-scoped `image.attach_bytes` and `file.attach`. The client has no demonstrated contract proving their references survive a new runtime session.
- `Conversation.send()` and `retryFrom()` await `prompt.submit` with a 30-minute timeout. The command interface returns `Promise<void>`, not an explicit accepted, rejected, or uncertain outcome. Some stale-scope failures are swallowed. Promise resolution must not be mistaken for a guaranteed submission acknowledgement without checking the gateway contract.
- `client/src/state/session-selection.ts` owns selection publication and bookmarks. Bookmarks currently include gateway and profile, not account. Runtime creation can return a null stored session ID, and `session.info` can supply it later.
- `client/src/state/gateway-controller.ts` checks `/api/auth/me` in browser interactive-auth flows but does not retain the response. Login responses contain an identity. `NativeIdentity` in `client/src/lib/types.ts` includes `org_id` and `user_id`.
- `client/src/gateway/scope-guard.ts` guards gateway/profile generations, not authenticated account changes. Draft work needs an authentication generation as well.
- `client/src/pwa/lifecycle.ts` and `client/src/pwa/PwaStatus.tsx` guard active turns and pending approvals, but cannot see composer state. `PromptCard` keeps sensitive responses in separate component state and must stay outside draft storage.

### Settled behavior

#### Identity and restore eligibility

Use a normalized gateway URL, verified organization/user identity (or a distinct provider/user identity for gateway-local accounts with an explicitly empty organization), profile, and stored session ID as the durable draft key. Encode structured fields without conflating null profiles with a literal profile named `default`. Never use an access token, cookie, display name, or email as a storage key.

Resolve identity during connection preparation before reading persistent drafts or restoring an account's session bookmark. Revalidate it after sign-in and authenticated reconnect. Capture an authentication generation for async operations so signing out and back into the same account still retires old work.

The first implementation step must verify `/api/auth/me` behavior for password, OAuth, token, and no-auth deployments. The gateway implementation is not in this repository. If a mode cannot provide a stable authenticated principal, retain drafts only in memory for that connection and explain that restart recovery is unavailable. Do not invent an account identity from the gateway URL. Do not call that mode fully restart-recoverable until its identity contract is established.

Network failure is not proof of a different account. Keep known drafts intact but do not expose another account's records before verification. Explicit auth failure locks persistent recovery until sign-in; explicit logout deletes this account's draft records even when remote logout fails.

#### Conversation identity

- Resuming the same stored conversation with a new runtime ID keeps its draft. Invalidate stale upload/completion callbacks without clearing durable text.
- A newly created session with a stored ID gets its own empty draft. Never carry the previous session's draft into it.
- While the stored ID is unknown, use a locally generated provisional ID bound to the selected session. Persist provisional text only under a verified account, and mark it as not yet linked to a recoverable remote conversation.
- When `session.info` supplies the stored ID for that same selection, promote the provisional record without overwriting a newer destination draft. Retire the old key only after the destination write succeeds.
- If a provisional session cannot be restored after restart, show its text as an unlinked recovery record. Offer explicit copy or move into the selected conversation. Never attach it automatically to the newest session.
- Branching creates a distinct draft. Renaming does not change a draft key. Deleting a remote session does not silently delete its unfinished local text; expose it as an unlinked recovery record.
- Scope account-aware bookmarks to the verified account before restoration. Do not import legacy account-blind bookmarks automatically. This is a narrow prerequisite for correct draft recovery, not a session-navigation redesign.

#### Text, editing, and attachments

Keep the normal message draft separately while editing an earlier message. Cancel edit restores that normal draft. Persist edit text with its stored conversation ID and durable row ID, not as an ordinary message. Before enabling recovered Edit & retry, reconcile history and verify the row is still editable. An invalid target remains recoverable text with an explicit copy action, never an automatic destructive retry.

All user-driven mutations must save through the same draft module: typing, slash selection, transcription success, attachment completion/removal, begin/cancel edit, and submit recovery. An empty normal draft with no attachments or recovery snapshot removes its record. Preserve whitespace exactly; trim only the outgoing prompt as today.

Persist completed attachment reference text, filename, media type, size, and the originating runtime ID. Raw `File`, Blob, and base64 data stay out of storage. Within the same live runtime, returning to the draft restores its attachment references. After a runtime change or restart, mark those references as needing reattachment unless the verified gateway contract guarantees durability. Show filenames and an explanation; do not quietly submit invalid references or claim files were restored. Unresolved attachments block sending until reattached or explicitly removed.

Track upload and transcription work as transient busy state. Switching conversations cancels or retires the old task, saves existing text and completed references, and reports that an unfinished attachment must be selected again. Do not transfer late results into the destination draft. Attachment metadata display here is limited to recovery and removal; item 4 still owns the broader composer redesign.

#### Submission without draft loss

Capture the origin draft key, authentication generation, revision, edit target, text, and attachment references before dispatch. Save a recovery snapshot before clearing the visible composer. Users may type a next message while the command is pending, but it is a separate revision.

- On confirmed success, remove only the matching submission snapshot. Do not delete or overwrite newer text, another conversation's draft, or a later submission.
- On known failure, restore the original snapshot if the composer has not changed. Otherwise retain it as a separate failed-message recovery entry with explicit restore/copy/discard actions.
- Session switching must not strand a failed snapshot. Update the captured origin record when the outcome is known, while leaving the destination composer untouched.
- A timeout, transport interruption, or page restart during submission may leave delivery uncertain. Label it "Delivery not confirmed. Check the conversation before sending again." Reconcile history when possible, but do not use text equality alone as proof of acceptance.
- Never retry automatically. Queued prompts and edit-and-retry submissions follow the same rules.
- Replace stale-scope swallowed success and no-session no-ops at the changed command seam with explicit outcomes or errors. Do not let them clear a recovery snapshot as though a send succeeded.

If the gateway has no early acceptance acknowledgement, keep the snapshot pending until the existing command settles. Do not add a speculative gateway protocol or infer acceptance from `message.start` without a contract that correlates it to this submission.

#### Update and exit protection

Expose an app-level reactive draft safety summary so PWA lifecycle code does not depend on a mounted `ChatScreen`. Include unsaved records, pending submissions, active uploads/transcription, and attachments that would need reattachment after reload. Account for drafts outside the currently visible chat.

Both the update button and `activatePwaUpdate()` must use the same policy. Recheck immediately before applying an update.

- A durably saved text-only draft may survive an explicit update. Tell the user it will be restored.
- Block updates during active turns, approvals, submission dispatch, uploads, or transcription, retaining existing guards.
- Block updates when storage failed or reload would invalidate attachments. Offer saving again, copying text, removing attachments, or explicitly discarding the affected local work. No silent discard or forced reload.
- Flush before unmount, selection changes, visibility loss, pagehide, and explicit update. Persist mutations immediately, so mobile recovery does not depend on exit events firing.
- Register `beforeunload` only while there is unrecoverable work. Treat the browser warning as additional protection, not the recovery mechanism. The service worker must not gain access to draft contents.

### Module ownership and storage

Add `client/src/features/chat/chat-drafts.ts` as the draft module. It owns key construction, validated versioned records, provisional promotion, submission snapshots, conflict preservation, persistence status, account cleanup, and the reactive safety summary. Accept the storage adapter for tests. Use the platform's existing `localStorage`; no new dependency or raw-file database is needed for this scope.

Keep its interface small. Callers select a draft context, read/write the current draft, begin/settle a submission, and clear an account. Hide serialization and storage keys inside the module. `ChatInteraction` continues to own slash completion and media tasks. `Conversation` continues to own gateway commands and transcript state. `SessionSelection` continues to own session publication.

Use a distinct versioned namespace such as `hermes.drafts.v1`, not the transcript cache key. Records include owner fields, durable or provisional conversation identity, record revision, timestamp, normal/edit content, attachment metadata, and submission recovery data. Parse stored data as untrusted input. Validate types, lengths, discriminants, owner equality, and edit row IDs. Do not spread arbitrary parsed objects into interaction state.

Set explicit storage limits in the implementation, initially 50 conversation records per account and 1 MiB of serialized draft data per account. Include edit and failed-submission recovery content in the budget. Exceeding a limit must retain the current draft in memory, report "Not saved on this device", and offer copy/discard actions. Do not truncate text or evict another unfinished draft silently. Test the exact limits using the serializer's documented byte measurement.

Use synchronous writes for user mutations to close the final-keystroke refresh gap. Catch blocked storage and quota failures. Keep existing data intact when a write fails, and expose unsaved state to update protection. Do not advertise localStorage as encrypted or secure against other scripts on the origin.

Handle multiple tabs without silent last-writer-wins loss. Detect stale record revisions and storage events. Preserve conflicting text as a separately identified recovery copy, then require an explicit user choice instead of merging automatically. If even the conflict copy cannot be persisted, keep it in memory and block destructive reload. Account logout in another tab locks the owner and prevents stale callbacks from recreating its deleted drafts.

Ordinary React cleanup flushes but does not delete drafts. Logout clears this account's active, provisional, edit, and submission records, invalidates callbacks first, and leaves unrelated preferences alone. Gateway/profile switching flushes the origin, resets visible state, and loads only the verified destination. Account-scoped transcript storage and logout cleanup are now covered by item 2. The general local-history preference and Clear local data setting remain item 3.

### Implementation sequence and file changes

1. Establish identity and acknowledgement contracts.
   - Check the existing connection request interface, login identity responses, gateway documentation, and available contract fixtures.
   - Add verified draft-owner state and an auth generation in a focused state module, proposed `client/src/state/draft-owner.ts`.
   - Integrate identity resolution, account change, auth failure, and logout into `client/src/state/gateway-controller.ts` without persisting credentials.
   - Update `client/src/state/session-selection.ts` so account-aware restore cannot select a previous account's bookmark. Keep current selection-epoch guards.
   - Record the capability decision for token/no-auth identity and attachment durability. Unsupported recovery must be visible, not a hidden fallback.
2. Build and test the draft module.
   - Add `chat-drafts.ts` and `chat-drafts.test.ts` for validated storage, per-context selection, promotion, recovery snapshots, limits, failures, and conflicts.
   - Make draft storage independent of React mounting. Add a recovery-list read operation only for the explicit unlinked/failed/conflicting records needed here.
3. Connect interaction state to durable context.
   - Replace runtime-only `setSession()` behavior with full draft-context selection in `chat-interaction.ts` and `use-chat-interaction.ts`.
   - Separate durable conversation identity from runtime task epochs. React to stored-ID promotion even when the runtime ID does not change.
   - Route every draft mutation through the module. Preserve StrictMode safety and guard callbacks across account/profile/session changes.
   - Add normal/edit draft separation and attachment metadata/busy state.
4. Make submission recovery revision-safe.
   - Change the narrow send/retry command seam in `chat-interaction.ts` and `conversation.ts` as needed to report truthful outcomes.
   - Persist before dispatch, keep next-message edits separate, and settle captured origin snapshots without overwriting newer revisions.
   - Add explicit recovery actions for failed and uncertain sends. Keep automatic resubmission disabled.
5. Add recovery feedback and update protection.
   - Update `client/src/components/chat-screen.tsx` with saved/unsaved status, restored-draft feedback, attachment reattachment guidance, and explicit recovery/copy/discard controls.
   - Update `client/src/pwa/lifecycle.ts` and `PwaStatus.tsx` to share the draft safety policy and flush before activation.
   - Use existing shared primitives. No shared UI package change is planned.
6. Extend regression tests and document behavior.
   - Update the tests listed below and browser fixtures only where required for account changes, failures, stored-ID promotion, and recovery.
   - Update the relevant chat ownership notes in `CONTEXT.md` and local-data explanation in `SECURITY.md` after implementation.
   - Run the checks below and record any device verification that remains unavailable.

### Test matrix and acceptance criteria

Automated tests must prove the following through the draft module and existing interaction interfaces.

| Area | Required cases |
| --- | --- |
| Persistence | Exact text and whitespace survive new module instances; empty records clear; blocked storage, quota failure, malformed JSON, unsupported versions, and over-limit data retain usable in-memory work and report unsaved status. |
| Isolation | Same session IDs across different accounts, gateways, and profiles never share drafts; null profile is distinct from a profile named `default`; unresolved identity never unlocks persistent records. |
| Session lifecycle | A/B/A switching restores A; new and branched sessions start independently; reconnect with a new runtime preserves text; late stored-ID promotion is lossless; missing/deleted/provisional sessions offer explicit unlinked recovery. |
| Interaction lifecycle | Unmount/remount and StrictMode rehearsals preserve records; slash choice and transcription save; stale upload/completion/transcription results never mutate another context. |
| Edit recovery | Begin/cancel edit preserves the normal draft; recovered edit targets are validated; missing rows cannot trigger a destructive retry. |
| Attachments | Completed references survive same-runtime navigation; restart/new-runtime records require reattachment unless contract-proven safe; in-flight files are not represented as uploaded; removal saves; unresolved references cannot be submitted. |
| Submission | Success clears only its snapshot; failure restores exact content; newer text survives late success/failure; navigation updates the origin recovery record; queue/retry/no-session/stale-auth outcomes do not claim false success; uncertain work is never automatically resent. |
| Logout and tabs | Logout clears all draft kinds even if remote sign-out fails; late callbacks cannot recreate them; another tab's owner change locks recovery; concurrent edits preserve conflict copies rather than overwriting. |
| PWA safety | Saved text allows explicit updates and restores afterward; unsaved text, pending sends, media tasks, and runtime-bound attachments block reload; direct calls cannot bypass the UI guard; idle updates still work. |
| Sensitive responses | Secret and sudo input never enter draft records, safety summaries, recovery UI, or debug logs. |

Extend these existing suites rather than replacing them wholesale:
- `client/src/features/chat/chat-interaction.test.ts`
- `client/src/features/chat/use-chat-interaction.test.tsx`
- `client/src/components/chat-screen.test.tsx`
- `client/src/state/conversation.test.ts`
- `client/src/state/gateway-controller.test.ts`
- `client/src/state/session-selection.test.ts`
- `client/src/pwa/lifecycle.test.ts`

Add browser coverage in `client/e2e/chat-drafts.spec.ts` and extend the existing PWA update fixtures. Cover refresh recovery, session/profile switching, account sign-out/sign-in, failed send with newer typing, reattachment guidance, provisional recovery, edit validation, conflict handling, and storage failure. Exercise keyboard and screen-reader access to recovery controls.

Run from `client/`:

```sh
npm run test -- src/features/chat/chat-drafts.test.ts src/features/chat/chat-interaction.test.ts src/features/chat/use-chat-interaction.test.tsx src/components/chat-screen.test.tsx src/state/conversation.test.ts src/state/gateway-controller.test.ts src/state/session-selection.test.ts src/pwa/lifecycle.test.ts
npm run typecheck
npm run test
npm run build
npm run test:e2e -- e2e/chat-drafts.spec.ts e2e/pwa-foundation.spec.ts e2e/pwa-performance.spec.ts e2e/pwa-status-bar.spec.ts
```

The new files in these commands are implementation targets, not files added by this planning task. Include additional draft-owner tests in the focused run when created.

Finally, verify on an installed phone PWA: type a long message, background/close and reopen the app, switch profiles, update with saved text, attempt an update with an attachment, and recover after a dropped send. Browser fixtures cannot prove mobile process-kill behavior or real gateway reference durability. Verify native WebView draft behavior if the same code ships there; PWA registration must remain browser-only.

Item 1 is complete only when these flows preserve text without cross-account leakage or unexpected submissions, and all unsupported recovery cases have explicit UI guidance. This document authorizes planning only, not application changes, deployment, or commits.

## 2. Keep the app usable while reconnecting

Priority: First implementation batch.

### Current evidence

Previously, reconnect made the entire shell inert. The implementation now retains a workspace verified during the current app lifetime. Gateway readiness and selected-conversation availability guard remote work independently of local navigation and drafting.

Relevant files:
- `client/src/components/mobile-shell.tsx`
- `client/src/app.tsx`
- `client/src/state/gateway-controller.ts`

### Implemented behavior

- Keep transcripts readable, scrolling and local swipe navigation available, and ordinary draft editing active during interruptions and after exhausted retries.
- Store multiple visited conversations under `hermes.transcript.v2:`. Identity includes verified gateway/account, nullable profile, and stored session ID. Discard account-blind v1 history; never import it.
- Keep at most 20 conversations per owner, with 80 projected entries per snapshot and a 2 MiB serialized UTF-8 persistent budget including keys. Evict oldest successful synchronizations, never drafts. Individually oversized history stays in memory without truncating message text.
- Persist authoritative reconciled history only. Cache data does not establish message delivery or authorize Edit & retry. Empty histories are valid saved selections.
- Support exact saved-session selection and latest-synchronized saved conversation per profile without network dispatch. Uncached destinations preserve the current selection. Cached targets supersede reconnect work, including across profiles.
- Suspend live prompts, streaming indicators, history requests, media tasks, and group drives on loss. Reconcile the selected conversation before enabling sending. A deleted saved target is not silently replaced with a newly created session.
- Enforce readiness in gateway adapters, command methods, query/mutation hooks, and UI controls. Unavailable mutations are rejected rather than queued. Settings autosave cancels and rolls back on interruption; reconnect does not restart it.
- Show a compact polite connection banner. Browser offline evidence, explicit server errors, generic reachability errors, reconnect, and history synchronization have different wording. Retry coalesces recovery for the same destination.
- Keep local Appearance, About, keyboard help, settings navigation, and sign out available. Existing remote editors remain mounted but inactive. Group-room expansion while offline is not included.
- The user's ordinary Send click or enabled Enter-to-send is confirmation after recovery. There is no automatic sending, offline outbox, extra confirmation dialog, or background synchronization.
- Cold offline startup does not reveal stored history without current account verification. Authentication expiry locks local records and clears the foreground. Principal-less gateways have memory-only snapshots and drafts.
- Logout removes this owner's history and drafts locally before remote sign out. Storage removal failures are reported; browser site-data deletion is still required when removal cannot be confirmed.

### Verification

- Reading, scrolling, and drafting work during a connection interruption.
- Gateway-dependent actions remain unavailable and explain why.
- Reconnection reconciles history without duplicate messages or unexpected submissions.
- Cached navigation preserves account and profile isolation.
- Exercise offline, unavailable gateway, expired authentication, and successful recovery paths in a browser.

Final automated checks passed: `npm run typecheck`, all 1,289 unit tests across
98 test files, `npm run build`, and the full phone-sized Chromium/WebKit browser
suite with 114 passed and 10 browser-specific skips. Reconnect coverage includes
cross-profile cached navigation, scroll retention, exact drafts, exhausted
retries, missing saved targets, auth expiry, uncertain delivery without resend,
open editor preservation, and offline Appearance/sign out. `git diff --check`
also passed.

Physical-device installed-PWA checks were not available in this session. Native
simulator/WebView checks were not performed because `xcrun simctl` is unavailable.
Clear local data and the persistent-history preference are implemented separately in item 3.

## 3. Tighten local conversation privacy

Priority: First implementation batch, ahead of cosmetic changes.

### Required outcome and settled scope

Provide an offline-capable local Privacy settings page with two independent controls. These scope choices were confirmed by the user:

1. **Save conversation history on this device** applies to the entire browser origin or native app installation, across accounts, gateways, and profiles. Turning it off removes all existing persistent conversation-history snapshots and stops future history reads and writes to persistent storage. It does not remove drafts.
2. **Clear local data** removes the currently verified account's conversation data across every profile on the current gateway: saved history, ordinary/edit/provisional drafts, attachment metadata, failed/uncertain/conflict recovery copies, and session bookmarks. It also clears corresponding in-process conversation data. It does not clear another account or gateway.

These controls cover regular chats. During implementation the user confirmed that the separate, shared `hermes.group-chats.v4` group-room store remains outside item 3. Explain this limitation in Privacy and recommend browser site-data deletion for a full local reset; do not silently delete other accounts' group logs. Account-scoping group storage requires separate work.

Both controls leave remote conversations, remote agent work, authentication, theme, gateway URL, selected profile, notification subscriptions, and unrelated preferences unchanged. Do not use `localStorage.clear()`, delete all Cache Storage, unregister the service worker, or reset native credentials. This is conversation-data cleanup, not a full app reset or secure erasure guarantee.

History opt-out alone is not a no-storage mode. Explain next to the control that unfinished drafts are still saved separately and that sign out or Clear local data removes this account's drafts. Keep item 1's draft-loss protection intact.

### Source evidence

- `client/src/state/transcript-cache.ts` owns `hermes.transcript.v2:` snapshots and the in-process visited-conversation map. It already verifies account/profile identity, enforces limits, and rejects malformed records. `clearOwner()` lacks a reactive notification, installation-wide persistent purge, history preference, and cross-tab invalidation.
- `client/src/features/chat/chat-drafts.ts` owns `hermes.drafts.v1:` records and `hermes.drafts.logout:` markers. Its ordinary storage-deletion handler intentionally preserves local text as unsaved work. Explicit privacy cleanup therefore needs an invalidation signal, not just key removal. Logout markers currently lock authentication and must not be reused unchanged for a clear action that retains sign-in.
- `client/src/state/session-selection.ts` owns `hermes.mobile.session.v2:` bookmarks and their memory fallback. Existing deletion is private and single-profile; logout does not currently remove all owner bookmarks.
- `client/src/state/gateway-controller.ts` already coordinates logout, runtime teardown, reconnect invalidation, and account cleanup. Conversation remains the sole writer of `$chat`. Scope/auth generations retire asynchronous work, but a clear action must not be treated as remote logout.
- `client/src/features/settings/settings-screen.tsx` renders local Appearance/About separately from remote settings. Privacy must follow that local pattern and remain available during interruptions.

### History preference behavior

- Default to enabled when the preference has never been set, preserving existing behavior. Store an explicit versioned installation-wide boolean, proposed `hermes.privacy.v1`. Validate stored input; a present but invalid or unreadable preference must not silently authorize persistent history access. Report degraded storage capability without breaking chat.
- Read the policy before the cache can load persistent history or write its first snapshot. Enforce it inside TranscriptCache, not only in settings or Conversation call sites.
- Turning off requires confirmation that saved history for all accounts on this installation will be removed, while drafts and remote history remain. Cancel leaves both policy and data unchanged.
- Once confirmed, block persistent history reads/writes first, persist the disabled policy, then remove every app-owned `hermes.transcript.v2:` record and the legacy `hermes.transcript.v1` key. Delete by namespace even when record contents or encoded identities are corrupt. Do not read or render another account's content to purge it.
- Keep verified in-process history and the current transcript usable. Mark all retained snapshots as memory-only so navigation never claims they are saved on this device. Existing snapshot limits and account-verification rules still apply.
- Synchronize the policy across tabs. A tab must recheck the persisted policy before persistent reads/writes, not rely solely on delayed storage events. Receiving opt-out must discard persistent-status bookkeeping and stop loading disk snapshots without losing current draft text.
- When disabled at startup, retry removal of leftover history. If deletion fails, keep persistence disabled and report that existing saved data may remain. Never display a success message without confirming removal.
- If saving the preference fails, disable history for the current process anyway, attempt cleanup, and explicitly warn that the setting may not survive restart or reach other tabs. Do not claim installation-wide protection was established.
- Turning on permits future authoritative history synchronizations to persist. Do not bulk-save the in-memory backlog or bypass current identity validation. Draft persistence is unchanged in either direction.

### Clear local data behavior

- Show the verified account/gateway scope and list the data categories in a destructive confirmation dialog. State that unfinished drafts will be permanently discarded locally, remote conversations remain, and sign-in/preferences are retained. Escape or Cancel performs no work.
- Require a currently verified, unlocked owner for persistent account cleanup. For principal-less connections, offer clearly labeled current-connection memory cleanup only; do not guess ownership of stored records. During authentication expiry, explain that account verification is required rather than exposing old account data.
- Disable confirmation while this tab has an active turn, approval, pending submission, upload, transcription, or another privacy operation. Explain which work must finish or be resolved first. Failed and uncertain recovery records can be discarded after the explicit warning. Do not send, retry, or remotely cancel work as part of cleanup.
- On confirmation, capture the owner and retire pending local work before deleting anything. Invalidate reconnect/selection/history/composer callbacks, stop local media tasks, retire the local conversation runtime's operations, and clear foreground/query projections through their owning modules. Keep the authenticated gateway connection and Privacy page available.
- Clear all owner profiles, including profiles not currently loaded. Match ownership from validated structured keys, not string-prefix guesses or message bodies. Delete a matching key even if its stored value is malformed. Unparseable keys with unknown ownership must be reported as a cleanup limitation, not used to justify deleting other accounts' data.
- Clear the active draft, edit mode, attachment references, recovery lists, provisional mappings, submission bookkeeping, memory bookmarks, and cached session selections. Notify cache/draft subscribers so stale entries disappear from navigation immediately.
- Do not automatically restore the cleared session, reload its history, or recreate its bookmark. Remain on Privacy with no selected conversation. Connection recovery can restore the authenticated transport without restoring or creating a conversation, so the user is not stranded after clearing offline. The user can explicitly reopen a remote conversation afterward; its authoritative history may then be cached again if history saving is enabled. New typing after cleanup is new draft work.
- Coordinate account-scoped clear operations across tabs using a durable, content-free reset revision distinct from authentication logout. Publish invalidation before record deletion. All owner-scoped persistence paths must reject work from an older revision, including tabs that have not yet handled the event. Late callbacks must not repopulate history, drafts, or bookmarks.
- Other tabs showing the same account must retire local work and clear corresponding foreground/memory state without remote logout or automatic resubmission. A remotely running turn may continue; explain that local clearing does not stop the agent. Tabs on other accounts retain their data and selection.
- Clear is not a transaction that can restore deleted text on failure. Attempt all independent deletions, verify each owned namespace, and return category-level results. On partial failure, keep old callbacks invalidated, preserve failure details, and offer Retry. Warn that browser site-data deletion may be needed before sharing the device. Never announce complete removal if enumeration, deletion, verification, or cross-tab invalidation failed.
- Leave minimal policy/reset markers in place where needed to prevent stale tabs from recreating deleted content. They contain no transcript, draft, credential, or display-name data.

### Module ownership and implementation sequence

Keep storage details out of settings JSX. Add a small app-local privacy module, proposed `client/src/state/local-privacy.ts`, owning validated history policy, reset revisions, initialization/disposal of cross-tab listeners, and structured operation results. Inject a storage adapter for tests. Keep transcript/draft/bookmark serialization and deletion within their existing owning modules. GatewayController coordinates live workspace teardown and exposes the clear command to settings.

1. **Add the history policy and cache enforcement.**
   - Implement the versioned preference and failure/status reporting.
   - Extend TranscriptCache with installation-wide persistent purge and reactive invalidation. Preserve memory snapshots when disabling, and enforce the policy on every persistent read/write.
   - Initialize privacy policy/listeners early enough to avoid a startup read or write race. Use the existing app lifecycle setup/cleanup pattern, including StrictMode-safe disposal.
2. **Add complete owner cleanup and reset guards.**
   - Add owner-wide bookmark removal and memory cleanup in SessionSelection. Add reset guards at bookmark publication as well as history/draft persistence.
   - Extend draft cleanup with non-logout reset semantics and read-back verification. Keep existing logout markers and cross-tab logout behavior working.
   - Make transcript cleanup notify subscribers and reject stale resets. Avoid introducing another account identity scheme; use existing gateway-local and organization principals.
3. **Coordinate clearing in GatewayController.**
   - Capture and recheck owner/reset revision at confirmation; never apply a dialog opened for one account to a newly selected account.
   - Retire local runtime, reconnect, selection, and query work through existing modules. Clear `$chat` through Conversation, never directly from settings.
   - Add the all-profile bookmark cleanup to logout too, including remote-sign-out failure paths. Share cleanup internals without making clear-local-data sign out or lock a valid account.
   - Return explicit complete/partial/blocked results that the UI can render without inspecting storage keys.
4. **Add local Privacy settings.**
   - Extend `navigation/routes.ts`, settings registry metadata, route parsing tests, and local/remote category typing so Privacy never requests a backend config section.
   - Add `features/settings/privacy-settings.tsx`, using existing page shell, shared controls, destructive confirmation, and accessible status/error feedback. Mount it outside GatewayActionRegion.
   - Handle busy, cancelled, blocked, successful, partial-failure, memory-only, and cross-tab-change states. Keep focus sensible after dialogs and announce results without exposing draft text.
5. **Document and verify.**
   - Update `SECURITY.md` with exact scope, history/draft distinction, cross-tab behavior, partial-failure limits, and browser-origin/native-installation storage boundaries.
   - Update ownership notes in `CONTEXT.md`. Mark item 3 complete only after the automated and browser checks below pass; record unavailable physical-device checks separately.

No shared UI package change, dependency addition, remote deletion endpoint, offline outbox, or broader settings redesign is planned. Herm remains standalone.

### Test matrix and acceptance criteria

| Area | Required evidence |
| --- | --- |
| Policy and startup | Missing preference defaults on; valid off blocks the first persistent read/write; malformed/unreadable settings do not authorize persistence; setting-write failures are visible; reload preserves successfully saved choices. |
| History opt-out | Removes all accounts' persistent history, including corrupt values/keys within the history namespace; current verified memory history stays readable and is labeled memory-only; drafts, bookmarks, tokens, theme, and unrelated records remain. |
| Re-enable | Only future authoritative synchronizations persist; no automatic backlog write; existing identity, profile, limits, validation, and cold-start verification remain intact. |
| Owner clearing | All profiles and all draft/recovery kinds plus bookmarks are removed from disk and memory; another account/gateway and unrelated preferences survive; no remote deletion/logout/cancel command occurs. |
| Runtime and races | Deferred history, selection, upload, transcription, submission settlement, reconnect, and unmount/pagehide flush cannot recreate old data; no automatic restore; account change after opening confirmation cannot clear the wrong owner. |
| Multiple tabs | History off is installation-wide; clear affects only matching owner tabs; same-owner foreground/cache/draft state clears without a conflict copy; delayed events cannot permit stale writes; unrelated account tabs remain usable. |
| Failure handling | Blocked storage, quota failure, enumeration failure, partial remove failure, missing reset marker, and malformed records do not crash chat or claim successful removal; retry attempts all failed categories. |
| Existing privacy | Organization and gateway-local accounts remain isolated; auth expiry still locks local records; logout removes history/drafts/bookmarks even if remote logout fails; callback and cross-tab logout guards remain effective. |
| UI | Privacy is accessible offline and after exhausted retries; confirmation names the scope; Cancel/Escape is inert; destructive action has an accessible name; focus and polite/error announcements work; history-only opt-out never silently discards drafts. |

Extend existing tests rather than replacing them:
- Add `client/src/state/local-privacy.test.ts` and `client/src/features/settings/privacy-settings.test.tsx`.
- Extend `transcript-cache.test.ts`, `draft-owner.test.ts`, `chat-drafts.test.ts`, `chat-interaction.test.ts`, `gateway-controller.test.ts`, `session-selection.test.ts`, and `conversation.test.ts` for the changed seams and races.
- Extend settings-registry, settings-screen, navigation, and app lifecycle tests where routing or initialization changes.
- Add `client/e2e/local-privacy.spec.ts`. Exercise history off/reload/on, current-account cleanup across profiles, another-account preservation, two-tab invalidation, offline clearing, confirmation cancellation, and injected storage failures in Chromium and WebKit. Assert actual storage contents and fixture RPC calls, not only success banners.

Run from `client/`:

```sh
npm run test -- src/state/local-privacy.test.ts src/state/transcript-cache.test.ts src/state/draft-owner.test.ts src/features/chat/chat-drafts.test.ts src/features/chat/chat-interaction.test.ts src/state/gateway-controller.test.ts src/state/session-selection.test.ts src/state/conversation.test.ts src/features/settings/privacy-settings.test.tsx src/features/settings/settings-screen.test.tsx src/features/settings/settings-registry.test.ts
npm run typecheck
npm run test
npm run build
npm run test:e2e -- e2e/local-privacy.spec.ts e2e/chat-drafts.spec.ts e2e/reconnect.spec.ts e2e/pwa-foundation.spec.ts
```

Also run `git diff --check` from the repository root. Check the changed UI at phone width with keyboard navigation; manually inspect confirmation focus and status announcements. On an installed phone PWA, verify off/reopen, offline clearing, and no unwanted session restoration. If native builds ship this code, verify preference persistence and cleanup in the WebView without modifying native credentials. Report device/simulator checks that are unavailable. The user subsequently authorized implementation and a commit for item 3; deployment remains outside this work.

### Implementation and verification record

Implemented Settings > Privacy with the shared switch and destructive confirmation,
installation-wide regular-chat history opt-out, account-wide history/draft/bookmark
cleanup, reset-revision guards, category-level partial failures and retry, and
transport-only recovery after offline clearing. Logout now clears all owner
bookmarks too. Shared group-room logs remain excluded by the user's explicit
scope decision, with a warning in the UI and `SECURITY.md`.

Verification passed:
- All 1,321 unit tests across 100 test files, plus TypeScript checking.
- Production build.
- Phone-sized Chromium/WebKit checks for local privacy, chat drafts, reconnect,
  and PWA foundation: 99 passed, 9 existing browser-specific skips. A final
  fresh-build Privacy run, including history-removal retry, passed all 14 tests.
- Privacy coverage includes history off/reload/on, all-profile offline clearing,
  preservation of other-account records/preferences, cross-tab invalidation,
  confirmation cancellation/focus, and partial-deletion retry. Storage tests cover
  malformed preferences, blocked writes/enumeration/removal, stale callbacks,
  undeleted old records after reset, and delayed storage events.
- `git diff --check`, read-only implementation review, and screenshot inspection.

Physical-device installed-PWA checks and manual screen-reader announcements were
not available. Native simulator/WebView checks could not run because
`xcrun simctl` is unavailable. These remain device-verification limitations,
not claims established by browser fixtures.

## 4. Give the composer clearer feedback

Priority: Second implementation batch.

### Current evidence

Attachments appear as reference strings. Uploading and transcription have no dedicated progress state. While Hermes is running, the send button becomes an interrupt button even though the input says "Queue another prompt." Read aloud starts playback without dedicated playback controls.

Relevant files:
- `client/src/components/chat-screen.tsx`
- `client/src/features/chat/chat-interaction.ts`
- `client/src/state/conversation.ts`

### Planned improvements

- Show filename chips, image previews where practical, and explicit remove buttons.
- Show uploading and transcribing states, including failures. Use indeterminate feedback unless actual progress is available.
- Provide a visible Queue action alongside Stop while Hermes is working.
- Confirm queued-prompt submission using the gateway's actual acknowledgement semantics. Do not imply execution has begun merely because submission was accepted.
- Add audio playback controls instead of a one-shot Read aloud action.
- Prevent repeated actions from accidentally starting duplicate uploads, submissions, or overlapping playback.

### Verification

- Attach, remove, upload failure, and conversation-switch flows behave correctly.
- Queue and Stop remain distinct and usable on a narrow phone viewport.
- Queue acknowledgement and errors accurately describe the gateway state.
- Transcription does not overwrite newer user edits.
- Audio can be stopped and does not continue unexpectedly after leaving the conversation.
- Exercise the composer with the software keyboard open in a browser.

## 5. Make answers easier to use

Priority: Second implementation batch.

### Current evidence

Markdown rendering is minimal. The entire transcript is an `aria-live` region, which needs screen-reader testing during streaming. Collapsed tool activity already keeps execution details out of the main conversation.

Relevant files:
- `client/src/components/message-markdown.tsx`
- `client/src/components/chat-screen.tsx`
- `client/src/components/agent-activity.tsx`

### Planned improvements

- Add copy controls for assistant answers and code blocks, with success and failure feedback.
- Improve code formatting and mobile handling of wide tables without causing page-wide horizontal overflow.
- Review streaming announcements so screen readers receive useful updates without repeatedly reading the entire transcript.
- Preserve collapsed tool activity rather than turning chat into a wall of execution logs.
- Preserve existing safe Markdown rendering and external-link behavior.

### Verification

- Copy produces the intended plain text or code and handles clipboard restrictions.
- Long code, tables, links, and streamed Markdown remain readable on phone screens.
- Controls are keyboard-accessible and have descriptive accessible names.
- Test streaming with a screen reader; automated accessibility checks alone are insufficient.
- Unchanged messages retain the current memoized rendering behavior.

## 6. Improve finding older conversations

Priority: After the core reliability and composer work.

### Current evidence

Session search filters the titles of loaded sessions, not the complete remote history.

Relevant files:
- `client/src/components/sessions-menu.tsx`
- `client/src/features/sessions/api.ts`

### Planned improvements

- Make the current search limitation explicit.
- Inspect gateway support before adding remote search. Use gateway-backed search only if the API supports it; do not simulate complete search over a partial local list.
- Group sessions by recent date where that improves scanning.
- Add richer session previews where gateway data supports them.
- Provide an accessible archive view if the gateway supports listing and opening archived sessions.
- Avoid elaborate folders until there is evidence users need them.

### Verification

- Search results and empty states accurately describe the searched data.
- Pagination does not conceal matches while implying the search is complete.
- Date grouping works across time zones and date boundaries.
- Archived-session behavior matches the gateway contract.
- Preserve existing session opening, branching, deletion confirmation, focus handling, and swipe behavior.

## 7. Make notification setup testable

Priority: After the core reliability and composer work.

### Current evidence

Notification settings offer an enable/disable control, but users need a direct way to verify background delivery without waiting for a real job.

Relevant files:
- `client/src/features/settings/settings-screen.tsx`
- `client/src/pwa/push.ts`
- `client/src/pwa/sw.ts`
- `web-push-relay/`

### Planned improvements

- Add a "Send test notification" flow after checking the relay and gateway capabilities needed to support it.
- Show clearer device status, distinguishing permission, local subscription, and server registration where observable.
- Provide platform-specific instructions when installation or permission is missing.
- Explain unsupported and blocked-permission states with actionable guidance.
- Report test submission separately from confirmed delivery. Do not claim delivery when only the send request succeeded.

### Verification

- Test supported, unsupported, denied-permission, expired-subscription, and relay-failure states.
- Verify a real notification arrives while the installed PWA is backgrounded or closed on supported devices.
- Tapping a notification opens the intended conversation without bypassing authentication or crossing account/profile boundaries.
- Test notification content does not include sensitive conversation data.

## Implementation order

1. Draft protection, selective reconnect blocking, and account-scoped cache cleanup.
2. Composer feedback, explicit Queue and Stop actions, answer-copy controls, and transcript readability/accessibility.
3. Session discovery and notification setup diagnostics.

Resolve account identity and persistence boundaries before implementing draft and history storage. Keep changes within the existing gateway ownership model: the app owns navigation and UI state; the gateway owns conversations, agent work, configuration, and remote files.

## Verification approach

- Start with focused tests around changed state and persistence behavior.
- Run typechecking and relevant unit tests, then broader checks in proportion to risk.
- Extend existing Playwright coverage for changed user workflows and integration boundaries.
- Exercise phone-sized Chromium and WebKit views, keyboard-open layouts, offline/reconnect paths, refresh/update recovery, and account switching.
- Check actual installed-PWA behavior on supported devices for lifecycle, installation, audio, and background notifications where browser fixtures cannot prove the workflow.
- If device or browser verification is unavailable, record that limitation rather than treating static checks as proof.
- No implementation, deployment, publication, or commit is authorized by this planning document alone.
