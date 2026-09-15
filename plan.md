# Deepen the Workspace navigation

Candidate 1 from the second architecture review (September 15, 2026). The report lives at `/var/folders/th/_8dpnzf515n6h74y89jpky5h0000gn/T/architecture-review-20260915-235331.html`; the design vocabulary (module, interface, implementation, depth, seam, adapter, leverage, locality) comes from the codebase-design skill; domain terms come from `CONTEXT.md`, which this plan extends (see *Side effects applied*). The plan that previously lived in this file — the Group send engine deepening — has landed (e0705e9); it was deleted to make room for this one.

## Problem

The workspace navigation module is missing, so its policy is scattered across a fan of shallow edits. Adding or moving one screen touches about 7 production sites across 6 files, excluding the screen implementation itself. The Playwright fixture has a separate shell fallback described below:

- **Route vocabulary** (`navigation/routes.ts`): typed route unions, `MOBILE_TABS` (5 tabs), `SETTINGS_CATEGORIES` (12), `SETTINGS_ADMINISTRATION_PAGES` (16), `ROOT_ROUTES`. This part is healthy — pure data, widely imported as types.
- **URL parse** (`navigation/screen-url.ts:32-91`): per-head `if (head === 'group'|'sessions'|'capabilities'|'cron'|'settings')` branches. `screen-url.test.ts:50-51` pins that `/bot` and `/bot/extra` are rejected.
- **Service-worker allowlist** (`pwa/policy.ts:18-19`): a second, independent regex, `^\/(?:bot|group|sessions|capabilities|cron|settings|navigation)(?:\/|$)`, that accepts `bot` and `navigation` heads the parser rejects. `policy.test.ts:14` pins both legacy heads as allowed. The two production vocabularies drifted and nothing can catch it.
- **Titles** (`app.tsx:44-73`): `DESTINATION_TITLES`, `BOT_CONFIGURATION_TITLES`, and `botWorkspaceRouteTitle` (cron detail/editor/blueprints; capabilities-section; capability-detail special ids `skills-hub`, `mcp-catalog`, `mcp:new`, `skill:`, `toolset:`, `mcp:` prefixes).
- **Destination vocabularies, distinct but overlapping**: `routes.ts:1` `MOBILE_TABS` is the five app tabs, while `bot-workspace-navigation.tsx:7-12` has four workspace destinations. Its `'model'` id is intentionally a settings pseudo-destination, not a missing mobile tab. The workspace list remains a separate ownership point, and extracting it does not make new destinations automatic.
- **Destination→action mapping, duplicated**: `app.tsx:239-245` `selectBotWorkspaceDestination` (sessions→menu, model→model settings, else openDestination) vs `sessions-menu.tsx:299-303` (sessions→no-op, model→intent, else intent — the pending-guarded `navigate`/`navigateModel` emitters at 197-205).
- **Playwright shell fallback** (`client/e2e/server.mjs:145-147`): a third, test-fixture regex serves `/session` deep links plus the seven screen heads so direct e2e navigations receive `index.html`. It is not the production policy and is not included in the shared table, so a future served head requires a fixture update too.
- **Return-origin choreography** (`app.tsx:94-115, 170-202, 234-249, 261-274`): `returnTab` state + `menuOriginRef`, `menuOriginStackRef`, `returnStackRef` refs; `openNavigationPage` captures the origin; the `onDismissed` intent closure resolves tab/model intents with origin-equality short-circuits; `exitDestination` restores the return stack and reopens the menu; `clearMenuReturn`, `backToRoster`, `backFromForeground` branch tree; `modelReturnsToSurface`.
- **Menu open/close latch** (`navigation/use-navigation-page-controller.ts`, 40 lines): boolean latch + `NavigationPageDismissIntent`, one caller. Shallow. The deletion test moves complexity, it doesn't concentrate it.
- **Cold-start glue** (`navigation/initial-navigation.ts`, 10 lines): a pass-through over `navigationFromPath` + `applyPathState`, one caller. Fails the deletion test outright.
- **Per-tab narrowers and derivations** (`app.tsx:406-439`): `activeBotConfigurationDestination` (`'model'` special case), `routeForCapabilities/Cron/Settings/GroupRoom`, `openModelSettings` (idempotent model-category open), `openDestination`.

