# Implementation plan: centralize Workspace screen navigation dispatch

## Status

Ready to implement. This file is the implementation plan only; no source changes are authorized by this planning step.

## Goal

Make the DOM-free Workspace navigation core own the typed screen API projection: `route`, `back`, and `navigate`, plus Settings `showModelBack`. Today `use-workspace-navigation.ts` owns `screen(tab)` object construction and calls `pushRoute` in three tab-specific branches, even though the core claims route dispatch ownership. Move that projection and its dispatch into `workspace-navigation.ts` while preserving the current React-facing behavior and all screen caller contracts. Operations' static embedded Cron adapter is outside this live Workspace projection and stays unchanged.

The per-screen API call path changed by this plan is:

```text
app.tsx (requests screen(tab), passes the result as screen props)
              |
              v
use-workspace-navigation.ts       React subscriptions and view adapter
              | workspaceScreen(tab)
              v
workspace-navigation.ts           route policy, typed screen projection, dispatch
              | pushRoute(...)
              v
navigation-store.ts               route-stack state engine
```

This is not the full core dependency graph. `app.tsx` also reads route state and imports `groupIdFromRoute` and `restoreWorkspacePath` directly. `sessions-menu.tsx`, `bot-workspace-navigation.tsx`, `navigation/deep-links.ts`, `state/gateway-controller.ts`, and `pwa/policy.ts` also import existing core exports. Those call paths stay unchanged.

## Decisions adopted

The following choices are settled for this plan. There are no open design questions.

| Decision | Adopted answer | Reason |
| --- | --- | --- |
| Scope of the seam | Deepen the existing Workspace navigation core. Move the full per-screen projection and route writes, not just a one-line `pushRoute` forwarding wrapper. | The current core owns `back`, `narrowRoute`, and route policy, but the adapter reconstructs the screen navigation model. Consolidating that model creates one coherent dispatch owner. |
| React adapter | Keep `useWorkspaceNavigation()` as the React binding. It remains responsible for `useStore` subscriptions, header derivation, and React-facing reads, then delegates `screen(tab)` to the core. | React state observation remains at the React boundary; route decisions and writes belong in the core. |
| Existing callers and types | Preserve `useWorkspaceNavigation().screen(tab)`, the shape and generics of its result, and type imports from `~/navigation/use-workspace-navigation`. Move screen interface ownership into the core and re-export those types from the existing hook module. | Cron, Capabilities, Settings, and Operations consume these types. No screen call-site migration is needed. |
| Route-stack store | Keep `navigation-store.ts` and `routes.ts` unchanged. The store remains the state engine and retains `pushRoute` validation. | The requested seam is above the store; no route-stack rewrite is needed. |
| Dependencies and concepts | Add no package, adapter, or new domain vocabulary. Keep the core DOM-free and preserve its allowed import set. | This is an in-process ownership change, not a new platform boundary. |
| Tests | Add direct tests for the core-owned screen projection and dispatch. Keep React hook, screen, store, and browser tests as integration coverage. | Each test layer protects a distinct boundary; existing behavior remains part of the contract. |
| Documentation | Update the existing Workspace navigation entry in `CONTEXT.md` to describe the new ownership split. Do not add an ADR; no tracked ADR exists to update. | Keep architecture guidance accurate without introducing a new documentation structure. |

## Current evidence and constraints

