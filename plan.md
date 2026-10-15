# Herm PWA improvement plan

Status: Items 1 through 7 have application implementations. Item 7's real gateway identity and physical-device delivery acceptance remain deployment/device verification limits. Item 3 adds local Privacy settings, installation-wide regular-chat history opt-out, and account-scoped conversation-data cleanup. Legacy shared group-room logs are explicitly excluded.

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

Status: Implemented following the user's authorization to implement and commit.
Items 1 through 3 provide the draft, reconnect, and privacy safeguards retained
by this work. Deployment remains outside this work.

### Scope and completion criteria

Improve the regular-chat composer and its existing Read aloud action. Keep this
work inside standalone Herm, using shared UI controls and tokens. Do not change
shared packages unless a concrete control deficiency requires it. Any shared
change must also be verified in integrated and standalone contexts.

Item 4 is complete when users can:
- Identify each selected file by name, see whether it is uploading, ready,
  failed, or needs reattachment, preview a newly selected image where supported,
  and remove it without sending it.
- See upload and transcription activity and recover from failure without losing
  text or successful attachments.
- Intentionally Send while idle or Queue during a turn, with a separate Stop
  action. See submission acceptance, rejection, or delivery uncertainty without
  confusing acceptance with execution.
- Start, pause, resume, and stop read-aloud playback, including stopping speech
  generation locally before a response arrives.
- Use these controls by keyboard and on a narrow phone viewport with the software
  keyboard open, without duplicate requests or cross-conversation media leaks.

Not included: group-room composer redesign, a client-side prompt queue, queue
position/reordering/deletion, automatic retries, background uploads, a new
recorder, persistent raw files/previews/audio, streamed TTS, or item 5's transcript
and Markdown redesign. Do not make Moirasia launch or control Herm.

### Evidence at planning time and contract limits

The original notes predate items 1 and 3. The following records the starting point
before item 4 implementation:
- `client/src/components/chat-screen.tsx` already renders filename chips and
  remove actions, plus recovered-file guidance. Uploads and transcription still
  have no dedicated visible activity state. Chip identity and removal use array
  indexes; metadata is read indirectly from the draft record.
- `client/src/features/chat/chat-interaction.ts` owns draft mutations, sequential
  upload batches, transcription, and speech. Submission already rejects rapid
  duplicates and preserves failed/uncertain snapshots. Media activity is tracked
  for draft/PWA safety, but not projected into the interaction state. Upload and
  transcription entry points can still overlap on repeated calls.
- Transcription already checks the conversation epoch and draft revision before
  replacing text. Speech reuses that draft revision, so unrelated typing can
  invalidate speech generation. Item 3 added playback cleanup on context changes,
  gateway unavailability, and disposal, but there is no reactive playback state.
- `client/src/features/chat/use-chat-interaction.ts` owns interaction lifetime and
  current-context checks. `ChatScreen` receives `active`, but currently passes it
  only to viewport handling. Switching workspace tabs can leave the same chat
  mounted, so disposal alone is not a sufficient playback stop rule.
- `client/src/state/conversation.ts` sends `prompt.submit` with `queued: true`
  when running. Only `accepted === true` confirms acceptance. A successful RPC
  without that flag is already treated as uncertain. No consumed contract gives
  queue position, execution start, or queue durability. The browser fixture can
  return an uncertain acknowledgement after recording the message.
- `Conversation.interrupt()` awaits `session.interrupt`; it does not prove the
  turn ended or the queue was cleared. The fixture currently has no dedicated
  interrupt behavior. Production gateway handlers are absent from this checkout.
- Attachments use whole-data-URL RPCs, with 20 MiB image and 50 MiB other-file
  limits. Transcription has a 25 MiB limit. Audio endpoints return whole responses.
  `GatewayPort` supports request signals, but exposes no measured upload progress
  or server-side per-file cancellation contract.
- Attachment response handling currently permits synthesized filename references
  and empty strings. Existing tests encode this behavior; those expectations must
  be revisited before a chip can honestly claim the file is ready.
- `client/src/styles.css` has a four-column composer grid and shared selectors
  used by the group composer. `useChatViewport` measures composer occlusion;
  extra feedback and a second action must not obscure the transcript or prompts.

### Interaction ownership and state

Keep the existing module responsibilities:
- `Conversation` owns gateway commands, live-context validation, acknowledgement
  interpretation, and interrupt request safety. It must not acquire UI timers,
  file previews, or HTML audio elements.
- `ChatInteraction` owns transient attachment, transcription, submission-feedback,
  and playback state. Expose a small reactive projection and guarded actions so
  React renders state rather than reconstructing operation lifecycles.
- `ChatDrafts` remains the only draft/recovery persistence owner. Preserve account,
  profile, provisional promotion, privacy-revision, and logout guards. Do not
  serialize transient operation state, raw files, object URLs, audio, or errors.
- `ChatScreen` renders controls, messages, and accessible status. The hook forwards
  visibility/lifetime changes. Extract Herm-local render modules only if needed
  to keep the screen readable; do not add a general media framework.

Use stable attachment and operation identities rather than array positions or
filename equality. Each deferred callback must verify its operation, owner,
conversation/runtime epoch, and relevant draft revision before changing state.
Give speech its own generation identity rather than incrementing the text revision.

Busy flags and draft/PWA task leases must describe the same lifecycle and settle
on success, failure, removal, local cancellation, context retirement, and disposal.
Use transport abort signals where supported, while retaining stale-result guards.
A local abort or removed chip does not promise server rollback or remote deletion.

### Attachment feedback and previews

- Project validated filename, media type, size, stable identity, and state directly
  from interaction state. Render a separate, labelled Remove button per file.
  Long names must truncate or wrap without hiding status or removal controls.
- Represent files waiting in the sequential batch separately from the file being
  uploaded. Keep successful files usable after another fails. Report per-file
  failure and leave an explicit select-again/remove path; do not retry silently.
- Guard repeated picker/action calls while a batch is active. Keep text entry
  available. Removing an in-flight file retires that file's result; its eventual
  response must never resurrect the chip or become part of a submitted prompt.
- Validate upload acknowledgements at the gateway-command interface. Require a
  nonempty supported reference before marking a file ready. Preserve a synthesized
  reference only if a verified gateway contract establishes that it is valid;
  otherwise show an unconfirmed result and require reselection/removal. Update the
  legacy empty-reference/fallback tests deliberately, not by weakening assertions.
- Show indeterminate progress and file counts, not invented percentages. Preserve
  existing pre-read size limits and surface rejected/oversized files by filename.
- Create small previews only from locally selected supported raster images. Do not
  fetch arbitrary reference strings or render uploaded HTML/SVG. Handle decode
  failures with the filename fallback. Revoke object URLs on removal, replacement,
  submission, context change, privacy reset, and disposal. Do not persist previews
  or recreate them from remote URLs after reload.
- Restored references remain subject to item 1's runtime-validity rules. A preview
  or matching filename is not proof that a reference is usable after reconnect.
  Pending, failed, unconfirmed, and stale references block submission until resolved
  or explicitly removed. Ready attachment-only messages remain sendable.

### Transcription feedback

- Show Transcribing audio with an explicit local Cancel action. Permit only one
  transcription request at a time, including direct method calls. Empty/cancelled
  file pickers make no request. Keep the existing size check before file reading.
- Preserve current successful replacement behavior only when the originating draft
  revision is unchanged. A later edit, slash choice, edit-mode change, restore,
  discard, or submission must prevent automatic insertion into the newer draft.
- If a valid result arrives after same-conversation text changes, keep one temporary
  transcript in memory with explicit use/copy/discard controls. Using it must not
  silently replace current text; insert into the current draft through its normal
  mutation method. Drop the temporary result on context/owner change or disposal.
- Failure and local cancellation preserve the current draft. Explain missing or
  malformed response data. No stale failure may replace a newer operation's status.
  Successful insertion uses normal draft persistence, never a separate audio store.

### Send, Queue, and Stop

- Keep Send available while idle. While running, show a labelled Queue action and
  a separate Stop action. Buttons and Enter must use the same guarded submission
  path. Shift+Enter inserts a newline; IME composition must not submit.
- Queue must remain disabled for an empty prompt, pending dispatch, invalid edit,
  unavailable/unverified conversation, or unresolved media. Do not queue an
  edit-and-retry operation into an active turn. Recheck these rules in command
  methods, not only through disabled controls.
- Capture whether dispatch used the queue path with the request outcome. A turn
  can finish during the RPC; feedback must describe the dispatched request, not
  infer its meaning from the latest `chat.running`. Return a structured internal
  outcome if needed, retaining the existing recovery semantics for all callers.
- While waiting, say Sending or Submitting queued prompt. After confirmed queue
  acceptance, say Gateway accepted your queued prompt, with no claim that execution
  has started. Do not optimistically add a queued message as an executed transcript
  turn or maintain a second local queue. Let gateway events/history show execution.
- Known rejection uses existing failed-message recovery without overwriting newer
  typing. Missing acknowledgement, timeout, or connection loss uses Delivery not
  confirmed and preserves the uncertain snapshot. Never auto-resend or label an
  uncertain submission as rejected. Acceptance feedback is transient and must not
  erase the status of a later request or survive a conversation/owner reset.
- Give Stop its own in-flight guard and error/status handling. Queue dispatch and
  interrupt are independent operations, so waiting for one must not hide the other.
  Say Stop requested after acknowledgement; keep actual running state driven by
  gateway events. Do not promise that Stop clears queued prompts. Guard stale
  completions and repeated clicks, including at the `Conversation` interface.
