# Plan — Deepen the known-rooms projection into the Group send engine

Candidate 1 from the 2026-09-20 architecture review (`Strong`). All clarification decisions were
settled with the recommended answers (user pre-authorized). Design was chosen via design-it-twice
(three parallel interface designs; hybrid adopted — see Decision record).

**Repo**: Herm-Bot (Hermes mobile PWA) · **Area**: `client/src/features/groups/`, `client/src/app.tsx`

---

## 1. Goal

The known-rooms projection is published by a render hook, not owned by the engine.
`useGroupRooms(rosterGroups?)` (`group-engine.ts:118-173` — the `// --- Reads.` section; the hook with its doc comment is 148-173) has two modes: roster-carrying screens
(roster, group-room, create dialog) compute the merge in render and **publish the merged view**
into an engine-internal `$knownRooms` atom via a render effect; roster-free callers (the app
header) read whatever the last mounted publisher left behind. The projection's freshness
therefore depends on MobileShell keeping `RosterScreen` always mounted (an architectural accident,
not an invariant), the app header's title resolution carries a documented publish-tick workaround
(`app.tsx:137-142`, the `openCreatedGroup` comment; the header renders `activeGroup?.name` at `app.tsx:196`), `$knownRooms` cannot be reset by tests — so `app-navigation.test.tsx` must
fake a roster-carrying publisher and `group-engine.test.ts` mounts Publisher/Reader components to
observe the contract at all — and a `$groupChats` write with no roster screen mounted goes unseen.

Deepen: the Group send engine owns the projection. Roster-carrying screens publish the roster
**input** through one content-signature verb; `$knownRooms` becomes a `computed` over the retained
roster snapshot and `$groupChats`; the reader gets a zero-argument hook. The merge stays the pure
`groupRoomsView`. Tests cross the engine's interface — publish/reset/atom read — instead of
mounting fake publishers.

## 2. Non-goals (explicitly out of scope)

- **Feed atoms** (`$groupActivity`/`$groupPrompts`/`$groupNeedsYou`) keep their three writers —
  architecture review candidate 2 (the group-feed module). No decorated `KnownRoomView` facets
  (the design-2 proposal) land here; folding feeds into the read surface now would pre-empt that
  candidate's seam decisions (YAGNI).
- **Coordination-state verbs** (watermark key format, epoch bumps, the engine's direct
  `$groupChats.set` in `handleGatewayTransition`) — architecture review candidate 3, untouched.
- **GroupChatScreen's roster query** stays: it remains a roster-carrying publisher and keeps its
  self-sufficient room resolution (deep-link cold start). Migrating it to `useKnownRooms()` is a
  possible future deletion once retention is trusted, not now.
- **`groupRoomsFromRoster`** and the `group-model.ts` leaf imports from outside `features/groups/` —
  `agents-api.ts:4-5` (the engine-header's sanctioned carve-out: `groupRoomsFromRoster` + the
  `GroupRoom` type) and the type-only `GroupRoom` import at `app.tsx:23` — untouched.
- **MobileShell** — the always-mounted roster slot stays as-is; it simply stops being
  load-bearing for the header's freshness.
- **Merge semantics** — unchanged: union by durable room key, roster rows win a shared key, the
  empty-tombstone filter, just-created rooms retained. `groupRoomsView`'s body is untouched.
