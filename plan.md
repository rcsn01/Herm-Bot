# Deepen settings autosave persistence

## Goal

Create one deep settings autosave module for profile-default configuration fields. The module will concentrate debounce timing, one-at-a-time remote writes, per-field revision handling, optimistic React Query updates, last-confirmed baselines, rollback, Scope and category guards, request abort, cache invalidation, and error classification behind a small React-facing interface.

`ConfigSectionScreen` will retain configuration and schema queries, category lookup, field selection, labels, rendering, refresh controls, and navigation. `SettingsApi.savePartial` will remain the remote adapter seam and the only settings module involved in config-route vocabulary.

This is primarily an architecture refactor, but it should correct two persistence defects exposed by moving the behavior behind a direct test seam:

1. If one same-field write succeeds and the next write fails, rollback must restore the first confirmed value, not the value from before both writes.
2. Category, Profile, remote Gateway, and unmount cleanup must not leave an unsaved optimistic value in an old query cache or permit a delayed write to start.

No unrelated settings administration, Model editing, field rendering, or route behavior should move into this module.

## Why this work is needed

`client/src/features/settings/config-section-screen.tsx` currently combines two different responsibilities:

- rendering one settings category from schema and config queries;
- implementing a 450 ms autosave state machine with timers, pending and active maps, revisions, optimistic cache writes, partial payload construction, serialized requests, abort controllers, rollback, Scope/category generations, and user-facing failures.

The six current screen tests exercise persistence policy by rendering fields and waiting on real time: partial payload/profile binding, rejection rollback, different-field serialization, a newer same-field edit behind an active write, pre-debounce Profile cleanup, and stale in-flight rejection suppression. This proves the behavior exists, but makes the screen the only test seam for concurrency and cleanup. The test suite does not directly pin category changes, remote-URL changes, unmount teardown, active-request abort, cache restoration after returning to an old Scope, `{ ok: false }`, rollback to the most recently confirmed same-field value, or a cache update that lands while a draft exists.

The deletion test supports this deepening. If the proposed module were removed after migration, the complete autosave state machine would have to return to `ConfigSectionScreen`; its complexity would not disappear.

## Decisions made

These choices use the recommended answers to the interface and testing questions.

### 1. Choose a dedicated React hook, not a generic autosave framework

Create `client/src/features/settings/use-config-autosave.ts` as the module interface and implementation. It will be a headless React hook because its work is inherently coupled to React Query subscriptions, React lifecycle cleanup, browser timers, and Scope-aware hooks.

Do not add a DOM-free engine with public clock, cache, draft, and callback ports. That alternative exposes most implementation mechanics through its interface and becomes shallow. Do not add generic `AutosaveCache<K, V, T>` and `AutosaveAdapter<K, V, T>` types. There is one current caller, and Model editing already has a deep module with materially different immediate/debounced and per-field queue policy.

The dedicated hook gives the current caller the highest leverage: the screen states an edit and asks for the displayed value; the implementation owns everything else.

### 2. Keep the seam inside the settings feature

The module sits between `ConfigSectionScreen` and these existing dependencies:

- `SettingsApi.savePartial` as the remote-owned production adapter;
- a narrow fake writer as the test adapter;
- React Query as the local cache adapter;
- `beginScopedTask` and `useScopeReset` as the existing Scope toolkit;
- `getConfigValue` and `setConfigValue` as the existing safe nested-config helpers.

Do not define a second transport port around `SettingsApi`. Production and tests already vary at the existing adapter seam. Do not change `settings-api.ts`, `gateway-api.ts`, `scope-guard.ts`, or `MemoryGateway` unless a failing contract test proves an existing defect.

### 3. Preserve screen ownership

`ConfigSectionScreen` continues to own:

- `useApi(createSettingsApi)` binding;
- the scoped config and schema query keys and queries;
- category registry lookup and field filtering;
- loading, query-error, empty-category, and voice-resource rendering;
- `ConfigField` rendering and field labels;
- the manual config/schema refresh button;
- back navigation and Profile badge.

The autosave module owns only edit persistence and the value overlay needed to keep optimistic drafts stable while background cache work occurs.

### 4. Use one hook-local write lane

Keep one active remote write per mounted autosave hook, matching current behavior. Every field has an independent debounce reservation, but all ready writes enter one insertion-ordered lane.

