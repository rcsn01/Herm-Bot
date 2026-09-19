# Plan — Deepen the Workspace navigation module to own route dispatch

**Status:** finalized design, ready to implement · **Cluster:** `client/src/navigation/` + `client/src/app.tsx` + three screens
**Origin:** architecture review 2026-09-20 (second pass), candidate 1 ("Deepen the Workspace navigation module to own route dispatch"), selected from a 6-candidate report. CONTEXT.md's **Workspace navigation** entry was sharpened as part of this decision.

---

## 1. Problem (evidence)

`app.tsx` is the codebase's #1 churn hot spot (39 touches in the last 120 commits; its test file 29). The Workspace navigation module already owns the destination vocabulary, but every *dispatch* decision still lives at the call sites:

1. **The module owns vocabulary, callers own dispatch.** 11 direct engine-write calls in `app.tsx` (`setTab` ×4, `pushRoute` ×5, `resetTabRoutes` ×2 at 119, 143, 150–151, 242–244, 261–262, 267) plus 2 in `deep-links.ts` (99, 101) — a second navigation-policy writer that bypasses the Workspace navigation module entirely: deep links cannot close the menu latch (it is React state in `use-workspace-navigation.ts`), and a third writer exists in `gateway-controller.ts:372` (`resetRoutes()` at scope teardown), which also cannot touch the latch or return origin.
2. **The back tree is re-encoded per call site.** `backFromForeground` (`app.tsx:162–175`) carries the group-room / sessions / model-with-return-origin decision chain, and each screen gets its own `onBack` lambda with an inline fallback — capabilities/cron fall back to `'sessions'`, settings to the default roster (`app.tsx:242–244`). The header back in the same tab falls back to the roster (the shared closure). The fallback *why* (menu-entered destinations return to the profile surface) exists only as two inline string literals that can drift.
3. **The `'model'` pseudo-destination leaks.** Its route-shape rule is re-checked in `app.tsx:171` (`backFromForeground`) and fed out as `showModelBack={!workspace.returnOrigin}` (`:244`), while its encoding lives in `workspace-navigation.ts:81,95,103` and `use-workspace-navigation.ts:41–47` (`openModelSettings`), `67–72` (the `dismissMenu` model branch), and `81` (the `openWorkspaceDestination` model branch) — 8 sites across 3 files for one concept.
4. **Screens re-encode route plumbing.** Every stack-driven screen receives `route` + `onBack` + `onNavigate` as separate props, with an optional-props fallback pattern inside (`cron-screen.tsx`: `onBack ? onBack() : navigate(root)`, `onNavigate ?? noop`, `route ?? {type:'cron-root'}`) that duplicates fallback policy the module should own.
5. **The menu latch is unreachable from non-React code.** `menuOpenRef`/`menuOriginRef`/`menuOriginStackRef`/`returnStackRef` are hook-internal refs (`use-workspace-navigation.ts:22–25`); deep links and gateway teardown physically cannot resolve menu policy, and the ref dance exists only to survive StrictMode double-invocation — complexity that evaporates if the state lives in a store.

