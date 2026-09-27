# Implementation plan: scope Group member sessions to their Gateway

**Status:** design settled for implementation planning. No production code changes have been made.

## Goal

Prevent the Group send engine from resuming a stored plumbing-session ID under a different `connectionKey` than the one that created it. Today `connectionKey` is the configured `remoteURL`; the app Profile is separate and Group member RPCs use `member.name`. A change of authenticated identity at the same URL is outside this guarantee and remains an explicit limitation below. Keep the Group room available across connection-key changes. Preserve the existing `Group: <roomId or name>` title lookup as recovery when the current connection has no usable stored ID.

The change deepens the existing Group member turn module. It does not isolate Group rooms, redesign the mirror, or add a new network port.

## Current behavior

- `group-store.ts` persists each room under the single `hermes.group-chats.v3` localStorage key. `sessions` and `stranded` have no Gateway provenance.
- `CurrentGatewayScope.connectionKey` is exactly `remoteURL`, with `profile` as a separate field. URL changes, logout, Profile switches, and dispose stop the Group engine. An ordinary socket reconnect does not replace the Group engine. A same-URL credential or authenticated-identity change is not represented by the current key.
- `group-turns.ts` acquisition currently tries a stored ID, then the room title, then creation after `4007`. Other acquisition errors fail that turn without creating. This is not true of every resume call: a baseline-resume failure is treated as a lazy session, poll failures retry, and harvest failures leave the stranded marker. Harvest uses the title only when no stored ID is available; if resuming an available ID fails, including with `4007`, harvest leaves the marker and does not retry by title.
- `group-rounds.ts` reads `room.sessions` itself to interrupt the current speaker. That puts session-identity policy outside the Group member turn module.
- Group member RPCs override `profile` with `member.name` in `createGroupMemberGateway`. The app's selected Profile is not the Profile used for a member's turn.
- The mirror's `GroupChatSyncRoom` projects room identity, members, image, log, and revision, not `sessions`, `sessionConnectionKey`, or stranded markers. Mirror merges spread existing local coordination fields forward.
- `group-engine.test.ts` proves that an old in-flight turn cannot continue through a replacement transport. It does not prove that the new transport avoids a stored session ID from the previous connection.

Evidence: `client/src/features/groups/group-store.ts:176-184, 274-352`; `group-engine.ts:53-95`; `group-turns.ts:42-47, 507-563, 619-662, 898-904, 978-1031`; `group-rounds.ts:390-417`; `groups-sync.ts:27-40, 432-571`; `gateway-scope.ts:13-22`; `scope-guard.ts:9-30, 115`; `gateway-controller.ts:93-112, 161-189, 279-337, 350-375`; `group-engine.test.ts:266-312`.

## Decisions and recommended answers

| Decision | Recommended answer | Reason |
| --- | --- | --- |
| What identifies a stored member session? | The captured `connectionKey` plus the existing `groupMemberKey`. | In the current Scope model, `connectionKey` is the configured `remoteURL`; the member key distinguishes members in the room. Member RPCs use `member.name` as the Profile. Do not use the app's selected Profile or the member's `connectionId` as a substitute for the Gateway connection. |
| Should all Gateways keep separate session-ID maps? | No. Keep one active-connection map per room and tag it with `sessionConnectionKey`. Clear it when the captured key changes. | This is the smallest policy that prevents cross-connection ID reuse. The existing title lookup may recover a session on the current Gateway if it remains accessible. Avoid a new cache and another storage dimension. |
| What happens to the shared Group room on a connection change? | Keep the room log, members, image, room key, watermarks, and holds. | The room projection and watermark cursors remain shared. Resetting them would replay retained history into recovered sessions on switch-back; retaining them means a fresh session on B starts at the cursor last advanced on A. This plan does not add per-connection history state or change mirror behavior. |
| What session-adjacent state changes scope? | Clear mismatched or untagged `sessions` and `stranded` state together. Remove pending prompt cards whose `connectionKey` is not current, and reject a stale prompt if a caller still holds it. | A stranded marker authorizes harvesting a reply from a session. A prompt contains a request ID and may contain a runtime session ID. Neither may be applied to another Gateway. |
| What about reconnects and app-profile switches? | Keep session state when `connectionKey` is unchanged. | Group member calls select `member.name`, so changing the app's selected Profile does not change the Profile for those calls. A reconnect to the same connection must keep working. |
| How do old local sessions migrate? | Discard v1-v3 session IDs and stranded markers because they have no recorded Gateway owner. Keep the rest of the room. | Assigning an old ID to the current Gateway would preserve the ambiguity this change removes. The title fallback can recover a matching hidden session; otherwise the engine creates one. |
| Where does the policy live? | In the existing Group member turn module, behind its current internal seam. Capture `connectionKey` with the existing member-gateway adapter. | Production already supplies the Gateway transport and tests already use in-memory transports. No second external seam is needed. The round driver should request an interrupt by room and member; it should not choose the stored ID. |