Do not introduce a module-global queue. Only one config category screen is mounted at a time, category changes reset the lifecycle, and a global registry would add cross-instance retention without a proven caller. Do not coordinate this lane with `useModelConfigEditing`; Model editing is already a separate deep module and has different immediate/debounced and per-field queue policy. The two modules also use distinct existing query keys for the same remote config: `['gateway', connection, profile, 'settings', 'config']` here and `['gateway', connection, profile, 'models', 'config']` in Model editing. Preserve those keys and do not add cross-domain invalidation in this refactor. The nearby Model tests are regression coverage, not a claim that the two caches become synchronized.

### 5. Roll back to the last confirmed field value

Maintain a field record whose confirmed baseline advances after every successful write, even when a newer edit for the same path is already pending. A failure of the newest current revision restores that confirmed baseline. An older failed revision never rolls back or reports an error over a newer draft.

This deliberately fixes the current stale-baseline behavior. It does not add cross-field or cross-request transactionality; the Gateway accepts partial config patches independently.

### 6. Treat cleanup as persistence policy

On category change, Profile change, remote-URL change, or unmount, the hook must:

- increment its lifecycle epoch;
- clear every debounce timer;
- remove pending work;
- abort the active request;
- suppress late success and failure effects;
- clear draft and error state while mounted;
- restore unconfirmed optimistic field values only when the cached path is still `Object.is`-equal to the exact value written by this hook;
- invalidate the captured query with `refetchType: 'none'` when an active request may have reached the Gateway or the outgoing lifecycle already has deferred invalidation work.

Category changes and Scope changes do not have the same cache shape. Every config category shares the same settings config key, while Profile and remote-URL changes produce distinct keys. Cleanup nevertheless uses one invalidation rule: mark the captured key stale without starting a refetch during abort teardown. An old Scope refetches when it mounts again. A category change keeps observing the same stale key and the restored confirmed baseline; it does not invent a second cache entry or claim an immediate authoritative refetch after an uncertain abort.

The cleanup function captured by the previous render must operate on the previous query key, field records, and adapter lifecycle. It must not read only the newest options. It may clear React state when a new mounted lifecycle replaces the old one, but the returned unmount cleanup must only mutate refs, cache, timers, and abort controllers.

## Proposed interface

Create `client/src/features/settings/use-config-autosave.ts` with a small settings-specific interface:

```ts
import type { QueryKey } from '@tanstack/react-query'

import type { HermesConfigRecord } from '~/lib/types'
import type { SettingsApi } from './settings-api'

export interface UseConfigAutosaveOptions {
  category: string
  config: HermesConfigRecord | undefined
  queryKey: QueryKey
  settings: Pick<SettingsApi, 'savePartial'>
}

export interface ConfigAutosave {
  error: string | null
  valueFor(path: string): unknown
  change(path: string, value: unknown): void
}

export function useConfigAutosave(
  options: UseConfigAutosaveOptions
): ConfigAutosave
```

The interface includes `category` only as a caller-owned lifecycle identity. Scope identity remains hidden in `useScopeReset` and `beginScopedTask`. `queryKey` and `config` are values the screen already owns for rendering, and the module needs them to update the same cache entry. The caller does not receive reset, flush, retry, queue, timer, revision, abort, or invalidation controls.

Return the classified message string, matching the screen's current error state and `<div className="error-banner" role="alert">` rendering. The hook still classifies caught failures internally, but it does not expose classification metadata that no caller consumes or change a save failure into `GatewayErrorBanner`'s special unsupported-capability presentation. `change` remains synchronous: it applies the optimistic value immediately and schedules persistence. There is no caller-visible save promise because debounce and replacement mean a single edit call does not map cleanly to one remote completion.

The intended caller becomes:

```tsx
const autosave = useConfigAutosave({
  category,
  config: config.data,
  queryKey: key,
  settings
})

{autosave.error && <div className="error-banner" role="alert">{autosave.error}</div>}

<ConfigField
  onChange={value => autosave.change(path, value)}
  value={autosave.valueFor(path)}
  // existing schema and description props
/>
```

Do not export internal queue records, lifecycle epochs, debounce constants, or helper functions solely for tests. The interface is the test surface.

## Internal behavior

### Field records

Keep one private record per edited path with:

- the last Gateway-confirmed value;
- the latest local revision number;
- the current draft value, if any;
- the latest pending operation, if any;
- the current debounce timer, if any.