- `client/src/navigation/workspace-navigation.ts` documents that it owns route policy and dispatch and must remain DOM-free. `client/src/pwa/policy.ts` imports it, and `client/src/pwa/sw.ts` imports that policy, so the core is in the service-worker dependency graph. Its tested imports are exactly `./navigation-store`, `./routes`, and `nanostores`.
- `client/src/navigation/use-workspace-navigation.ts` currently has three screen-specific `pushRoute` branches for settings, cron, and capabilities. Each branch builds `route`, `back`, and `navigate`; Settings also reads `$workspacePolicy.returnOrigin` for `showModelBack`.
- The current projection narrows the global `$activeRoute`, not the requested tab's retained stack. If Cron has a detail route but Settings is active, `screen('cron').route` is the Cron root. Its `navigate` pushes onto the requested tab's stack without selecting that tab. Its `back` always calls `back('screen')`, which operates on the globally active tab; it is not scoped to the `tab` argument. Preserve all three behaviors.
- `client/src/app.tsx` is the only production caller of `workspace.screen(...)`: it requests capabilities, cron, and settings and passes those values to `CapabilitiesScreen`, `CronScreen`, and `SettingsScreen`. Those screens use `navigate` for capability sections/details, cron roots/details/editors/blueprints, and settings categories/administration pages. Keep these caller sites and contracts unchanged.
- Other production modules call the core directly: `app.tsx` reads `groupIdFromRoute` and `restoreWorkspacePath`; `sessions-menu.tsx` uses `workspaceMenuIntent`; `bot-workspace-navigation.tsx` uses `WORKSPACE_DESTINATIONS`; `navigation/deep-links.ts` uses `openChatSurface`; `state/gateway-controller.ts` uses `resetWorkspace`; and `pwa/policy.ts` uses `isAppShellScreenPath`. Do not reroute or change these clients.
- `WorkspaceScreenApi`, `WorkspaceSettingsScreenApi`, and `WorkspaceScreenTab` are currently exported from `use-workspace-navigation.ts`. `capabilities-screen.tsx`, `cron-screen.tsx`, `settings-screen.tsx`, and `operations-screen.tsx` import screen types from that path; the hook tests import `WorkspaceNavigation` from it.
- `OperationsScreen` embeds `CronScreen` outside the Workspace module with a static Cron root route, `onBack`, and a no-op `navigate`. Preserve this embed behavior and its type import; it does not dispatch into the Workspace route stack.
- `navigation-store.test.ts` already covers wrong-stack runtime rejection by `pushRoute`. Preserve this validation by continuing to delegate through `pushRoute`, rather than writing stacks directly.
- `workspace-navigation.test.ts` pins the core's exact imports to `./navigation-store`, `./routes`, and `nanostores`. It also exercises `narrowRoute`, route policy, history isolation, and the DOM-free guard.
- `use-workspace-navigation.test.tsx` covers header and foreground derivation, Cron detail navigation and header/back updates, root fallback, Settings `showModelBack`, stable verb identities, and StrictMode/history behavior. Preserve all of it.
- `client/e2e/pwa-foundation.spec.ts` exercises runtime Cron and Capabilities navigation, nested headers, back/return-origin behavior, and the unchanged URL. `client/e2e/cron-editor.spec.ts` exercises the editor-to-detail route after save. Playwright is configured for Chromium and WebKit with a local fixture server.
- `CONTEXT.md` already has a Workspace navigation entry. No tracked ADR exists to update.

## Intended design

### Core module

In `client/src/navigation/workspace-navigation.ts`:

1. Own `WorkspaceScreenTab`, `WorkspaceScreenApi<Tab>`, and `WorkspaceSettingsScreenApi`, preserving the existing tab-specific `RouteForTab<Tab>` route type.
2. Export one typed core function, named `workspaceScreen(tab)`, that constructs the complete screen navigation value for a Workspace tab. Give it a settings-literal overload returning `WorkspaceSettingsScreenApi`, a generic `Tab extends Exclude<WorkspaceScreenTab, 'settings'>` overload returning `WorkspaceScreenApi<Tab>`, and a `WorkspaceScreenTab` overload returning the settings/capabilities/cron API union. The last overload lets the React adapter delegate its union-typed `tab` without a cast; the implementation returns the same union.
3. Resolve `route` by applying the existing `narrowRoute` behavior to the global `$activeRoute`. Do not read the requested tab's retained stack when another tab is active; a foreign active route falls back to the requested tab's root.
4. Provide `back` as `() => back('screen')`. It remains global to the active navigation tab and is not bound to the requested screen tab.
5. Provide `navigate` as `route => pushRoute(tab, route)`. Keep the tab-specific `RouteForTab<Tab>` contract. This pushes only to the requested stack, does not select that tab, and retains `pushRoute` runtime validation; do not write to `$navigation` directly.
6. For settings, derive `showModelBack` from `$workspacePolicy.get().returnOrigin === null`, exactly as today; do not derive it from the route or destination.
7. Read `$activeRoute` and `$workspacePolicy` from the existing stores. The function must not import React or `@nanostores/react`, accept hidden state from the hook, or duplicate/copy the policy.
8. Keep the existing `narrowRoute` export and its direct tests. Keep all existing core imports within the DOM-free guard's exact allowed set.

### React adapter

In `client/src/navigation/use-workspace-navigation.ts`:

1. Preserve the return type and public shape of `useWorkspaceNavigation()` and its settings-specific and generic `screen(tab)` overloads.
2. Keep all three current store subscriptions and the header/foreground derivation.
3. Replace the three local screen-object branches and the direct `pushRoute` import with delegation to `workspaceScreen(tab)`.
4. Re-export `WorkspaceScreenTab`, `WorkspaceScreenApi`, and `WorkspaceSettingsScreenApi` from the core at this existing module path. Keep `WorkspaceNavigation` owned by the React adapter because it includes React-facing derived state and verbs.
5. Do not change screen props or imports. In particular, keep the three `app.tsx` screen() calls and `OperationsScreen`'s no-op embedded Cron navigation behavior unchanged.