- Verify any stronger gateway semantics against an authoritative contract before
  using stronger wording. Lack of a queue inventory must not block these honest
  controls or be papered over by a browser fixture.

### Read-aloud controls

- Identify speech by the originating assistant message and expose generating,
  playing, paused, stopped/idle, ended, and error states. Only one speech request
  or playback may own the player at a time.
- Repeating Read aloud for the same active message must not create another request.
  Selecting another message retires the previous request/player before starting
  the new one. Pause/resume reuse the loaded audio; Stop also retires generation.
- Observe media play/pause/ended/error events and rejected `play()` promises so the
  UI reflects actual playback, including mobile autoplay restrictions. Validate
  the returned audio data before constructing a player. Do not persist it.
- Keep controls attached to the relevant message or a clearly labelled compact
  player. Pause, resume, and Stop audio are distinct from Stop Hermes. Stopping
  local audio remains available while offline; it must not require a gateway RPC.
- Stop and release local media on conversation/profile/account change, privacy
  reset, leaving the active chat workspace, document hiding, and disposal. Forward
  visibility explicitly through the hook; do not rely only on unmount. StrictMode
  rehearsals must not leave listeners, players, or late requests behind.

### Layout and accessibility

Use shared Button and feedback conventions with Herm-local layout rules. Keep the
message field useful at 320 CSS pixels, moving actions into a second row if needed
rather than shrinking touch targets. Bound attachment/previews and media feedback
height so users can still see the draft, active prompt, and latest response.

Label each icon action and file control. Use polite, concise live status for state
changes and alerts for actionable failures, not per-tick announcements. Keep focus
predictable after file removal and cancellation. Verify text zoom, long filenames,
keyboard traversal, visible focus, light/dark themes, and distinguishable disabled
states. Scope composer CSS changes so the group composer keeps working. Preserve
viewport measurement, safe areas, transcript anchoring, and prompt-card visibility.
Item 5 still owns redesigning the transcript-wide live region.

### Implementation sequence

1. Confirm acknowledgement/reference contracts and record supported outcomes.
   Extend deterministic browser fixtures for deferred upload/transcription/speech,
   rejection, uncertainty, and interruption without inventing production guarantees.
2. Add guarded transient operation state and stable attachment identity through
   `ChatInteraction`. Add unit tests for transitions and stale work. Preserve draft
   persistence, privacy/reset guards, task safety, and provisional promotion.
3. Implement attachment states, removal, local previews, and transcription feedback.
   Wire cleanup and explicit use of late transcripts through the existing hook.
4. Implement Send/Queue/Stop and typed acknowledgement feedback through Conversation
   and interaction ownership. Preserve recovery records and verify every caller
   affected by an outcome-interface change.
5. Implement single-owner playback state, controls, media events, visibility rules,
   and resource cleanup. Separate speech identity from text editing.
6. Finish narrow/mobile layout and accessible feedback. Add browser flow coverage,
   run regressions, and update `CONTEXT.md` plus this item's implementation record.
   Update `SECURITY.md` only if the documented handling of local media changes.

### Verification matrix

| Area | Required checks |
| --- | --- |
| Attachments | Multiple files and stable order; repeated picker/action guard; removal before/during/after upload; one failure among successes; oversized and malformed/unconfirmed responses; ready attachment-only send; no stale chip resurrection. |
| Previews | Supported images and decode failure; non-images/SVG fallback; long names; no reference URL fetching; object URLs released after every retirement path; reload shows metadata/reattachment guidance without preview persistence. |
| Transcription | Success; pending feedback; duplicate guard; size/malformed/network errors; Cancel; newer edits and submit; explicit late-result insertion/copy/discard; no draft overwrite; no result crossing contexts. |
| Submission | Idle Send and running Queue; simultaneous visible Stop; keyboard/IME behavior; duplicate dispatch; turn ends during queue acknowledgement; accepted vs uncertain vs rejected; newer typing and edit recovery preserved; offline controls do not dispatch. |
| Interruption | One in-flight interrupt; request success/failure/uncertainty; Queue still usable under its own guards; running changes only from events; no assertion that queued prompts were cancelled; destination state unaffected by stale results. |
| Speech | Generating/playing/paused/ended/error; pause/resume without another synthesis; duplicate and cross-message clicks; Stop during generation/playback; out-of-order responses; playback rejection; typing does not invalidate speech; offline Stop audio. |
| Lifecycle | A-to-B-to-A switches, profiles/accounts, reconnect/new runtime, provisional stored-ID promotion, privacy reset and other-tab reset, hidden workspace/document, unmount and StrictMode; task leases and resources retire exactly once. |
| Integration | Existing draft/recovery, reconnect, privacy, PWA update guards, history anchoring, prompt responses, shared group-composer styles, and keyboard-reduced viewport remain usable. |

Extend existing interaction, hook, conversation, and chat-screen tests, with a new
`client/e2e/composer-feedback.spec.ts` for user-visible flows. Use controlled deferred
responses, not timing-dependent sleeps. Mock audio events deterministically for
state coverage, then exercise actual browser playback where the environment permits.
Do not treat DOM-only tests as proof of playback or software-keyboard behavior.

Run from `client/`, starting with focused tests, then broader verification:

```sh
npm run test -- src/features/chat/chat-interaction.test.ts src/features/chat/use-chat-interaction.test.tsx src/state/conversation.test.ts src/components/chat-screen.test.tsx
npm run test
npm run build:native
npm run build
npm run test:e2e -- e2e/composer-feedback.spec.ts e2e/chat-drafts.spec.ts e2e/reconnect.spec.ts e2e/local-privacy.spec.ts e2e/pwa-foundation.spec.ts
```

Exercise Chromium and WebKit at phone and desktop sizes. Inspect screenshots with
Queue and Stop, attachment failures, transcription, playback, and the keyboard-reduced
viewport. Verify an installed phone PWA and native WebView when available, including
real keyboard/file capture, playback permissions, background/foreground, and safe
areas. Check screen-reader names and status announcements manually. Report unavailable
device/audio checks separately, and do not claim real gateway queue behavior from
fixtures. Review the final diff and keep commits/deployment subject to authorization.

### Implementation record

Implemented regular-chat per-file feedback and local raster previews, cancellable
transcription with explicit late-result insertion/copy/discard, separate Send/Queue
and Stop actions, typed gateway-acceptance feedback, and message-owned read-aloud
controls. No shared UI package or group-engine behavior changed. Group composer
layout retains its existing override.

Transient file identities, preview URLs, operation state, audio, and late transcripts
stay out of persistent drafts. Removing an in-flight file aborts its signal and
retires local waiting independently of remote cancellation, so later files can
proceed. Nonempty references are required before files become ready. Attachment
selection/removal also advances the draft revision so edited-message acknowledgements
cannot overwrite newer attachment-only work.

Playback owns independent request and play-attempt identities. A late rejected
`play()` promise after an intentional Pause cannot turn that pause into an error.
Visibility/context retirement stops speech and releases local media. Edit feedback
and errors live inside the measured composer; prompt cards and the latest-message
button use dynamic composer occlusion instead of a fixed bottom offset.

Verification passed:
- 1,349 unit tests across 102 files and TypeScript checking.
- Native and browser production builds.
- Chromium/WebKit regression checks for composer feedback, chat drafts, reconnect,
  local privacy, and PWA foundation: 117 passed, 9 existing browser-specific skips.
- After the final touch-target and focus refinements, a fresh native/browser build,
  all 16 composer browser checks, and 8 keyboard/viewport browser checks passed.
  Speech coverage exercised actual browser audio playback and keyboard Pause/Resume
  without additional synthesis requests, not only mocked media events.
- Unit regressions cover removed/stalled files, preview cleanup and decode failure,
  transcription cancellation/late insertion, duplicate operations, acknowledgement
  identity, next-message attachments during edited retry, and late play rejection.
- Read-only reviews identified two lifecycle issues, both fixed with regressions.
  Inspected phone-sized attachment-failure, Queue/Stop, and narrow-layout screenshots.
  `git diff --check` passed.

Physical installed-PWA, real phone keyboard/capture, native simulator/WebView, and
manual screen-reader checks remain unavailable in this environment. `xcrun simctl` is unavailable.
Native production builds are separate from native device verification. Gateway
fixtures establish UI behavior, not production queue ordering/durability or remote
cancellation guarantees.

## 5. Make answers easier to use

Priority: Completed in the second implementation batch, after items 1–4.
Status: Implemented following explicit user authorization for implementation,
local dev-container rebuild, and commit. No remote deployment or push authorized.

### Required outcome and scope

Regular-chat assistant answers should be easy to copy, read, and navigate on a
phone. Code and tables must scroll within their own containers rather than make
the page wider. Streaming must not repeatedly announce the conversation to a
screen reader.

Keep this work in Herm. Reuse the shared Button and existing typography, spacing,
colors, focus styles, and 44px action targets. No shared-package change is planned.
Do not change group-engine behavior, gateway contracts, storage, queue semantics,
read-aloud behavior, or draft recovery. Group chat remains plain text.

Do not add syntax-highlighting packages, a Markdown-to-plain-text converter,
rich-HTML clipboard output, automatic copying, or message export in this item.

### Evidence at planning time and constraints

- `client/src/components/message-markdown.tsx` already uses `react-markdown`,
  `remark-gfm`, `skipHtml`, secure external-link attributes, and `memo`. Its tests
  prove unchanged content is not reparsed and streamed changes do render.