Capture the confirmed baseline from `queryClient.getQueryData(queryKey)`, falling back to `options.config`, only when the field first becomes dirty in the current lifecycle. `undefined` is a valid confirmed baseline. Never replace that baseline from a background refetch while the field has a draft.

The schema query can finish before the config query, and the current screen renders fields in that state. If `change` runs before either the cache or `options.config` contains a config record, keep the draft and send the partial write, but do not synthesize a partial record as successful query data. At that boundary, `valueFor` uses the draft overlay while the original config query continues. This preserves query loading semantics instead of turning an incomplete optimistic object into the config query result.

### Edit path

For every `change(path, value)` call:

1. Read or create the field record.
2. Increment that path's revision.
3. Replace its pending operation with the newest value while preserving the confirmed baseline.
4. Store the draft so `valueFor(path)` remains stable across query invalidation or refetch.
5. Apply the nested value optimistically when the cache or `options.config` contains a full config record; otherwise leave the query data absent and rely on the draft overlay.
6. Clear only the previous timer for that path.
7. Start a new 450 ms timer associated with the current lifecycle epoch, revision, category, and Scoped task.
8. Do not start remote work if that timer later proves stale by revision, lifecycle, or Scope.

Preserve the existing safe nested-path rules by using `setConfigValue`; do not duplicate its prototype-pollution checks.

### Queue and request path

When a current timer expires, mark that path's latest operation ready and drain the lane:

1. Return immediately if another request is active.
2. Choose the first ready operation in the pending map's insertion order. Replacing a pre-debounce operation for an existing path retains that path's current map position; inserting a newer operation after its predecessor became active gives it a new position behind already-pending paths.
3. Remove it from pending work and mark it active.
4. Build a one-field patch with `setConfigValue({}, path, value)`.
5. Call `settings.savePartial(patch, abortController.signal)`.
6. Treat an aborted signal or stale lifecycle/Scope as silent cancellation.
7. Treat `{ ok: false }` as `The gateway rejected this setting.` and classify it through `classifyGatewayError`.
8. On success, advance that field's confirmed baseline to the submitted value even if a newer revision exists.
9. If success is also the newest revision, remove the draft and clear the current autosave error.
10. If failure belongs to the newest revision, restore only that path to its confirmed value when the cached value is still `Object.is`-equal to the submitted value, remove its draft, and publish the classified error. If the cache differs, leave it untouched and request deferred invalidation.
11. If failure belongs to an older revision, leave the newer draft, cache, and error state untouched.
12. Release the active slot in `finally` and drain the next ready operation only while lifecycle and Scope remain current.

At no time may two `savePartial` calls from the same hook overlap.

### Cache policy

Apply optimistic values immediately when full query data exists, but defer ordinary query invalidation until the lane is fully idle: no active request, pending operation, or debounce timer remains. This prevents a refetch after one field succeeds from overwriting another field's unsaved optimistic cache value.

Maintain one private `needsInvalidation` flag. Set it after any successful request and when rollback declines to overwrite a cache value the hook no longer owns. When the lane becomes idle, consume the flag and invalidate the config query once. A mixed batch with one failure and one success still invalidates because a success occurred. Keep local drafts until their own newest write succeeds, so a refetch cannot visibly regress another edited field.

A normal current failure whose ownership check permits rollback does not invalidate by itself; the cache is already restored to the module's confirmed baseline. Cleanup marks the captured query stale with `refetchType: 'none'` if an active request was aborted or `needsInvalidation` was already set. The first condition covers an uncertain Gateway commit; the second preserves deferred success or ownership-mismatch invalidation when lifecycle teardown prevents the ordinary idle drain.

### Error policy

- Keep one displayed error. A failure may publish only when it is the newest revision for its path and its lifecycle and Scope are current.
- Suppress abort and stale Scope/category errors.
- Preserve the current rejection message for `{ ok: false }`.
- Clear the error when a newest-revision current save succeeds. Do not clear it merely because the user starts another edit, and do not add automatic retry.
- An older same-field operation must not clear or replace state belonging to its newer draft.

## Detailed implementation sequence

Use vertical red-green slices. Do not write all tests before all implementation.

### Step 1: Document the module

Update `CONTEXT.md` with a concise **Settings autosave** entry:

- name `features/settings/use-config-autosave.ts` as the deep module;
- state that it owns debounce, global-within-screen ordering, confirmed baselines, optimistic config cache updates, rollback, error classification, invalidation, abort, and Scope/category lifecycle;
- state that `ConfigSectionScreen` owns queries, category selection, schema interpretation, and rendering;
- state that `SettingsApi.savePartial` remains the remote adapter seam;
- distinguish it from the existing Model editing module.

This prevents future work from merging two persistence policies merely because both write `/api/config`.

### Step 2: Add the smallest tracer test and hook

Create:

- `client/src/features/settings/use-config-autosave.ts`
- `client/src/features/settings/use-config-autosave.test.tsx`

Start with one fake-timer hook test that supplies a real `QueryClient`, a loaded config cache, and a narrow fake `savePartial` adapter. Assert that:

- `change('display.personality', 'concise')` updates `valueFor` and the loaded query cache immediately;
- no request starts before 450 ms;
- the request contains only `{ display: { personality: 'concise' } }`;
- success removes the draft and leaves the confirmed value visible.

Add the boundary case where schema-backed UI calls `change` while both cache data and `options.config` are absent. The draft must render and save, but the hook must not seed the config query with a partial object.

Implement only enough hook state, timer handling, partial-patch construction, and success handling to pass this slice.

### Step 3: Add independent debounce and serialization

Add tests one at a time for:

1. Repeated edits to one path before 450 ms send only the newest value.
2. Two paths debounce independently.
3. Once both are ready, the second request does not start until the first settles.
4. Ready work drains in pending-map insertion order, including replacement before debounce and reinsertion behind other fields after a same-field predecessor becomes active.

Then add per-path timers, revisions, the pending map, and the single active slot. Use Vitest fake timers rather than 500 ms sleeps.

### Step 4: Add confirmed-baseline semantics

Add vertical tests for:

1. A latest current failure restores the original confirmed field and preserves an unrelated optimistic field.
2. A first same-field write succeeds, a second same-field write fails, and rollback restores the first submitted value.
3. An older same-field write fails while a newer edit exists; the newer draft remains visible and no stale error appears.
4. `{ ok: false }` follows the same rollback path with the existing rejection message.
5. A background cache replacement during a draft prevents rollback from overwriting that replacement; the hook removes its draft, reports the save failure, and invalidates when idle.

Implement field records whose confirmed value advances on each success. Guard rollback with both lifecycle and revision checks. Use `Object.is` for ownership, which recognizes the exact primitive or array/object reference placed in the cache by this hook and conservatively treats an equivalent cloned value as externally replaced.

### Step 5: Add invalidation and refetch safety

Spy on `queryClient.invalidateQueries` and test that:

- successful idle completion invalidates once;
- completion of the first serialized field does not invalidate while another field remains debounced, pending, or active;
- a mixed failure/success lane still performs the success-driven invalidation once at idle;
- a rollback ownership mismatch performs one deferred invalidation;
- a background cache update cannot replace `valueFor` while a draft exists;
- after the draft succeeds, `valueFor` falls back to the query result.

Implement one deferred invalidation flag and settle it only when the entire lane is idle. Do not expose invalidation through the hook interface.

### Step 6: Add Scope, category, and unmount lifecycle

Use `renderHook` rerenders plus `$preferences` changes to cover:

- category change before debounce prevents the old request and restores the shared config cache;
- category change during an active request aborts its signal, suppresses both late success and late failure, and marks the same settings config key stale with `refetchType: 'none'`;
- Profile change before debounce prevents the old request and clears the draft;
- remote-URL change before debounce prevents the old request and clears the draft;
- Profile or remote-URL change during an active request aborts its signal, suppresses both late outcomes, and invalidates the captured old key with `refetchType: 'none'`;
- changing Scope away and back does not reveal the old unsaved optimistic value;
- unmount before debounce clears timers and prevents delayed requests;
- unmount during an active request aborts its signal, marks the captured key stale without a state update, and produces no state-update warning;
- switching away and back to the same Scope still rejects old work through the Scope generation.

For the category tests, assert that the query key is unchanged. For Profile and remote-URL tests, assert that old and new keys differ and inspect both cache entries.

Use `useScopeReset` for the lifecycle and capture `beginScopedTask()` in each `change` call, before scheduling its timer. The hook's private lifecycle epoch handles category changes, while the shared Scope generation handles connection/Profile changes, including a switch away and back before React effects can make old work current again.

