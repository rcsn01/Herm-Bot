# Deepen the Profile mutation workflow

## Goal

Create one deep Profile workflow module for Profile creation, duplication, and editing. The module will concentrate remote loading, draft-to-wire mapping, operation ordering, model confirmation, avatar persistence, partial-save policy, Scope guarding, and roster cache refresh behind one interface.

The dialogs will retain rendering, accessibility, field drafts, touched flags, focus, and open/close behavior. `AgentsApi` will remain the remote adapter seam and the only module that knows RPC names. Its existing typed method inputs and results remain the wire vocabulary consumed by the workflow.

This refactor should remove the current duplication without changing normal-path user-visible behavior, accepted-response compatibility, or gateway payload semantics. It deliberately fixes four race defects: completion uses the frozen submitted name rather than later input state; a fresh roster result can replace an obsolete cached duplicate-name suggestion; stale Scope work stops before later RPCs; and late advanced/avatar reads cannot overwrite edits made while they were pending. Existing unknown-avatar no-clear behavior remains intact.

## Why this work is needed

The current workflow is split across several callers:

- `client/src/features/agents/create-profile-dialog.tsx` binds `AgentsApi`, loads the roster and advanced Profile data, validates Profile names and model pairs, builds create/configuration payloads, applies best-effort follow-up mutations, generates and persists avatars, guards the Scope, invalidates the roster, and renders the form.
- `client/src/features/agents/edit-profile-dialog.tsx` repeats advanced loading and avatar generation, separately loads the existing avatar asset, maps edit payloads, clears inherited models through the CLI fallback, handles expensive-model confirmation, persists appearance and avatar changes, guards the Scope, invalidates the roster, and renders the form.
- `client/src/features/agents/profile-advanced-fields.tsx` owns Profile draft types and persistence rules such as toolset normalization, but it also renders controls and starts the model-options query.
- `client/src/app.tsx` constructs duplicate mode through eight independent `initial*` props. That makes the dialog interface nearly as complex as the duplicate seed itself.

This loses locality. A change to Profile capabilities, asset semantics, model confirmation, or cache policy currently requires coordinated edits in several modules. Tests mostly exercise the dialogs, so workflow behavior and rendering behavior share the same test surface.

The deletion test supports the refactor: deleting the proposed workflow module after migration would spread the same payload, ordering, Scope, and partial-save rules back across both dialogs and App.

## Decisions made

These choices use the recommended answers to the design questions.

### 1. Scope of the module

Include:

- fresh Profile creation, including the existing option to clone selected configuration;
- Profile duplication, as the seeded presentation mode of creation;
- Profile editing;
- Profile name validation and duplicate-name suggestion;
- advanced Profile loading through `profiles.describe` plus best-effort `mcp.catalog`;
- model-option loading;
- edit-avatar baseline loading;
- avatar generation normalization;
- create/edit mutation orchestration;
- expensive-model confirmation for edit;
- Scope checks and stale-result discard;
- roster invalidation after a completed save.

Exclude:

- Profile deletion. It has a separate destructive confirmation and CLI lifecycle, and there is no duplication proving that it belongs behind this seam yet.
- Profile action-menu rendering.
- avatar file reading, resizing, and preview rendering. These are browser concerns already localized in `ProfileAvatarPicker`.
- form state or a global Profile draft store.
- changes to `AgentsApi` wire behavior.

### 2. Module shape

Use the same split already established for Workspace navigation:

1. `client/src/features/agents/profile-workflow.ts` will be the DOM-free core. It will own domain types, validation, normalization, payload mapping, remote operation ordering, response checks, warnings, and mode-specific policy.
2. `client/src/features/agents/use-profile-workflow.ts` will be the React entry. It will bind `AgentsApi`, React Query, Scope utilities, confirmation presentation state, and roster invalidation to the core.

This gives the core a direct test interface while keeping React and cache mechanics out of the domain implementation. Do not add a generic workflow engine, public step registry, event bus, or new dependency.

### 3. Adapter strategy

Keep `AgentsApi` in `client/src/features/agents/agents-api.ts` as the remote adapter seam. The core should depend on a narrow `Pick<AgentsApi, ...>` rather than define a second transport abstraction.

The production adapter remains `createAgentsApi(createGatewayApi(...))`. Core policy tests use a small in-memory `AgentsApi` adapter. Contract tests use `MemoryGateway` through the production adapter for exact RPC payload and ordering evidence. No new port is needed beyond this proven production/test seam.

### 4. Preserve mode-specific behavior

Do not homogenize policies merely because the implementation becomes shared.