The core function should return the same values and trigger the same route transitions as the current hook implementation. Do not change URL/history behavior, the tab stacks, route titles, menu/return-origin policy, or screen rendering.

## File-by-file work

### `client/src/navigation/workspace-navigation.ts`

- Add the three screen-related exported types currently declared in the hook module.
- Add the typed `workspaceScreen(tab)` projection and dispatch function using the active route, `narrowRoute`, `back`, `$workspacePolicy`, and `pushRoute`.
- Preserve the core import set, DOM-free constraint, existing `narrowRoute` behavior, and runtime route-stack validation.

### `client/src/navigation/use-workspace-navigation.ts`

- Import and delegate to `workspaceScreen`.
- Remove screen-specific route construction and direct `pushRoute` calls.
- Re-export the moved screen types from this module to preserve current type-import paths.
- Leave subscriptions, derived header/foreground properties, other verb identities, and the `WorkspaceNavigation` interface unchanged.

### `client/src/navigation/workspace-navigation.test.ts`

- Add focused tests for all fields of the core-owned screen projection: `route`, `back`, `navigate`, and Settings `showModelBack`.
- For each of capabilities, cron, and settings, call `navigate` with a representative typed route (a capabilities section, a Cron job detail, and a settings administration page) and assert that only that tab's stack changes and `activeTab` stays unchanged. Also pass a wrong-tab route through a deliberate runtime cast and assert that the projection still throws via `pushRoute` without changing any stack.
- Test `route` with a matching active route for each screen tab. For the foreign-route fallback case, first give the requested inactive tab a nested route, then activate another tab; assert that the projection returns the requested tab's root rather than reading its retained stack.
- For each screen tab, test that projected `back` pops a nested route. Also call `workspaceScreen('cron').back()` at an active capabilities root and assert it follows the globally active tab's screen-source fallback to Sessions, not the header's roster fallback. This pins that `back` is not scoped to the `screen(tab)` argument.
- Test Settings `showModelBack` as true when `returnOrigin` is null and false when it is non-null.
- Retain the existing `narrowRoute`, policy, history-isolation, and DOM-free guard tests here. Keep the wrong-stack `pushRoute` test in `navigation-store.test.ts`; do not move or weaken it.

### `client/src/navigation/use-workspace-navigation.test.tsx`

- Keep all existing React-binding tests: header/foreground derivation, Cron detail navigation and header/back round trip, root fallback, Settings `showModelBack` lifecycle, stable verb identities, and StrictMode/history behavior.
- Add a compile-only `@ts-expect-error` assertion that `WorkspaceScreenApi<'cron'>.navigate` rejects a Capabilities route, so moving the types cannot silently widen the tab-specific route contract. Put the call in an unreachable/type-only assertion so it is not executed by Vitest.

### `CONTEXT.md`

- Refine the existing Workspace navigation entry to state that the core owns the per-screen route projection (`route`, `back`, `navigate`, and Settings `showModelBack`), while the React entry subscribes and delegates.
- Keep the existing distinction between the navigation core and the route-stack store. Do not add a new architecture term or separate document.

### Intentionally unchanged

- `client/src/navigation/navigation-store.ts` and `client/src/navigation/routes.ts`.
- `client/src/app.tsx`, screens, and screen callers, including `operations-screen.tsx`.
- Package manifests, dependencies, route URL parsing, browser history, screen behavior, and unrelated navigation policy.

## Implementation sequence

1. Before editing source, inspect `git status` and confirm there are no unexpected changes in the target files. Preserve any unrelated user work. The replacement `plan.md` is expected to be present as the planning change.
2. Move the screen types into `workspace-navigation.ts` and implement the typed core projection using existing store and route operations.
3. Refactor `use-workspace-navigation.ts` to delegate `screen(tab)` and re-export the moved types. Keep its React subscriptions intact.
4. Add core screen-projection/dispatch tests and the compile-only tab-route type assertion. Keep the React binding tests intact; test the new core API directly rather than moving or replacing hook coverage.
5. Update the single Workspace navigation description in `CONTEXT.md`.
6. Run the focused tests and source audits below. Fix only issues caused by this plan; do not expand into route-store or UI redesign.
7. Run full verification in the order below, including the browser flow because route dispatch is user-visible.

## Verification plan

Run commands from `client/` unless noted.

### Focused unit and integration tests