### Step 7: Migrate `ConfigSectionScreen`

Modify `client/src/features/settings/config-section-screen.tsx`:

- import and call `useConfigAutosave` after creating `settings`, `key`, and the config query;
- replace `valueFor` and `save` with `autosave.valueFor` and `autosave.change`;
- render `autosave.error` through the existing save-error `<div className="error-banner" role="alert">`, preserving current save-failure presentation;
- delete `SAVE_DELAY_MS`, `PendingConfigSave`, drafts, timers, pending/active/revision/generation refs, local Scope comparison, drain, reset, and save implementations;
- remove imports used only by the deleted implementation, including direct `useQueryClient`, `useRef`, `useState`, `useScopeReset`, `getConfigValue`, `setConfigValue`, and `HermesConfigRecord` where no longer needed;
- preserve all query, field, voice-resource, refresh, and page-shell behavior.

Do not modify `ConfigField`; it already reports semantic values through `onChange` and does not know persistence timing.

### Step 8: Replace screen orchestration tests

Refocus `client/src/features/settings/config-section-screen.test.tsx` on the screen-to-hook integration seam:

- retain one production-composition happy path with `GatewayProvider`, `MemoryGateway`, and the real hook to prove a rendered field produces the profile-scoped partial PUT;
- retain the visible rollback/error case and assert that the existing alert displays the hook's classified message through the rendered screen;
- add the currently missing rendering case for a config category whose schema exposes none of its registered fields;
- remove the four detailed concurrency and Scope orchestration cases after equivalent or stronger assertions pass in `use-config-autosave.test.tsx`.

The screen file therefore ends with three cases: production-composition happy path, visible rollback/error, and empty-category rendering. This follows replace-don't-layer testing: direct interface tests become authoritative for autosave policy, while screen tests prove composition and visible output.

### Step 9: Add one browser persistence path

Extend `client/e2e/server.mjs` with the smallest deterministic config fixture:

- initialize per-session config with only `display.personality: 'default'`;
- return a `/api/config/schema` GET response that exposes only `display.personality`, the sole field this test consumes;
- return current config for `/api/config` GET;
- on `/api/config` PUT, record the body, merge the partial nested config into fixture state, and return `{ ok: true }`;
- preserve the selected `profile` query in the existing call record;
- do not add a generic fixture-control route.

Add one case to `client/e2e/pwa-foundation.spec.ts` that logs in, opens Settings, opens Chat, changes Personality, waits for the debounced save, and asserts through `/api/fixture-calls` that exactly one profile-scoped PUT carries the nested partial patch. Reload or leave and re-enter Chat, then assert the confirmed value is returned by the fixture.

The hook tests remain authoritative for races and cleanup. The browser case proves the changed user-visible flow and production adapter composition.

## Required behavior matrix

### Debounce and ordering

- Each field has an independent 450 ms debounce.
- Repeated pre-debounce edits collapse to the newest value.
- Ready writes across fields execute one at a time in insertion order.
- A newer same-field edit waits behind its active predecessor.
- No caller can force a flush or bypass ordering.

### Optimistic state and confirmation

- The edited value renders immediately.
- A loaded query cache mirrors the optimistic draft; an absent config query remains absent and the draft overlay carries the value.
- A successful write advances that path's confirmed baseline.
- Newer drafts remain visible while older writes settle.
- Ordinary invalidation waits until all current timers, pending operations, and requests settle; any success or rollback ownership mismatch requests one idle invalidation.

### Failure

- A latest failure restores only its path.
- Rollback uses the last successful same-field value.
- Unrelated optimistic fields survive rollback.
- An older failure cannot remove a newer draft or publish an error.
- `{ ok: false }` is a failure, not success.
- Abort and stale work are silent.

### Lifecycle

- Category, Profile, and remote Gateway changes cancel timers and active work.
- Cleanup after any active abort marks the captured settings config key stale without refetch; category changes reuse that key, while Scope changes create a new one.
- Old results cannot change values, errors, baselines, or invalidation state after reset.
- Returning to an old Scope cannot expose an unsaved cache value as confirmed.
- Unmount leaves no timer, request, draft, or React state update behind.
- The shared Scope generation rejects work after a switch away and back.

### Compatibility