- `client/src/components/chat-screen.tsx` renders Markdown for regular-chat
  messages and already offers assistant read-aloud actions. Its whole transcript
  is polite-live, including history, recovery controls, and execution activity.
  A separate compact session status already says "Hermes is working", "Ready",
  or "Status unavailable". There is no need for another token-announcement loop.
- Existing draft-copy code calls `navigator.clipboard.writeText` directly and
  reports through draft-recovery feedback. Answer-copy feedback must stay beside
  the copied answer or code, not reuse that draft-specific state.
- `client/src/transcript/transcript.ts` retains live assistant entry identity as
  deltas arrive. History reconciliation can replace it with a durable history ID.
  Completion clears streaming; a gateway error clears `running` without clearing
  the entry's streaming flag. Disconnect separately finalizes streaming flags.
  Consequently, `streaming === false` alone is not proof of successful completion.
- `client/src/components/agent-activity.tsx` and transcript grouping already keep
  reasoning/tool output in initially closed, independently expandable disclosures.
  Preserve their keys, expansion state, and error visibility.
- `client/src/styles.css` already gives code and tables horizontal overflow rules,
  but global wrapping rules and `display: block` on tables need scoped review.
  Code currently uses hard-coded dark colors instead of shared theme tokens.
- `client/src/features/groups/group-screen.tsx` renders plain text but shares
  `.message` and `.message-content` styles. Scope new Markdown rules to a dedicated
  wrapper so group messages and tool/reasoning output do not change accidentally.
- `client/e2e/server.mjs` supports held turns and echoed answer text, but does not
  yet provide a deterministic paced Markdown stream or explicit completion control.
  Extend the local fixture rather than introduce timing-dependent sleeps.

### Copy behavior

1. Offer "Copy answer" for nonempty ordinary assistant messages only, not system
   events, reasoning, tools, cron instructions, user messages, or recovery entries.
   Pair it with the existing read-aloud action without changing speech ownership.
2. Copy the exact `entry.content` captured at click time as plain clipboard text.
   This includes its Markdown syntax. Do not copy rendered `innerText`, reasoning,
   action labels, tool output, or other messages. Do not claim formatting has been
   stripped. No newline trimming or content truncation.
3. Permit copying cached/offline answers without a live gateway. During streaming,
   label the action "Copy answer so far" and copy that snapshot. Do not wait for a
   remote completion or silently replace the clipboard with later deltas.
4. Give fenced and indented code blocks their own "Copy code" action. Inline code
   keeps its normal inline rendering and has no toolbar. Read the code text from
   the existing parsed code node, not a second Markdown parser, DOM scraping, or
   a regex over the whole answer. Exclude fence markers, language labels, toolbar
   text, and surrounding prose. Preserve indentation, blank lines, Unicode, and
   the parsed code text's terminal newline. Fixtures must assert the exact payload.
5. Use the Clipboard API directly from the user gesture. Do not preflight browser
   permissions or require a gateway connection. Missing API, insecure-origin,
   denied-permission, and rejected-write cases must be handled without throwing
   through the screen. No success before the write promise resolves.
6. Each control owns idle/pending/success/failure feedback. Disable duplicate clicks
   while its write is pending. Keep focus on the same button as its label changes.
   Announce concise local feedback and offer a labelled, selectable plain-text
   fallback on failure, with an explicit selection action for manual copying.
   The fallback must contain the same captured text, not a newer stream revision.
7. Associate feedback with the captured snapshot, not a promise that newer deltas
   were copied. If text changes while a write is pending, report "Copied snapshot"
   on success and retain that snapshot for manual copying on failure. A new copy
   attempt replaces the old feedback/fallback. Guard callbacks by operation and
   current account/profile/session; distinguish source revisions when describing
   results. Navigation, logout, local-data clearing, or unmount must not display
   old text or copy feedback in another context. A clipboard write already issued
   to the platform cannot be retracted; local cleanup must not imply otherwise.
8. Keep all copy state and fallback text in memory. Never log answer/code payloads,
   persist clipboard feedback, add analytics, or read clipboard contents in app code.

### Module ownership and rendering

- Add a small app-local `client/src/components/copy-text-button.tsx` module, with
  tests, to own clipboard operations, stale-result guards, stable focus, local
  feedback, and manual-copy fallback. Its interface should take the text, a
  descriptive label, and a context identity. Derive identity from the existing
  gateway/owner/profile/session scope and owner-generation/privacy-reset guards;
  do not create a new account store or require a live gateway. Callers should not
  manage promises, timers, permissions, or shared clipboard status themselves.
  Reuse this module for answer and code controls; do not refactor existing
  draft-copy flows here.
- Extend `MessageMarkdown` with an optional code-copy capability, defaulting off.
  Enable it only for ordinary assistant answers. Use stable renderer maps and
  primitive props so unchanged messages retain their memoization behavior.
- Keep clipboard state in child modules below `ReactMarkdown`. Clicking Copy or
  changing its feedback must not rerun Markdown parsing. Do not add a second parse
  to extract code or a separate parse on every composer keystroke.
- Implement the code-block wrapper through the existing parsed `pre`/`code` nodes.
  Preserve semantic `<pre><code>`, safe language classes, and text escaping. Treat
  a language label as plain display text, never HTML, CSS, or executable input.
- Add a dedicated Markdown wrapper class. Put answer actions beside their answer,
  not in the fixed composer. Context-key local action state so live-to-history ID
  replacement safely resets it instead of associating it with another message.

### Code, table, and phone layout

- Give code a compact header with an optional language label and copy control.
  Use shared theme tokens for background, border, text, spacing, and focus rings.
  Long lines remain unwrapped inside the code scroller, with normal text selection.
- Wrap tables in a bounded horizontal scroller while retaining native table,
  header, and cell semantics. Remove the need to make the table itself a block.
  Do not render a second mobile copy, clip columns, or truncate cell contents.
- Give code/table scroll containers descriptive accessible names, keyboard access,
  and visible focus. Arrow-key horizontal scrolling must work without moving the
  page horizontally. Do not intercept ordinary text selection or vertical scrolling.
- Check explicit `min-width: 0` and `max-width: 100%` through the Markdown wrapper,
  block wrappers, and bubbles. Inline code, long URLs, and ordinary prose can wrap;
  they must not inherit the code block's no-wrap behavior.
- Test 320px and 390px viewports, light/dark themes, browser text enlargement,
  long language labels, and the keyboard-reduced visual viewport.
  Copy actions must not obscure content or the existing read-aloud control.
- Preserve measured composer occlusion, history-prepend anchoring, paused follow,
  jump-to-latest, and current-position reading while copy fallback expands.
  Do not force a user reading older content back to the newest message.

### Streaming announcements and accessibility

- Remove `aria-live` from the transcript container. Keep its content navigable in
  normal reading order. Do not replace it with `role="log"`, hide streaming text
  from assistive technology, or make the entire transcript `aria-busy`.
- Reuse the existing compact session status as the turn-level polite announcer.
  Make that small status atomic, not the transcript. Token deltas, tool progress,
  history loading, reconciliation, composer typing, and copy feedback must not
  make it reread answer text or the conversation.
- Announce observable working/ready/unavailable status changes only. Keep existing
  error alerts and connection feedback. Do not add "Answer completed" based on a
  stale streaming flag, Stop acknowledgement, error, or connection loss. Automatic
  full-answer reading is out of scope; users can navigate the answer or use Read aloud.
- Inactive/hidden chat must not produce background token announcements or leak
  answer/copy text when another account/profile/session is selected. Check the
  existing shell workspace visibility before adding any visibility machinery.
- Name ordinary assistant articles for nonvisual navigation without adding visible
  speaker captions. Code scroll areas and copy controls must have useful names in
  that context. Keep toolbar controls stable as copy status changes.
- Preserve collapsed activity and independent nested disclosure behavior. Do not
  announce hidden reasoning or turn copy actions into execution-log expansion.
- Manually verify streaming and copying with VoiceOver or another real screen
  reader. DOM assertions and browser accessibility snapshots cannot establish what
  a screen reader actually announces. Record unavailable checks as verification
  limits, not passes. Native WebView clipboard behavior needs separate device checks.

### Implementation sequence

1. Add focused tests for exact answer/code copy payloads, restricted clipboard
   behavior, pending guards, stale callbacks, and unchanged-message parse counts.
   Build the copy module and integrate it with assistant answer actions.
2. Add code-block controls through `MessageMarkdown`, then scoped code/table layout
   and accessibility. Test fenced/indented/inline code and incomplete streamed fences.
3. Remove transcript-wide announcements and verify the existing compact status,
   error feedback, article navigation, and inactive-workspace behavior. Do not add
   a new gateway reducer or completion state machine unless evidence requires it.
4. Add deterministic local Markdown fixture cases and
   `client/e2e/answer-usability.spec.ts`. Cover paced deltas, explicit finish/error,
   long code/tables, and account/session switches without live service credentials.
5. Run focused checks, then the broader affected regressions and both builds.
   Inspect phone screenshots and perform available clipboard/screen-reader/device
   checks. Update `CONTEXT.md`, the implementation record here, and `SECURITY.md`
   if the clipboard/manual-fallback privacy description needs updating.

### Verification matrix and completion criteria