```sh
npm test -- \
  src/navigation/workspace-navigation.test.ts \
  src/navigation/use-workspace-navigation.test.tsx \
  src/navigation/navigation-store.test.ts \
  src/features/capabilities/capabilities-screen.test.tsx \
  src/features/cron/cron-screen.test.tsx \
  src/features/settings/settings-screen.test.tsx \
  src/app-navigation.test.tsx
```

This validates the core projection, React subscription boundary, route-store rejection behavior, screen callers, and app navigation integration. Operations has no dedicated screen test file; its existing type import and embedded no-op adapter must continue to compile.

### Static and complete test verification

```sh
npm run typecheck
npm test
npm run build
```

The build is required because the core is included in the service-worker bundle. The existing DOM-free guard must still pass with the exact import set `./navigation-store`, `./routes`, and `nanostores`.

### Browser verification

```sh
npm run test:e2e -- e2e/pwa-foundation.spec.ts \
  --grep 'runtime screen and navigation routes stay out of the browser URL|workspace tabs share a stable header without redundant menu buttons'
```

Run these two existing flows in both configured Chromium and WebKit projects. They cover Cron and Capabilities navigation, nested route headers, back behavior, and the invariant that runtime route transitions do not alter the startup URL. Do not run the full PWA fixture suite for this change; its auth, chat, group, and offline cases are unrelated. Leave out the full Cron editor form/save E2E: the changed boundary is the shared `navigate` operation, which the direct core and React-hook tests exercise with a Cron job-detail route; no Cron editor or save code changes. Do not add an E2E fixture unless an existing test cannot exercise the unchanged flow.

### Source ownership audit

From the repository root, verify:

```sh
rg -n "pushRoute" client/src/navigation/use-workspace-navigation.ts
rg -n "pushRoute" client/src --glob '!**/*.test.*'
rg -n "WorkspaceScreenApi|WorkspaceSettingsScreenApi|WorkspaceScreenTab" client/src
```

Expected results:

- The first search has no matches.
- Production `pushRoute` references are confined to `workspace-navigation.ts` calling the store operation and `navigation-store.ts` defining it. Other modules may still read navigation stores.
- Screen type declarations are in the core and are re-exported from the hook path; existing screen and Operations imports need no changes.

Also inspect the final diff and `git status`. The implementation diff should contain only the two navigation modules, their focused tests, the `CONTEXT.md` clarification, and this plan file. This plan review changes `plan.md` only; implementation and test execution remain separate work.

## Acceptance criteria

- `useWorkspaceNavigation().screen(tab)` has the same call shape and behavior as before.
- Existing imports of screen types from `~/navigation/use-workspace-navigation` continue to compile.
- `workspace-navigation.ts` owns construction of the typed per-screen route/back/navigate model and Settings `showModelBack`.
- The React hook does not import or call `pushRoute` and remains responsible for React subscriptions and derived React-facing state.
- The `RouteForTab` contract remains tab-specific, and `pushRoute` still rejects a wrong-stack route at runtime.
- Cron, Capabilities, and Settings stacks, root fallbacks, back behavior, and Settings model-return behavior are unchanged. The projection reads the globally active route, pushes to the requested tab without selecting it, and preserves the unscoped `back('screen')` behavior.
- `OperationsScreen` can still embed Cron with a static root route and no-op navigation.
- The core remains DOM-free with the exact tested import set; no new dependency, adapter, route store, or domain term is introduced.
- Focused tests, full tests, typecheck, build, and the targeted browser tests pass.
- `CONTEXT.md` accurately describes the finalized ownership split.

## Risks and stop conditions

- **Type widening during extraction:** Stop if the generic tab-to-route relationship cannot be preserved cleanly. Do not replace it with a union-wide `MobileRoute`, `any`, or a broad cast. Keep the compile-only negative assertion.
- **Core boundary regression:** Stop if the implementation requires React, browser APIs, app imports, or a fourth core import specifier. Do not weaken or rewrite the DOM-free guard to accommodate it.
- **Runtime validation bypass:** Do not manipulate route stacks directly from the core screen projection. All route pushes must pass through `pushRoute` so wrong-stack runtime rejection remains intact.
- **Behavior drift:** If tests show changes to active-route narrowing (including a retained inactive-tab detail), stack ownership or active-tab selection on `navigate`, the global `back('screen')` behavior, return-origin behavior, header state, or URL behavior, correct the projection rather than updating expected behavior.
- **Scope creep:** Do not modify route parsing, service-worker policy, `navigation-store.ts`, screen flows, or unrelated documentation. If any of those changes appear necessary, stop and reassess the seam before expanding scope.