## Intended behavior

1. `GatewayController` passes the `connectionKey` from the captured `CurrentGatewayScope` when it installs the Group engine. The Group lifecycle captures that key with its transport.
2. After stopping any old lifecycle and before constructing the new modules or starting the mirror pull, the Group engine clears a room's session IDs and stranded markers when `sessionConnectionKey` is missing or differs from the active `connectionKey`. It preserves room content, watermarks, and holds. This cleanup is local and must not schedule a mirror write.
3. A room's `sessionConnectionKey` describes the whole `sessions` and `stranded` maps. All member session IDs in a room map therefore belong to one Gateway connection. `ensureGroupChatSession` sets the tag after successful acquisition of a runtime session, even if the Gateway did not return a stored session ID.
4. Session acquisition uses a stored ID only when the room tag matches the captured connection key. Otherwise it resumes by `Group: <roomId or name>`, then creates only on the existing `4007` path. Non-`4007` acquisition failures and the baseline, poll, and recovery paths keep their current behavior.
5. Harvest uses a stored ID only under the matching tag and uses the title when no usable ID exists. A failed resume of a present ID, including `4007`, leaves the stranded marker and does not retry by title. Stop-time interrupt asks the Group member turn module to resolve the handle for the active connection. A mismatched or absent handle causes no remote interrupt; local stop, epoch, and hold behavior still applies.
6. A `GroupPrompt` records the connection key that produced it. On engine start, remove cards for other or unknown keys. `answer` checks the entry's key before making a request, so a stale event cannot send an approval or clarify response to the newly active Gateway.
7. Switching A → B clears A's active session map and session-bound markers before B's engine is installed. B then resolves by title or creates a B session. Switching back to A follows the same rule and tries A's title lookup; if A still has the hidden session, it can resume. The implementation does not promise to cache IDs for inactive Gateways.
8. An ordinary socket reconnect keeps the existing Group engine and its in-memory state. An app Profile switch tears down and restarts the engine with the same connection key, so valid session IDs, stranded markers, and prompt cards survive. The existing room epoch invalidation still stops in-flight work on engine teardown.

Title lookup is intentional recovery, not proof that two Gateways share session IDs. Only an ID tagged for the current `connectionKey` may be sent as a stored ID.

## Trade-offs

- The active-connection map is replaced when the user switches connection keys. If they switch back, the title lookup may recover the prior hidden session, but the plan does not retain its stored ID.
- Watermarks remain room-wide log cursors, not per-connection cursors. A fresh member session created on B receives only entries after the cursor last advanced on A, not the earlier room log. Resetting watermarks would replay retained history into recovered sessions on switch-back. This plan preserves the current shared-watermark behavior and does not add per-connection cursors.
- Clearing a stranded marker on a connection change can leave a late reply from the inactive Gateway out of the local room log. Clearing its prompt card also means the card is not preserved for a later switch back. This plan favors not applying session work to the wrong Gateway over preserving pending work from an inactive one. Keeping those pending items would require a per-connection cache and a separate product decision.
- Title lookup may find a hidden Group session on the newly active Gateway. That is intended recovery on that Gateway; the isolation guarantee applies to stored session IDs, not to title-based discovery.
- A same-URL authentication identity change is not distinguishable through the current `connectionKey`. This plan follows the repository's existing Scope model and does not store credentials or invent an auth identity key.