The test surface pays too: `app-navigation.test.tsx` (462 lines) mocks nine modules just to exercise the choreography, evidence the seam sits at the wrong layer. The three screen-narrower fallbacks (`routeForCapabilities`, `routeForCron`, and `routeForSettings`) are dead at runtime because `navigation-store.ts` rejects foreign routes, and they have no direct coverage. `routeForGroupRoom` is a live roster derivation and stays in App. Application-level settings-administration navigation also has no direct coverage. The replacement `narrowRoute` must test both matching and foreign-route fallback cases. The menu reopen-over-origin path is pinned at the UI level (the witness's capabilities and model round trips assert the menu reopens over the restored origin, and e2e walks all three destinations) but nowhere at the interface level.

Deletion-test verdicts: `initial-navigation.ts` means the complexity vanishes because it is a pass-through. `use-navigation-page-controller.ts` means the complexity vanishes into its one caller. The title lookups, generic route narrowing, and four-item workspace list are shallow on their own. They stay with the module's real policy for locality, not because each earns a separate seam. The return-origin state machine and parser/SW policy would otherwise remain split across App, the menu, the parser, and the service worker.

## Goal

One **Workspace navigation** module inside `client/src/navigation/`, with the interface in `workspace-navigation.ts` and the React entry in `use-workspace-navigation.ts`. After the refactor:

- `app.tsx` loses about 130 lines of choreography: no title maps, origin refs, latch, dismiss-intent closure, `openNavigationPage`/destination selection, `openDestination`/`openModelSettings`/`exitDestination`/`backToRoster`/`clearMenuReturn`/`goBackOr`/`routeForCapabilities`/`routeForCron`/`routeForSettings`/`activeBotConfigurationDestination`. `routeForGroupRoom` remains with the roster/group policy. It keeps composition: which screens render, which dialogs open, and the roster/group back policy (`backFromForeground`, swipe-dismiss reset), now expressed through module verbs.
- The module centralizes titles, production URL policy, destination-to-action policy, and back fallbacks. It does not make screen registration automatic: a new route or destination still requires the route union, parser grammar and a valid URL vector when URL-addressable, the screen/app render branch, and for a new workspace destination the local icon map/list entry.
- The production service-worker allowlist and URL parser consult one head table. That removes their duplicated head list, while per-head parser grammar and the Playwright fixture's fallback regex remain separate. The `bot`/`navigation` drift becomes an explicit, tested legacy entry instead of a second production regex.
- `initial-navigation.ts`, `use-navigation-page-controller.ts`, and `screen-url.ts` are deleted; their coverage moves to the module's interface tests.
- Zero user-visible behavior change is the target. `app-navigation.test.tsx` and `pwa/policy.test.ts` pass untouched as regression witnesses for the covered flows, not as complete proof.

## Design

### The seam

Two files, one module. The core is DOM-free so the service-worker bundle (`pwa/sw.ts` → `pwa/policy.ts`) can share its vocabulary without dragging React or the app into the worker bundle. This accepts the DOM-free `navigation-store`/nanostores dependency pulled by the shared file; the production build must keep React and app code out of the worker.

```
src/navigation/workspace-navigation.ts   ← the interface (DOM-free; imports only sibling navigation modules)
src/navigation/use-workspace-navigation.ts ← the React entry (core + navigation-store + React)
```

What the module does **not** own (stays put): `navigation-store.ts` (the route-stack engine — deep, tested), `DeepLinkCoordinator` + `parseHermesDeepLink` (session deep links), `MobileShell`/`BotWorkspaceHeader`/`BotWorkspaceNavigation` (presentation), and the roster/group back policy in `app.tsx`, including `routeForGroupRoom`.

### Core interface — `workspace-navigation.ts`

```ts
export type WorkspaceDestination = 'sessions' | 'cron' | 'capabilities' | 'model'
export type BotConfigurationDestination = 'capabilities' | 'cron' | 'model'

/** Dismiss intents emitted by the sessions menu (moved verbatim from
 *  use-navigation-page-controller.ts). */
export type WorkspaceMenuIntent =
  | { type: 'close' }
  | { type: 'model' }
  | { type: 'tab'; tab: MobileTab }

/** Single source for the workspace bottom-nav destinations and their labels, in the
 *  current order (sessions, cron, capabilities, model; the interface test
 *  pins this array order and the component renders it in that order). 'model' is a pseudo-destination: it opens the settings-category
 *  route, not a tab. bot-workspace-navigation maps ids to icons locally.
 *  Header titles stay in the two absorbed title tables (label and title
 *  coincide for every destination today, so no second field here). */
export const WORKSPACE_DESTINATIONS: readonly { id: WorkspaceDestination; label: string }[]

/** Plain destination header title (DESTINATION_TITLES absorbed). */
export function workspaceTabTitle(tab: MobileTab): string

/** Bot-configuration header title: detail-route titles for cron/capability
 *  routes, else the destination title (BOT_CONFIGURATION_TITLES +
 *  botWorkspaceRouteTitle absorbed). */
export function workspaceRouteTitle(destination: BotConfigurationDestination, route: MobileRoute): string

/** Which bot-configuration destination the active surface shows, or null
 *  (activeBotConfigurationDestination absorbed, incl. the 'model' rule). */
export function workspaceDestinationFor(tab: MobileTab, route: MobileRoute): BotConfigurationDestination | null

/** Narrow the active-route union to a tab's route type; the tab root is the
 *  fallback. Total — never throws (replaces the three routeFor* helpers). */
export function narrowRoute<Tab extends MobileTab>(tab: Tab, route: MobileRoute): RouteForTab<Tab>

/** The sessions menu's dismiss intent for a destination tap
 *  (model → {type:'model'}, else {type:'tab', tab}). 'sessions' callers
 *  guard it as a no-op themselves, exactly as today. */
export function workspaceMenuIntent(destination: WorkspaceDestination): WorkspaceMenuIntent

/** Back-label policy: nested detail wins — except the model surface with a
 *  return origin, which reads 'Back to menu' (today's modelReturnsToSurface
 *  suppression; the witness asserts it on the model round trip) — then
 *  menu-origin return, then roster. Pass surface =
 *  workspaceDestinationFor(tab, route). */
export function workspaceBackLabel(nested: boolean, surface: BotConfigurationDestination | null, hasReturnOrigin: boolean): 'Back' | 'Back to menu' | 'Back to bots'

/** Cold start only: parse a screen path and apply it to the in-memory router.
 *  Returns false — store untouched — for unknown, malformed, and /session/*
 *  paths (those belong to the DeepLinkCoordinator). '/' parses to the roster
 *  root and applies, like today's restoreInitialNavigation (a value-identical
 *  store write the cold-start effect ignores). Call once per cold start,
 *  before any user navigation. (Absorbs initial-navigation.ts.) */
export function restoreWorkspacePath(pathname: string): boolean

/** Service-worker screen-path allowlist. Derived from the same head table the
 *  parser uses: parseable heads {group, sessions, capabilities, cron, settings}
 *  plus legacy served-only heads {bot, navigation} — preserved byte-for-byte,
 *  pinned by pwa/policy.test.ts:14. First-segment prefix semantics, exactly
 *  today's regex (`^/head(?:/|$)` per served head), NOT parse success:
 *  malformed subpaths under a served head still serve the shell (e.g.
 *  '/group/a/b', '/sessions/x'), and '/session/…' stays excluded because the
 *  head 'session' is not in the table. (Absorbs pwa/policy.ts's private regex.) */
export function isAppShellScreenPath(pathname: string): boolean
```

Implementation detail: the per-head parser is private and absorbed from `screen-url.ts`. `SCREEN_URL_HEADS` (`{ head, parsable, served, legacy? }`) is exported only for the structural invariant test; no production caller consumes it directly. Its parser check admits a known parsable head but does not supply that head's branch grammar, so every parsable head still needs a positive parser vector. The title tables remain private; `WORKSPACE_DESTINATIONS` is the intended public static workspace list consumed by the presentation component.

### React entry — `use-workspace-navigation.ts`

```ts
export interface WorkspaceNavigation {
  menuOpen: boolean                 // the navigation-page latch (StrictMode-safe, idempotent open)
  returnOrigin: MobileTab | null    // today's returnTab: drives back labels and showModelBack
  openMenu(): void                  // captures origin tab + origin stack, then opens
  dismissMenu(intent?: WorkspaceMenuIntent): void
  openWorkspaceDestination(destination: WorkspaceDestination): void
  exitToReturnOrigin(fallback?: MobileTab): void  // default fallback 'roster'
  clearReturn(): void                             // today's clearMenuReturn: origin + stack, as a pair
  backOr(tab: MobileTab, fallback(): void): void
  closeToRoster(): void
}
export function useWorkspaceNavigation(): WorkspaceNavigation
```

Verbs, mapped one-to-one from today's `app.tsx` handlers:

- `openWorkspaceDestination('sessions')` → `openMenu()`; `'model'` → idempotent model-category open (`setTab('settings')` first; keep an existing model-category stack top — the check precedes the reset — else `resetTabRoutes('settings')` + push; today's `openModelSettings`); else → `resetTabRoutes(tab)` + `setTab(tab)` (today's `openDestination`).
- `dismissMenu(intent)` — latch closes, then: intent `tab` with `origin === intent.tab` → close only; intent `model` with origin already on the model category → close only; otherwise stash `{ returnOrigin: origin, returnStack: originStack }` and apply the action (today's `onDismissed` closure, verbatim).
- `exitToReturnOrigin(fallback)` — today's `exitDestination`: destination = returnOrigin ?? fallback; if a menu-originated return exists, `applyPathState(destination, returnStack)` and reopen the menu over it (recapturing the origin); otherwise `setTab(destination)`; always clear the return state as a pair, before the move, as today.
- `clearReturn()` — today's `clearMenuReturn` (returnOrigin + return stack, as a pair) without navigating.
- `backOr(tab, fallback)` — today's `goBackOr`: `popRoute(tab) === undefined` → run fallback.
- `closeToRoster()` — today's `backToRoster` (`clearMenuReturn` followed by `setTab('roster')`).

Implementation notes: `useState` for `menuOpen`/`returnOrigin`, refs for the origin/return stacks — the same shape `app.tsx` and the latch use today, so StrictMode and double-mount behavior carry over unchanged. No new atoms; `App` is the only consumer, so hook-local state suffices.

### Callers after the refactor

- **`app.tsx`** — `const workspace = useWorkspaceNavigation()`. Cold-start effect: `restoreWorkspacePath(pathname)` (the `history.replaceState` and `parseHermesDeepLink` check stay app-side — they need the deep-link coordinator). Headers read `workspaceTabTitle`/`workspaceRouteTitle`/`workspaceBackLabel(nestedRoute, activeBotConfiguration, workspace.returnOrigin !== null)`/`workspace.returnOrigin` (and `showModelBack={!workspace.returnOrigin}`); bottom nav reads `workspaceDestinationFor`; handlers become `workspace.openWorkspaceDestination(...)`, `workspace.backOr(...)`, `workspace.exitToReturnOrigin(...)`, `workspace.closeToRoster()` — capabilities/cron keep their `'sessions'` exit fallback, settings the `'roster'` default. `openAgent`, `openSettingsFrom`, and the cron `onOpenSession` call `workspace.clearReturn()` before switching (today's `clearMenuReturn` at app.tsx:177, 230, 354 — without it a stale returnOrigin survives on the roster and mislabels back labels or reopens the menu on the next root exit). `SessionsMenu` receives `onDismissRequest={workspace.dismissMenu}`. `backFromForeground` keeps its full branch tree (group-room pop-or-roster, sessions→roster, model surface with returnOrigin → exit, generic pop-or-exit — reading `workspace.returnOrigin` for the model branch), delegating to `closeToRoster`/`exitToReturnOrigin`/`backOr`; `onDismissForeground` keeps its swipe reset to the roster.
- **`sessions-menu.tsx`** — imports `WorkspaceMenuIntent` from the module; its onSelect becomes `if (destination === 'sessions' || actionPendingRef.current) return; onDismissRequest(workspaceMenuIntent(destination))` — the sessions no-op precedes the pending guard, and the model/tab intents keep `navigate`/`navigateModel`'s pending guard exactly as today (dropping it would dismiss the menu mid-action). The menu's other intent emitters (identity click, session-row open, post-resume, requestClose, edge swipe) are unchanged.
- **`bot-workspace-navigation.tsx`** — derives its list from `WORKSPACE_DESTINATIONS` (id + label) over a local icon map; `BotWorkspaceDestination` becomes an alias of `WorkspaceDestination`.
- **`pwa/policy.ts`** — imports `isAppShellScreenPath` and ORs it with the unchanged `/session/...` deep-link rule; the rest of the policy is unchanged. The SW bundle chain stays DOM-free: `sw.ts → policy.ts → workspace-navigation.ts → routes.ts + navigation-store.ts` (nanostores, no React or app code). The Playwright fixture server (`client/e2e/server.mjs:145-147`) retains its separate app-shell regex, including `/session`, and must be updated separately when a new served head is added.
- **Screens** — untouched: they keep `route` + `onNavigate`/`onBack` props and their `~/navigation/routes` type imports.

## Why this shape (design-it-twice)

Three interfaces were designed in parallel. All converged on the same seam — a DOM-free core plus one React hook, screens staying prop-bound — and differed in genericity:

- **Minimal interface** (1–3 entry points): cleanest seam, but left the exit/back verb choreography half in `app.tsx`.
- **Declarative registry** (per-destination metadata, parse, action): buys one-line destination additions for screens that mostly don't exist; honest self-verdict: over-engineering for a five-tab app. Only its static vocabulary-table idea earns its keep.
- **Common-caller-first**: same two-file seam, plus the hook owning the back/exit verbs so `app.tsx`'s refs and closures leave entirely; screens untouched.

Chosen: the hybrid — the minimal design's file shape and shared head table, the common-caller design's ownership of the return-origin and back policy, the registry design's static workspace table only. The workspace table is intentionally distinct from `MOBILE_TABS`; it does not provide automatic registration. No runtime registration machinery: with four static destinations, a registration API would be a shallow module's interface ahead of its implementation. One adapter justifies no seam; today there is exactly one SW consumer and one app consumer of the production head vocabulary, so they share the table without a port.

## Decisions (grilling rounds, self-answered)

1. **Module ownership** — route policy only; the store, deep links, and presentation stay put. *(chosen)*
2. **Dependency category** — in-process; the SW bundle is a build-time constraint, handled by keeping the core DOM-free. *(chosen)*
3. **SW drift** — preserve production behavior byte-for-byte via per-head flags (`parsable`/`served`/`legacy`); the shared table removes parser/SW head-list duplication, but parser branch grammar still needs positive vectors and the Playwright fixture regex remains separate. Tightening the allowlist is a future one-line change with a test to update, not a silent one here. *(chosen)*
4. **Deletion-test failures** — `initial-navigation.ts` and `use-navigation-page-controller.ts` are absorbed and deleted. *(chosen)*
5. **Behavior deltas** — none accepted. *(chosen)*
6. **Naming** — "Workspace navigation" in `CONTEXT.md`, with the sessions-menu overlay named in the same entry. *(chosen)*
7. **Test strategy** — replace, don't layer: module tests at the interface supersede the absorbed files' tests; `app-navigation.test.tsx` and `policy.test.ts` stay untouched as regression witnesses for their covered behavior. *(chosen)*
8. **Back policy** — the hook owns the return-origin stack and the back verbs; roster/group policy (`backFromForeground`'s group-room branch, swipe-dismiss reset) stays in `app.tsx` because it is not workspace policy. *(chosen)*
9. **Rollout** — one commit, sequenced in reviewable steps (below), tests green at each step. *(chosen)*

## Behavior preserved verbatim (known quirks included)

- History is never touched by runtime navigation: runtime routes stay in memory; cold-start screen URLs rewrite the document to `/` (`app.tsx:128-134`; menu verbs pinned no-history by `app-navigation.test.tsx:389-405` and `use-navigation-page-controller.test.tsx:17-28`, whose assertions move into the hook tests; the cold-start rewrite itself is pinned by e2e 'a screen URL is consumed as a cold-start input' and 'cold session deep links switch profile and normalize the URL').
- The sessions-tab quirk: the header back label reads "Back to menu" while `back()` routes to the roster after an identity-click return. Preserved verbatim by the zero-change constraint; recorded here as a follow-up candidate once constraints loosen.
- `openModelSettings` idempotence: an existing model-category stack top is kept, not reset.
- The menu reopen-over-origin path (`exitDestination` with `returnTab !== null && returnStack !== null`) — already exercised: the witness asserts the menu reopens over the restored origin in the capabilities and model round trips, and e2e 'bot configuration destinations return to the sessions menu' walks it for all three destinations; the hook tests pin it at the interface level.

## Test plan

**New — public functions and hook methods are the test surface; the head table is test-only structural data:**

- `navigation/workspace-navigation.test.ts`:
  - parser vectors, superseding `screen-url.test.ts` (preserve every existing vector, including a positive bare `/sessions` case, the `/capabilities/mcp` section case, `/bot` rejection, `/session/*` rejection, malformed paths, cron/capabilities/settings branches, trailing-slash and encoded segments) plus `restoreWorkspacePath` apply/reject vectors from `initial-navigation.test.ts` (a supported `/settings/model` applies; an unknown path and a session deep link with `?profile=work` reject) plus `/` → true with the roster root applied, as today;
  - after a non-roster stack is populated, every false `restoreWorkspacePath` vector leaves the active tab and all stacks untouched;
  - title table: every `botWorkspaceRouteTitle` branch (cron detail/editor/blueprints, capabilities-section, capability-detail ids and prefixes, fallbacks);
  - `workspaceDestinationFor` (tabs, model category, null);
  - `narrowRoute`: matching routes pass through, while a foreign route falls back to the requested tab's root for capabilities, cron, and settings;
  - `workspaceMenuIntent` mapping;
  - `workspaceBackLabel` mapping (nested detail; the model-surface suppression of 'Back' when a return origin exists; menu-origin return; roster fallback);
  - `isAppShellScreenPath`: parseable heads, legacy `bot`/`navigation`, unknown rejection, malformed subpaths under served heads still allowed (`/group/a/b`, `/sessions/x`), `/session/…` still rejected;
  - head-table invariants: an explicit valid-path vector for every current parsable head parses successfully and is served; every legacy head is served but unparsable;
  - a DOM-free guard: direct import specifiers stay within sibling navigation modules or `~/navigation/*` (a source scan, not a transitive bundle proof; the production build is also required).
- `navigation/use-workspace-navigation.test.tsx`:
  - latch: idempotent open, no-op close when closed, StrictMode double-mount;
  - zero history calls across every verb;
  - `dismissMenu` intent policy: origin-equality short-circuits (tab and model), return-origin stash, non-origin destinations;
  - `exitToReturnOrigin`: stack restore via `applyPathState`, menu reopen + origin recapture, fallback when no return origin;
  - `openWorkspaceDestination` mapping (sessions→menu, model idempotence, cron/capabilities reset+select);
  - `backOr` pop-or-fallback; `clearReturn` clears origin and stack as a pair without navigating; `closeToRoster`.

**Deleted (replace, don't layer):** `screen-url.test.ts`, `initial-navigation.test.ts`, `use-navigation-page-controller.test.tsx` — superseded by the module tests above.

**Untouched:** `app-navigation.test.tsx` (the regression witness — must pass unchanged), `navigation-store.test.ts`, `navigation/deep-links.test.ts`, `native/deep-links.test.ts`, `pwa/policy.test.ts` (pins the legacy heads).

Known unchanged gap: the settings component tests cover administration-screen behavior, but no test drives `SettingsScreen`'s `onNavigate` into a settings-administration route. The `/settings/profiles` parser case is not UI-navigation coverage.

## File-by-file changes

| File | Change |
|---|---|
| `src/navigation/workspace-navigation.ts` | **new** — core interface + absorbed parser, head table, titles, intents |
| `src/navigation/use-workspace-navigation.ts` | **new** — hook: latch, origin capture, dismiss policy, back verbs |
| `src/navigation/workspace-navigation.test.ts` | **new** |
| `src/navigation/use-workspace-navigation.test.tsx` | **new** |
| `src/navigation/screen-url.ts` | **deleted** — parser absorbed, private |
| `src/navigation/initial-navigation.ts` | **deleted** — deletion-test failure |
| `src/navigation/use-navigation-page-controller.ts` | **deleted** — latch absorbed |
| `src/navigation/screen-url.test.ts`, `initial-navigation.test.ts`, `use-navigation-page-controller.test.tsx` | **deleted** — superseded |
| `src/app.tsx` | title maps, refs, latch handler, `openNavigationPage`/destination selection, `openDestination`/`openModelSettings`/`exitDestination`/`backToRoster`/`clearMenuReturn`/`goBackOr`/`routeForCapabilities`/`routeForCron`/`routeForSettings`/`activeBotConfigurationDestination`/`botWorkspaceRouteTitle` leave; `routeForGroupRoom` stays with the roster/group policy; module verbs and queries replace them (about 130 lines out) |
| `src/components/sessions-menu.tsx` | intent import + onSelect mapping → `workspaceMenuIntent`, keeping the pending guard and the unconditional sessions no-op |
| `src/components/bot-workspace-navigation.tsx` | destinations derived from `WORKSPACE_DESTINATIONS`; local icon map stays |
| `src/pwa/policy.ts` | private regex → `isAppShellScreenPath` import |
| `CONTEXT.md` | Workspace navigation + Sessions menu entries added (done — see *Side effects applied*) |

## Steps

1. **Land the core.** Add `workspace-navigation.ts` + its test (valid parser vectors for every current parsable head first, then rejection atomicity, titles/intents/table). No consumers yet. Checkpoint: `vitest run src/navigation/workspace-navigation.test.ts` green.
2. **Land the hook.** Add `use-workspace-navigation.ts` + its test, replicating the latch and choreography semantics exactly (origin capture ordering, StrictMode, no-history). Checkpoint: hook tests green.
3. **Bridge the SW.** `pwa/policy.ts` delegates to `isAppShellScreenPath`. Checkpoint: `pwa/policy.test.ts` is green and unchanged, and `npm run build` emits `dist/sw.js` with the DOM-free chain.
4. **Migrate `app.tsx`.** Replace the maps, refs, latch, and helpers with the module. Checkpoint: `app-navigation.test.tsx` passes **unmodified**, serving as a regression witness for the covered app choreography.
5. **Migrate the two components.** `sessions-menu.tsx` intents; `bot-workspace-navigation.tsx` destination list. Checkpoint: `app-navigation.test.tsx` still green.
6. **Delete the absorbed files and their tests.** Checkpoint: full `tsc` + `vitest run` green; no dangling imports.
7. **End-to-end verification.** `npx playwright test` — the whole suite, not just pwa-foundation: the cron-blueprints and cron-editor specs also drive the sessions menu; then a manual browser pass: cold-start URLs (`/cron/job-1/edit`, `/group/…`, `/settings/model`), menu round trip (open → Automations → back to menu → back), model destination round trip from both surfaces, offline reload of `/bot` still serving the shell, back labels in every surface.

## Risks

- **Menu reopen semantics** — the reopen-over-origin path is gesture-adjacent; the witness and e2e already exercise it, the hook tests pin it at the interface level, and step 7 exercises it by hand.
- **StrictMode double-mount** — the latch must stay idempotent; the `isOpenRef` pattern carries over.
- **SW bundle regression** — the source guard rejects direct React/app imports, while `npm run build` must emit `dist/sw.js`; neither is a transitive-dependency proof. The current worker includes the DOM-free `navigation-store`/nanostores chain and no React, so keep those dependencies DOM-free when they change.
- **Silent policy drift returns** — the head table removes the production parser/SW head-list duplication, but it does not implement parser branch grammar and does not cover `client/e2e/server.mjs`'s fixture regex. Positive parser vectors, legacy-head assertions, the two title tables, and the intent mapping each need explicit tests; update the fixture separately for a new served head.
- **Scope creep** — no runtime registration, no URI scheme changes, no new destinations. The registry-shaped extension is a deliberate non-goal for a five-tab app (YAGNI); revisit only when a second wave of destinations actually lands.

## Side effects applied

- `CONTEXT.md` gained six appended domain terms in this commit: **Group chat**, **Group send engine**, **Group mirror**, **Known rooms**, **Workspace navigation**, and **Sessions menu**; no existing terms changed.
- The previous `plan.md` (Group send engine, landed as e0705e9) was deleted to make room for this plan, as directed.