| Area | Required checks |
| --- | --- |
| Answer copy | Exact Markdown string and whitespace; one message only; cached/offline availability; partial-stream snapshot; no reasoning, tools, or UI labels; empty/system/user entries excluded. |
| Code copy | Multiple fenced blocks and languages; indented code; inline code without toolbar; blank lines, indentation, Unicode, terminal newline; incomplete/open fences; escaped HTML-looking code copied literally. |
| Clipboard failure | Missing API; insecure/restricted context; rejected and delayed writes; duplicate clicks; success only after resolution; exact selectable fallback; keyboard selection; source changes and retry without stale success. |
| Context/privacy | Session/profile/account switch; logout/local clearing; hidden workspace; unmount/remount; history ID replacement; no old feedback/fallback in a new context; no storage or payload logging. |
| Markdown safety | Preserve GFM, `skipHtml`, escaping, secure external links, and default URL filtering. Test raw HTML, dangerous URL schemes, hostile language labels, tables, images, and streamed partial Markdown. No new HTML interpretation or link policy. |
| Layout | Long code/table scrolls internally at 320px/390px; document width does not exceed viewport; semantic tables; text enlargement; light/dark tokens; keyboard-focusable scrollers; no message/action/composer overlap. |
| Streaming accessibility | No transcript live region or per-token live text; compact working/ready/unavailable status; errors stay visible; initial/reconciled/prepended history is not announced as a new answer; manual screen-reader observation recorded separately. |
| Nearby behavior | Collapsed activity and disclosure state; read-aloud controls; composer typing and recovery; history prepend/follow/jump; group plain-text layout; no clipboard-triggered Markdown reparse. |

From `client/`, start with the copy-module, Markdown, and chat-screen unit tests,
then the new answer-usability browser tests in Chromium and WebKit. Verify at least
one actual clipboard write/read path on a supported secure browser after explicit
test permission. Use stubs to exercise denied/pending/stale cases, but do not report
mock-only tests as proof of real system clipboard behavior. Record browser/platform
clipboard limitations separately.

Before completion, run:
- `npm run test`
- `npm run typecheck`
- `npm run build:native`
- `npm run build`
- `npm run test:e2e -- e2e/answer-usability.spec.ts e2e/composer-feedback.spec.ts e2e/chat-drafts.spec.ts e2e/pwa-foundation.spec.ts e2e/reconnect.spec.ts e2e/local-privacy.spec.ts e2e/pwa-performance.spec.ts`
- `git diff --check`

Item 5 is complete only when copy payload/failure and rendering guarantees are
verified, affected browser flows pass, and unavailable manual checks are documented.
Do not infer physical-phone, native WebView, screen-reader, or production-gateway
results from local browser fixtures. The user subsequently authorized the full
implementation, local dev-container rebuild, and commit.

### Implementation and verification record

Implemented assistant answer copying, parsed fenced/indented code copying,
per-control clipboard feedback, and exact selectable manual fallback. Streaming
copies capture a snapshot; later deltas do not rewrite the clipboard. Context,
owner-generation, and privacy-reset keys retire pending local feedback and fallback
text. Copy remains available for cached/offline answers. Nothing new is persisted.

Code and semantic tables have bounded, labelled keyboard scrollers. A reproduced
WebKit failure showed native ArrowRight did not scroll a focused overflow region;
a direct-region horizontal-key handler now handles that case without intercepting
modified keys, child controls, or vertical scrolling. Markdown styling uses shared
theme tokens. Copy labels and feedback use foreground text for dark-theme contrast.
Safe Markdown, external links, default URL filtering, and memoization remain intact.

The regular transcript no longer has a live region. Its existing compact session
status is atomic and inactive-workspace announcements are disabled. Assistant
articles have accessible names. Tool/reasoning disclosures and group plain-text
rendering remain unchanged. No new dependency or shared UI package change.

Verification:
- Full unit suite: 1,365 tests across 103 files passed, with TypeScript checking.
- Native and browser production builds passed, including the final contrast change.
- Broad Chromium/WebKit run: 131 passed, 11 skipped across answer usability,
  composer feedback, draft recovery, PWA foundation/performance, reconnect, and
  local privacy. One new skip is real system-clipboard verification in WebKit,
  whose Playwright permissions do not expose the required read/write capability.
- Final answer/theme smoke after the contrast refinement: 11 browser checks passed,
  with the one documented WebKit real-clipboard skip. Dark/light screenshots were
  inspected again after waiting for theme transitions.
- Actual Chromium system clipboard checks copied/read both Markdown answer text
  and parsed code. Controlled browser writes cover denied, pending, stale-profile,
  partial-stream, and offline cases in both engines. They are not substitutes for
  real WebKit/native system-clipboard verification.
- Focused tests cover exact whitespace, hostile Markdown/URLs/language labels,
  no clipboard-triggered reparse, duplicate guards, manual selection, same-owner
  privacy resets, hidden workspace, and stale operation retirement.
- Inspected phone-sized manual-copy and 320px code/table screenshots. Explicit
  theme-token checks distinguish dark and light; OS-media emulation alone does
  not change an already-resolved app theme. Theme assertions wait for button color
  transitions rather than treating an intermediate animation color as a failure.
- A read-only review found no concrete high/medium issues in the scoped changes.
  `git diff --check` passed.
- Rebuilt the local mobile service with `compose.build.yaml`, `--no-deps` and
  health waiting. The app and `/healthz` on port 8081 return HTTP 200. The push
  relay and persistent volumes were not rebuilt or removed.

Manual screen-reader, installed-phone PWA/keyboard, and native WebView clipboard
checks remain unavailable. `xcrun simctl` is not available in this environment.
DOM/live-region assertions do not establish actual screen-reader announcements,
and a native production build is not a device test. No remote deployment or push.

## 6. Improve finding older conversations

Priority: Completed after items 1 through 5.
Status: Implemented following explicit user authorization for implementation,
local dev-container rebuild, and commit. No remote deployment or push authorized.

### Required outcome

Help users find and reopen an older conversation without pretending that the app
has searched history it has not loaded. Keep the current bot/profile navigation,
remote session ownership, offline history limits, and swipe behavior.

The complete supported scope is explicit title-search coverage, reliable manual
expansion while searching, date groups, available preview metadata, and an
accessible path to the existing archived-chats screen. Add an explicit
restore-then-open action rather than assuming archived sessions can be resumed.
Remote full-history search and archive pagination require a verified gateway
contract. They are not prerequisites for the honest loaded-list improvements.

### Evidence at planning time

- `client/src/components/sessions-menu.tsx` owns search, row rendering, focus,
  refresh-on-open, an IntersectionObserver for automatic expansion, and row/page
  swipes. Search trims and lowercases the query and matches loaded titles only.
  Rows show title and start date, not the provided preview or message count.
  The generic empty state currently conflates an empty list with no matches.
- `client/src/features/sessions/api.ts` calls `session.list` with `profile`,
  `include_hidden: true`, and `limit`. Keep `include_hidden`: desktop-created bot
  conversations can otherwise disappear. `humanSessions` removes automation and
  bot-plumbing rows while preserving unknown/custom sources.
- `client/src/state/session-selection.ts` starts at 30 rows. Expansion increases
  the cumulative limit by 30 and refetches/replaces the list, not an offset page.
  `$sessionsHasMore` is inferred from raw response length being at least the
  requested limit. The adapter consumes no cursor, total, or server `hasMore`.
  Scope guards reject old-profile responses, but same-scope overlapping refreshes
  have no list-publication generation guard.
- `client/src/lib/types.ts` declares `StoredSession` fields for ID, title,
  `started_at`, preview, source, and message count. Do not assume richer fields
  in `compat/hermes-types.ts` also arrive through this RPC. In particular,
  last activity, archived state, and lineage are not established here.
- Offline rows come from `transcriptCache.list(owner, profile)`. Saved excerpts
  are bounded and may include activity rows. Their entry count is not the total
  conversation message count; save time is not last remote activity.
- `client/src/features/settings/settings-api.ts` already requests
  `/api/sessions?archived=only&limit=100&order=recent` through the profile-bound
  gateway adapter. `ArchivedChatsSettings` in `settings-administration-screen.tsx`
  already displays preview/count, restore, and confirmed permanent deletion.
  It has no search, pagination, or open action. Restore invalidates its own query,
  not the live session list. This is an existing view to improve, not duplicate.
- `workspace-navigation.ts` owns typed menu dismiss intents, in-memory route
  stacks, and return-to-menu policy. `app.tsx` already wires a resume-and-land
  callback for cron sessions. Reuse these ownership rules for archive entry/open.
- The matching Python gateway handlers are not in this repository. Existing
  adapter tests establish outgoing requests, not real server support. A public
  upstream snapshot acquisition was blocked during planning. Remote search,
  server limits/order, archived pagination, and direct archived resume remain
  unverified, not proven unsupported. No authenticated history was fetched.

### Settled behavior

#### Search scope and pagination

- Label the field "Search loaded titles" with associated help text. Online help
  says it searches loaded conversations for this bot, not message contents or
  archived chats. Offline help says it searches titles saved on this device.
  Previews are displayed for recognition but are not searched in this batch.
- Match case-insensitively after trimming the query. Use the same displayed-title
  fallback for rendering and matching an untitled session. Do not add fuzzy search,
  tokenization, a search index, or a new dependency.
- Show matching count and loaded human-session count, not a fabricated remote
  total. Base paging availability on raw gateway rows before human filtering.
  A page full of excluded automation rows does not establish an empty history.
- Preserve automatic expansion for the unfiltered browse list. While a nonblank
  query is active, disable observer-driven expansion and offer an explicit
  "Load more sessions" button whenever the current paging model permits it.
  Keep the query and existing matches during loading. Do not drain all remote
  history merely because filtering brings the sentinel into view.