## Implementation steps

### 1. Capture the Gateway connection key

- Change the Group engine lifecycle entry in `client/src/features/groups/group-engine.ts` to the required signature `startGroupEngine(transport, connectionKey)`.
- Pass the captured `scope.connectionKey` from `connect()` through `installGroupEngine(scope)`. Pass only `scope.connectionKey`, not `scope.profile`; the current key is the exact `remoteURL` from the captured Scope.
- Give `GroupMemberGateway` the captured connection key in `group-turns.ts`. Keep its request behavior unchanged: it adds `profile: member.name` to each member request.
- `group-engine.test.ts` has 18 direct `startGroupEngine` calls and no shared start helper. Pass an explicit test key at every call, using distinct keys in connection-switch tests. Update the four `createGroupMemberGateway` call sites and the hand-built `GroupMemberGateway` test fixture in `group-turns.test.ts` to provide a key. Do not add a production fallback key.

### 2. Record session provenance in the local room store

- Add optional `sessionConnectionKey` to `GroupChatRoom` in `group-store.ts`. It tags that room's `sessions` and `stranded` maps together, including when a runtime session has no stored ID yet.
- Add a store operation that clears `sessions`, `stranded`, and the tag when the tag is absent or differs exactly from the requested key. Preserve every other room field. If nothing changes, do not set the atom or write localStorage. If anything changes, replace and persist the store once without calling `updateGroupChat` or scheduling mirror sync.
- Add only a narrow provenance sanitizer, not a general localStorage schema framework. Apply it on v4 rehydration and durable serialization without changing validation of other room fields. A usable tag is a non-empty string. `sessions`, when present, must be a non-array record whose non-empty member keys map to non-empty string IDs. `stranded`, when present, must be a non-array record whose entries are either finite non-negative numeric cursors (including `0`) or records with a finite non-negative `before` and non-empty string `thread`. Preserve valid opaque IDs as written. If the tag or either map is malformed, drop `sessionConnectionKey`, `sessions`, and `stranded` together while retaining the room's other valid fields.
- In `durableGroupChatRooms`, persist the tag even when no stored ID is available, and persist session-bound maps only with a valid tag and valid map shapes. A record with no usable tag must not retain session IDs or stranded markers.
- Keep `rekeyRoomCoordination`'s member-key rekey behavior for retained active maps. The room-level connection tag does not change when a member's `connectionId` enriches its key.
- Preserve the local-only rule. `GroupChatSyncRoom` and `groupChatSyncSnapshot()` must not gain session IDs, `sessionConnectionKey`, or stranded markers. Mirror merges must continue to retain only the existing local fields.

### 3. Migrate local persistence to v4

- Make `hermes.group-chats.v4` the current storage key. Read v4 first; only when `getItem(v4) === null`, try v3, then v2, then v1. An empty string, unreadable JSON, or invalid root value (including `null` or an array) is present but malformed: load no rooms and do not fall back to an older key. This avoids truthiness-based fallback and resurrection of stale room data.
- Reuse the existing version-specific room parsing and rekey behavior. Add validation only for the new session provenance and its nested maps; malformed session-bound fields are dropped without discarding otherwise usable room content.
- V1, v2, and v3 predate the provenance contract. Discard every session ID, stranded marker, and `sessionConnectionKey` from those sources, even if a legacy record contains an unexpected tag. For v3, retain its durable room-key shape and member-key coordination. For v2, retain the existing room-map rekey and keep holds, watermarks, and room content. For v1, retain the existing shape guards, member-coordination rekey, and durable room-key rekey.
- Match the current rollback policy: leave v1-v3 storage untouched and write v4 on the next normal persistence event. Do not eagerly delete old keys. Test that a migration does not write v4 at load, that a normal subsequent persistence writes v4, and that the legacy source remains unchanged.
- Update storage comments and tests to describe `v1/v2/v3 → v4` and why old session IDs cannot migrate.