- Fresh creation and duplication must preserve the current `profiles.create` payload. Description, clone flags, auth flags, credentials, provider/model, and SOUL retain their exact touched/dirty inclusion rules. Do not move model assignment into a follow-up request or introduce a new confirmation path for creation.
- "Duplicate" is a seeded UI mode, not a permanent wire invariant. It starts with the selected source and `cloneAll: true`, but the user can still choose "Start with gateway defaults" before saving. Conversely, a dialog opened as fresh creation can select a clone source. The initial mode continues to control the title, busy label, initial touched flags, and untouched `share_auth` behavior.
- After successful creation, advanced capability configuration, appearance configuration, and avatar persistence remain independent best-effort steps. Failures become the existing aggregate warning, the newly created Profile remains committed, the roster refreshes, and the dialog closes.
- Edit remains fail-closed. A failed requested edit step leaves the dialog open with an error. Do not convert edit failures into a successful close with warnings in this refactor.
- Edit continues to use the verified `cli.exec --profile <name> config unset model` fallback when the user explicitly clears provider and model.
- Edit alone handles `confirm_required` and retries the same frozen draft with `confirm_expensive_model: true` after approval.
- No cross-RPC rollback will be added. The gateway does not provide a transaction, and a guessed rollback could overwrite concurrent changes.

These differences must be expressed as policy inside the workflow implementation, not as duplicated caller code.

### 5. Cache and Scope policy

- Keep the roster key byte-for-byte compatible with `useScopeKey('agents', ['roster'], { unscoped: true })`. This key currently has seven production constructors: the two Profile dialogs, `RosterScreen`, `ChatScreen`, `DeleteProfileDialog`, `CreateGroupChatDialog`, and `GroupScreen`. Migration removes the two dialog constructors and adds the hook constructor, leaving six.
- Keep model options under the existing unscoped `useScopeKey('agents', ['model-options'], { unscoped: true })` key. `ProfileAdvancedFields` is its only current constructor; the hook replaces it.
- Key advanced Profile data as `useScopeKey('agents', ['profile-advanced', mode, source], { unscoped: true })` and avatar baselines as `useScopeKey('agents', ['profile-avatar', name], { unscoped: true })`. Advanced normalization suppresses provider/model/SOUL outside edit, so mode is part of that result's identity. Both reads include the gateway connection and explicit Profile name but not the active conversation Profile.
- Use `useScopedQuery` for all remote reads and `useScopedTask` for generation and mutation work.
- The hook combines the scoped task's `isCurrent` predicate with a dialog-operation generation captured at submit. Increment that generation on close, mode change, edit target-name change, unmount, and Scope reset. Pass the combined predicate into the core operation. Check it before and after sequential remote calls, before opening confirmation, before invalidating caches, and before reporting completion.
- If the Scope changes, do not start another sequential step. Discard completion, errors, confirmation, and cache effects. An RPC already accepted by the gateway cannot be undone.
- Do not add optimistic roster updates. Multi-step mutations can partially persist, so rollback would be misleading.

### 6. Avatar policy

Preserve the current safety rules and make them explicit:

- An inline avatar from `bot.meta.image` or `bot.avatar` is a known baseline and avoids another fetch.
- If edit receives only `hasAvatar: true`, load `profiles.get_asset` before enabling save. Save becomes available after either a known baseline or a terminal unknown-baseline result; it stays disabled only while the fetch is pending.
- A failed asset load, `found: true` without nonempty `data`, or a response that does not explicitly establish presence or absence means the remote baseline is unknown, not absent.
- An appearance-only title, color, or shape update must never clear an avatar asset. Selecting a character while a photo is present is different: `ProfileAvatarPicker` calls `onImage(null)`, so that action is an explicit image removal as well as a shape change.
- An explicit image removal clears the asset only when the workflow knows a saved asset existed.
- Replacing an unknown saved asset with a new image is safe and remains allowed.
- A generated-avatar response must contain a truthy `image_data` or `image`; `success: true` without image data is an error. Preserve the current rejection message when `success === false` and the current no-image message otherwise.
- Duplication continues to use the avatar data already hydrated into the roster row. Do not add another duplicate-only asset fetch in this refactor.

## Proposed interface

Implement the following responsibilities and information flow.

### DOM-free core

`profile-workflow.ts` should export domain values rather than wire payloads:

```ts
export const PROFILE_NAME_MAX_LENGTH = 63

export type ProfileWorkflowMode = 'create' | 'duplicate' | 'edit'

export interface ProfileAppearanceDraft {
  color: string | null
  created?: number
  shape: string
  title: string
  touched: boolean
}

export type ProfileAvatarBaseline =
  | { status: 'known'; image: string | null }
  | { status: 'unknown' }

export interface ProfileAvatarDraft {
  baseline: ProfileAvatarBaseline
  current: string | null
}

export interface ProfileCreateSeed {
  cloneAll: boolean
  cloneFrom: string
  color: string | null
  description: string
  image: string | null
  name: string
  shape: string
  title: string
}

export interface CreateProfileCommand {
  mode: 'create' | 'duplicate'
  name: string
  description: string
  descriptionTouched: boolean
  appearance: ProfileAppearanceDraft
  image: string | null
  advanced: ProfileAdvancedState
  advancedTouched: boolean
  cloneFrom: string
  cloneAll: boolean
  noSkills: boolean
  shareAuth: boolean
  shareAuthTouched: boolean
  mirrorCredentials: boolean
  mirrorCredentialsTouched: boolean
}

export interface EditProfileCommand {
  mode: 'edit'
  name: string
  description: string
  descriptionTouched: boolean
  appearance: ProfileAppearanceDraft
  avatar: ProfileAvatarDraft
  advanced: ProfileAdvancedState
}

export type ProfileSaveCommand = CreateProfileCommand | EditProfileCommand

export type ProfileSaveResult =
  | { status: 'saved'; name: string; warning?: string }
  | { status: 'cancelled'; reason: 'model-confirmation-declined' }
```