- After a manual expansion, search the expanded list with the same query. A page
  with no additional matches is not a search failure. Announce a compact result
  summary after settling; never make the row list a live region.
- Distinguish initial loading, no loaded conversations, no loaded-title matches,
  offline with no saved conversations, refresh failure, and expansion failure.
  For no matches with possible more rows, say "No matching loaded titles. Load
  more sessions to look further." Offline never offers remote expansion.
- Keep old rows on refresh/expansion failure and provide a manual retry. Avoid
  observer-triggered retry loops. Pending guards must prevent duplicate expansion
  requests. Reset the observer's retry eligibility only after explicit retry or
  a fresh menu opening, not every error render.
- Never say "all conversations searched" merely because fewer than the requested
  limit arrived. A gateway cap may be indistinguishable from exhaustion. If an
  expansion makes no progress, stop repeated automatic requests and retain honest
  loaded-count language. Do not invent a cursor or claim completeness.
- Preserve a query when closing/reopening the same workspace. Clear query,
  errors, revealed delete, confirmations, and request-local state on account,
  gateway, owner-generation, profile, or privacy-reset changes. Online/offline
  transitions alone retain the query but update its scope label and result set.

#### Date groups and previews

- Sort displayed human rows by known start time descending, with a deterministic
  ID tie-breaker. This is "started", not "last active". Do not reorder or filter
  the underlying `$sessions` store to implement presentation.
- Group as Today, Yesterday, Earlier this month, then localized month/year
  headings. Put future-dated rows in a separate Future dates group and invalid
  or missing timestamps under Date unavailable. Omit empty headings. Group after
  filtering so counts and headings describe visible results.
- Compare local calendar dates. Construct yesterday and the next local midnight
  from calendar parts, not by adding/subtracting 24 hours. Avoid UTC date-string
  buckets and fixed day-length assumptions across daylight-saving transitions.
- Recompute on menu open, return to a visible/focused app, and local midnight
  while open. Use one menu-level clock, not a timer per row. Keep group IDs
  independent of localized heading text. Formatting must not throw for malformed
  external dates, and unknown dates must not silently become today's date.
- Use semantic headings associated with each group. Each row retains a stable
  session identity, accessible title, active-session indication, and explicit
  start-date text where known. Do not make group headers selectable sessions.
  Provide a non-gesture, keyboard-accessible delete action alongside each row;
  the existing swipe reveal remains a shortcut to the same confirmation flow.
- Show the gateway's existing nonempty preview as plain text, capped visually to
  two lines, and a valid nonnegative message count. Omit unavailable metadata.
  Do not fetch transcript bodies for every row, parse previews as Markdown,
  autolink them, or include reasoning/tool content extracted by the client.
- Offline rows keep the existing saved-time and persistent/temporary labels.
  Omit remote preview/count if unavailable; do not present saved excerpt length
  as full history length or save time as conversation start time. Keep actual
  known start time separate from missing-date presentation.

#### Archive access and reopening

- Add an "Archived chats" action to the sessions menu using shared controls.
  Route to the existing settings administration page through a typed workspace
  dismiss intent. Do not add a second archive browser or change browser URLs.
  Back from a menu-entered archive page returns to the originating menu; entry
  through Settings retains its existing Settings back behavior.
- Extract the archive view into a dedicated module if needed to keep session
  list/query/actions together. Retain the Settings registry entry. Centralize
  archived listing vocabulary in the sessions adapter, with Settings delegating
  to it, rather than duplicating the same wire request in two feature adapters.
- Add explicit loaded-title search and bounded-result copy to the archive view.
  The known request asks for up to 100 rows. State that bound, especially when
  100 arrive; never describe that response as the entire archive. Add archive
  pagination only after validating actual route parameters and limits.
- Preserve plain-text previews, restore-only, and confirmed permanent deletion.
  Give icon-only destructive controls session-specific accessible names. Disable
  conflicting actions while a mutation is pending and keep focus/feedback local
  to the selected row. No new bulk actions or swipe-to-permanently-delete.
- Add a separately labelled "Restore and open" action using the existing restore
  request followed by the normal stored-session resume path. This explicitly
  changes archive state. Do not label it simply "Open" or assume direct resume
  of an archived ID works. Do not automatically open after restore-only.
- After restore succeeds, invalidate the archive query and refresh/invalidate
  the live session list in the captured scope. Opening must not depend on the
  restored row appearing in the first 30 live results. Resume by its exact ID.
  A list-refresh failure after a successful restore is a distinct warning, not
  a claim that restoration failed.
- If resume fails after restore, report "Restored, but could not open" and offer
  an open retry without repeating the mutation. A failed restore must not start
  resume. Do not navigate until resume has published the requested session.
  An undefined/superseded selection outcome is not successful opening.
- Scope guards and a local operation lifetime must prevent old callbacks from
  updating feedback or navigating after account/profile/privacy changes, leaving
  the page, or a newer selection. Issued remote mutations cannot be retracted.
  Reuse controller selection, ownership checks, and draft persistence; never
  write `$chat`, bookmarks, or navigation stores directly from the archive view.
- Offline archive access shows an explanation/back path and no remote actions.
  Do not expose cached ordinary conversations as an archive or persist a new
  archive index. Unsupported routes and auth failures get accurate errors, not
  an empty-state success message or silent fallback to another profile.

### Gateway capability gate

Before introducing any new remote discovery request, inspect the matching deployed
version's `tui_gateway/methods_session.py` and session HTTP handlers, or an
authoritative versioned contract. Record the version and evidence in this section.
Check search semantics, profile isolation, inclusion of hidden bot sessions,
archive filtering, order, paging, caps, response metadata, and resume behavior.

The default implementation uses only the already-established client operations
above. Do not probe guessed query parameters and treat HTTP 200 as proof that a
server honored them. Do not switch the live list to an HTTP route merely because
compatibility types mention offset/total. An upstream version alone does not prove
what the installed gateway supports.

If matching evidence establishes remote search or archive paging, document the
exact contract and amend the plan before adding it. Remote search would need
separate query/result state, cancellation, debouncing, scope guards, explicit
coverage, and real gateway verification. It must not overwrite the live session
roster or claim full-text matching if the server searches titles only. If evidence
is unavailable, ship the honest loaded-list scope and record those limits rather
than adding speculative transport behavior.

### Module ownership and edit map

- Add a small pure presentation module under `client/src/features/sessions/`,
  for example `session-discovery.ts`. A single list-building interface accepts
  supplied rows, query, and current date and returns visible groups and counts.
  Keep title fallback, ordering, and calendar grouping here. Tests cross this
  interface with fixed dates. No storage, requests, or global store writes.
- `sessions-menu.tsx` remains responsible for interaction, browse/search loading
  policy, focus, row swipes, scoped local state, and dismissal intents. Reuse
  `humanSessions` and the current controller instead of adding another list store.
- `session-selection.ts` retains remote list publication and cumulative paging.
  Add a latest-request/limit generation guard so a slower earlier 30-row refresh
  cannot replace a newer expanded list. Retire publication on reset. Preserve
  retry rollback, raw-row paging inference, source propagation, and scope guards.
  Keep the controller interface small; add restore coordination only if needed
  for the archive flow, not a general-purpose search framework.
- `features/sessions/api.ts` owns wire operations and any archived-list type.
  Validate newly consumed optional metadata at the external-data seam. Missing
  optional preview/count/date should not prevent a valid ID/title from opening.
  Never expand unrelated response normalization during this item.
- Archive UI, settings adapter/administration entry, `app.tsx`, and typed workspace
  navigation provide one archive view and the restore/resume/landing callback.
  Preserve the DOM-free navigation module and service-worker import guard.
- Keep styles scoped to Herm's session/archive views in `client/src/styles.css`,
  using existing controls, typography, theme tokens, and 44px action targets.
  No shared package changes or dependencies are expected. If shared UI changes
  prove necessary, verify integrated and standalone contexts separately.

### Implementation sequence

1. Record capability evidence and limits. Add pure title/date/group tests first,
   plus same-scope list-refresh ordering and expansion-failure regressions.
2. Implement the presentation module and narrow list-publication guard. Preserve
   the existing selection/new/branch/rename/archive/delete behavior and filters.
3. Update the menu with search coverage, grouped rows, previews, accurate empty
   states, bounded announcements, manual search expansion, and scope resets.
   Keep one scroll region and the existing new-session and bottom-navigation
   positions. Do not auto-focus search or unexpectedly summon the phone keyboard.
4. Improve the existing archive view and add the typed menu entry, return policy,
   mutation feedback, and explicit restore-and-open flow. Guard success navigation
   separately from a mutation acknowledgement and a stale selection result.
5. Extend the browser fixture with deterministic multi-page human/automation
   sessions, metadata, archive state, restore/delete/resume failures, delayed
   replies, and request recording. Respect actual cumulative-limit requests;
   fixture support must not be presented as gateway capability evidence.
6. Run focused and broader checks, exercise browser workflows, inspect phone-sized
   screenshots, and update `CONTEXT.md`, `SECURITY.md` if behavior warrants it,
   and this implementation record. Rebuild/commit only if separately authorized.

### Verification matrix

- Pure tests: title-only matching, trimming/case, fallback titles, hostile preview
  text, unavailable metadata, count correctness, stable tie ordering, invalid and
  future dates, month/year boundaries, local midnight, daylight-saving transitions,
  and multiple time zones. Verify returned dates are start dates, not recency.