- **Scope teardown** — the projection is NOT cleared on `stopGroupEngine`/`teardownGatewayScope`
  (today `$knownRooms` isn't cleared either; retention is the contract).

## 3. Decision record (grilling rounds, recommended answers adopted)

| # | Decision | Chosen | Rejected alternatives & why |
|---|----------|--------|------------------------------|
| Q1 | Module shape | Keep the projection in `group-engine.ts` beside the existing read surface | Move to `group-store.ts` (nothing inside the folder needs the projection — the store's import-cycle dodge is for the feed atoms, a different candidate); new `known-rooms.ts` file (fragments the engine's single import path) |
| Q2 | Interface shape | Compile-time caller-class split: `useGroupRooms(rosterRooms)` required-arg + `useKnownRooms()` + `publishRosterRooms` + `resetKnownRooms` + exported read atom `$knownRooms` | Design 1's two-mode optional-arg hook (zero call-site churn, but `undefined`-means-reader stays caller knowledge — the interface keeps carrying mode subtlety); Design 2's decorated `KnownRoomView` rows (speculative; overlaps candidate 2) |
| Q3 | Publish semantics | The hook publishes the roster **input** (a snapshot atom) through `publishRosterRooms`; the merge runs in a `computed`. Roster-carrying hooks still return the render-time merge (synchronous, no effect round-trip on their own renders). Last publish wins; `[]` clears the roster half (matches a pending query's publish today) | Publishing the merged output (today's shape — the ownership bug itself); returning the computed read from roster-carrying hooks (one-paint lag behind the effect) |
| Q4 | Publish trigger | Content signature = room keys + names, joined; array identity never triggers a write; the dedupe lives in `publishRosterRooms`, the stable-copy memo in the hook | Keys-only (Design 1: preserves today's staleness where an id-keyed rename reaches readers only when keys change); deep equality (serialize per render per screen for a theoretical case — over-engineering) |
| Q5 | Deliberate improvement | The projection recomputes on any `$groupChats` write regardless of mounted screens; `openCreatedGroup`'s publish-tick comment dies; the shell's always-mounted roster stops being load-bearing for freshness | None — this IS the ownership fix (constraint 4 of the brief) |
| Q6 | Reset scope | `resetKnownRooms()` clears only the retained roster half (the engine's projection state); the local half resets through `replaceGroupChats({})` — the store owns rooms | Design 3's `resetGroupRooms()` reaching into `$groupChats` (a second direct atom write in the engine file — the exact seam break review card 3 will fix; don't add more) |
| Q7 | GroupChatScreen's own roster query | Keep it (self-sufficient deep-link resolution; harmless idempotent publisher) | Migrate to `useKnownRooms()` now (changes the cold-start room-resolution path; a future deletion, not now) |
| Q8 | Test strategy | Replace, don't layer: verb-based interface tests (`publishRosterRooms` / `resetKnownRooms` / `$knownRooms.get()`), two React tests for the hook contracts; drop the fake Publisher/Reader pair; drop the mocked RosterScreen's `useGroupRooms([])` publish call; keep the `groupRoomsView` describe and the live-title app test unchanged | Keeping Publisher/Reader fakes (they exist only because `$knownRooms` was engine-internal and unresettable) |
| Q9 | Naming | The domain name carries: reader hook `useKnownRooms()`, verbs `publishRosterRooms` / `resetKnownRooms`, atom `$knownRooms`, pure merge `groupRoomsView` unchanged | `seedKnownRooms` (test-flavored name for the production publish path — the interface is the test surface, so the verb is named for its production role) |
| Q10 | Non-React read | Export `$knownRooms` as a `ReadableAtom<GroupRoom[]>` (nanostores `computed`'s inferred type — the package has no `ReadonlyAtom`) so engine tests assert without React | Keep it internal (tests would need React to read; the Publisher/Reader fakes exist for exactly that reason today) |

## 4. Target interface

`client/src/features/groups/group-engine.ts` — replace the `// --- Reads.` section (today
`group-engine.ts:118-173`) with the block below. Everything after that section — the read-surface
re-exports (today 175-178), the actions section (179-197), and the type re-exports (199-203) — is
untouched, per §5. The old section-local `EMPTY_ROOMS` constant (today 121) is deleted with it:
nothing in the new code uses it (the reader hook no longer defaults a missing argument).

```ts
import { atom, computed } from 'nanostores'   // computed is new

// --- Known rooms — the engine's read projection. ----------------------------

/** The known-rooms merge: the gateway roster snapshot ∪ local engine rooms,
 *  unioned by durable room key (roster rows win a shared key — they are the
 *  gateway's richer copy); empty runtime tombstones (no transcript, no
 *  durable identity) never render — the create dialog always sets roomId and
 *  members, so a just-created room is retained. The one merge, behind one
 *  pure function. */
export function groupRoomsView(rosterGroups: GroupRoom[], localRooms: Record<string, GroupChatRoom>): GroupRoom[] {
  // body unchanged from today
}

/** The retained roster snapshot: the last roster half any roster-carrying
 *  caller published. Internal — writers are publishRosterRooms only. */
const $rosterRooms = atom<GroupRoom[]>([])

/** The engine's known-rooms projection: recomputes whenever the retained
 *  roster snapshot or $groupChats changes — roster-carrying screens mounted
 *  or not. Retention: always holds the last-known view; the roster snapshot
 *  outlives every roster screen. Read-only: the writers are
 *  publishRosterRooms and the group-store room verbs. */
export const $knownRooms = computed([$rosterRooms, $groupChats], groupRoomsView)

let rosterSignature = ''

/** Publish a roster snapshot into the engine — the one writer of the
 *  retained roster half, wrapped by `useGroupRooms(rosterRooms)` and callable
 *  without React (tests; a future push-sync roster source). The content
 *  signature is the room-key list plus names: freshly built arrays are
 *  content-equal no-ops, and array identity never triggers a write. `[]`
 *  clears the roster half, matching a pending roster query's publish. Last
 *  publish wins. */
export function publishRosterRooms(rosterRooms: readonly GroupRoom[]): void {
  const signature = rosterRooms.map(room => `${room.key}::${room.name}`).join('|')
  if (signature === rosterSignature) return
  rosterSignature = signature
  $rosterRooms.set([...rosterRooms])
}

/** Clear the retained roster half. The one beforeEach verb for the
 *  projection's own state; the local half resets through
 *  `replaceGroupChats({})` — the store owns rooms. */
export function resetKnownRooms(): void {
  rosterSignature = ''
  $rosterRooms.set([])
}

/** The known rooms for roster-free callers (the app header): one
 *  subscription to the live projection, no roster data required. Recomputes
 *  whenever $groupChats or the retained roster contribution changes, whether
 *  or not any roster-carrying screen is mounted. */
export function useKnownRooms(): GroupRoom[] {
  return useStore($knownRooms)
}

/** The known rooms for roster-carrying callers. Pass the freshly built
 *  `roster.data?.groups ?? []`: the hook publishes it through
 *  publishRosterRooms — a content-signature publish (room keys + names,
 *  never array identity; the stable copy below exists so the publish effect
 *  cannot loop) — and returns that render's merged view synchronously, no
 *  effect round-trip. Two callers holding the same roster publish identical
 *  content; the dedupe makes the second a no-op (last publish wins). */
export function useGroupRooms(rosterGroups: GroupRoom[]): GroupRoom[] {
  const localRooms = useStore($groupChats)
  const signature = rosterGroups.map(room => `${room.key}::${room.name}`).join('|')
  // Content signature, not identity: the memo closure holds the roster array
  // from the render where the signature last changed — content-equal arrays
  // produce the identical view and never re-fire the publish effect.
  const stableRoster = useMemo(() => rosterGroups, [signature])
  const rooms = useMemo(
    () => groupRoomsView(stableRoster, localRooms),
    [stableRoster, localRooms]
  )
  useEffect(() => {
    // publishRosterRooms dedupes content-equal snapshots internally.
    publishRosterRooms(stableRoster)
  }, [stableRoster])
  return rooms
}
```

`groupRoomsView`'s body, the tombstone filter, and the roster-wins union are unchanged from
today (`group-engine.ts:127-146`).

## 5. Rewiring table

| Site | Today | After |
|---|---|---|
| `app.tsx:50` | `const groups = useGroupRooms()` | `const groups = useKnownRooms()` (the `app.tsx:22` import swaps `useGroupRooms` → `useKnownRooms`) |
| `app.tsx:137-142` (`openCreatedGroup`) | comment: "the published known-rooms view picks the name up on the next publish tick" | comment updated: the projection reads `$groupChats` directly — `createGroupChat`'s write resolves the header name on the same commit; no publish tick |
| `roster-screen.tsx:62` | `useGroupRooms(roster.data?.groups ?? [])` | unchanged (compile-time: the arg is now required — this call already passes it) |
| `group-screen.tsx:81` | `useGroupRooms(roster.data?.groups ?? [])` | unchanged (stays a publisher by design, Q7) |
| `create-group-chat-dialog.tsx:31` | `useGroupRooms(roster.data?.groups ?? [])` | unchanged |
| `app-navigation.test.tsx:37-44` | mocked `RosterScreen` imports + calls `useGroupRooms([])` to keep the publish contract | call and import dropped — the header reads the live computed, the `act()` `$groupChats` seed flows through the engine itself |
| `group-engine.test.ts:552-603` | `groupRoomsView` describe (keep) + `useGroupRooms` Publisher/Reader describe (replace) | keep the merge describe verbatim; replace the hook describe with the interface tests in §7 |
| `group-engine.ts:118-173` | the `// --- Reads.` section: `$knownRooms` atom + two-mode hook (the `groupRoomsView` body at 127-146 is kept verbatim) | §4 read surface |

Everything else — lifecycle verbs, actions, the bottom read-surface re-exports — untouched.

## 6. Behavior-preservation notes (verified against today's code)

- Retention: the roster snapshot outlives every roster-carrying screen — matches today's
  `$knownRooms` retention (the app-header contract pinned by `group-engine.test.ts:578-603`).
- Roster-carrying renders: the hook returns the render-time merge (stable copy keyed on the
  signature), so a screen's own rows never lag one paint behind its own query — same as today.
- Roster-free readers lag one effect behind a *roster-data* change — identical to today (today's
  publish is also an effect); the improvement is recompute on `$groupChats` changes without any
  mounted publisher, which today happens to hold only because MobileShell always mounts
  RosterScreen.
- `[]` publish semantics: a pending roster query publishes an empty snapshot, clearing retained
  gateway rows — matches today's merged-view publish with empty roster data.
- Tombstone filter and just-created retention are the same pure function, pinned by the unchanged
  `groupRoomsView` tests.
- Scope teardown, `stopGroupEngine`, `handleGatewayTransition`, persistence — untouched; the
  projection is not cleared on teardown today and is not cleared after.
- **The one sanctioned delta (Q4)**: the publish signature is keys + names, so an id-keyed room's
  display-name rename reaches roster-free readers one render earlier (today's key-only signature
  can hold a stale name until a key changes). Within the projection-recompute family; called out
  so a behavior diff during review traces to a decision, not an accident.

## 7. Test strategy (replace, don't layer)

`group-engine.test.ts` — the `useGroupRooms` describe becomes a `known rooms` describe. Add
`resetKnownRooms()` to the file's `beforeEach` (beside `replaceGroupChats({})`): module-level
`$rosterRooms` and `rosterSignature` persist across tests in the file, so without the reset the
retained roster half of an earlier test leaks into later assertions (e.g. test 6's rendered count
would include a prior test's published rows):

1. **Retention** (no React): `publishRosterRooms([gatewayRoom])`; `replaceGroupChats({})`;
   `$knownRooms.get()` still contains the gateway row (roster half retained across local clears).
2. **Content-signature publish** (no React): publish the baseline roster, then attach a `vi.fn()`
   via `$knownRooms.listen` — `listen`, not `subscribe`: nanostores `subscribe` calls the listener
   immediately with the current value (the computed's mount compute goes through `atom.set`), so a
   subscribe-based spy always shows one initial call and the no-op assertion below cannot pass.
   Publish a content-equal roster built fresh → no notification; publish with a changed name → one
   notification. Proves identity never triggers a write.
3. **Live recompute without publishers** (no React): `replaceGroupChats({...new room...})` →
   `$knownRooms` reflects it with no roster publish at all (the improvement that kills the
   publish-tick workaround).
4. **Reset**: `publishRosterRooms([...])`; `resetKnownRooms()`; `$knownRooms.get()` shows local
   rooms only; a re-publish of the same content notifies a `$knownRooms.listen` spy again
   (signature state cleared — with `rosterSignature` reset to `''`, even content-equal input
   writes).
5. **`useGroupRooms(roster)` hook contract** (React): renders with roster data →
   `$knownRooms` updated; unmount → retained; re-render with content-equal data → no extra write.
   Replaces the Publisher half of today's fake.
6. **`useKnownRooms()` app-header contract** (React): render, seed `$groupChats` via `act()` →
   re-render shows the new room (the live projection). Replaces the Reader half.

`app-navigation.test.tsx`:

- Drop the mocked RosterScreen's `useGroupRooms([])` call, the `~/features/groups/group-engine`
  import in that mock, and the comment above them (today `app-navigation.test.tsx:37-39`) that
  explains the now-obsolete publish contract — the publish contract no longer needs a mounted
  caller.
- The `opens a desktop group chat from its URL` test stays as written (seeds `$groupChats` via
  `act()`, asserts the header title updates) — it now passes through the real seam.

`groupRoomsView` describe: unchanged (merge semantics pinned).

## 8. Documentation (applied with this plan)

- `CONTEXT.md`: the **Known rooms** entry now names the engine-owned projection (computed over the
  retained roster snapshot and `$groupChats`), the two caller-class hooks, the publish/reset verbs,
  and the retention contract; the **Group send engine** entry's read-surface list gains the
  known-rooms verbs.
- Module header comment on the read-surface section of `group-engine.ts` in the same voice.

## 9. Implementation order

1. **`group-engine.ts` read surface** — §4 (atoms, computed, verbs, hooks, doc comments); import
   `computed` from `nanostores`.
2. **`app.tsx`** — `useKnownRooms()` at :50; update the `openCreatedGroup` comment.
3. **Test rewrite** — `group-engine.test.ts` §7; `app-navigation.test.tsx` mock cleanup.
4. **Verification** (below), fix fallout.
5. **CONTEXT.md** — re-read the amended entries for accuracy after implementation; adjust wording
   if the built interface drifted.

## 10. Verification

```bash
cd client
npm run typecheck                     # tsc --noEmit
npm test                              # full vitest suite

rg -n 'useGroupRooms\(\)' src                      # expect: no matches (reader callers use useKnownRooms)
rg -n 'useKnownRooms' src --no-heading             # expect: group-engine.ts, app.tsx, tests
rg -n 'publishRosterRooms|resetKnownRooms' src     # expect: group-engine.ts (hook + verbs), tests only
rg -n 'roster.data\?\.groups' src/features --no-heading   # expect: the three roster-carrying call sites, unchanged, plus the doc comment inside group-engine.ts that repeats the expression (4 matches)
```

- All pre-existing tests pass unmodified except the two rewritten describe blocks and the mock
  cleanup — no other test touches the known-rooms surface.
- The `groupRoomsView` merge describe passes without edits.
- `npm run dev` + manual smoke: connect → roster shows groups → open a room → header title
  resolves → create a new group from the dialog → header name resolves without a publish tick;
  Playwright e2e (`npm run test:e2e`) — verified to run in this environment (see below).

**Verified during plan evaluation** (scratch worktree with §4/§5/§7 applied verbatim, then
discarded): `npm run typecheck` and `npm test` pass (955 tests / 81 files — the 5-test delta is
the new `known rooms` describe), `npm run test:e2e` passes (58 passed, 6 environment skips),
including `e2e/profile-create.spec.ts` "creates a group chat from selected bots", which pins the
header-name-without-publish-tick flow end to end, and all four `rg` checks above return the
expected matches. Note the e2e webServer serves the built `<client>/dist` bundle — run
`npm run build` first when `dist` is stale or absent, or every spec fails at login with
`Not found`.

## 11. Risks

- **nanostores `computed` + `useStore`** — standard subscription path (navigation-store already
  computes); the only new primitive in the engine.
- **Effect-ordering nuance** — a roster-data change reaches roster-free readers one effect after
  the roster screen's render (same as today); roster screens themselves see their own data
  synchronously via the render-time merge. If a future reader needs same-tick roster freshness,
  the fix is internal to the module (publish before paint), never a caller change.
- **Signature scope** — keys + names: member-row enrichment under stable keys does not republish
  (identical to today's keys-only behavior for member changes; member display rides `$groupChats`
  enrichment). Deep equality deliberately rejected (Q4). The `|`/`::` join can theoretically
  collide (a room name containing `|` followed by another room's `key::name` text) — the same
  theoretical class as today's keys-only join; the worst case is one skipped republish until the
  next signature change.
- **Test-harness coupling** — `app-navigation.test.tsx`'s RosterScreen mock loses its engine
  import; if any hidden assertion depended on the mock's publish side effect rather than the
  header's read, the live-title test will surface it (it asserts through the real seam).
- **Multiple publishers** — three screens publish the same unscoped query data; last publish wins,
  content-equal publishes no-op. No drift is possible because the merge is a pure function of the
  same inputs.