The core factory should expose the smallest useful behavior set:

```ts
export interface ProfileWorkflow {
  loadAdvanced(input: {
    mode: ProfileWorkflowMode
    source: string
    signal?: AbortSignal
  }): Promise<ProfileAdvancedState>

  loadAvatar(input: {
    hasAsset: boolean
    inlineImage: string | null
    name: string
    signal?: AbortSignal
  }): Promise<ProfileAvatarBaseline>

  generateAvatar(prompt: string, signal?: AbortSignal): Promise<string>

  save(
    command: ProfileSaveCommand,
    context: {
      confirmModel(message: string): Promise<boolean>
      isCurrent(): boolean
    }
  ): Promise<ProfileSaveResult>
}

export function createProfileWorkflow(
  agents: Pick<AgentsApi,
    | 'clearModel'
    | 'configure'
    | 'create'
    | 'describe'
    | 'generateAvatar'
    | 'getAsset'
    | 'mcpCatalog'
    | 'setAsset'
  >
): ProfileWorkflow
```

Use `Date.now()` directly for fresh Profile metadata and `vi.setSystemTime(...)` in the timestamp test. A production clock option solely for one test would enlarge the interface without adding a real adapter. Do not expose private payload builders or remote step types.

The core should also export:

- `validateProfileName(value)` as the single submit and UI validation rule;
- `duplicateProfileSeed(agent)` to map `description ?? ''`, `meta.color ?? null`, `meta.shape ?? 'blobatar'`, `meta.image ?? avatar ?? null`, `meta.title ? meta.title + ' (copy)' : ''`, `cloneAll: true`, the source name, and the initial `-2` name. It does not copy `meta.created`;
- `suggestDuplicateProfileName(sourceName, existingNames)` for the existing `-2` through `-99` search and truncation. If all 98 candidates are occupied, return the initial `-2` candidate and let `profiles.create` report the collision, matching the current behavior;
- `emptyAdvancedProfileState()` and the `ProfileAdvancedState` type;
- `advancedStateFromDescribe(...)` for loaded draft normalization;
- keep toolset persistence normalization private. The renderer does not need it after migration.

### React entry

`use-profile-workflow.ts` should expose one headless hook for the two dialogs:

```ts
export function useProfileWorkflow(options: {
  advancedOpen: boolean
  advancedSource: string | null
  avatar: null | {
    hasAsset: boolean
    inlineImage: string | null
    name: string
  }
  mode: ProfileWorkflowMode
  onSaved(result: { name: string; warning?: string }): void
  open: boolean
}): {
  advanced: {
    data: ProfileAdvancedState | null
    error: string | null
    loading: boolean
  }
  avatar: {
    baseline: ProfileAvatarBaseline | null
    loading: boolean
  }
  modelOptions: {
    data: AgentModelOptionsResult | undefined
    error: string | null
    loading: boolean
  }
  roster: {
    data: AgentRosterPage | undefined
    error: string | null
    loading: boolean
  }
  generateAvatar(prompt: string): Promise<string | null>
  mutation: {
    busy: boolean
    clearError(): void
    confirmation: string | null
    error: string | null
    submit(command: ProfileSaveCommand): void
    confirm(): void
    declineConfirmation(): void
  }
}
```

The hook reports completion through the required `onSaved` callback:

- completion reports only `{ name, warning? }`;
- the hook must own busy/error/confirmation lifecycle; `clearError()` lets the create dialog preserve its current clear-on-name-edit behavior;
- confirmation must resume a frozen command, not reconstruct a command from current React state;
- the hook must invalidate the roster only after a saved result and only while the captured Scope is current;
- pending confirmation and errors must reset when the dialog closes, its target changes, or the Scope changes.

Do not expose `QueryClient`, query keys, raw `GatewayError`, RPC response fields, `confirm_expensive_model`, or `ScopedTask` through this interface.

## Detailed implementation steps

### Step 1: Add the Profile workflow domain term

Update `CONTEXT.md` with a concise **Profile workflow** entry:

- name the module files;
- state that it owns create, duplicate, and edit orchestration;
- list payload mapping, advanced/avatar loading, model confirmation, Scope guarding, partial-save policy, and roster refresh as implementation responsibilities;
- state that dialogs own rendering and drafts;
- state that `AgentsApi` remains the adapter seam;
- explicitly exclude Profile deletion.

This prevents later architecture reviews from moving the seam back into the dialogs or incorrectly folding deletion into it.

### Step 2: Build the DOM-free core and direct tests

Create:

- `client/src/features/agents/profile-workflow.ts`
- `client/src/features/agents/profile-workflow.test.ts`

Move or implement in the core:

1. Profile name constants and validation currently in `create-profile-dialog.tsx`.
2. `ProfileAdvancedState`, `emptyAdvancedProfileState`, and `advancedStateFromDescribe` currently in `profile-advanced-fields.tsx`.
3. Toolset persistence normalization currently exposed as `enabledToolsetNames`.
4. Duplicate seed and unique-name suggestion currently split between `App` and the create dialog effect. Preserve suffixes 2 through 99, the 63-character limit, source names that already end in a suffix, and the exhausted-range behavior.
5. Advanced data loading:
   - run `describe(source)` and `mcpCatalog(source)` in parallel with the same signal;
   - treat `describe` as required;
   - treat an ordinary catalog failure as nonfatal and preserve configured MCP entries; if the shared signal is aborted, propagate the abort rather than convert it to a catalog miss;
   - for `edit`, include the described provider, model, and SOUL;
   - for `create` and `duplicate`, preserve the current `includeModel = false` behavior, which suppresses both described model fields and described SOUL while still loading capabilities. Do not describe this flag as model-only.
6. Avatar baseline loading and generated-image response normalization. Return known-present for an inline image or explicit `found: true` plus truthy data, known-absent for `hasAsset: false` or explicit `found: false`, and unknown for an ordinary fetch failure or indeterminate result. If the supplied signal is aborted, rethrow the abort instead of caching it as an unknown baseline.
7. Private create, advanced-configuration, edit-configuration, appearance, and avatar mappers.
8. Ordered create/duplicate and edit executors. Use `command.name`, not mutable dialog state, for every RPC and completion result.
9. Response compatibility through the existing rules:
   - create fails only when `created.ok === false`, as it does now;
   - configuration uses `isSuccessfulProfileConfiguration`, which accepts omitted `ok` and `applied` fields unless an explicit negative value appears;
   - avatar writes fail only when `result.ok === false`;
   - model clearing uses `isSuccessfulCliResult` and therefore requires `code === 0`.
   Do not tighten these legacy-compatible optional result envelopes in this refactor.
10. A private stale-work sentinel that stops the executor without presenting an error when `isCurrent()` becomes false.

Execute saves in these exact orders:

- create/duplicate: validate the name and model pair before remote work; call `create`; then attempt advanced configuration, appearance configuration, and avatar write in that order. Check Scope before each call and immediately after each await, including rejection paths, before interpreting a result or adding a warning. Each attempted follow-up continues after a thrown or explicit-negative result and appends `advanced settings`, `appearance`, or `avatar image` in operation order. Return the unchanged sentence `Profile created, but ${labels.join(' and ')} could not be saved.`
- edit: validate the model pair before remote work; clear an explicitly emptied model first; send the combined description/SOUL/capability/model configuration second; send appearance third; then replace or clear the avatar. Skip every empty step. Check Scope before and immediately after every awaited step, including errors. If the combined configuration requests confirmation, stop, check Scope, await the semantic decision, check Scope again, and either return cancelled or retry that same configuration once with only `confirm_expensive_model: true` added. Continue to appearance and avatar only after successful retry.

Core tests should use the public `ProfileWorkflow` interface. They should not import private builders.

### Step 3: Add the React hook and hook tests

Create:

- `client/src/features/agents/use-profile-workflow.ts`
- `client/src/features/agents/use-profile-workflow.test.tsx`

The hook should:

1. Bind `useApi(createAgentsApi)` once.
2. Own the existing unscoped roster and model-options keys. Load the roster only for an open create/duplicate dialog whose advanced section is open, matching the current clone-selector behavior; `loadRoster` is not a caller option. Load model options only while the open dialog's Advanced section is open, matching the renderer's current mount behavior.
3. Start advanced loading only when the dialog and advanced section are open and a source exists. Pass `mode` to the core so edit alone hydrates described provider, model, and SOUL. For create and duplicate, the dialog passes `cloneFrom || 'default'` as `advancedSource`, exactly as the current effect does.
4. Treat advanced and fetched-avatar reads as loading while React Query is fetching, even when cache data exists. Hydrate from the post-fetch result, not an immediately returned stale cache entry; the current dialogs clear and reload these drafts each time they open.
5. For edit, return a known-absent avatar baseline without a query when `hasAsset` is false, and return a known-present baseline without a query when inline data exists. Query only when no inline image exists and `hasAsset` is true. Expose unknown after a terminal failure or indeterminate result so the dialog can re-enable save safely. Preserve the current silent asset-load failure; the hook does not expose or render an avatar-load error.
6. Wrap generation and save in `useScopedTask`. Avatar generation keeps its busy/error presentation in `ProfileAvatarPicker`; the hook normalizes the result, rejects with the current message while Scope is current, and returns `null` without touching the draft when Scope is stale.
7. Maintain a dialog-operation generation in a ref. Capture it at submit and pass `() => task.isCurrent() && generation === capturedGeneration` into every core save. Increment it and reset local mutation state on close, mode change, edit avatar target-name change, unmount, and Scope reset. Do not increment it when a create dialog's `advancedSource` changes; that is a draft edit, and an already submitted frozen command must continue. Guard busy/error callbacks with the same generation so an old save cannot update a new target in the same gateway Scope.
8. Hold the frozen command and model-confirmation resolver privately.
9. Resolve confirmation from `ConfirmDialog` actions without exposing wire retry details.
10. Clear pending confirmation on decline, close, target change, unmount, or Scope reset.
11. Invalidate the unscoped roster key after `saved`, including a create result with warnings.
12. Avoid invalidation and caller callbacks after a stale Scope.
13. Convert classified query and mutation errors to the user-facing messages the dialogs already render. Do not add a second generation error state; `ProfileAvatarPicker` already owns it.