- Menu tests: correct online/offline scope labels, distinct empty/error/loading
  states, automation-only pages, query persistence on close, reset on ownership/
  profile/privacy changes, no observer expansion during search, explicit expansion
  revealing an older match, failure/retry without losing matches, and no retry loop.
- List tests: 30 then 60 then 90 cumulative requests, exact-limit ambiguity,
  server-capped/no-progress results, expansion rollback, stale scope discard,
  overlapping same-scope refresh ordering, and list reset during a pending request.
- Archive tests: profile-bound request and declared limit, loaded-title search,
  bounded-result copy, missing/unsupported route versus true empty results,
  duplicate action guards, confirmed delete, restore-only without opening,
  restore-and-open success, restore failure, restore success plus refresh/resume
  failure, open retry, superseded selection, page unmount, and stale callbacks.
- Navigation tests: menu-to-archive/back reopens the original menu; Settings entry
  returns normally; successful open lands on the exact restored ID; failure keeps
  the archive page; no browser URL change. Preserve cron/model/capabilities routes,
  group boundaries, session branching, draft handoff, and update-recovery policy.
- Chromium and WebKit flows: find a match beyond the initial page, clear search,
  browse grouped rows, reopen an old session, browse/restore/open an archive row,
  recover from failures, switch accounts/profiles during requests, and reconnect.
  Assert request scope and lack of unintended transcript-per-row fetches.
- Accessibility and layout: semantic group headings, labelled search/help, compact
  result announcements, useful row/action names, visible focus, keyboard deletion
  access and confirmation, Escape/focus trapping and opener restoration. Preserve
  focus on search while results change. If a focused paging control disappears,
  restore focus predictably without stealing it from another control. Check group
  changes at midnight do not strand focus on a removed row.
- Exercise 320px and 390px layouts, keyboard-reduced height, long/unbroken titles
  and previews, light/dark themes after transitions, reduced motion, vertical scroll,
  left-edge dismissal, and row swipe reveal/conceal without page dismissal.
- Run relevant unit tests, typecheck, native/browser production builds, then broad
  session/navigation/draft/privacy/reconnect/PWA browser regressions. Review the
  final diff. Do not equate fixture tests with actual server contract verification.
  Record missing real-gateway, screen-reader, installed-phone, or native checks.

### Completion criteria and exclusions

Item 6 is complete when the supported behavior above is implemented, verified,
and documented with explicit search/archive limits. Unverified server-dependent
extensions must remain labelled unavailable, not silently counted as implemented.
No full-text local index, folder/tag system, transcript prefetch, new persistence,
server modification, new shared UI, group-chat redesign, or item 7 notification
work belongs in this batch. Herm remains a standalone app.

### Implementation and verification record

Implemented the supported scope above. The menu now searches displayed loaded
human-session titles, shows coverage/counts, groups known start dates, and renders
available plain-text previews and validated message counts. Search expansion is
explicit, retains the query, and does not automatically drain remote history.
Offline rows retain saved-history labels without inventing total message counts
or replacing unknown start dates with save time. Local discovery state retires on
owner/gateway/profile/authentication-generation/privacy changes.

List publication now rejects older overlapping requests, resets retire pending
publication, paging failures preserve rows and roll back their limit, and
no-progress expansion stops. Selection results are rechecked after history/list
follow-up; a superseding selection can retire completion even after an earlier
publication. The earlier publication is not rolled back. Menu dismissal requires
a current operation lifetime and outcome. Controller creation returns that guarded
outcome so UI callers do not equate a stale void completion with success.

The existing archive view is now a dedicated module used by both Settings and a
typed menu intent. It searches only returned titles and discloses the existing
100-row bound. Restore-only, confirmed permanent deletion, and explicit Restore
and open use the established profile-bound adapter. Resume targets the exact
restored ID independently of the first live page. Failed opening can retry without
restoring again. A completed remote mutation invalidates its captured current-scope
cache even after leaving the page, but cannot trigger stale navigation. Archive
queries revalidate on entry. Offline entry removes remote controls and explains
that archived chats are not saved locally, outside the inert gateway wrapper.

Keyboard deletion and swipe deletion share confirmation. The visible delete
control has a separate fixed 44px hit area; the 104px swipe rail needs only 60px
additional travel. An existing Chromium touch regression caught the initial hit
area overlap. The corrected layout keeps open/delete hit areas separate even with
enlarged text. An unrevealed rail cannot receive pointer actions or activate via
its handler. Escape from confirmation no longer also dismisses the menu.

Verification:
- Full unit suite: 1,413 tests across 105 files passed. TypeScript checking passed.
- Native and browser production builds passed, including fresh builds after the
  final action-size refinement.
- Broad Chromium/WebKit run: 149 passed and 11 existing documented skips across
  discovery, answer usability, composer feedback, drafts, PWA foundation/performance,
  reconnect, and local privacy. All 18 new discovery browser checks passed.
- Final smoke after fixing the 44px enlarged-text geometry: all 18 discovery checks
  passed again, plus the real Chromium row reveal/conceal touch check. Its WebKit
  counterpart remains skipped because that test uses Chromium CDP input.
- Calendar tests passed separately in America/New_York and Asia/Tokyo, including
  local midnight, daylight-saving, month/year, unknown-date, and future-date cases.
- Browser flows exercised older matches beyond the first page, scope labels,
  request limits/profiles, exact-ID opening, ordinary draft handoff, archive return
  navigation without URL changes, literal previews, restore-only, separate restore/
  resume failures, open retry, leaving a pending restore, offline archive entry,
  unsupported-route recovery, and expansion retry without an observer loop.
- Inspected 320px browsing, 390px archive, and enlarged-text dark-theme screenshots.
  Both theme token modes, reduced motion, bounded previews, separate action hit
  areas, keyboard deletion/confirmation, focus, and existing swipe behavior have
  automated browser coverage. No new dependency or shared UI package change.
- Read-only review found selection-completion and offline-presentation issues;
  regression tests were added and follow-up review confirmed those fixes with no
  remaining concrete high/medium findings in the inspected lifetimes.
- Rebuilt only local `mobile` with `compose.build.yaml`, `--no-deps`, and health
  waiting. App and `/healthz` on port 8081 return HTTP 200, and the served JavaScript
  contains the new loaded-title control. The relay remains healthy and untouched;
  persistent volumes were not removed. `git diff --check` passed.

The gateway capability gate remains unchanged. No matching deployed handler source
was available, so no remote-search parameters, total/cursor semantics, archive
pagination, or direct archived-resume behavior were invented. Browser fixtures
verify the client integration, not actual remote gateway behavior. Manual
screen-reader, physical installed-phone PWA/keyboard, and native WebView checks
remain unavailable. Native builds are not device tests. No remote deployment or
push. The pre-existing unrelated `untitled.md` remains untouched.

## 7. Make notification setup testable

Priority: Completed after items 1 through 6.
Status: Implemented following explicit user authorization for implementation,
local dev-container rebuild and commit. No remote deployment/publication or real
manual test-notification sends were performed. Physical-device acceptance remains
unverified as recorded below.

### Required outcome

Let a user determine whether this device is configured for Web Push and explicitly
send one nonsensitive test to this device. Separate observable setup facts from
unobservable OS delivery. Explain what to do when setup is unavailable, blocked,
missing, expired, disconnected, or only partially complete.

Use the existing same-origin PWA, relay, authentication, and navigation model.
Herm remains standalone. Do not add native APNs, a notification inbox, arbitrary
message composition, broadcasts, a new gateway job, or a new push provider.

### Current evidence

Repository inspection establishes the following client and local relay behavior;
it does not establish the capabilities of a deployed gateway or installed device.

- `client/src/features/settings/settings-screen.tsx` owns an inline notifications
  screen with one enable/disable control. Native iOS displays an APNs limitation.
  The screen refreshes on gateway readiness/network changes, not on permission
  changes when returning from OS settings.
- `client/src/pwa/push.ts` uses secure-context/API detection, browser permission,
  `serviceWorker.ready`, local `getSubscription()`, and relay public-key reachability.
  Its `enabled` flag is not proof of server registration. Public-key success is
  not proof of authenticated access, bridge readiness, or delivery.
- Client operations patch a global store without captured owner/scope or operation
  generations. `serviceWorker.ready` has no deadline. Existing enable rollback
  removes a newly created local subscription if registration fails; disable removes
  remote registration before local unsubscribe. These partial outcomes need explicit
  representation rather than another overloaded enabled/disabled flag.
- `web-push-relay/src/app.js` exposes health, public key, and subscription PUT/DELETE.
  There is no registration-status or test-send route. `notifyAll` broadcasts to all
  stored subscriptions, removes expired 404/410 endpoints, and reports aggregate
  provider outcomes. It must not implement a browser's device-only test.
- `web-push-relay/src/state.js` stores subscriptions globally by endpoint, without
  account or profile ownership. `deploy/nginx.conf` authenticates subscription
  mutations through protected `/api/config`, but that boolean auth check does not
  bind a subscription to a principal. Relay handlers themselves do not authenticate.
- `web-push-relay/src/server.js` supplies separate operator credentials to the
  completion bridge. The bridge currently connects to the default profile, and its
  normal completion notifications can contain response previews and session links.
  Neither global fanout nor profile metadata proves subscriber account ownership.
