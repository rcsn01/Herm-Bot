# Plan — One member key wins in the Group send engine

**Status:** finalized design, ready to implement · **Cluster:** `client/src/features/groups/` (group-model, group-store, group-rounds, group-turns, groups-sync) + their suites
**Origin:** architecture review pass 3 (2026-09-20), candidate 1 ("One member-identity key wins"), selected from a 7-candidate report. CONTEXT.md gained the **Member key** entry as part of this decision.

---

## 1. Problem (evidence)

One member has three identity strings, and which one applies depends on which file touches the member:

1. **Twin key functions.** `groupMemberKey` (group-store.ts:164) keys the engine's local coordination state: it qualifies a member as `${connectionId}::${name}` only when the row carries `sourceScoped`, and keeps the bare name otherwise. `groupDurableMemberKey` (group-model.ts:66) keys the mirror's member merge: it qualifies whenever `connectionId` is present, with a `legacy::` rung otherwise. A member with a `connectionId` but no `sourceScoped` flag is one member to the mirror (`gw-2::research`) and two characters to the engine (`research`, shared with any connectionless member of the same name). Nothing pins the two functions' agreement; the flag is data the desktop controls, so the classes can drift apart silently.
2. **The agreement is load-bearing across the merge.** groups-sync merges members by durable key (groups-sync.ts:393, :496, :519) while the engine keys holds, watermarks, plumbing-session ids, stranded markers, and prompts by the engine key (group-turns.ts:178, :339, :414, :459, :511, :703, :811, :869; group-rounds.ts:376, :402). The mirror write path (groups-sync.ts:223–229) sends member rows, never keys, so both sides recompute from the same rows and agree only while the rows carry the flag consistently.
3. **The adoption path strips identity data.** `coerceGroupMember` (group-model.ts:143) keeps only `name` and `handle`, dropping `connectionId`, `connectionKind`, `connectionLabel`, and `sourceScoped`. Rooms adopted through `parseGroupSnapshot` → `adoptMirrorRoom` (group-store.ts:332, called from group-engine.ts:99) therefore hold identity-stripped rows: the engine keys their members by bare name while the next groups-sync merge computes durable keys from the remote rows. The same member can then appear twice in a merged roster (once under `legacy::name` from the local copy, once under `gw-2::name` from the remote), capped only by the 6-member slice.
4. **Attribution ignores identity entirely.** `unaddressedGroupMentions` (group-rounds.ts:186) matches room-log authors to members with a bare `members.find(m => m.name === entry.from?.name)`, twice (:194, :203): once for the citing member, once for the last poster. Same-named members blur the unresolved-handoff detector no matter which key wins. `stopGroupThread` has a third bare-name match: the interrupt-target lookup `roster.find(member => member?.name === turnName)` (group-rounds.ts:410), where `room.turn` was written as `member.name` in group-turns.ts:836.
5. **The state is persisted.** The local working copy persists to `localStorage['hermes.group-chats.v1']` (group-store.ts:57) including `holds`, `sessions`, `watermarks`, and `stranded`, all keyed by the engine key; watermarks compose `${thread}::${memberKey}` (group-turns.ts:417). Any key-shape change must carry the persisted state across or a member's room memory (its plumbing session) and its watermark reset mid-room.