The interface is the test surface problem: `app-navigation.test.tsx` must hand-mock the whole screen contract (including RosterScreen's engine-publishing contract, `:36–52`) because the app root, not the module, is where behavior lives.

## 2. Design decisions (grilling record — user delegated recommended answers)

Design-it-twice ran three parallel interface designs: **D1 minimize-interface** (one `WorkspaceIntent` union + `dispatchWorkspaceIntent()` + a `$workspaceSurface` computed read), **D2 maximize-flexibility** (a destination-descriptor registry with entry modes, match predicates, per-row title/back policy, and a parse-rule head table), **D3 optimize-for-common-caller** (named dispatch verbs in the core, `$menuOpen`/`$returnOrigin` atoms, a `WORKSPACE_BACK_FALLBACKS` table, a derived header model, and a per-screen injected api). All three independently converged on the same structural insight: **the menu latch, menu-origin capture, and return-origin stack must leave React state and become policy state in the DOM-free core** — it is what makes non-React dispatchers (deep links, gateway teardown) resolvable and deletes the StrictMode ref dance.

| Decision | Choice | Rationale |
|---|---|---|
| Write-seam shape | **Named verbs in the core** (D3), tested through a resolution-table suite (D1's testing idea) | The intent union's totality is elegant but adds an indirection layer callers must decode; named verbs keep today's vocabulary (`openWorkspaceDestination`, `dismissMenu`) and read as policy at the call site. The totality idea survives as tests: one suite per resolution row. |
| Policy state placement | **`$workspacePolicy` nanostores atom in the DOM-free core** (D1 + D3) | Deep links and gateway teardown must resolve the same policy; React `useState`/refs are unreachable from them. StrictMode idempotency becomes an atom invariant, not a ref dance. |
| Read seam | **Derived values on the React adapter** (`header`, `foregroundVisible`, `foregroundDismissible`) rather than a second computed store (D1's `$workspaceSurface`) | Derived per render from `$navigation` + `$activeRoute` + `$workspacePolicy` (header destination/title/backLabel, the two visibility booleans, and the per-screen `route`/`showModelBack` reads); a hook-computed object keeps the core free of a second derived-store surface and keeps reads co-located with the verbs. |
| Scope boundary | **Dispatch + header model move behind the seam; the screen-render chain stays in `app.tsx`** | CONTEXT.md pins it: "Which screen renders, wire calls, and dialogs stay with the app root." D2's assembly component was rejected as re-litigating that record. `ChatScreen` (always-mounted cache) and `GroupChatScreen` (roster-overlay route) are not stack-driven surfaces and stay app-side. |
| Destination registry | **Rejected wholesale (D2); two pieces adopted**: `initialStacks()` derives from `MOBILE_TABS`/`ROOT_ROUTES`; the icon map stays a `Record<WorkspaceDestination, …>` compile canary | 7-field function-valued descriptors for 4 rows fails YAGNI; `workspaceDestinationFor`/titles/`workspaceBackLabel` already give one-owner reads. The parse-rule head registry is recorded out-of-scope (see §8) — URL behavior is byte-for-byte pinned by tests and e2e, and the drift class is real but small. |
| Back fallback policy | **`back(source: 'header' \| 'screen')` with the fallback encoded once** (D1's `source` distinction, verified real) | The header back falls to the roster in every tab; a screen back falls to `WORKSPACE_BACK_FALLBACKS[tab]` (cron/capabilities → `'sessions'`, settings/roster/sessions → `'roster'`). The two fallbacks genuinely differ in the same tab (`app.tsx:242` vs `:162–175`); today they are two inline literals one drift away. |
| Deep-link landing semantics | **`openChatSurface()` — closes the latch and clears the return origin** (D3; D1 kept the origin) | Unifies with roster agent entry and cron → session: landing on the chat surface fresh is the coherent policy, and a stale `'Back to menu'` label after a deep link is wrong. Documented intended delta (§3.4, Δ1). |
| Scope teardown | **`resetWorkspace()` = `resetRoutes()` + policy reset; `gateway-controller.ts` switches to it** | Today's teardown resets stacks but leaves a possibly-stale latch/origin. Strictly more correct; documented as intended delta (§3.4, Δ2). |
| Screen contract | **Injected per-screen api** (`screen(tab)` → `{ route, back, navigate }`; settings adds `showModelBack`) (D3) | Kills the optional-props fallback pattern; the interface becomes the test surface for screens. Settings' `showModelBack` rides one overload — a second tab-specific flag would justify a per-tab api map, one does not. |
| Public hook surface | **Shrinks.** `backOr`, `closeToRoster`, `exitToReturnOrigin`, `clearReturn` leave the public interface (internal helpers) | After the move their only callers are module-internal (the back tree, `openChatSurface`, `openSettings`). `menuOpen`, `returnOrigin` stay as reads (test-friendly, backLabel inputs). |
| Sessions menu & bottom nav components | **Unchanged** | They already emit intents/tap vocabulary; `workspaceMenuIntent` and `WORKSPACE_DESTINATIONS` keep their shapes (e2e pins DOM order). `navigate` guard in the menu stays menu-owned policy. |
| Group-room route read | **`groupIdFromRoute(route)` moves into the core** (from `app.tsx:288`) | `dismissForeground`/`back` need the same detection internally; the app root keeps only a decoded read for rendering data (group name, GroupChatScreen mount). |

## 3. Target design

### 3.1 Module division after the change

```
navigation/routes.ts            unchanged (typed route unions; MOBILE_TABS, ROOT_ROUTES)
navigation/navigation-store.ts  initialStacks() derives from MOBILE_TABS/ROOT_ROUTES; everything else unchanged
navigation/workspace-navigation.ts   (DEEP, DOM-free) + policy atom, dispatch verbs, back tree, reset verb
navigation/use-workspace-navigation.ts  (adapter) useStore bindings + screen(tab) factory + header model
navigation/deep-links.ts        setTab import → openChatSurface(); zero store imports
state/gateway-controller.ts     resetRoutes() → resetWorkspace()
app.tsx                         loses all store imports + back tree + per-screen fallback lambdas
features/{cron,capabilities,settings} screens  props collapse to the injected api (+ app data)
```

### 3.2 DOM-free core — `workspace-navigation.ts` (additions; existing exports unchanged)

```ts
import { $navigation, applyPathState, popRoute, pushRoute, resetRoutes, resetTabRoutes, setTab } from './navigation-store'
// Import set stays ./routes + ./navigation-store + nanostores ONLY — the DOM-free guard test
// pins this (extended in Phase 4 for the atom import; pwa/policy.ts → pwa/sw.ts pulls this
// file into the service-worker bundle).

/** Menu latch + menu-origin capture + return-origin stack. Written only by the
 *  verbs below; readable for tests. */
export interface WorkspacePolicyState {
  menuOpen: boolean
  menuOrigin: MobileTab | null
  menuOriginStack: MobileRoute[] | null
  returnOrigin: MobileTab | null
  returnStack: MobileRoute[] | null
}
export const $workspacePolicy: Atom<WorkspacePolicyState>

/** Test/setup verb, symmetric with resetNavigation. */
export function resetWorkspacePolicy(): void

/** Scope teardown: route stacks AND menu/return policy together (Δ2). */
export function resetWorkspace(): void   // resetRoutes() + resetWorkspacePolicy()

// ── Dispatch verbs (the write seam) ──

/** Open the sessions menu: capture (activeTab, copy of its stack) first, then
 *  latch if closed — capture-first order preserved; idempotent. */
export function openMenu(): void

/** Resolve a sessions-menu dismiss intent (default {type:'close'}). Closed →
 *  no-op. close → close only. tab t → origin===t ? close only : stash pair +
 *  resetTabRoutes(t) + setTab(t). model → origin already on settings-model ?
 *  close only : stash + openModelSettings(). Origin refs clear as a pair. */
export function dismissMenu(intent?: WorkspaceMenuIntent): void

/** Bottom-nav destination tap (menu closed). 'sessions' → openMenu();
 *  'model' → openModelSettings() (NO stash — bottom-nav path); else
 *  resetTabRoutes(tab) + setTab(tab). */
export function openWorkspaceDestination(destination: WorkspaceDestination): void

/** model open, shared by both entry paths: setTab('settings'); if the settings
 *  stack top is already the model category route → done; else resetTabRoutes +
 *  pushRoute(model). (The idempotency rule moves verbatim.) */
// private: openModelSettings()

/** Push a group-room route onto the roster stack (roster tap + created-group). */
export function openGroupRoom(roomId: string): void

/** Land on the chat surface fresh: clear the return pair, close the menu latch
 *  and drop its captured origin (latch closed ⇒ no capture, as today; no stash,
 *  no intent side effects), setTab('sessions'). One verb for roster agent entry,
 *  cron run → session, and deep-link landing (Δ1). */
export function openChatSurface(): void

/** Header gear: clear the return pair, resetTabRoutes('settings'), setTab('settings'). */
export function openSettings(): void

/** Committed foreground swipe: group-room route → resetTabRoutes('roster');
 *  sessions-or-group → setTab('roster'); else no-op (totality). Does NOT clear
 *  the return pair (byte-for-byte with today's closure). */
export function dismissForeground(): void

/** The whole back tree, one owner:
 *  ① group-room route → popRoute('roster'); at root → close-to-roster (clear pair + setTab('roster'))
 *  ② tab sessions → close-to-roster
 *  ③ settings ∧ settings-category ∧ 'model' ∧ returnOrigin → consume the pair
 *     (applyPathState(origin, returnStack) else setTab(origin)) and reopen the
 *     menu — the reopen recaptures the restored surface as the menu origin
 *  ④ else popRoute(activeTab); at root → exitToReturnOrigin(fallback) where
 *     fallback = source === 'header' ? 'roster' : WORKSPACE_BACK_FALLBACKS[tab] */
export function back(source: 'header' | 'screen'): void

/** Where a destination's screen back returns when its stack is already at root.
 *  Menu-entered destinations fall back to the profile surface ('sessions');
 *  the roster-entered surfaces and the header fall to the roster. */
export const WORKSPACE_BACK_FALLBACKS: { readonly [Tab in MobileTab]: MobileTab }
// roster: 'roster', sessions: 'roster', cron: 'sessions', capabilities: 'sessions', settings: 'roster'

/** Decoded read for render data (app root, dismissForeground, back internals). */
export function groupIdFromRoute(route: MobileRoute): string | null

// private: exitToReturnOrigin(fallback?), closeToRoster(), clearReturnPair(), backOr(tab, fallback)
// — the old public hook methods become module-internal helpers.
```

Unchanged core exports (pinned by existing tests): `WORKSPACE_DESTINATIONS`, `workspaceTabTitle`, `workspaceRouteTitle`, `workspaceDestinationFor`, `narrowRoute`, `workspaceMenuIntent`, `workspaceBackLabel`, `SCREEN_URL_HEADS`, `restoreWorkspacePath`, `isAppShellScreenPath`.

**Invariants (test-pinned, not implementation):**
- `$navigation` + `$workspacePolicy` are the only writable state; verbs are synchronous, never touch browser history, never await.
- `menuOpen ⇒ menuOrigin !== null`, and the converse — latch closed ⇒ no capture (`dismissMenu` clears the capture as it unlatches, `openChatSurface` drops it with the latch, `openMenu` recaptures before latching). The return pair is set only by a dismissal to a *different* surface and cleared only as a pair.
- `dismissMenu` while closed is a no-op (preserved).
- The bottom-nav `'model'` path never stashes an origin; the menu-intent `'model'` path stashes unless already there — both preserved verbatim.
- Engine guards stay unreachable through verbs: `openGroupRoom`/api `navigate` push self-routed routes; `applyPathState` only ever receives captured same-tab stacks.

### 3.3 React tier — `use-workspace-navigation.ts` (adapter)

```ts
export type WorkspaceScreenTab = 'capabilities' | 'cron' | 'settings'

export interface WorkspaceScreenApi<Tab extends WorkspaceScreenTab> {
  /** The tab's active route, narrowed; the tab root is the total fallback. */
  route: RouteForTab<Tab>
  /** Core back('screen'): popRoute; at root → exitToReturnOrigin(WORKSPACE_BACK_FALLBACKS[tab]).
   *  Tree branches ①–③ are unreachable here — no group-room or sessions route can be active
   *  under a capabilities/cron/settings api, and ③'s trigger (the model surface with a return
   *  origin) hides ModelsScreen's in-page back — so this description holds for every reachable
   *  state. */
  back(): void
  /** pushRoute(route.tab, route) — a cron screen cannot push a settings route. */
  navigate(route: RouteForTab<Tab>): void
}

export interface WorkspaceSettingsScreenApi extends WorkspaceScreenApi<'settings'> {
  /** ModelsScreen's in-page back: visible only when the model surface was
   *  reached without a sessions-menu return origin. (Absorbs showModelBack.) */
  showModelBack: boolean
}

export interface WorkspaceHeaderModel {
  /** workspaceDestinationFor(activeTab, activeRoute) — null hides the bot-workspace header AND the bottom nav. */
  destination: BotConfigurationDestination | null
  /** workspaceRouteTitle for bot destinations, else workspaceTabTitle. */
  title: string
  /** workspaceBackLabel(stackNested, destination, returnOrigin !== null). */
  backLabel: 'Back' | 'Back to menu' | 'Back to bots'
}

export interface WorkspaceNavigation {
  // reads
  menuOpen: boolean
  returnOrigin: MobileTab | null          // read for labels/tests; written only by verbs
  foregroundVisible: boolean              // activeTab !== 'roster' || group-room route
  foregroundDismissible: boolean          // sessions tab || group-room route
  header: WorkspaceHeaderModel
  // sessions menu
  openMenu(): void
  dismissMenu(intent?: WorkspaceMenuIntent): void
  // destinations
  openWorkspaceDestination(destination: WorkspaceDestination): void
  openGroupRoom(roomId: string): void
  // app-root intents
  openChatSurface(): void
  openSettings(): void
  dismissForeground(): void
  back(): void                            // == core back('header')
  // per-screen injection
  screen(tab: 'settings'): WorkspaceSettingsScreenApi
  screen<Tab extends WorkspaceScreenTab>(tab: Tab): WorkspaceScreenApi<Tab>
}

export function useWorkspaceNavigation(): WorkspaceNavigation
```

Implementation: `useStore($workspacePolicy)`, `useStore($navigation)`, `useStore($activeRoute)`; verbs are the stable core functions (no `useCallback` needed — StrictMode-safe by construction); `screen()`/`header`/visibility derive per render. Deleted from the file: the latch state, the four refs, all `useCallback` bodies, and the old public methods `backOr`/`closeToRoster`/`exitToReturnOrigin`/`clearReturn`.

### 3.4 Call sites after the change

**`deep-links.ts`** — `import { setTab } from '~/navigation/navigation-store'` deleted; both `setTab('sessions')` calls (success `:99` and catch `:101`) become `openChatSurface()` (imported from `workspace-navigation`; still DOM-free).
**Δ1 (intended):** a deep link now closes an open menu latch and clears the return origin. Today's direct `setTab` cannot do either — a menu left open over the landed chat, and a stale `'Back to menu'` label, are exactly the bug class this fixes. No other landing behavior changes (tests `deep-links.test.ts:52–53,68–69,107–108,123–124` keep their assertions and gain latch/origin assertions).

**`gateway-controller.ts`** — `resetRoutes()` at `teardownGatewayScope` (`:372`) becomes `resetWorkspace()`.
**Δ2 (intended):** scope teardown (configure-URL change, logout, profile switch) now also resets the menu latch and return pair. Today the route stacks reset but stale menu policy can survive; that is a latent bug, not a contract.

**`app.tsx`** — deleted from imports: `pushRoute`, `resetTabRoutes`, `setTab` (the mutating functions; `$navigation`/`$activeRoute` remain as **reads** for render data — `navigation.activeTab` feeds the chat wrapper (`:238–239`), `inProfile` (`:96`), and the sessions header branch (`:224`); `activeRoute` feeds `groupIdFromRoute`). Also deleted: the `narrowRoute`, `workspaceBackLabel`, `workspaceDestinationFor`, `workspaceRouteTitle`, `workspaceTabTitle` imports (their reads move into `workspace.header` and `screen()`), the derived locals `nestedRoute`, `activeBotConfiguration`, `backDestinationLabel`, `headerTitle`, `backFromForeground` (`:162–175`), `routeForGroupRoom` (`:288–290`, replaced by core `groupIdFromRoute`), and every per-screen `onBack`/`onNavigate`/`route` bundle. Kept and rewired:

```tsx
const workspace = useWorkspaceNavigation()
const navigation = useStore($navigation)                   // render-data read: chat wrapper, inProfile
const activeRoute = useStore($activeRoute)
const activeGroupId = groupIdFromRoute(activeRoute)        // decoded read for render data

const openAgent = (profile: null | string) => {
  // Enter the destination first; the wire work streams into the visible shell.
  workspace.openChatSurface()
  void controller.openProfile(profile)
}
const openSettingsFrom = () => { closeDialogs(); workspace.openSettings() }
const openCreatedGroup = (room: GroupRoom) => { closeDialogs(); workspace.openGroupRoom(room.key) }
// cron onOpenSession: await controller.resumeSession(sessionId); workspace.openChatSurface()
// MobileShell: onDismissForeground={workspace.dismissForeground}
//             foregroundVisible={workspace.foregroundVisible}
//             foregroundDismissible={workspace.foregroundDismissible}
//             foregroundNavigation={workspace.header.destination
//               ? <BotWorkspaceNavigation active={workspace.header.destination} onSelect={workspace.openWorkspaceDestination} />
//               : null}
// header: BotWorkspaceHeader gets backLabel={workspace.header.backLabel}
//         subtitle={workspace.header.title} onBack={workspace.back};
//         the plain header's back button gets the same label/verb (the group-room
//         branch keeps its hardcoded "Back to bots" aria-label — render copy);
//         the inProfile title branch uses workspace.header.title
// screens: <CapabilitiesScreen workspace={workspace.screen('capabilities')} />
//          <CronScreen onOpenSession={…} workspace={workspace.screen('cron')} />
//          <MobileSettingsScreen controller={controller} workspace={workspace.screen('settings')} />
```

The conditional render chain, the chat wrapper (`mounted-view-hidden`), `GroupChatScreen`, roster, dialogs, connection gating, and `restoreWorkspacePath` cold-start all stay — app-root territory per CONTEXT.md.

**Screens** — props collapse (required, not optional; the standalone-fallback pattern dies because fallback policy exists in exactly one place):
- `CronScreen({ workspace, onOpenSession? })` — `onOpenSession` stays a prop (wire work belongs to the caller); `route`/`onBack`/`onNavigate` come from the api. `CronJobDetail`/`CronJobEditor`/`CronBlueprintsScreen` receive `workspace.back`/`workspace.navigate` as today's equivalents.
- `CapabilitiesScreen({ workspace })` — identical narrowing behavior.
- `SettingsScreen({ controller, workspace })` — `showModelBack` comes from the settings api; `onBack`/`onNavigate` from the api.
- `ChatScreen`, `GroupChatScreen`, `RosterScreen`, `sessions-menu.tsx`, `bot-workspace-navigation.tsx`: **unchanged**.

### 3.5 Invariants to preserve (the must-list)

- Menu capture order: origin captured **before** the latch opens; open while open re-captures nothing today — preserve the current capture-then-idempotent behavior exactly (`openMenu` reads `$navigation`, writes origin refs, then latches).
- `dismissMenu` intent table byte-for-byte, including "origin === intent.tab → close only" and the model-origin dedupe.
- `exitToReturnOrigin`: destination = `returnOrigin ?? fallback`; `returnStack ? applyPathState : setTab`; reopen the menu only when both origin and stack were set — the reopen **recaptures** the restored surface as the new menu origin (so a subsequent dismiss to it closes only).
- `back` ③ consumes the return pair and reopens the menu; `back` ④'s fallback split (header → roster, screen → table) must not be merged.
- `dismissForeground` keeps today's reset-then-switch order and does not clear the return pair (documented; any fix there is a separate change).
- `openModelSettings` idempotency: setTab first, then the top-of-stack model check, then reset+push.
- Cold-start `restoreWorkspacePath` runs once, before any dispatch; URL parse and SW allowlist behavior byte-for-byte (tests pin `VALID_SCREEN_PATHS`/`REJECTED_SCREEN_PATHS` and the legacy served-only heads).
- e2e-pinned: bottom-nav DOM order/labels, header subtitle layout, no browser-history growth for menu/destination/back operations.

## 4. Implementation phases

Every phase ends with the verification suite green (§6). Commits are suggested; nothing is committed without explicit request.

### Phase 1 — Policy state + dispatch verbs in the core (additive)
1. Add `$workspacePolicy` (atom + type), `resetWorkspacePolicy()`, and the private helpers (`exitToReturnOrigin`, `closeToRoster`, `clearReturnPair`, `backOr`, `openModelSettings`) ported verbatim from `use-workspace-navigation.ts:27–103` with atom reads/writes replacing refs.
2. Add the dispatch verbs: `openMenu`, `dismissMenu`, `openWorkspaceDestination`, `openGroupRoom`, `openChatSurface`, `openSettings`, `dismissForeground`, `back(source)`, `WORKSPACE_BACK_FALLBACKS`, `groupIdFromRoute`, `resetWorkspace()`.
3. Switch `gateway-controller.ts:372` to `resetWorkspace()` and add the §5 gateway teardown case in this phase. Call-site only until Phase 3: the hook's refs still own the latch, so the policy half of the reset is not yet observable by the app. The test passes here anyway — it drives the core verbs directly, not the hook.
4. Write the core dispatch suite (§5 — one test per resolution row) driving `$navigation`/`$workspacePolicy` directly. The hook is untouched in this phase; the app still runs on the old hook.
5. Verify: `vitest run`, `typecheck`.

### Phase 2 — Deep links resolve module policy
1. `deep-links.ts`: drop the `setTab` import; both landing calls → `openChatSurface()`.
2. Update `deep-links.test.ts`: existing landing assertions hold (same store); add: menu latch closed after landing when the latch was opened (open the menu via `openMenu()`, then `accept()` → `settled()` → `$workspacePolicy.get().menuOpen === false`), and return origin cleared after landing when one was stashed. The suite's `beforeEach` gains `resetWorkspacePolicy()` next to `resetNavigation()` — the latch is store state now, and a latch left open by one test leaks into the next.
3. Verify: suite green. **Δ1 is now live** — the audit grep `rg -n "navigation-store" navigation/deep-links.ts` shows no hits.

### Phase 3 — The React adapter + app root rewire (the switch)
1. Rewrite `use-workspace-navigation.ts` as the adapter (§3.3): `screen()` factory, header model, visibility reads, verb passthrough. Delete the old state/refs/methods. Keep the file's export name `useWorkspaceNavigation` (app's only import). **Δ2 is now live** — the adapter reads the atom, so scope teardown genuinely clears the latch and return pair (Phase 1's switch was call-site only).
2. Rewire `app.tsx` per §3.4: delete the mutating store imports (`pushRoute`, `resetTabRoutes`, `setTab` — `$navigation`/`$activeRoute` stay as render-data reads), the back tree, the derived locals, `routeForGroupRoom`; wire verbs and the header model. `applyTheme`/dialogs/connection gating untouched.
3. Collapse the three screens' props per §3.4 (cron/capabilities/settings) and update their internal call sites (`CronJobDetail`/`CronJobEditor`/`CronBlueprintsScreen`/sub-screens receive the api's `back`/`navigate`). Delete the optional-fallback branches (`onBack ? onBack() : navigate(root)`, `onNavigate ?? noop`, `route ?? root`).
4. Migrate tests (§5): hook cases move to the core suite; `app-navigation.test.tsx` mock contracts update to the new props and its `beforeEach` gains `resetWorkspacePolicy()` (a fresh render no longer resets the latch — without the reset, a stale open latch from an earlier test renders SessionsMenu open and fails the launch test); screen tests build the api via `renderHook(useWorkspaceNavigation)`.
5. Verify: suite green; the audit greps:
   - `rg -n "setTab|pushRoute|resetTabRoutes|popRoute|applyPathState" app.tsx` → no hits
   - `rg -n "backOr|closeToRoster|exitToReturnOrigin|clearReturn" app.tsx src/features` → no hits
   - `rg -n "narrowRoute|workspaceBackLabel|workspaceDestinationFor|workspaceRouteTitle|workspaceTabTitle" app.tsx` → no hits (`restoreWorkspacePath` stays — cold-start parse)
   - `rg -n "'model'" app.tsx` → no hits (the pseudo-destination encoding lives in the core only)

### Phase 4 — Engine hygiene + guards
1. `navigation-store.ts`: `initialStacks()` → derived from `MOBILE_TABS`/`ROOT_ROUTES` (`Object.fromEntries(MOBILE_TABS.map(tab => [tab, [ROOT_ROUTES[tab]]])) as NavigationStacks` — `Object.fromEntries` widens the key type).
2. Extend the DOM-free guard in `workspace-navigation.test.ts` (the `?raw` source test) to assert the new core additions import no React (regex over the import block: only `./routes`, `./navigation-store`, `nanostores`).
3. Add the engine guard test to `navigation-store.test.ts`: initial navigation state carries a root stack for every `MOBILE_TAB`.
4. Verify: suite green; `pwa/policy.test.ts` untouched and green (the SW allowlist is unaffected).

### Phase 5 — Documentation
1. CONTEXT.md is already updated (done during design): verify the **Workspace navigation** entry matches the shipped interface exactly — verb names, `openChatSurface` semantics, `back(source)` fallback split, `resetWorkspace`, the `screen(tab)` api — and adjust for any drift.
2. Header comments: `workspace-navigation.ts` states the division (core owns policy state + dispatch; store stays engine; React entry is an adapter); `use-workspace-navigation.ts` states it is an adapter, not policy.

### Phase 6 — Full verification
`cd client && npm test && npm run typecheck`; `npm run test:e2e` (pwa-foundation pins the bottom-nav DOM order, header layout, and history-invisibility — the exact behaviors this refactor must not move). Manual smoke: open app → roster → tap agent (chat surface) → menu open → Automations → back to menu → Models → back to menu → header gear settings → back → push-notification-style deep link while the menu is open (menu must close on landing) → logout (no stale menu on the login screen).

## 5. Test plan (replace, don't layer)

**Migrate out of `use-workspace-navigation.test.tsx` into `workspace-navigation.test.ts`** (the verbs are core functions now; no React render needed — 17 existing cases, 7 of which drive methods that leave the public interface):

| Today (hook test) | Becomes |
|---|---|
| opens idempotently and keeps the menu out of browser history | core: `openMenu()` twice → latch once, origin captured once; `history.length`/`state` unchanged |
| does nothing when dismissing while closed | core: `dismissMenu()` closed → state untouched |
| (dismiss intent cases) | core: one test per resolution row — close-only on origin-equal tab, stash + reset + switch on different tab, model-origin close-only, model stash + open |
| (return-origin exit cases) | core: stash → `back` ③ consumes pair, restores stack, reopens menu, recaptured origin closes only |
| (closeToRoster / clearReturn cases) | core: covered inside `back` ①/② and `openChatSurface`/`openSettings` tests |
| (openWorkspaceDestination cases — sessions → menu, tab reset + select, model top kept idempotently) | core: one test per `openWorkspaceDestination` resolution row; `openModelSettings` idempotency pinned (setTab → top-of-stack model check → reset + push) |

**New core suites in `workspace-navigation.test.ts`:**
- `back(source)` tree: group-room at root vs nested; sessions → roster; model + origin → exit + reopen; settings root header → roster; capabilities root **screen** → `'sessions'` vs **header** → `'roster'` (the fallback-split pin); cron detail pop.
- `WORKSPACE_BACK_FALLBACKS` table shape (all five tabs).
- `openChatSurface`: clears the return pair, closes the latch, selects sessions; works while the menu is open; no stash.
- `openSettings`: clears the pair, resets the settings stack, selects settings.
- `openGroupRoom`: pushes onto the roster stack; second push stacks.
- `dismissForeground`: group-room → roster root + tab; sessions → roster; cron → no-op; return pair untouched.
- `openWorkspaceDestination('model')` does NOT stash (vs menu-intent path which does).
- `resetWorkspace()`: stacks to roots + policy zeroed.
- Screen-URL parse + allowlist: existing vectors unchanged (`VALID_SCREEN_PATHS`/`REJECTED_SCREEN_PATHS`, legacy heads).
- History invisibility across verbs: no `history.back`/`pushState`/`replaceState` for menu/dismiss/destination/back/return operations, and a StrictMode mount adds none (ported from the two hook history cases; e2e pins URL invariance, the core suite pins the history objects).

**Policy-state reset discipline (new test-isolation hazard):** the latch, menu-origin capture, and return pair are store state after this change — a fresh render no longer resets them. Every suite that dispatches verbs resets both stores in `beforeEach`: `resetNavigation()` + `resetWorkspacePolicy()` (core suite, adapter suite, screen tests, `deep-links.test.ts`, `app-navigation.test.tsx`, the gateway teardown case).

**`use-workspace-navigation.test.tsx` shrinks to adapter concerns:** `menuOpen`/`returnOrigin`/`header`/visibility track dispatched verbs across re-renders; `screen('cron').route` narrows a foreign active route to the cron root; `screen('settings').showModelBack` flips with the return origin; StrictMode double-render safety; verb identities stable.

**`deep-links.test.ts`:** landing assertions hold; + latch-closed and origin-cleared deltas (Phase 2).

**`app-navigation.test.tsx`:** behavior assertions survive verbatim in wording (back labels, menu latch, destination round trips, chat-instance caching, history invisibility); mocked screens' prop contracts update to the api shape; the CronScreen mock keeps `onOpenSession` (it exercises `controller.resumeSession` + landing through the real module).

**Screen tests (`cron-screen.test.tsx` etc.):** build the api with `renderHook(useWorkspaceNavigation)` + `resetNavigation()`/`resetWorkspacePolicy()` per test; back behavior exercised through the real module (pop at detail → root; pop at root → table fallback); the optional-fallback branches have no dedicated tests today (the cron tests pass `onNavigate` stubs and never render a back control), so nothing to delete there.

**`gateway-controller.test.ts`:** no existing assertions pin `resetRoutes` (verified); add one teardown case that arranges a non-zero policy first (core `openMenu()` + a dismissal to a different tab) and asserts the menu latch and return origin are zeroed after a scope teardown.

**Untouched:** the engine files (`navigation-store.ts`, `routes.ts`) and `pwa/policy.test.ts` stay as-is; `navigation-store.test.ts` gains only the derived-initialStacks guard; e2e specs (labels/DOM order preserved; only new destinations would extend the loops — none here).

## 6. Verification commands

```bash
cd client
npm test          # vitest run — all suites green at every phase
npm run typecheck # tsc --noEmit
npm run test:e2e  # playwright — pwa-foundation pins the navigation chrome
```

Audit greps after Phase 3/4 (§4 expected outputs). The manual smoke in Phase 6 is the integration check for the changed seams (menu latch × deep link × teardown are the cross-module interactions no unit test fully owns).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Back-tree semantics drift (the subtlest behavior in the app) | Byte-verbatim port into `back(source)`; one test per resolution row; the header-vs-screen fallback split pinned explicitly (capabilities root, both sources) |
| Policy atom survives across profile switches (App never unmounts) | `resetWorkspace()` at scope teardown (Δ2) covers it; a future App-unmount path would call the same verb |
| Deep-link delta (Δ1) changes a flow someone depends on | The delta is strictly closing a gap (menu closed, stale origin cleared); deep-links tests pin the new behavior; manual smoke covers link-while-menu-open |
| Screen props change ripples through screen tests | Api built via `renderHook` in one helper; optional-fallback tests deleted (replace, don't layer); behavior assertions survive verbatim |
| Service-worker bundle grows a React import (regression) | The `?raw` DOM-free guard test extends to the new core code; `pwa/policy.test.ts` stays green |
| `as const` fragility on `WORKSPACE_DESTINATIONS` (icon map canary) | Unchanged table; `Record<WorkspaceDestination, …>` ICONS map stays the compile tripwire |
| Scope creep into the parse-rule registry (D2) | Recorded out-of-scope (§8); the head table and `navigationFromPath` stay untouched |

## 8. Out of scope (recorded, not scheduled here)

- **Parse-rule head registry** (D2's `TAB_SCREEN_HEADS` with per-head `parse` functions): the URL parser is stable, byte-for-byte pinned, and e2e-backed; the drift class (head table vs hand-built parse branches) is real but small. Revisit if a destination with a URL head is added.
- **Destination-descriptor table** (entry modes / match predicates / per-row titles): 4 rows today; the existing read functions already give one-owner reads. Revisit at ~6–7 destinations.
- **Menu-intent union reshape** (`{kind:'destination', id}`): `workspaceMenuIntent` is trivial and pinned; not worth the churn.
- From the review's smaller-frictions list: PageList deletion-test failure, sessions-menu sentinel idiom, twin member-identity keys, Conversation seam trim, `compat/hermes-types.ts` split — none block this deepening.