Use `useScopeReset` rather than adding another Scope listener. Ensure unresolved confirmation promises are settled during cleanup so no mutation remains hung after unmount or Scope change. The hook owns remote read state, but it does not hydrate dialog drafts; one-time hydration remains a dialog responsibility.

### Step 4: Turn `ProfileAdvancedFields` into a renderer

Modify `client/src/features/agents/profile-advanced-fields.tsx`:

- import `ProfileAdvancedState` from `profile-workflow.ts`;
- remove its `AgentsApi` dependency;
- remove `useScopeKey` and `useScopedQuery`;
- accept model-provider data plus loading/error state as props;
- keep capability filtering, checkboxes, selects, textareas, and immutable draft updates;
- keep manual provider/model input when model options are unavailable;
- remove persistence helpers that moved to the core.

Move the toolset normalization assertion out of `edit-profile-dialog.test.tsx` and into `profile-workflow.test.ts`. A rendering test should not own a gateway persistence invariant.

### Step 5: Migrate fresh creation and duplication

Modify `client/src/features/agents/create-profile-dialog.tsx`:

- replace the eight `initial*` props with one optional `seed: ProfileCreateSeed`;
- use an empty seed for fresh creation and `seed.cloneFrom` to select duplicate mode;
- consume roster, advanced, model-options, generation, mutation, busy, error, and completion behavior from `useProfileWorkflow`;
- keep local field values, touched flags, name-edited tracking, focus, advanced expansion, and dialog rendering;
- hydrate advanced local state once per loaded source. When the selected source changes, reset the source-specific draft and allow one hydration for the new source. A background refresh of the same source must not overwrite a draft after any advanced field was edited;
- construct and submit one frozen domain `CreateProfileCommand`; create carries only its current `image`, not an edit-only avatar baseline. Use its trimmed name for the RPC and later completion callback even if an enabled input changes while the request is in flight;
- remove direct imports and use of `useQueryClient`, `useScopeKey`, `useScopedQuery`, `useScopedTask`, `AgentProfileCreateInput`, `AgentProfileConfigureInput`, `botMetaForProfile`, and response predicates;
- remove local advanced-loading and avatar-generation implementations;
- preserve the existing warning string and `onCreated(name, warning)` behavior;
- preserve disabled buttons, busy labels, and close behavior.

For duplicate naming and mode behavior:

- use `duplicateProfileSeed` when App opens the dialog;
- track the last automatically suggested value separately from user edits. When either cached or refreshed roster data arrives, recompute from the full roster if the user has not edited the name. This allows fresh data to advance an earlier cached suggestion rather than getting blocked by the current `name === initialName` guard;
- search suffixes `-2` through `-99` inclusive. Truncate the source so the whole candidate is at most 63 characters. If the range is exhausted, retain the initial `-2` candidate;
- let `profiles.create` remain authoritative if another client races the suggestion;
- require a nonempty source to construct a duplicate seed, but do not require `cloneFrom` to remain nonempty at submit time. The duplicate dialog currently lets the user choose gateway defaults. Keep the duplicate title and busy label after that choice;
- keep fresh mode capable of selecting a clone source from Advanced settings;
- preserve initial-mode touched rules. Duplicate starts with description and advanced touched; fresh starts untouched. Untouched `share_auth` is omitted in duplicate mode but opening Advanced in fresh mode causes the current default `share_auth: true` inclusion. `mirror_credentials` remains omitted until its checkbox is touched.

Modify `client/src/app.tsx`:

- replace `duplicateOptions` with `createProfileSeed: ProfileCreateSeed | null`;
- build duplicate mode through `duplicateProfileSeed(actionsProfile)`; the helper must reject an empty source name, though normalized roster entries already guarantee a nonempty one;
- pass the seed object to `CreateProfileDialog`;
- keep create/close/open dialog behavior and notices unchanged;
- do not alter unrelated App navigation or group creation logic.

### Step 6: Migrate editing

Modify `client/src/features/agents/edit-profile-dialog.tsx`:

- consume advanced, model-options, avatar baseline, generation, mutation, busy, error, and confirmation behavior from `useProfileWorkflow`;
- keep local drafts, touched flags, focus, rendering, and `ConfirmDialog` presentation;
- add a dialog-local image-touched ref, separate from appearance-touched, to protect hydration. `ProfileAvatarPicker.onImage` sets both; title and color set appearance only; selecting a character calls `onImage(null)` and is therefore an explicit removal. Do not put this UI hydration flag in `ProfileAvatarDraft`; persistence is determined by `baseline` plus `current`;
- hydrate the avatar draft from the workflow baseline only if the image has not been touched. A known baseline initializes `current`; an unknown baseline leaves the current image alone and records only the baseline status;
- construct an `EditProfileCommand` on submit;
- let the hook freeze that command before a confirmation round trip;
- wire `ConfirmDialog` confirm and cancel actions to the hook's semantic confirmation actions;
- remove direct imports and use of `useQueryClient`, `beginScopedTask`, `useScopeKey`, `useScopedTask`, `botMetaForProfile`, response predicates, and direct mutation methods;
- remove the local advanced and asset loading effects;
- preserve save-button disabling until a required avatar baseline finishes loading;
- preserve error-open and success-close behavior;
- keep `onSaved(name)` unchanged. The dialog adapts the hook's `{ name }` completion to that callback; edit never returns create-style warnings.

### Step 7: Remove migrated duplication

After both dialogs use the new interface:

- delete local `CreateResult` and `SaveResult` types;
- delete duplicate `generateAvatar` functions;
- delete duplicate `describe`/`mcpCatalog` effects;
- delete dialog-level payload mapping and best-effort helpers;
- delete dialog-level cache invalidation;
- remove dead imports;
- keep `ProfileAvatarPicker`, `AgentsApi`, and gateway Scope utilities focused on their existing responsibilities;
- do not move adapter response types out of `agents-api.ts` unless the workflow only needs a type import.

The resulting dependency direction should be:

```text
App
  -> CreateProfileDialog / EditProfileDialog
    -> useProfileWorkflow
      -> profile-workflow
        -> AgentsApi
          -> GatewayApi / GatewayPort
```

`ProfileAdvancedFields` and `ProfileAvatarPicker` should remain renderers called by the dialogs. They must not regain remote mutation policy.

## Required behavior matrix

### Fresh create

- Invalid names fail before remote work.
- A provider without a model, or a model without a provider, fails before remote work.
- Untouched optional values remain omitted.
- Touched empty description and SOUL retain their current clear/write meaning.
- `profiles.create` failure is fatal and keeps the dialog open.
- `ok: false` is not treated as success. Preserve acceptance of legacy success responses that omit optional status fields; do not invent stricter response-envelope requirements here.
- Capability, appearance, and avatar follow-ups execute after successful creation.
- Each optional follow-up failure adds its existing label to the aggregate warning and does not block remaining optional steps.
- A Scope, dialog target, or open-state change suppresses warning, close, notice, and invalidation callbacks from the old operation.
- Successful or warning-bearing create invalidates the roster once.

### Duplicate

- Opening duplicate mode requires an explicit source seed. Submit may omit `clone_from` and `clone_all` after the user chooses gateway defaults, while the dialog remains in duplicate presentation mode.
- When a source remains selected, `clone_from` and `clone_all` match the current payload. Fresh mode may also send them after the user selects a source.
- Share-auth and mirror-credential inclusion rules remain byte-compatible: untouched duplicate omits both; fresh Advanced mode includes default `share_auth: true`; either mode includes a checkbox value after that checkbox is touched.
- Source title, description, shape, color, and hydrated image seed the dialog.
- The duplicate seed and client appearance follow-up neither carry the source `created` value nor invent a fresh one. The gateway remains free to copy metadata as part of `clone_all`. Fresh presentation mode adds `Date.now()` when appearance is touched, even if the user selected a clone source; duplicate presentation mode omits it even after the user selects gateway defaults.
- Suggested names use `-2` through `-99`, with the existing 63-character maximum. If all candidates exist, the dialog retains `-2` and allows the authoritative create call to fail.
- An unavailable source avatar does not trigger a duplicate-specific asset fetch or block duplication. The ordinary roster query may still hydrate `hasAvatar` rows through `AgentsApi.list`, as it does now.

### Edit

- Every operation carries the explicit target Profile name.
- Untouched description and advanced fields generate no configuration entry. A fully untouched edit generates no RPC and still completes, matching current behavior.
- Touched empty description clears it through configuration.
- Dirty skills, toolsets, MCP servers, SOUL, provider, and model map exactly as they do now.
- All-enabled and all-disabled toolsets map to the unpinned empty list; partial selection maps to enabled names.
- Clearing both provider and model uses the verified CLI fallback and requires explicit `code === 0`.
- A partial provider/model pair fails before remote work.
- `confirm_required` stops before appearance and avatar work.
- Approval retries the frozen configuration exactly once with `confirm_expensive_model: true` and then continues.
- Decline performs no later steps, leaves the dialog open, and clears confirmation state.
- An old confirmation or ordinary save cannot produce later work or UI/cache effects after Scope change, target change, close, or remount.
- Appearance metadata preserves the existing `created` value.
- Title-only, color-only, and programmatic shape-only edits do not clear an avatar. Choosing a character while a photo exists is an explicit image removal because the picker emits `onImage(null)`.
- Explicit removal clears a known-present asset. No clear RPC is sent for a known-absent baseline.
- Failed or indeterminate asset loading never becomes an automatic clear.
- Avatar replacement remains possible after an asset-load failure.
- Any thrown error or explicit negative result from a requested edit step leaves the dialog open with the existing error behavior. Preserve the existing optional-envelope compatibility for configure and asset responses.
- Full success invalidates the roster once and closes the dialog.