- `client/src/pwa/sw.ts` displays pushes and, on a click, both messages an existing
  window and attempts to open another. `push-payload.ts` restricts URLs to the same
  origin, but same-origin alone is not an account check. The deep-link coordinator
  currently navigates after resume without validating its guarded selection result,
  and also opens the chat surface on errors. Notification entry needs stronger
  target, lifetime, and outcome checks.
- Existing coverage includes three push-client tests, payload URL validation,
  relay validation/state/send failures, bridge replay, and ordinary deep links.
  It does not prove test delivery, registration ownership, or notification-click
  behavior across account changes.

Platform reference: WebKit's "Web Push for Web Apps on iOS and iPadOS"
(https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
documents iOS/iPadOS 16.4 Home Screen support and a permission request made directly
from user interaction. Use capability detection for functionality; platform hints
only select instructions. Do not require installation on browsers that support
Web Push without it.

### Capability and ownership gate

Resolve this before exposing test sends or claiming registered-for-this-account.
This is required security work, not an optional diagnostics improvement.

1. Establish a server-verified principal for browser registration/status/test/delete
   using credentials forwarded only to the fixed configured Hermes gateway. The
   client already consumes `/api/auth/me` and validates organization/user/provider
   identity in `draft-owner.ts`; verify equivalent server-side response semantics
   for supported deployments. Never trust a browser-supplied owner, display name,
   profile, endpoint, or opaque registration ID as proof of account ownership.
2. Make the relay itself enforce that identity, or use an equivalently authenticated
   internal handoff that cannot be forged by browser headers or direct relay access.
   Preserve the proxy's fixed upstream, credential restrictions, no-store responses,
   and protected mutation policy. Do not treat `/healthz` or `/api/status` as auth.
3. Store server-owned subscription bindings against the verified gateway/account.
   Device registration is account/device scoped; switching bots must not silently
   subscribe/unsubscribe the same device or claim all-profile completion coverage.
4. Require the same verified identity for status, replacement, deletion, and test.
   Resolve only a stored current-device binding. Other-account lookup must not
   disclose existence, keys, endpoint, or provider diagnostics.
5. Version relay state and migrate legacy ownerless subscriptions to an explicitly
   unverified/inactive state. Preserve VAPID keys and unrelated state. Do not silently
   attach all legacy endpoints to the next user or continue unsafe global fanout.
   Explain when re-enabling is required. Test migration, restart, and atomic writes.
6. Bind completion fanout to the bridge's verified owner, and to any established
   profile policy. Do not route a bridge account's completions to other accounts.
   If owner provenance is unavailable, fail closed for affected delivery instead of
   inferring a single-user deployment. Do not invent gateway endpoints or identity
   semantics to make this gate pass. Record unsupported identity modes explicitly.

If the deployed gateway cannot provide verifiable identity, show that limitation
and disable account-bound registration/test features there. A working local relay
fixture is not proof that this deployment gate passed. Supporting anonymous/shared
identity modes would require a separately reviewed ownership contract.

### Device diagnostics and state model

Extract `NotificationsSettings` into an app-owned settings module. Keep platform,
subscription, relay, and operation policy in the push module rather than JSX.
Use existing shared controls/tokens; no new shared package or dependency is planned.

Represent independent facts with explicit checking/unknown/error states:
- Browser capability and secure context; native shell versus browser/PWA.
- Installation context where observable, without treating ordinary desktop browser
  use as unsupported or presenting a native shell as a browser installation.
- Permission: not requested, granted, or blocked. A dismissed prompt is not a
  permanently denied permission.
- Service-worker availability and local subscription: absent, present, expired,
  incompatible key, checking, or inspection failed.
- Current-account relay registration: confirmed, missing, identity unavailable,
  unsupported relay version, checking, or could not verify.
- Latest explicit operation: registering, disabling, sending, accepted, rejected,
  expired, or outcome unknown. Test acceptance is not an enabled/delivered flag.

Do not erase a known local subscription merely because relay lookup fails. Do not
show registered when only local subscription or public key exists. Label status
as observed, not a guarantee about the OS, Focus settings, battery policy, or future
background delivery. A direct relay test does not verify the automatic completion
bridge or delivery from every bot/profile. Do not claim bridge health from HTTP
health/public-key success; show unknown unless actual bridge state is exposed.

Actions:
- Refresh status explicitly and on visible return/focus/reconnect, with deduplicated
  requests. Passive checks never prompt for permission, subscribe, or send a test.
- Enable from a direct user gesture. Request permission before unrelated awaits
  that could consume activation; then validate key, obtain a bounded worker-ready
  result, subscribe/register, and reconcile the actual resulting state.
- Offer repair/re-register when a local subscription exists but the current-account
  registration is missing. Handle VAPID rotation/expiry without claiming repair
  succeeded until both local and remote facts agree. Do not silently take ownership
  from another account or bulk-remove that account's other devices.
- Disable with truthful partial-failure feedback. Distinguish removal at the relay
  from local unsubscribe failure, and local state from remote cleanup failure.
  Permission remains granted after unsubscribe; say so. Provide retry for the
  unfinished step without accidentally re-enabling or deleting a newer binding.
- Show Send test notification only when the current device has a usable local
  subscription and a confirmed current-owner registration. Block duplicates and
  provide bounded pending feedback, Retry where safe, and an explicit cooldown.

All operations capture authenticated owner/gateway generation and credentials at
start. Retire stale publication after logout, account/gateway changes, privacy
retirement, disposal, or a newer operation. Separate page feedback lifetime from
subscription lifetime. A page closing cannot recall an issued server mutation.
Never perform stale rollback or cleanup against a replacement subscription or a
new owner's binding. Do not queue a test to run automatically after reconnect.
Bound network and worker readiness waits; a timeout after dispatch means outcome
unknown, not definitely unsent. Reconcile status before retrying destructive steps.

### Targeted relay contract and test flow

These are proposed local additions, not claims about existing gateway routes.
Keep the current registration transport where compatible and add versioned,
non-cacheable authenticated operations under the same `/push/v1/` proxy prefix.

- A read-only registration lookup, preferably POST to avoid placing subscription
  endpoints in URLs/logs, resolves the browser's local endpoint to an owner-bound
  opaque binding. Return only minimal capability/registration state. No global
  subscription list, raw key material, or raw endpoint in feedback.
- A POST test operation accepts only that binding and a bounded idempotency key.
  The relay rechecks ownership and current registration and selects exactly one
  stored recipient. It does not accept arbitrary endpoint URLs, notification text,
  session IDs, profiles, or navigation destinations from the caller.
- Use fixed text such as "Hermes notification test" / "This device received a test
  notification." The click destination is the safe app root. Include no transcript,
  title, account name, profile, token, endpoint, or other conversation information.
- Send through the existing Web Push adapter, with bounded request/provider waits.
  Report accepted-by-provider, expired-registration, throttled, or failed/unknown
  outcomes separately. Do not return "delivered" from a successful provider request.
  Reuse the same request key for an uncertain retry; bound retention and document
  that idempotency cannot guarantee exactly-once delivery across every crash.
- Enforce server-side per-owner/device rate limits and a bounded concurrency limit,
  not just a disabled button. Handle 429 with a safe retry delay. On provider 404/410,
  retire only the matching binding/version and ask the user to enable again.
- Keep provider errors/credentials/endpoints out of client responses and logs. Return
  stable, redacted error categories, not the existing truncated raw provider body.
- Validate registered endpoints at the shared registration boundary before they can
  become send targets. HTTPS alone is insufficient. Restrict to approved push-provider
  destinations, reject local/private/literal-address targets, and ensure redirect/DNS
  behavior cannot bypass that policy. Do not add a general-purpose outbound sender.
- Preserve no-store, body-size limits, strict input validation, same-origin/CSRF
  protections, fixed upstream routing, and authentication in both proxy and relay
  tests. An unsupported older relay must produce actionable upgrade guidance,
  not a generic empty state or a falsely working test control.

After acceptance, show "Test accepted by the push service. Check this device's
notifications; delivery is not confirmed." Explain checking Focus/Do Not Disturb,
OS notification settings, connectivity, and trying while the app is backgrounded.
Do not fabricate receipt telemetry or a delivery acknowledgement protocol. A user
can report seeing the test, but that is not an automatic delivery measurement.

### Platform guidance and notification entry

- On iPhone/iPad outside the Home Screen app, explain Add to Home Screen and opening
  the installed app before enabling. Use available installation/capability signals,
  account for iPad desktop-style user agents, and avoid brittle OS-version parsing.
- For supported desktop/Android browsers, provide the available browser install
  action or browser-menu instructions without falsely making installation mandatory.
- For denied permission, explain changing this app/site's browser or OS notification
  setting and then returning to Refresh status. Do not repeatedly call the prompt.
- For insecure context or missing APIs, explain the actual HTTPS/browser limitation.
  For native iOS retain the explicit APNs limitation; no Web Push/native entitlement
  changes, fake enable button, or new native push dependency.
- For offline/reconnecting/auth-expired states, keep Back and explanations usable.
  Show local facts where available, remote registration as unverified, and remote
  actions disabled with a reason. Do not put the entire screen under an inert
  gateway wrapper or leave a disabled query announcing Loading forever.
- Test notifications open the app root through normal authentication. Existing
  conversation notifications may open a session only after matching authenticated
  gateway/account provenance and an authorized exact-ID/profile resume. Missing or
  stale provenance must fall back to safe app entry, not another account's session
  with the same ID. No credentials in notification URLs or payloads.
- Harden the service-worker/app click handoff so one tap does not both navigate an
  existing window and open a duplicate. Prefer a verified same-app window and one
  focus/navigation path; use a cold window only when needed. Validate worker message
  origin/source and target schema. Existing HTML-shell fallback is not authorization.
- Retire queued notification intents on account/logout changes. Validate guarded
  selection outcomes before navigation, including supersession after publication,
  missing/unauthorized sessions, profile-switch races, and transport errors. Preserve
  drafts and never navigate merely because a resume Promise resolved or rejected.

### Implementation sequence and edit map

1. Lock down verified owner/identity semantics and supported deployment modes.
   Specify relay request/result schemas and safe migration before UI implementation.
2. Extend `web-push-relay/src/state.js`, validation, handler, authenticator/server,
   and completion bridge for owner-bound registration/fanout, status, targeted test,
   redacted outcomes, throttling, and migration. Add `deploy/nginx.conf` routes and
   proxy/auth coverage. Preserve current VAPID keys and data volumes.
3. Refactor `client/src/pwa/push.ts` into the owner-scoped diagnostics/operation
   module described above. Add pure presentation helpers only where they remove
   proven duplication or improve testing. Keep credentials and endpoints private.
4. Extract a notification settings module under `client/src/features/settings/`,
   wire it through `settings-screen.tsx`, and add platform guidance, status rows,
   explicit repair/disable/refresh/test actions and accessible result feedback.
5. Update `sw.ts`, `push-payload.ts`, browser message forwarding, and deep-link
   coordination for validated notification entry, single-window handling and guarded
   navigation. Preserve ordinary deep-link behavior with regression tests.
6. Add relay, client, UI, service-worker and browser integration coverage. Extend
   `client/e2e/server.mjs` with scoped controllable fixtures rather than real sends.
7. Update `CONTEXT.md`, `SECURITY.md`, and deployment guidance with actual capabilities,
   identity prerequisites, migration/re-enable effects, delivery limits and verification
   results. Rebuild/commit/deploy only if separately requested.

### Verification matrix

Start narrow, then test the changed integration boundaries and nearby regressions.

- Client unit tests: independent status combinations, absent/expired/mismatched local
  subscription, denied/dismissed permission, unsupported/insecure/native context,
  missing worker and readiness timeout, malformed/old relay responses, auth/offline
  failures, key rotation, repair, enable rollback, partial disable/unsubscribe failure,
  deduplicated refresh, stale callbacks and account/gateway/privacy retirement.
- Relay tests: valid/invalid identity and auth expiry; forged owner/internal headers;
  cross-account lookup/send/delete and duplicate endpoint ownership; exactly one
  recipient; expired-binding cleanup with concurrent replacement; fixed nonsensitive
  payload/root target; invalid body; provider failures/timeouts; redacted responses;
  destination restrictions; cooldown/concurrency/idempotency; state migration/restart.
  Verify completion fanout never reaches another owner's or legacy unverified device.
- Proxy integration: real nginx configuration with stub gateway/relay upstreams,
  not only fixture HTTP routes. Verify method restrictions, cookie/token forwarding,
  auth rejection, identity provenance, no-store, CSRF/origin handling, body limits,
  and that missing new relay routes do not become successful HTML-shell responses.
- Settings tests: actionable support/install/permission states, local versus remote
  registration, unknown versus false, explicit gesture-only permission/test, separate
  accepted/expired/failed/unknown results, duplicate prevention, retry and cooldown,
  usable Back offline, focus retention and bounded live announcements.
- Worker/navigation tests: nonsensitive test notification/root click, malformed and
  cross-origin payloads, valid owner/profile exact-ID resume, wrong-account or stale
  intents, locked/signed-out startup, failed or superseded selection, message source
  validation, existing-window focus versus cold open, duplicate-tap behavior and
  draft preservation. No navigation on an undefined/stale resume outcome.
- Playwright Chromium/WebKit: phone widths, light/dark and enlarged text, keyboard
  access, reduced motion, status refresh after simulated permission changes,
  enable/repair/disable/test happy and error paths, offline/reconnect, auth/account
  switching and delayed completions. Test real service-worker handlers where the
  engine supports them; label injected API/push events as fixtures, not real delivery.
- Run client full unit suite, typecheck, browser and native production builds, relay
  tests, and relevant existing PWA/privacy/reconnect/draft/deep-link browser checks.
  Inspect phone screenshots and exercise primary and failure flows in a browser.
- Physical-device acceptance: on supported installed iOS/iPadOS and Android/PWA
  devices, enable from a gesture, receive an actual test while backgrounded and while
  the app is not open, tap it through normal authentication, recheck permission after
  OS changes, and verify expiry/re-registration, account switching and Focus guidance.
  Exercise real conversation notifications separately for authorized profile/ID
  routing. Record OS/browser/deployment and observed outcomes without secrets.

### Completion criteria and verification limits

The implementation is complete only when setup facts are distinguishable, a user
can explicitly test only the current owned device with nonsensitive content, normal
notifications cannot cross account ownership, partial failures have safe recovery,
and click navigation uses current authenticated/selection state. No automatic test
send, broad broadcast fallback, fabricated delivery confirmation, or new gateway
contract is acceptable.

Automated checks can establish client/relay/proxy behavior, not actual installed-PWA
background delivery or OS presentation. If trusted gateway identity or physical-device
verification is unavailable, record exactly what is blocked/unverified and do not
claim end-to-end delivery is verified. Do not silently weaken ownership to make a
button work. Manual screen-reader and native-device limitations remain explicit.
Preserve the pre-existing unrelated `untitled.md` and all unrelated user changes.

### Implementation and verification record

Implemented account-bound relay registration, authenticated status and one-device
test routes, owner-isolated completion delivery and state-v2 legacy quarantine.
VAPID keys and completion state are preserved. Browser and bridge identity use the
fixed gateway's `/api/auth/me`; unsupported identity modes fail closed. Default
profile provenance is explicit in notification links. Vendor destinations are
allowlisted; tests reject arbitrary/private targets and forged owner headers.

Extracted notification Settings from the general screen. Permission, local
subscription, current-account registration and test outcome are separate facts.
Refresh is passive; enable prompts only on a gesture. Repair, partial disable,
expired-subscription recovery, offline/unsupported/blocked instructions and explicit
provider-acceptance feedback are covered. Service-worker/network waits are bounded.
Captured owner/privacy generations retire stale publication and cleanup. Device
subscriptions are not bot-specific and OS permission is not reset by Disable.

Tests use fixed content/root targets, one stored binding, per-account cooldown,
bounded send concurrency and ten-minute in-memory idempotency. A completed unknown
provider result permits a new explicit test after cooldown; unresolved HTTP retries
retain their request ID. No test notification was sent through a real provider.
Normal completion messages retain existing response previews, unlike test content.
Logout retires client work but does not recall OS notifications or automatically
revoke a previously enabled subscription. This limitation is explicit in deployment
and security guidance.

Notification clicks choose one controlled app window or one cold window, rather
than messaging and opening simultaneously. The app verifies relay-owner provenance
before profile/exact-ID resume and requires a current guarded outcome. Worker
messages must originate from the controlling same-origin worker. Legacy unowned
notification targets fall back to root. Ordinary deep links retain their parsing,
but failed/superseded resume no longer navigates to unrelated loaded chat.

Verification:
- 1,428 client unit tests across 106 files passed; TypeScript checking passed.
- Native and browser production builds passed. Native build is not a device test.
- Broad Chromium/WebKit verification: 107 passed, 9 existing documented skips
  across notifications, PWA foundation, reconnect, local privacy and drafts.
- Final notification-only run: all 10 checks passed in Chromium/WebKit, including
  setup/registration distinction, authenticated request targeting, relay failure,
  accepted-not-delivered feedback, disable, blocked permission, unsupported APIs,
  offline usable Back, and expired subscription disable/re-enable recovery.
- Inspected 320px light and enlarged-text dark notification screenshots; horizontal
  page bounds checked in both theme states. OS permission/subscription APIs in these
  browser checks are injected fixtures, not proof of real push transport/receipt.
- 25 relay tests passed covering owner isolation, targeted sends, provider errors,
  expiry, throttling/retry, empty binding rejection, identity, destination restrictions,
  VAPID preservation, legacy migration and existing completion replay.
- Real nginx integration with local stub upstreams passed authentication rejection,
  exact status/test routing, method restrictions, cookie/token forwarding,
  Authorization stripping, no-store and body-size checks. Run with
  `cd web-push-relay && npm run test:proxy`; no external push service is used.
- Rebuilt local `mobile` and `web-push-relay` using `compose.build.yaml` with
  health waiting and persistent volumes intact. Both containers are healthy. `/`
  and `/healthz` on port 8081 return HTTP 200; unauthenticated push status returns
  HTTP 401. Served lazy Settings JavaScript contains the test UI and public-key
  metadata advertises relay version 2. No remote deployment or push.
- Read-only reviews found and verified fixes for default-profile targeting, replaced
  binding deletion, empty binding wildcard and unknown-result retry. Follow-up expiry
  guidance/recovery was fixed and browser-tested.

The deployed gateway identity contract and real installed-PWA delivery while
backgrounded/closed are not verified. Physical screen-reader, device OS permission,
Focus, native APNs and real conversation-notification tap acceptance are unavailable.
Do not claim automatic bridge readiness or end-to-end delivery from these tests.
Unsupported identity deployments must update/provide the verified identity contract,
not bypass ownership. No dependency or shared UI package change. The unrelated
`untitled.md` was not modified by any task command; it disappeared externally during
implementation and was not recreated or staged.

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