### 4. Keep session policy inside Group member turn

- Add one private stored-ID lookup rule in `group-turns.ts`. It returns `room.sessions[memberKey]` only when `room.sessionConnectionKey` exactly matches the captured `GroupMemberGateway.connectionKey`.
- Use that rule in `ensureGroupChatSession`, `harvest`, and `interrupt`. For turn acquisition, keep the current order: try a matching stored ID, then the title; create only after the existing `4007` path. A non-`4007` acquisition error still fails without creating. Preserve the existing `res.session_key || known || null` behavior whenever `known` came from a matching tag, including when the stored-ID attempt returned `4007` and the title attempt succeeded without a returned key. Baseline resume failures remain lazy-session success, polling failures continue retrying, and harvest failures leave the marker. Harvest falls back to the title only when there is no usable stored ID; a failed resume of a present ID, including `4007`, does not try the title and leaves the marker for a later boundary.
- Set `sessionConnectionKey` when `ensureGroupChatSession` successfully acquires a non-empty runtime `session_id`, on either resume or create, even if the Gateway returns no stored ID. Persist a returned stored ID when present. Do not tag a failed or no-runtime acquisition. Do not add tag writes to baseline or poll reads; they use the already acquired handle.
- Keep the hidden-session creation parameters, session-gone recovery using the acquired handle, poll logic, turn ownership, and log publication unchanged. Baseline, submit/recovery, and poll requests must continue using only the scoped handle returned by acquisition.
- Change the in-cluster `GroupTurnModule.interrupt` operation to accept `(roomKey, member)`, resolve the current room's stored ID inside the module, and skip the wire request if the handle is absent or belongs to another connection. Preserve the round driver's current ordering: apply local stop/epoch/hold state before best-effort interrupt.
- Remove the `room.sessions` lookup from `group-rounds.ts`. It should keep ownership of stop state and ask the turn module to interrupt the current speaker.
- Add required `connectionKey` to `GroupPrompt`, set it from the captured member gateway when `syncGroupClarify` creates a card, remove cards with missing or non-current keys during engine startup, and reject an entry whose key differs in `answer` before any request. Keep prompt display and response forms unchanged. Update the existing prompt fixtures in `group-engine.test.ts`, `group-turns.test.ts`, `group-store.test.ts`, and `groups-sync.test.ts.

### 5. Clear mismatched state before mirror hydration

- In `startGroupEngine`, first stop any existing lifecycle, then synchronously clear mismatched room session state and filter `$groupPrompts`, before constructing or publishing the new turn module and mirror and before calling `mirror.pull()`.
- The initial mirror pull only reads and merges room data; it does not start member work. Cleanup must precede it because a room can be opened and harvested as soon as the new engine is installed. Test that an immediate room open on B cannot send A's ID and that the cleanup itself sends no `profiles.configure` write.
- Retain `handleGatewayTransition()`'s existing epoch bump and `running: false` behavior. The cleanup changes no holds, watermarks, logs, room identity, members, image, epoch, or turn field, and does not clear `$groupActivity` or `$groupNeedsYou`. Same-key cards survive a Profile-switch restart; cards with missing or different keys do not.
- Keep the `GroupMirrorGateway`, CAS/retry behavior, default-profile snapshot, and wire projection unchanged.

### 6. Update the domain notes

`CONTEXT.md` was updated while settling the design. Keep its Group chat and Group member turn entries aligned with the final code: session IDs and stranded markers are tied to the captured connection key, member calls use `member.name`, and the shared room state remains local and portable. Update any function comments that still say the engine captures only a transport or that every coordination map has the same scope.

## Tests

Use the existing in-memory transport adapters and caller-facing Group engine actions. Do not test by importing writable state into cross-feature tests. Keep the existing low-level `group-turns` tests for internal session mechanics.

### Store and migration tests

- V4 persistence retains a correctly tagged session map and stranded markers, retains a valid tag when maps are empty, and still strips runtime `running`/`turn` fields and identity-less stubs.
- Table-test missing, null, empty, and non-string tags; non-record and array maps; empty IDs; invalid stranded cursors; and malformed stranded records. Any malformed provenance drops all three session-bound fields but preserves the rest of a valid room. Verify numeric stranded cursor `0` remains valid.
- Present but malformed v4 values (including an empty string and JSON roots of `null` or array) load no rooms and do not fall back to v3. With v4 absent, a v3 fixture with session IDs, stranded markers, and even an unexpected `sessionConnectionKey` migrates with room log, members, holds, watermarks, image, room key, and sync revision preserved, but all three session-bound fields removed. Assert v4 is not written at load and the v3 localStorage value remains byte-for-byte unchanged; a later normal persistence event writes v4.
- V1 and v2 migrations retain their current room/member-key migration behavior while dropping session-bound fields that cannot be assigned to a Gateway. Include session IDs, stranded markers, and an unexpected tag in both legacy fixtures; assert those fields are absent after migration and the legacy localStorage values remain byte-for-byte unchanged.
- Re-keying a member after `connectionId` enrichment still rekeys session and stranded maps without changing the room's connection tag.
- A connection cleanup test clears mismatched and untagged session state without changing logs, members, watermarks, holds, epoch, turn, activity, or needs-you state, and without scheduling a mirror write. A matching-key cleanup is a no-op that does not notify or persist.

### Group member turn tests

- A matching tag uses the stored ID. A mismatched or missing tag never sends it and resumes by `Group: <roomId or name>` first. Preserve the current stored-ID → title → create order when the tagged ID returns `4007`; title `4007` still reaches the existing create path.
- A successful acquisition by title stores the returned key and current tag. A successful runtime session with no stored ID still stores the tag. A failed or no-runtime acquisition does not tag the room.
- Pin the failure taxonomy: non-`4007` acquisition failures do not create; baseline-resume failures remain lazy-session success; polling failures retry; harvest failures leave the marker; a harvest `4007` for a present tagged ID leaves the marker and does not retry by title. Keep `4001`/session-gone recovery on the acquired scoped handle.
- Harvest uses a stored ID only under a matching tag and uses the title when no usable stored ID exists. Engine-start cleanup removes mismatched or untagged stranded markers before harvest can inspect them.
- `interrupt(roomKey, member)` sends only a current-connection stored ID. Missing or mismatched tags send no RPC while local stop state remains applied. Update the two `group-rounds.test.ts` interrupt expectations and fake to the new `(roomKey, member)` call; keep its stale-turn-key no-op assertion.
- A current-key prompt still answers normally. Prompt cards carry their originating key; startup removes missing/different-key cards, same-key restarts retain them, and a stale card passed directly to `answer` after a switch sends neither `approval.respond` nor `clarify.respond`.

### Engine lifecycle tests

- Start on connection A, acquire and persist a session, stop, then start on B. Assert B never receives A's stored ID, its first acquisition request is `Group: <roomId or name>`, and it can create or resume its own session. Also assert the room log, watermarks, and holds survive. The shared watermark consequence described under Trade-offs is intentional.
- Start A → B → A. Assert each key change discards the previous active ID map and title lookup can reacquire that Gateway's hidden session; no Gateway-specific stored-ID cache is added.
- Exercise an actual app Profile switch through `GatewayController`: the Group engine restarts with the same `connectionKey`, retains valid session state, and member RPCs still carry `profile: member.name`. Add the scope-forwarding assertion to `state/gateway-controller.test.ts`; direct engine tests alone do not verify this wiring.
- Seed v4 rooms with mismatched and absent tags before startup. Assert cleanup and prompt filtering complete before `startGroupEngine` invokes the initial `profiles.list`, and that an immediately opened room cannot send the old ID or harvest its old stranded marker.
- Keep the existing tests proving old turns and mirror pulls cannot publish after lifecycle replacement. Ordinary socket reconnect does not replace the Group engine; do not test or describe it as a new lifecycle.

### Mirror and UI regression tests

- Assert `groupChatSyncSnapshot()` never includes `sessions`, `sessionConnectionKey`, or `stranded`, including when the local room has tagged values.
- Assert pulling/merging a room preserves matching local session provenance and never imports those fields from the remote snapshot.
- `group-screen.test.tsx` currently covers mirrored messages and a missing room, not prompt cards. Add a rendered-card test for same-key retention and card removal after a key switch. Keep `app-navigation.test.tsx` and the existing Group browser flow as route/open/send regressions.
- The browser fixture is configured with a single Gateway endpoint and has no existing two-endpoint switch setup. Do not extend it solely for this internal request-eligibility change; distinct-key engine tests cover the security boundary, and the component test covers the visible card transition.

## Acceptance criteria

- No stored session ID is sent to a Group member RPC unless its room tag matches that engine's captured `connectionKey` (`remoteURL`). Same-URL authenticated-identity changes remain outside the guarantee.
- `sessionConnectionKey` and the local session/stranded state never appear in the Group mirror payload.
- A connection-key change clears mismatched session IDs, stranded markers, and prompt cards before the new mirror pull. It preserves the Group room log, membership, room-wide watermarks, and holds.
- Ordinary socket reconnects keep the existing Group engine. An app Profile switch restarts it with the same connection key and preserves valid session state.
- `group-rounds.ts` no longer reads the session map; Group member turn owns session lookup for acquisition, harvest, answer validation, and interrupt.
- Acquisition keeps the `4007` stored-ID → title → create path and existing creation parameters. Harvest with a present ID that returns `4007` keeps its marker for a later boundary and does not retry by title. Baseline/poll failure behavior, stop holds, room epoch checks, and mirror behavior remain unchanged.
- Legacy untagged session state is discarded without deleting the room or its transcript.
- Focused Group tests, the full client suite, typecheck, and production build pass.

## Out of scope

- A cache retaining independent session IDs for every previously used Gateway.
- Scoping Group room logs, membership, watermarks, or holds by `remoteURL`.
- Changing the Group mirror wire schema, room keys, member keys, polling policy, or room transcript ownership.
- Changes to the desktop client, backend session APIs, authentication identity, or the settings UI.
- Preserving a pending prompt card while its Gateway is inactive. On a connection change, the old card is invalidated rather than risking a response to the wrong Gateway.

## Verification commands

From `client/`, run the focused suites first, then the broader checks. The focused list includes the controller wiring and the UI component regression; the browser command runs the existing Group flow in both configured projects, Chromium and WebKit.

```sh
npm test -- src/features/groups/group-store.test.ts src/features/groups/group-turns.test.ts src/features/groups/group-rounds.test.ts src/features/groups/group-engine.test.ts src/features/groups/groups-sync.test.ts src/features/groups/groups-mirror.test.ts src/features/groups/group-screen.test.tsx src/state/gateway-controller.test.ts src/app-navigation.test.tsx
npm run test:e2e -- e2e/pwa-foundation.spec.ts --grep 'desktop group chats list on the main screen and open with sending'
npm run typecheck
npm test
npm run build
```

There is no `docs/adr/` directory in the repository, and this plan does not reopen an existing ADR decision.