## Test changes

### New core tests

Add focused cases in `profile-workflow.test.ts` for:

- every validation branch: empty and whitespace-only; a trimmed valid slug; exactly 63 valid characters; 64 characters; uppercase, spaces, punctuation, and non-ASCII input; and each reserved name (`default`, `hermes`, `root`, `sudo`, `test`, `tmp`). This includes all five current validator cases and adds the uncovered boundaries;
- duplicate seed mapping; suffixes `-2`, `-3`, and `-99`; collision handling; a 63-character source; a source already ending in a suffix; and exhaustion of all 98 candidates;
- fresh create payload omission rules;
- duplicate payload rules;
- model-pair validation;
- description and SOUL empty/touched semantics;
- skill, MCP, and toolset mapping;
- fresh versus duplicate metadata timestamps with `vi.setSystemTime`;
- required create failure;
- explicit `ok: false` create/configure/asset results, thrown failures, and compatibility responses with omitted optional status fields;
- best-effort create steps continuing after individual failures;
- stable aggregate warning text and ordering;
- edit mapping and operation order;
- verified model clearing;
- expensive-model confirmation approval and decline;
- no appearance/avatar calls before confirmation;
- avatar known-absent, unchanged, replacement, explicit clear, ordinary fetch failure, aborted fetch, `found: true` without data, response with no presence fields, and title/color-only cases;
- stale `isCurrent()` before the first RPC, between every pair of sequential create and edit steps, before presenting confirmation, while confirmation is pending, after approval before retry, before completion, and during each best-effort create failure path.

Test policy through `createProfileWorkflow` with an in-memory `AgentsApi` fake. Use `MemoryGateway` through `createAgentsApi` only for the smaller contract-test set that asserts exact RPC payloads and ordering.

### New hook tests

Add focused cases in `use-profile-workflow.test.tsx` for:

- read enablement based on dialog state and mode, including no roster read for edit or for collapsed fresh Advanced settings;
- advanced query-key changes by explicit source, `cloneFrom || 'default'` selection, mode-sensitive loaded data, and fresh post-fetch hydration when cached data exists;
- nonfatal MCP catalog failure;
- model-option fallback state;
- avatar fetch only when `hasAsset` lacks inline data;
- generation result normalization, error propagation to the picker contract, and stale-result suppression. The hook exposes no generation state;
- roster invalidation after successful and warning-bearing create;
- no roster invalidation after fatal failure or stale Scope;
- confirmation command freezing;
- confirmation cleanup on decline, close, target change, unmount, and Scope change;
- an ordinary non-confirming save that resolves after close or target change produces no stale busy, completion, error, or invalidation effect.

### Existing dialog tests

Update:

- `client/src/features/agents/create-profile-dialog.test.tsx`
- `client/src/features/agents/edit-profile-dialog.test.tsx`

Keep them focused on the interface between form rendering and the workflow:

- accessibility and validation rendering;
- draft values passed by fresh create, duplicate, and edit forms;
- busy labels and disabled actions;
- gateway errors leaving dialogs open;
- create warnings reaching the notice callback;
- edit confirmation rendering and actions;
- avatar baseline blocking and explicit removal;
- avatar generation busy/error rendering and successful image handoff through `ProfileAvatarPicker`; there is no current standalone picker test;
- dialogs closing only on successful completion.

Remove low-level persistence assertions that are fully covered through the workflow interface. Keep at least one integration-style happy path per mode using `MemoryGateway` so provider composition remains verified. The current create suite has ten executed cases across seven declarations, including the four-row `it.each`; the edit suite has three cases; preserve their accessibility, busy, error-open, roster-refresh, explicitly named edit, and CLI-clear coverage at the appropriate interface instead of silently dropping it.

Keep `client/src/features/agents/agents-api.test.ts` focused on adapter behavior: RPC names, exact wire shapes, roster parsing, and avatar hydration. It currently has ten tests. Do not move workflow ordering assertions into it.

### App integration test

Update `client/src/app-navigation.test.tsx`. Its current `RosterScreen` mock exposes only open-agent actions, so it has no Profile menu or duplicate coverage. Extend that mock narrowly to call `onManageAgent` with a hydrated `work` row. Mock `CreateProfileDialog` with a hoisted prop spy, then assert that App passes one seed containing the copied description, title, shape, color, image, source, `cloneAll`, and `work-2` name. Keep the existing create-options and group-opening tests unchanged.

### Browser coverage

Extend `client/e2e/profile-create.spec.ts` rather than creating a second overlapping suite. It currently has five tests: two create paths, group creation, advanced edit, and duplicate/delete. Add three tests below, for a final total of eight.