- PUT payloads remain one-field nested partial config records.
- Profile binding remains in `createSettingsApi` and `GatewayApi`.
- Existing query keys remain byte-compatible.
- The 450 ms delay remains unchanged.
- Query loading, schema errors, voice resources, refresh, navigation, and field rendering remain unchanged.
- No new runtime dependency is added.

## Verification sequence

Run from `client/` in increasing breadth:

1. New hook tests during each red-green slice:
   ```bash
   npm test -- src/features/settings/use-config-autosave.test.tsx
   ```
2. Settings screen and adapter tests:
   ```bash
   npm test -- src/features/settings/config-section-screen.test.tsx src/features/settings/settings-api.test.ts
   ```
3. Nearby Model editing regression tests, because both modules write profile config but must retain separate policy:
   ```bash
   npm test -- src/features/models/model-editing.test.tsx src/features/models/models-screen.test.tsx
   ```
4. Typecheck:
   ```bash
   npm run typecheck
   ```
5. Full unit suite:
   ```bash
   npm test
   ```
6. Production build:
   ```bash
   npm run build
   ```
7. Browser settings path in both configured Playwright projects:
   ```bash
   npm run test:e2e -- pwa-foundation.spec.ts --grep "autosaves a Chat setting"
   ```

Exercise the browser flow rather than relying only on typecheck and unit output. Confirm the field changes immediately, one PUT lands after the delay, and the value survives re-entry or reload. Layout and error-banner variants do not change in this refactor, so do not add unrelated browser assertions for them.

## Acceptance criteria

- `ConfigSectionScreen` contains no timer, queue, revision, abort, rollback, optimistic mutation, or local Scope-generation implementation.
- `use-config-autosave.ts` is the only settings module that owns config-field autosave orchestration.
- The hook interface is limited to category/config/query-key/settings inputs and error/value/change outputs.
- At most one settings config write is active per mounted hook.
- Same-field rollback restores the last Gateway-confirmed value.
- Different-field optimistic values survive each other's success and failure.
- Category, Profile, remote-URL, and unmount cleanup are directly tested.
- Old unsaved optimistic cache values do not reappear as confirmed after returning to a Scope.
- Screen tests prove composition without duplicating the hook's concurrency matrix.
- The browser fixture proves a real rendered Chat field persists through the production adapter.
- `CONTEXT.md` records the module ownership and its separation from Model editing.
- No new dependency, global queue registry, generic autosave framework, or settings-route change is introduced.
- Focused tests, nearby regressions, typecheck, full tests, build, and the browser case pass.

## Risks and mitigations

### Cleanup can target the new query key accidentally

React effect cleanup must capture the previous lifecycle's query key, field records, and settings adapter lifecycle. Category rerenders reuse the same key; Profile and remote-URL rerenders create distinct keys. Test both shapes and never perform old-cache cleanup by reading only the newest render's options.

### Refetch can overwrite an unsaved optimistic field

Keep drafts inside the module and make `valueFor` prefer them. Defer invalidation while any timer, pending operation, or active request exists. Test two fields where the first succeeds while the second remains debounced.

### Abort does not prove the Gateway rejected a request

An active request may commit before cancellation reaches the transport. On lifecycle cleanup, suppress its local result and invalidate the captured query without immediate refetch. When an old Scope mounts again, React Query fetches authoritative config. A category change keeps the same key mounted, so cleanup restores the known confirmed baseline and leaves that key stale rather than claiming abort produced an authoritative read.

### Rollback can clobber another writer

Before restoring a path, verify with `Object.is` that the cached value is the exact value written by this hook. If it differs, leave it alone and request invalidation at idle rather than guessing ownership. This is reference-conservative for list values produced by `ConfigField`. Keep Model editing independent and cover its existing suite as a regression check; its cache key is different, so those tests do not establish cross-cache coherence.

### Fake timers can hide promise-order bugs

Use `vi.advanceTimersByTimeAsync`, explicit deferred promises, and `act` around timer and settlement transitions. Assert request counts before resolving each deferred response. Keep one `MemoryGateway` screen test and one Playwright path to verify real adapter timing.

### The module can become shallow through excessive configurability

Keep the delay private and fixed at 450 ms. Do not expose clock, queue, cache, reset, flush, retry, or lifecycle controls. If a future second caller needs different policy, compare its invariants first rather than widening this interface speculatively.