The churn record backs the boundary: member-identity logic keeps being re-derived at call sites across five files, and every recent group fix (#93129, #94376, #94478, #90694) touched it.

## 2. Design decisions (grilling record — user delegated recommended answers)

| Decision | Choice | Rationale |
|---|---|---|
| Single key shape | **Qualify on `connectionId` presence:** `connectionId ? \`${connectionId}::${name}\` : name` | Keys are computed locally from member rows and never ride the wire (the sync compact shape writes member rows, never keys: groups-sync.ts:223–229; entry keys carry `from.kind/name/source`, not member keys: groupChatSyncEntryKey, groups-sync.ts:102), so the shape is free to choose. This shape keeps today's persisted values for both consistent member classes: a connectionless member keys as the bare name (unchanged), a `sourceScoped` member with a connectionId keys as `conn::name` (already identical under both functions). It also kills the collision class by construction: any row with a connectionId qualifies, whether or not the flag made the round trip. The `legacy::` rung buys nothing: member names are unique per gateway, so two connectionless members of one room cannot collide on a bare name. |
| Name and home of the function | **`groupMemberKey`, in group-model.ts** | One export, one home. group-model is the leaf both the engine and the mirror already import from, so the two identity computations become the same function call rather than two functions with a convention. `groupDurableMemberKey` is deleted; its doc comment's contract (display strings never key membership) moves onto the survivor. |
| Fate of `sourceScoped` | **Display and protocol flag only** | It still drives the peer `[label]` suffix in turn prompts (group-turns.ts:183), the log entry's `source` label (:780, :944), and the mirror row passthrough (groups-sync.ts:229). It stops gating identity. |
| Room-log attribution | **A pure matcher, no log-shape change:** `groupAuthorMemberKey(from, members)` in group-model.ts | The log author already carries `(name, source)` where `source` is `connectionLabel || connectionId` (group-turns.ts:780). The matcher finds members by name, then disambiguates among same-named members by comparing `connectionLabel || connectionId` against `from.source`. Strictly more precise than the bare-name find, uses only existing data, and adds nothing to the wire projection. Same-named members on distinct connections are distinguished; same-named members with no distinguishing source stay ambiguous exactly as far as the log's display vocabulary can see — the matcher then returns the first bare-name match, never null, so attribution is a strict refinement of today's behavior; null is reserved for user entries and names with no member row. That residual ambiguity is a data problem upstream of this module. |
| `room.turn` shape | **Member key instead of member name** | Runtime-only state: `durableGroupChatRooms` persists `turn: null` (group-store.ts:230). Writing `memberKey` (group-turns.ts:836) makes the interrupt-target lookup a key read (group-rounds.ts:410) and deletes the third bare-name match. The activity feed keeps `member: member.name`, which is display. One display consumer follows the shape: the room screen's turn indicator renders `room.turn` directly (`` `${engineRoom.turn} is thinking…` ``, group-screen.tsx:193), so it resolves the display name through the member row by key and falls back to the unnamed copy ('Bots are working') when no row matches — a drifted key never renders as raw text. |
| Persisted-state migration | **Bump to `hermes.group-chats.v2`; re-key on load; leave v1 in place** | A member row that gains a `connectionId` changes its key, and the coordination state must follow or the member loses its plumbing session (its memory of the room) and its watermark (it gets re-fed history). The same shape change happens live, not only across releases, so the re-key becomes a reusable invariant keeper rather than a one-time migration: run it at the two boundaries where persisted coordination state meets the current member rows — the storage load and the mirror merge write. |
| Re-key direction | **Bare → qualified only, never backward** | Guard: move a map entry only when the member row has a `connectionId`, the qualified key is absent, and the bare key is present. Row drift that drops a connectionId orphans that member's coordination state, which is today's behavior for the same drift and strictly bounded: session-gone recovery and room-open harvests already handle missing state. |
| Mention resolution for same-named members | **Unchanged, documented** | `@research` in text is singular no matter how many members it could reach; the handles map stays last-wins (deterministic). The model disambiguates through the `[label]` suffix in the peer list. This fix is about identity, not about teaching the model to address members. |
| Locally created members | **Keep `{ name }` rows** | `createGroupChat` seeds rows with names only (create-group-chat-dialog.tsx:66). Enriching them with profile connection data belongs to the mirror cycle, which now carries coordination state along when rows are enriched (the re-key at the merge boundary). |

## 3. Target design

### 3.1 Files

```
group-model.ts   gains groupMemberKey (the one function), groupAuthorMemberKey; coerceGroupMember
                 preserves connectionId/connectionKind/connectionLabel/sourceScoped; loses
                 groupDurableMemberKey
group-store.ts   loses groupMemberKey (imports it from group-model); gains
                 rekeyRoomCoordination(room) + the v2 storage key with a v1→v2 load pass
group-rounds.ts  imports the key from group-model; hold stamping, sessions lookup, responder
                 and mention resolution keep working unchanged; unaddressedGroupMentions
                 resolves authors through groupAuthorMemberKey; stopGroupThread finds the
                 interrupt target by room.turn as a member key
group-turns.ts   import swap; the turn capture writes r.turn = memberKey (:836); everything
                 else is mechanical
groups-sync.ts   import swap; the merge calls rekeyRoomCoordination on the merged room before
                 it lands in the store
CONTEXT.md       done (Member key entry)
```

Screens: `create-group-chat-dialog.tsx` constructs `{ name }` rows and stays untouched. `group-screen.tsx` reads `prompt.memberKey` (:144), which is unaffected — but its turn indicator renders `room.turn` as display (:193, `${engineRoom.turn} is thinking…`), so Phase 2 adds one resolution there: the member row matching the key supplies the display name (importing the one `groupMemberKey` from group-model), falling back to the unnamed copy when no row matches.

### 3.2 group-model.ts after the change

```ts
/** The one member identity inside a room. Qualified when the row carries a
 *  connectionId so same-named agents on two machines never share holds,
 *  watermarks, or plumbing sessions; bare name otherwise. Display strings
 *  (label, handle) never key membership. Computed locally; never rides the
 *  wire. */
export function groupMemberKey(member: GroupMember | EngineMember): string

/** Room-log author → member key. Matches members by name; a lone match wins.
 *  Same-named members disambiguate by the author's source label
 *  (connectionLabel || connectionId): exactly one source match wins, an
 *  unresolvable field falls back to the first bare-name match (today's
 *  behavior). Returns null for user entries and names with no member row. */
export function groupAuthorMemberKey(
  from: GroupMessageAuthor,
  members: ReadonlyArray<EngineMember | GroupMember>
): string | null
```

`coerceGroupMember` gains the four identity fields with the same string-coercion discipline the sync write path uses (groups-sync.ts:223–229): preserve when a non-empty string, omit otherwise.

### 3.3 The re-key pass (group-store.ts)

```ts
/** Coordination maps are keyed by the current member rows' keys. When a row
 *  gains a connectionId (desktop projection arrives, v1 state loaded), move
 *  its coordination state from the bare key to the qualified key. Never moves
 *  qualified → bare, and never overwrites an existing qualified entry. */
export function rekeyRoomCoordination(room: GroupChatRoom): GroupChatRoom
```

Mechanics per member with a `connectionId`:

- `bareKey = member.name`, `qualifiedKey = \`${connectionId}::${name}\``
- `holds`, `sessions`, `stranded`: direct key move, skipped when the qualified key already exists.
- `watermarks`: keys are `${thread}::${memberKey}`. Split each key at the FIRST `::` (thread ids are minted `t…` or `legacy`, never containing `::`, while member keys may, for qualified members — a first split recovers them; a right split would mistag an already-qualified member's persisted key as bare and double-qualify it). When the member-key part equals `bareKey`, rewrite to `${thread}::${qualifiedKey}`.

Call sites: the storage load (v1 → v2, section 3.4) and the mirror merge, where groups-sync applies it to the room it is about to write (groups-sync.ts:519–545 region, after the member map is finalized). `adoptMirrorRoom` needs no call: it only seeds rooms that do not exist locally, and their coordination maps are empty.

### 3.4 Storage v1 → v2

- `STORAGE_KEY` becomes `'hermes.group-chats.v2'`.
- Load: read v2 first and use it verbatim when present; otherwise read v1, run `durableGroupChatRooms` shape guards, run `rekeyRoomCoordination` per room, keep the result as the store. Write v2 on the next persist; the v1 key stays in localStorage untouched as a rollback copy. The v2 loader runs no migration, so the pass executes exactly once per install. v1 must never be read once v2 exists: it is a frozen pre-migration copy, and re-reading it would discard everything persisted since the first migrated session.
- Members with a `connectionId` whose persisted keys were already qualified (`sourceScoped` rooms) re-key as a no-op; connectionless members' bare keys stay bare. Only the inconsistent class moves, which is why the migration is small.

### 3.5 Wire compat

No wire change. Member rows already carry the identity fields in both directions (sync write groups-sync.ts:223–229, merge :519). Keys, holds, watermarks, sessions, and stranded markers never ride the wire (CONTEXT.md: Group chat entry). The desktop remains the arbiter of the `sourceScoped` flag and connection fields on projected rows; this change makes the PWA's identity independent of that flag's consistency, which is the direction of safety. The desktop's own Bot Mode keying lives in plugin storage in a separate codebase and is untouched.

## 4. Phases

**Phase 1 — the pure core (group-model.ts).** Add the unified `groupMemberKey`, add `groupAuthorMemberKey`, widen `coerceGroupMember`. Nothing else moves: group-store keeps exporting its twin, and group-rounds/group-turns keep importing `groupMemberKey` from group-store while groups-sync/group-rounds keep importing `groupDurableMemberKey` from group-model — the deletion of `groupDurableMemberKey` and the group-store twin happens in Phase 2 together with the import swap (deleting in Phase 1 would break those imports).
Verify: `npm test` (group-model.test.ts green with the new describes), `npm run typecheck` red only where planned (none expected).

**Phase 2 — the engine swap (store, rounds, turns, sync).** Point all five files at group-model's key; delete the twin from group-store.ts; switch `room.turn` to the member key (group-turns.ts:836 write, group-rounds.ts:395/:410 read) and add the group-screen turn-indicator resolution (member row by key, unnamed fallback); rewire `unaddressedGroupMentions` through `groupAuthorMemberKey`; stopGroupThread's interrupt lookup by key.
Verify: `npm test` with the suite updates from section 5, `npm run typecheck`.

**Phase 3 — storage v2 + merge re-key.** Bump `STORAGE_KEY`, add the v1 load pass, call `rekeyRoomCoordination` from the mirror merge write.
Verify: `npm test` (group-store.test.ts, groups-sync.test.ts), `npm run typecheck`.

**Phase 4 — audit.** Grep audit (section 6), full suite, manual smoke: create a group with two same-named bots on two connections if a gateway with that shape is available, drive one round, stop mid-turn, reload the app, and check the held/watermarked/sessioned state survives with qualified keys (the localStorage payload is inspectable in devtools).

## 5. Test plan

**group-model.test.ts**
- Key: same-named members on two connections get distinct keys; connectionless stays bare; `connectionId` without `sourceScoped` qualifies (the pinned collision case); `connectionId` with `sourceScoped` equals the old engine key (migration no-op for that class).
- Author matcher: member entry with a matching label resolves; source absent on a local member resolves by name among connectionless members; two same-named members with distinct labels resolve distinctly; an unresolvable same-named field falls back to the first bare-name match; user entries and unknown authors return null.
- `coerceGroupMember` preserves the four identity fields on member rows (the existing expectation `members: [{name:'codex', handle:'@codex'}, {name:'scout', handle:'@scout'}]` widens to carry `scout`'s `connectionId: 'gw-2'` and `sourceScoped: true`).

**group-store.test.ts**
- v1 → v2: rooms with mixed member classes re-key exactly the inconsistent class; holds, sessions, and stranded move as maps; watermarks move by first-`::` split rewrite; a room whose member list lost its rows leaves its maps alone.
- Idempotency: loading v2 runs no re-key (qualified keys are never moved backward, bare keys never duplicated); an already-qualified member's persisted watermark (`t1::gw-2::research`) is never re-touched.
- `rekeyRoomCoordination` directly: row gains a connectionId → state follows; row already qualified → no-op; existing qualified entry → bare entry left in place rather than overwriting.
- Persisted `turn` stays null (existing).
- The suite's own `STORAGE_KEY` constant splits: v1 fixtures feed the loader's migration pass, persistence assertions read v2.

**group-rounds.test.ts**
- Fixtures where a member carries `connectionId`: hold stamps land under `gw-2::research` (previously `research`), and a connectionless twin named `research` keeps its own hold.
- `unaddressedGroupMentions` with two same-named members on distinct connections: attribution distinguishes them by source label.
- Stop: `room.turn` set to a member key, interrupt targets that member, a stale key misses.

**group-turns.test.ts**
- Existing fixtures use connectionless members; watermark assertions like `'t1::research'` survive verbatim.
- New: two members named `research`, connections `gw-1`/`gw-2`, driven alternately; watermarks stay per connection (`t1::gw-1::research` vs `t1::gw-2::research`), plumbing sessions stay distinct, one member's hold never consumes the other's turn.

**groups-sync.test.ts / groups-mirror.test.ts**
- Merge dedupe: a room whose local rows carry identity (adopted rooms — `coerceGroupMember` now preserves them) and the remote row for the same bot dedupe to ONE member after the tie-union merge (today the adopted copy is stripped, so they produce two, capped only by the 6-member slice).
- A locally created bare `{name}` row and its enriched remote twin stay two rows on a revision tie — only the coordination keys stay consistent through the re-key; row unification for that class is out of scope (section 8).
- Existing merge vectors survive; member rows still write identity fields (:223–229 unchanged).

**create-group-chat-dialog.test.tsx**
- The persisted-key assertion (:67) hardcodes `hermes.group-chats.v1`; it moves to the v2 key (or the shared constant) — otherwise the v2 bump fails it.

**group-engine.test.ts**
- Unchanged; the prompt fixtures construct `memberKey` literals directly and the read surface does not re-key.

## 6. Verification commands

```bash
cd client
npm test          # vitest run — all suites green at every phase
npm run typecheck # tsc -p tsconfig.json --noEmit
npm run test:e2e  # playwright — pwa-foundation pins the navigation chrome, groups ride under it
```

Audit greps after Phase 3 (expected outputs):

```bash
rg -n "groupDurableMemberKey" client/src        # zero hits
rg -n "groupMemberKey" client/src/features/groups  # definition in group-model.ts only, imports everywhere else
rg -n "sourceScoped" client/src/features/groups    # type/copy sites: group-model.ts:38, :50 + the widened coerceGroupMember, group-store.ts:46; display/protocol sites: group-turns.ts:182, :779, :943, groups-sync.ts:229, :519 — nothing else
rg -n "m.name === entry.from" client/src           # zero hits (bare-name attribution gone)
rg -n "hermes.group-chats" client/src              # the v2 constant + the v1 read in the loader (group-store.ts) and the suite constants (group-store.test.ts, create-group-chat-dialog.test.tsx)
```

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| The desktop projects a row with a connectionId where it previously omitted one, mid-room | The merge-boundary re-key moves coordination state with the row; that direction is the common, load-bearing one (phone-created room, desktop enriches on its first mirror cycle). Covered by a groups-sync test. |
| A row loses its connectionId (projection drift) | Never re-keyed backward. The member's coordination state orphans until the id returns; session-gone recovery and reopen harvests already absorb missing state, so drift degrades to today's behavior. |
| Watermark key parsing (`${thread}::${memberKey}` with `::` inside member keys) | Split at the FIRST `::`, exactly once; thread ids are minted `t…` or `legacy` and contain no `::`, so the first separator is always the thread boundary — an already-qualified member's persisted key (`t1::gw-2::research`) then parses to member part `gw-2::research` and is never re-touched. Rewrites match the member's bare key exactly, so a member named like a thread cannot collide (the rewrite requires an exact member-key part match against a member row in the same room). |
| The migration moves state it should not | Two guards: the qualified key must be absent (never overwrite), and the bare key must belong to a member row that carries a connectionId. Idempotent by construction, and v2 loading never re-runs the pass. |
| Same-named members share a connection | Impossible on one gateway (profile names unique); recorded as an assumption the desktop's projection upholds. If a future gateway relaxes profile-name uniqueness, this key needs a third component and the desktop decides first. |
| Test churn from key shapes | Most fixtures use connectionless members and keep their keys verbatim; only new collision fixtures introduce qualified shapes. The `legacy::` rung's deletion touches no fixture. |
| Scope creep into the round-driver ↔ turn protocol (candidate 7) | The `room.turn` shape change is identity, not protocol: the tri-flag and the caps/continuation split stay exactly as they are. |

## 8. Out of scope (recorded, not scheduled here)

- **The local store keys rooms by display name** (`all[group]`, `adoptMirrorRoom` by `room.name`) while the durable room key is `id:<roomId>` or `name:<name>`. A rename across surfaces has its own candidate.
- **The round-driver ↔ member-turn protocol** (caps and continuation counting in the driver, holds consumed in the turn, the lossy `{abandoned, spoke, stop}` tri-flag): candidate 7 of this review, its own grilling pass.
- **Member-row unification for locally created rooms**: a bare `{name}` row and its enriched remote twin stay two roster rows on a revision tie — the merge unifies membership only when both sides compute the same key (adopted rows, post-widening) or the remote revision wins and clears local rows. Coordination keys stay consistent through the re-key; only the residual duplicate row is left as-is.
- **`publishTurn`'s double watermark write** around the append (group-turns.ts:770–785): belongs with the protocol candidate.
- **`useGroupRooms`' dual-mode + `$knownRooms` side channel** and the remaining smaller frictions from the pass-3 report: chat-viewport interface leaks, the empty-tombstone predicate ×4, the Conversation seam trim, dead registries.
- **Desktop-side keying** (`apps/desktop/.../group-membership.ts`): separate codebase, not in this repository; the PWA's local keys never constrain it.