1. Keep both fresh create paths, the duplicate and edit paths, and the nearby group-creation regression.
2. Add an edit expensive-model case. Decline the first confirmation, verify the dialog stays open and no appearance/avatar call follows, submit again, approve, and assert the retry repeats the same configuration with only `confirm_expensive_model: true` added.
3. Add an avatar replacement case using the fixture's image generator. Assert one `profiles.set_asset` data write and no clear. Also cover a title-only edit of a Profile with an inline image and assert that no asset RPC occurs.
4. Add a partial create follow-up failure case using title `Reject appearance`. Verify the created Profile remains in the roster, the dialog closes, and the notice reads `Profile created, but appearance could not be saved.`

Modify `client/e2e/server.mjs` to support these cases deterministically. Add `fixture/expensive` to the RPC `model.options` result. When `profiles.configure` receives that model without `confirm_expensive_model: true`, return `{ confirm_message: 'This fixture model is expensive.', confirm_required: true, ok: false }` and do not mutate the Profile. The confirmed call follows the normal success path. Seed `work` with an inline data-URL image. When an appearance configuration contains title `Reject appearance`, return `{ applied: { ui_meta: false }, ok: true }` without applying `ui_meta`; `profiles.create` remains committed. Record all calls as the fixture already does. Do not add a generic fixture-control protocol.

Browser assertions should verify the visible dialog/notice behavior and a bounded set of fixture calls. Core tests remain authoritative for the full operation matrix.

## Verification sequence

Run checks from `client/` in increasing breadth:

1. Focused core and hook tests:
   ```bash
   npm test -- src/features/agents/profile-workflow.test.ts src/features/agents/use-profile-workflow.test.tsx
   ```
2. Profile dialog and adapter tests:
   ```bash
   npm test -- src/features/agents/create-profile-dialog.test.tsx src/features/agents/edit-profile-dialog.test.tsx src/features/agents/agents-api.test.ts
   ```
3. App integration test because the create-dialog seed interface changes:
   ```bash
   npm test -- src/app-navigation.test.tsx
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
7. Profile browser suite:
   ```bash
   npm run test:e2e -- profile-create.spec.ts
   ```

Exercise the browser flow, not just the test runner output: create a fresh Profile, duplicate `work`, edit advanced settings, decline and then approve an expensive model, replace an avatar, and verify a title-only edit does not write the avatar asset. Check that the roster refreshes, the active bot does not switch, stale dialogs do not reappear, and nearby group creation still opens from the same roster action.

## Acceptance criteria

- `CreateProfileDialog` and `EditProfileDialog` contain no direct Profile mutation sequencing, wire payload construction, response predicate checks, Scope task setup, or roster invalidation.
- `ProfileAdvancedFields` performs no remote query and owns no persistence normalization.
- `App` passes one duplicate seed object rather than eight parallel initial-value props.
- `profile-workflow.ts` is DOM-free and can be tested through its public interface.
- `use-profile-workflow.ts` is the sole React entry for Profile loading, mutation lifecycle, confirmation state, Scope guarding, and cache refresh.
- `AgentsApi` remains the only adapter that knows Profile RPC names. The workflow consumes its existing typed wire-shaped inputs and results; dialogs do not.
- Fresh create, duplicate, and edit gateway payloads and optional response-envelope acceptance remain compatible with current behavior.
- Create follow-up failures remain warnings; edit failures remain errors.
- Expensive-model confirmation resumes the frozen edit and cannot survive a Scope or target change.
- Avatar removal cannot occur from an unknown or known-absent baseline, or from an unrelated title/color edit.
- Successful and warning-bearing saves refresh the roster without switching the active Profile.
- No new runtime dependency is added.
- Focused tests, full tests, typecheck, build, and all eight Profile Playwright tests pass.
- The pre-existing user modification in `client/src/navigation/workspace-navigation.test.ts` remains untouched.

## Risks and mitigations

### Draft hydration can overwrite user edits

A cached advanced or avatar result may arrive after the user starts changing the form. The dialogs, not the hook, hydrate each source or target once and track whether the user has touched the corresponding draft before applying remote data. A source change starts a new advanced draft generation; a same-source refetch never replaces edited state.

### Confirmation can leave a pending promise

The semantic confirmation adapter waits for UI input. Resolve it as declined during close, unmount, target change, or Scope reset, then discard the stale workflow result.

### Refactoring can alter gateway payloads or response compatibility accidentally

Capture current payloads and result predicates in workflow contract tests before removing dialog code. Compare fresh create, fresh-with-clone, duplicate-with-source, duplicate-after-selecting-defaults, advanced edit, model clear, appearance, and asset calls byte-for-byte. Pin omitted-status success responses as well as explicit negative responses.

### Multi-step saves can partially persist

Do not claim transactionality and do not add rollback. Preserve create warnings and edit error-open behavior. Edit can therefore leave an earlier configuration step committed when a later appearance or asset step fails. Make that policy explicit in tests.

### Query-key changes can stop roster refreshes

Reuse the existing unscoped roster and model-options keys exactly. Verify invalidation by rendering `RosterScreen` with the dialogs in integration tests.

### Scope changes cannot undo accepted RPCs

Check `isCurrent()` before every later step and every UI/cache effect. Document that stale-effect discard protects the client but cannot reverse remote work already accepted by the gateway.
