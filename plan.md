# Deepen the OAuth flow module

Option 1 from the architecture review on September 17, 2026. The report lives at `/private/var/folders/th/_8dpnzf515n6h74y89jpky5h0000gn/T/architecture-review-20260917-113711.html`. This plan replaces the previous Workspace navigation plan after that refactor landed in `e3c14b6` and its follow-up documentation landed in `bf4f7ce`.

The architecture vocabulary here uses **module**, **interface**, **implementation**, **depth**, **seam**, **adapter**, **leverage**, and **locality** as defined by the codebase-design guidance. Domain names come from `CONTEXT.md`.

## Executive summary

Create the missing `client/src/gateway/oauth-flow.ts` module already described in `CONTEXT.md`. It will own the shared OAuth lifecycle end to end:

1. capture the current Scope;
2. call a feature-owned start adapter;
3. normalize and publish the first flow state;
4. launch a safe external authorization URL without blocking polling when the initial waiting state has one;
5. poll through the existing `runRemoteAction` engine;
6. normalize waiting, approved, denied, expired, and error phases;
7. suppress stale or aborted effects;
8. classify bounded polling as `GatewayError` code `OAUTH_TIMEOUT`.

Provider, memory-provider, and MCP route vocabulary stays in their feature modules. Each feature supplies a small adapter that maps its wire shapes to the normalized OAuth flow state. Device-code submission, explicit remote cancellation, cache invalidation, navigation, and fallback/rendering copy remain caller policy, matching the ownership recorded in `CONTEXT.md`. Adapters may preserve a wire-provided message or supply the feature-specific waiting/timeout text needed after raw statuses are normalized away.

This preserves valid-flow behavior and makes six corrections at boundaries the current screens mishandle: every OAuth timeout receives the stable code `OAUTH_TIMEOUT`; malformed provider/MCP start handles fail before polling; memory `connected: true`, `state: 'error'`, and post-start `state: 'idle'` are interpreted consistently; memory success invalidates the actual OAuth query key instead of a nonexistent derived key; changing the selected memory provider aborts rather than retargets an in-flight run; and one screen cannot own two active OAuth runs.

## Why this work is needed

The repository already names an **OAuth flow** domain concept, but its implementation file does not exist. Three screens repeat the protocol choreography:

### Provider accounts

`client/src/features/settings/settings-administration-screen.tsx` currently splits one flow across `ProvidersSettings` and `ProviderOAuthFlow`:

- `ProvidersSettings.startOAuth` starts the provider route, stores its raw response, and opens the returned URL.
- `ProviderOAuthFlow` captures a Scope, creates an `AbortController`, calls `runRemoteAction`, polls the provider route, maps terminal states, and reports timeout or transport errors.
- Device-code submission and cancellation are separate handlers with important secret-clearing behavior.
- Mutable refs keep callbacks and the one-shot code current while polling runs.

The provider flow supports two start shapes:

- PKCE: `auth_url`, `session_id`, `expires_in`.
- Device code: `verification_url`, `user_code`, `session_id`, `poll_interval`, `expires_in`.

### Memory-provider authorization

`client/src/features/settings/memory-settings.tsx` owns another copy:

- `startMemoryOAuth` may return `connected` immediately or `pending`.
- A `useEffect` watches `oauthPending`, captures a Scope, creates an `AbortController`, invokes `runRemoteAction`, and polls `memoryOAuthStatus`.
- Completion invalidates memory status and attempts to invalidate OAuth status, but the latter currently constructs a key that does not match the query's actual `useScopeKey` value.
- There is no remote cancellation route. Unmount and Scope teardown only stop local polling.

### MCP authorization

`client/src/features/capabilities/mcp-screen.tsx` owns the third copy:

- `mcpApi.auth` returns a flow id and an optional authorization URL.
- The screen opens the URL when present.
- A `useEffect` captures a Scope, creates an `AbortController`, invokes `runRemoteAction`, and polls the process-scoped flow route.
- The screen maps `starting`, `authorization_required`, `approved`, and `error` itself.
- It uses string matching against the generic timeout message to produce MCP-specific copy.
- Explicit cancellation calls the process-scoped delete route; dismiss only stops local polling and clears the card.

### Current test gap

`client/src/gateway/remote-action.test.ts` thoroughly tests the generic polling engine. Feature route tests pin provider and MCP unscoped poll/cancel paths. The screen tests do not cover the complete OAuth choreography:

- `settings-administration-screen.test.tsx` has no provider OAuth tests.
- `memory-settings.test.tsx` covers configuration and Scope-discarded mutations, but not OAuth.
- There is no `mcp-screen.test.tsx`.

The result is low locality. Bugs in start-to-poll ordering, external URL opening, terminal mapping, Scope changes, or cancellation can differ across three callers even though they are one domain protocol.

### Verified baseline inventory

The plan's scope was rebuilt from source rather than inherited from the architecture report:

| Area | Verified current sites and counts |
|---|---|
| Generic engine | Four production invocations: one inside `runGatewayAction` plus one OAuth invocation in each of the three screens. `runRemoteAction` itself is defined in `gateway/remote-action.ts`; six files mention the symbol when its test file is included. |
| Unused transport parameter | All four production callbacks ignore the engine's `GatewayPort` argument. The only four `api.gateway` reads are the engine call in `runGatewayAction` and the three OAuth screen calls. |
| Provider routes | Five methods in `SettingsApi`: profile-bound list/start/submit, unscoped poll/cancel. The screen uses all five. `OAuthStartResponse` has exactly two response variants; `OAuthProvider.flow` also allows `external`, so the adapter must discriminate on the response. `OAuthPollResponse` has five statuses. |
| Memory routes | Two profile-bound methods in `SettingsApi`: start and status. The status type has four states plus an independent `connected` boolean. There is no memory cancel method or route. |
| MCP routes | Three methods in `McpApi`: profile-bound auth start and unscoped status/cancel by encoded flow id. `McpOAuthFlow` has four statuses and a nullable URL. |
| Scope/abort sites | Each OAuth screen currently owns one controller and one raw `beginScopedTask` around polling. The provider child also owns mounted/callback/code refs. `runRemoteAction` already owns a second effective controller, caller-listener cleanup, delay cancellation, and post-start/post-poll Scope assertions. |
| Timeout sites | The engine has one generic bounded-poll throw. MCP has the only OAuth timeout substring match. No provider or memory custom timeout exists. |
| Current tests | `remote-action.test.ts`: 18 tests, 12 for the generic engine and 6 for gateway actions. `settings-api.test.ts`: 11 tests, including one provider poll/cancel scope test. `mcp-api.test.ts`: 2 tests, including one cancel-scope test. Provider screen: 3 unrelated tests. Memory screen: 4 unrelated tests. MCP screen: no test file. |
| URL safety | `PlatformActions.openExternal` delegates to `validatedExternalURL`; its test pins HTTP/HTTPS-only and credential rejection. No feature screen should duplicate that validation. |
| Browser fixture | Zero matching OAuth REST handlers and zero MCP fixture rows with `auth: 'oauth'`; unmatched API routes return 404. |
| Repository state | `plan.md` and `client/src/navigation/workspace-navigation.test.ts` were already modified. The navigation test is outside this work and must remain untouched. |

## Deletion test

The proposed module passes the deletion test. If `oauth-flow.ts` were deleted after this refactor, the following complexity would immediately reappear in all three callers:

- Scope capture and stale-effect guards;
- start-before-poll ordering;
- nonblocking external URL opening and late-opener suppression;
- bounded polling through `runRemoteAction`;
- normalized phase publication;
- timeout classification;
- suppression of expected abort errors.

The feature adapters do not try to pass the deletion test independently. They remain intentionally small because wire vocabulary belongs beside `SettingsApi` and `McpApi`. Their leverage comes from allowing one deep OAuth flow implementation to work across three real adapters.

## Scope

### In scope

- Add the shared OAuth flow module and direct interface tests.
- Remove `runRemoteAction`'s unused `GatewayPort` pass-through and add a stable timeout-error hook without changing polling behavior.
- Add provider, memory, and MCP OAuth adapters beside their feature route modules.
- Migrate all three screens to the shared module.
- Add targeted feature and screen tests for the migrated behavior.
- Preserve route scoping, secret hygiene, user-visible states, and cancellation distinctions.
- Record the checked-in browser fixture's verified inability to exercise these OAuth routes; do not substitute typechecking or JSDOM for popup verification.

### Out of scope

- Changing gateway routes or wire payloads.
- Adding OAuth providers or new authorization modes.
- Persisting active OAuth flow state.
- Resuming a flow after reload.
- Adding a remote cancellation route for memory-provider OAuth.
- Moving device-code submission into the shared module.
- Automatically invoking provider or MCP remote cancellation during unmount.
- Changing React Query cache keys outside the OAuth success paths.
- Reworking the broad `SettingsApi` interface.
- Replacing `runRemoteAction` or changing its retry/backoff algorithm.
- Reworking browser sign-in handled by `GatewayController.login`; that is gateway authentication, not the provider/memory/MCP OAuth flow defined in `CONTEXT.md`.

## Design decisions

The grilling branches are resolved with the recommended answers below.

### Decision 1: cover all three feature flows now

Provider, memory, and MCP OAuth are included in one refactor. Implementing only provider OAuth would leave one adapter at the seam and would not establish a real shared module. Three existing callers justify the seam.

### Decision 2: keep the core DOM-free and imperative

Use one async `runOAuthFlow` entry point in `gateway/oauth-flow.ts`. Do not make the deep module a React hook.

Reasons:

- The protocol has no React-specific behavior.
- Direct interface tests are simpler and faster than hook tests.
- A React hook would make adapter identity and effect dependency rules part of the interface.
- Screens still own when a flow starts, what they render, and what happens after approval.
- The imperative shape matches `runGatewayAction` and keeps the module usable outside React.

React callers keep one local `AbortController` to tie the run to unmount, dismiss, explicit cancellation, or a replacement run. `runRemoteAction` already creates the effective controller, forwards the caller signal, removes its listener, aborts its timer in `finally`, and passes its signal to start/poll callbacks. `runOAuthFlow` must not duplicate that controller layer.

### Decision 3: use normalized feature adapters

Each feature adapter returns normalized OAuth flow state instead of exposing raw provider, memory, or MCP responses to the core.

This keeps wire vocabulary local while giving the core enough information to own the protocol. The adapter maps:

- its opaque context, such as a provider session id or MCP flow id;
- the normalized phase;
- an optional authorization URL;
- an optional user code;
- an optional feature message. This carries wire errors/details and, where normalization removes a user-visible substate, its existing instruction text.

### Decision 4: leave submit and remote cancel with callers

Do not add generic `submit` or `cancel` methods to the OAuth flow interface.

- Only provider device-code flows submit a one-shot code.
- Provider and MCP have different remote cancellation routes.
- Memory has no remote cancellation route.
- Provider code clearing before and after submit/cancel is credential policy, not polling policy.
- Dismiss and remote cancel are different user actions for MCP.

Generalizing these operations would widen the interface to represent capabilities most adapters do not have. Local polling abort remains part of the runner through `AbortSignal`.

### Decision 5: opening an external URL is best effort and nonblocking

After publishing an initial `waiting` state with a non-empty authorization URL, the module launches `openExternal` once without awaiting it before polling. It classifies and reports an opener failure only while that run remains active. A pending opener must not delay the first poll or terminal resolution, and an opener rejection after abort, Scope change, or terminal completion is ignored.

This matches the current React scheduling: provider and MCP publish flow state, their polling effect can start, and the separately awaited opener does not gate that effect. A popup blocker or native opener failure must not destroy a gateway flow that the user may complete in another browser. Missing MCP URLs and URLs on already-terminal start states produce no opener call.

### Decision 6: terminal wire states are outcomes, not transport failures

`approved`, `denied`, `expired`, and wire-level `error` are normalized terminal states. They do not throw. Their optional message travels in the state.

Start failures, poll transport failures, malformed required start data, and bounded polling failures are classified `GatewayError` instances.

### Decision 7: Scope changes and aborts are silent

Unmount, explicit local abort, a superseding flow, and a stale Scope resolve `undefined`. They do not call `onUpdate` or `onError` after becoming stale and do not render an error banner.

This matches the repository’s Scoped operation contract.

### Decision 8: simplify the polling engine interface and add typed timeout creation

Remove `RemoteActionOptions.gateway` and the unused `GatewayPort` argument from its `start` and `poll` callbacks. All three current OAuth callers name that argument `_gateway` or `_transport`, and `runGatewayAction` also ignores it. The generic engine schedules callbacks; feature closures already own their route adapters. Remove the now-unused `GatewayApi.gateway` escape hatch too. This narrows both interfaces rather than carrying a transport through two modules that never use it.

Also extend `RemoteActionOptions` with an optional timeout factory. The default remains the current generic classified timeout. OAuth supplies a non-retryable `GatewayError` with code `OAUTH_TIMEOUT` and adapter-specific copy.

Do not inspect error message text. MCP’s current `message.includes('timed out')` branch is deleted.

### Decision 9: preserve current polling cadence

Keep the current values during the refactor:

- provider and MCP: 1 second initial interval, 5 second ceiling, 60 attempts;
- memory: 2 second initial interval, 10 second ceiling, 60 attempts.

Do not begin interpreting provider `poll_interval` or `expires_in` as part of this change. That would alter behavior and needs a separate contract decision.

## Alternatives considered

### A. Minimal imperative runner, selected

One `runOAuthFlow` entry point accepts a feature adapter, external opener, abort signal, and guarded callbacks.

- **Depth:** high. It hides the complete shared lifecycle.
- **Locality:** high. Wire states stay in feature adapters; lifecycle stays in one module.
- **Interface:** small enough for direct tests.
- **Cost:** each React caller retains a small amount of local state and cleanup wiring.

### B. React-first `useOAuthFlow` hook, rejected

A hook could expose `state`, `start`, and `abort`.

- It makes common screen usage short.
- It also couples the protocol to React, adds adapter memoization rules, and moves the test surface into hook rendering.
- Non-React callers would need another entry point later.
- The extra abstraction is not needed for three current callers.

### C. Capability-rich port with generic submit and cancel, rejected

A broad interface could include `start`, `poll`, `submit`, `cancel`, and `open`.

- It is flexible.
- It is shallow for this repository because memory cannot cancel and only provider device code can submit.
- Callers would need optional-method checks and generic payloads.
- It blurs the explicit ownership in `CONTEXT.md`.

### D. Put all wire routes in `gateway/oauth-flow.ts`, rejected

This would remove adapter code but make the gateway module understand provider ids, memory-provider names, MCP flow ids, profile scoping, and unscoped status routes.

That seam has poor locality. Backend route changes would touch the shared protocol module, and the feature route modules would stop owning their vocabulary.

## Target module interface

Add `client/src/gateway/oauth-flow.ts` with the following public shape. Exact comments may be refined during implementation, but the semantics are fixed by this plan.

```ts
import type { GatewayError } from './gateway-error'

export type OAuthFlowPhase =
  | 'waiting'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'error'

export interface OAuthFlowState<TContext> {
  /** Opaque feature context retained for submit/cancel policy. */
  context: TContext
  phase: OAuthFlowPhase
  authorizationUrl: string | null
  userCode: string | null
  message: string | null
}

export interface OAuthFlowPolling {
  intervalMs: number
  maxAttempts: number
  maxIntervalMs: number
  timeoutMessage: string
}

export interface OAuthFlowAdapter<TContext> {
  /** Feature route vocabulary. Returns normalized start state. */
  start(signal: AbortSignal): Promise<OAuthFlowState<TContext>>
  /** Feature status vocabulary. Called only while phase is waiting. */
  poll(context: TContext, signal: AbortSignal): Promise<OAuthFlowState<TContext>>
  polling: OAuthFlowPolling
}

export interface RunOAuthFlowOptions<TContext> {
  adapter: OAuthFlowAdapter<TContext>
  openExternal(url: string): Promise<void>
  signal?: AbortSignal
  /** Guarded publication of start and poll states. */
  onUpdate?(state: OAuthFlowState<TContext>): void
  /** Guarded classified error reporting. Opener errors are nonfatal. */
  onError?(error: GatewayError): void
}

/**
 * Runs one OAuth flow. Resolves with the current terminal state. Resolves
 * undefined after abort, stale Scope, or a handled start/poll failure.
 */
export function runOAuthFlow<TContext>(
  options: RunOAuthFlowOptions<TContext>
): Promise<OAuthFlowState<TContext> | undefined>
```

### Interface invariants

1. `runOAuthFlow` captures `beginScopedTask()` before calling the adapter.
2. The adapter’s `start` is called exactly once.
3. Every adapter call receives the runner’s effective abort signal.
4. The first normalized state is published before an external URL is launched.
5. `openExternal` is called only when `authorizationUrl.trim()` is non-empty on the initial `waiting` state. The original string is passed to the opener for authoritative URL validation. A missing/blank URL or an already-terminal start state does not invoke it.
6. External opening is attempted at most once automatically per run. A URL first returned by polling is exposed to the caller but is not auto-opened.
7. Opening runs concurrently with polling. A pending opener cannot delay polling or terminal resolution.
8. An opener failure calls guarded `onError` only if the run is still active; polling continues. A rejection after abort, Scope change, or terminal completion is silent.
9. Only `waiting` states poll.
10. `approved`, `denied`, `expired`, and `error` are terminal.
11. Poll delay, backoff, transient-network retry, and attempt bounds come only from `runRemoteAction`.
12. `onUpdate` and `onError` run only while the captured Scope remains current, the caller signal is not aborted, and the run has not reached a terminal result.
13. Abort and stale Scope are silent and resolve `undefined`.
14. A timeout reports `GatewayError` with `code === 'OAUTH_TIMEOUT'`, `retryable === false`, and attempt details.
15. Other start/poll failures are reported as classified `GatewayError` values; `classifyGatewayError` preserves an existing `GatewayError` instance.
16. The module never imports React, `GatewayPort`, `PlatformActions`, `SettingsApi`, or `McpApi`.
17. The module never calls remote submit or cancel routes.

## Feature adapters

### Provider adapter in `features/settings/settings-api.ts`

Add a provider adapter factory beside the provider OAuth route vocabulary.

```ts
export interface ProviderOAuthContext {
  flow: 'device_code' | 'pkce'
  providerId: string
  sessionId: string
}

export function createProviderOAuthAdapter(
  settings: SettingsApi,
  provider: OAuthProvider
): OAuthFlowAdapter<ProviderOAuthContext>
```

Start mapping:

- call `settings.oauthStart(provider.id, signal)`;
- require `session_id.trim()` to be non-empty before any poll can use it, but retain the original nonblank value because the handle is opaque;
- use the response discriminant, not `provider.flow`, for the actual run: PKCE maps `auth_url` to `authorizationUrl`, `userCode` to `null`, and phase to `waiting`; device code maps `verification_url`, `user_code`, and phase `waiting`;
- retain `provider.id`, the original `session_id`, and the response flow kind in context;
- pass URL strings to `PlatformActions` unchanged. URL scheme, credentials, and parse validation remain in `validatedExternalURL`, and a rejected opener remains nonfatal.

Poll mapping:

- call `settings.oauthPoll(context.providerId, context.sessionId, signal)`;
- `pending` → `waiting`;
- `approved` → `approved`;
- `denied` → `denied`;
- `expired` → `expired`;
- `error` → `error`;
- copy `error_message` into `message` when present;
- retain the exact start context, authorization URL, and user code on every poll state. Poll responses do not carry those fields, and the provider card needs them for reopen and device-code display.

Polling configuration remains 1,000 ms / 60 attempts / 5,000 ms ceiling. Timeout copy: `Provider authorization timed out. Start the connection again.`

### Memory adapter in `features/settings/settings-api.ts`

```ts
export interface MemoryOAuthContext {
  provider: string
}

export function createMemoryOAuthAdapter(
  settings: SettingsApi,
  provider: string
): OAuthFlowAdapter<MemoryOAuthContext>
```

Start and poll use one total mapping over the declared `MemoryProviderOAuthStatus` shape:

- call `settings.startMemoryOAuth(provider, signal)` for start and `settings.memoryOAuthStatus(context.provider, signal)` for poll;
- `connected === true` or `state === 'connected'` maps to `approved`, including a contradictory payload whose boolean is true but state is stale;
- `state === 'error'` while not connected maps to `error` with `detail`;
- `pending` and `idle` while not connected map to `waiting`;
- authorization URL and user code remain `null`, context always retains the requested provider, and `detail` becomes the normalized message.

The `idle` case is intentionally waiting only inside a run. The screen's ordinary status query may render idle before a run, but returning idle from post-start polling is not proof of approval. The current effect incorrectly treats every non-`pending`, non-`error` poll response as success. Likewise, a start response with `state: 'error'` currently enters polling. The adapter corrects both edge cases.

Polling configuration remains 2,000 ms / 60 attempts / 10,000 ms ceiling. Timeout copy: `Memory provider authorization timed out. Start the connection again.`

There is no cancel method in this adapter.

### MCP adapter in `features/capabilities/mcp-api.ts`

```ts
export interface McpOAuthContext {
  flowId: string
  serverName: string
}

export function createMcpOAuthAdapter(
  mcp: McpApi,
  serverName: string
): OAuthFlowAdapter<McpOAuthContext>
```

Start mapping:

- call `mcp.auth(serverName, signal)`;
- require `flow_id.trim()` to be non-empty, but retain the original nonblank value because the handle is opaque;
- retain the requested `serverName` in context. It identifies the selected row and is not a poll handle, so a malformed or renamed wire `server_name` cannot redirect caller policy;
- map nullable `authorization_url` exactly, without inventing an error;
- `starting` and `authorization_required` → `waiting`;
- preserve the visible distinction normalization would otherwise erase: `starting` has no message and uses the screen's existing `Starting authentication…` fallback; `authorization_required` carries `Authorize the server in your browser, then return to Hermes.` even when its URL is null;
- `approved` → `approved`;
- `error` → `error` with the wire error message.

Poll mapping:

- call `mcp.oauthStatus(context.flowId, signal)`;
- map phases as above;
- retain the exact start context and map the poll response's `authorization_url` exactly. A non-null URL returned by polling becomes available to the Open authorization button but is not auto-opened.

Polling configuration remains 1,000 ms / 60 attempts / 5,000 ms ceiling. Timeout copy remains behaviorally equivalent to the current UI: `MCP authorization timed out. Start authentication again if needed.`

Explicit remote cancellation remains `mcp.cancelOAuth(flowId)` in the screen.

## Polling engine change

Update `client/src/gateway/remote-action.ts`:

```ts
export interface RemoteActionOptions<T> {
  // existing scheduling, completion, Scope, and signal fields...
  poll: (signal: AbortSignal) => Promise<RemoteActionState<T>>
  start: (signal: AbortSignal) => Promise<RemoteActionState<T>>
  timeoutError?: (maxAttempts: number) => Error
}
```

Delete the `gateway` option, remove the `GatewayPort` import, and invoke `start(controller.signal)` / `poll(controller.signal)`. Update `runGatewayAction` and engine tests to this narrower callback shape. Remove `GatewayApi.gateway` from `client/src/gateway/gateway-api.ts`; the repository-wide `.gateway` inventory shows no other `GatewayApi` consumer. `GatewayController.gateway` and the `GatewayProvider` prop are unrelated and stay unchanged.

At the existing bounded-poll failure:

```ts
if (!complete(state)) {
  throw options.timeoutError?.(maxAttempts)
    ?? classifyGatewayError(new Error(`Remote action timed out after ${maxAttempts} polls.`))
}
```

`runOAuthFlow` supplies:

```ts
new GatewayError(adapter.polling.timeoutMessage, {
  code: 'OAUTH_TIMEOUT',
  details: { maxAttempts: adapter.polling.maxAttempts },
  kind: 'server',
  retryable: false
})
```

The default path must remain byte-for-byte equivalent in behavior for gateway actions and every non-OAuth caller.

## Core implementation flow

`runOAuthFlow` should follow this order:

1. Capture `beginScopedTask()`.
2. Define `active = true` and `isActive()` as `active`, caller signal not aborted when present, and captured Scope still current.
3. Call `runRemoteAction` rather than implementing a new loop. Pass the caller signal directly; the engine already owns signal forwarding, listener removal, its effective controller, and timer cleanup.
4. In the engine's `start` callback:
   - call `adapter.start(signal)`;
   - if inactive, return the state without publishing. The engine's post-start Scope assertion will turn it into a silent abort;
   - publish the normalized state through `onUpdate`, then check activity again so a callback-triggered abort or Scope change cannot launch an external URL;
   - only for an initial `waiting` state whose URL has non-whitespace content, launch the opener without awaiting it and pass the original URL. Start it through a promise chain so a synchronously throwing test adapter also becomes a rejection. Report that rejection only if `isActive()` still holds;
   - return the normalized state to the engine immediately, so the opener cannot gate polling.
5. Save the start context once. In the engine's `poll` callback:
   - call `adapter.poll(startContext, signal)`;
   - publish through `onUpdate` only if active;
   - return the normalized state to the engine.
6. Complete when phase is not `waiting`.
7. Supply the adapter timing values, Scope predicate, caller signal, and OAuth timeout factory to `runRemoteAction`.
8. After the engine resolves, set `active = false` before returning the terminal state. Return it only if the caller signal and captured Scope are still current. This also suppresses a later opener rejection.
9. Catch errors:
   - snapshot whether the caller signal and captured Scope are current, then set `active = false` so detached opener failures become silent;
   - classify the value. Existing `GatewayError` identity is preserved;
   - if its kind is `aborted`, the caller signal is aborted, or Scope is stale, resolve `undefined` silently;
   - otherwise invoke `onError` using the pre-deactivation guard snapshot and resolve `undefined`. Do not call `isActive()` after setting `active = false`.
10. Use a `finally` fallback to set `active = false` even if a caller callback throws.

Do not add another `AbortController`, abort listener, retry loop, delay helper, or timer to `oauth-flow.ts`.

## Screen migration

### Provider screen

Files:

- `client/src/features/settings/settings-administration-screen.tsx`
- `client/src/features/settings/settings-administration-screen.test.tsx`

Changes:

1. Replace raw `OAuthStartResponse` ownership with the selected `OAuthProvider` plus normalized `OAuthFlowState<ProviderOAuthContext>`. Selection exists while start is pending, but the card renders only after the adapter publishes normalized context, matching today's no-card start wait.
2. Start `runOAuthFlow` from the Connect handler. Keep one run active per screen: disable all provider Connect buttons until the run reaches a terminal state, fails, or is cancelled. A ref guard prevents a second synchronous click before React commits the busy state.
3. Store that run's abort controller in a ref. Abort it on screen/card unmount, Scope reset, explicit cancel, and defensively before assigning a replacement controller.
4. Use `createProviderOAuthAdapter(settings, provider)`.
5. Inject `url => platformActions.openExternal(url)`.
6. Publish normalized state to the card. Render:
   - provider name;
   - user code when present;
   - current normalized phase;
   - Open provider only when the URL has non-whitespace content;
   - device-code input only when `context.flow === 'device_code'`.
7. Await `runOAuthFlow` and apply terminal caller policy once. On `approved`, close the card, clear the one-shot code, and refetch the provider list. On `denied`, `expired`, or `error`, keep the card and preserve the current error banner using normalized `message` with existing fallback copy. `onUpdate` only publishes card state; it does not duplicate terminal policy.
8. If start fails before normalized context exists, report the classified error and clear the pending selection, matching today's absence of a card after start failure. An opener error is different: keep the active card and continue the run.
9. Keep device-code submission in the card:
   - snapshot the raw field revision, trim a separate submitted value, and no-op if it is empty;
   - call `settings.oauthSubmit(context.providerId, context.sessionId, submittedValue)` through `useScopedTask`; this route remains profile-bound;
   - after success or failure, clear only when the current raw field still equals the raw snapshot. This clears whitespace-padded submitted input without erasing newer user edits made while the request was in flight;
   - approved submission aborts polling, then closes/refetches exactly like approved polling.
10. Keep remote cancel in the caller:
    - abort local polling first;
    - clear the code before the request;
    - call `settings.oauthCancel(context.sessionId)`;
    - clear the code again after the request;
    - keep the card/context and show the error when remote cancellation fails.
11. Remove provider-specific imports of `beginScopedTask`, `runRemoteAction`, `useGatewayApi`, `OAuthStartResponse`, and `OAuthPollResponse` when no longer used elsewhere in the file.
12. Remove mutable callback refs that existed only to protect the old polling effect. Keep only the run controller/ref guard and the revision-safe code ref needed by caller policy.

### Memory settings

Files:

- `client/src/features/settings/memory-settings.tsx`
- `client/src/features/settings/memory-settings.test.tsx`

Changes:

1. Replace `oauthPending` plus the polling `useEffect` with one normalized flow state and one abort-controller ref. Derive the pending display from `phase === 'waiting'`.
2. `startOAuth` creates `createMemoryOAuthAdapter(settings, providerKey)` and calls `runOAuthFlow`. Abort and replace any existing controller before the run, though the waiting-state button remains disabled.
3. `onUpdate` updates the card from normalized phase/message. Await the runner once for terminal policy: `approved` invalidates queries; `error` uses its detail/fallback; transport and timeout failures arrive through `onError`. Preserve the current unsupported-route copy, `This memory provider does not offer OAuth.`, when `error.kind === 'unsupported'`.
4. Immediate `approved` completes without a poll.
5. Any `approved` result, immediate or polled, invalidates:
   - `statusKey`, the memory status query;
   - a saved `oauthKey = useScopeKey('settings', ['memory', 'oauth', providerKey])`, which is also passed to `useScopedQuery`.

   The current `[...statusKey, 'oauth', providerKey]` is not the query's key. The actual key places `oauth` under the `settings` domain before `providerKey`; pin both exact invalidations in the screen test.
6. `error`, `denied`, or `expired` maps to the existing `oauthError` display. The memory adapter should normally emit only waiting, approved, or error.
7. `chooseProvider` aborts the current local run and clears its normalized state/error before changing `selectedProvider`. The current effect instead cleans up and can restart against the newly selected provider because `oauthPending` stays true; never retarget one provider's flow to another provider's status route.
8. `useScopeReset` aborts the active run and clears normalized flow state and errors. A separate unmount cleanup aborts as well.
9. There is no Cancel button and no remote cancellation call.
10. Remove screen imports of `beginScopedTask`, `runRemoteAction`, and `useGatewayApi`; other memory behavior does not use the raw Gateway API.

### MCP screen

Files:

- `client/src/features/capabilities/mcp-screen.tsx`
- new `client/src/features/capabilities/mcp-screen.test.tsx`

Changes:

1. Replace raw `McpOAuthFlow` screen state with `OAuthFlowState<McpOAuthContext>`.
2. Replace the `authMutation` plus polling `useEffect` with `runOAuthFlow(createMcpOAuthAdapter(...))`.
3. Keep one local `authBusy` flag plus a synchronous ref guard for all Auth buttons for the entire run, not just the start request. Clear them only while the captured Scope is current; `useScopeReset` clears them for the new Scope. This prevents two server rows from sharing one flow slot.
4. The shared module auto-opens the initial nonblank URL. Keep the Open authorization button so users can reopen the latest URL, but hide it for null, empty, or whitespace-only values.
5. Render normalized phase and message:
   - waiting → adapter message or `Starting authentication…`; the adapter message preserves the authorization-required instruction even when no URL exists;
   - approved → Authentication complete;
   - error → adapter message or existing fallback.
6. Delete timeout string matching. Display the `OAUTH_TIMEOUT` message supplied by the adapter.
7. Explicit Cancel:
   - abort local polling first;
   - call `mcpApi.cancelOAuth(flow.context.flowId)` through the existing scoped mutation;
   - clear flow state on success;
   - keep the card and show the classified error on failure.
8. Dismiss:
   - abort local polling;
   - clear local state;
   - do not call the remote cancel route.
9. `useScopeReset` aborts and clears the active flow and busy guard. A separate unmount cleanup aborts as well.
10. Remove the OAuth-specific `runRemoteAction`, `useGatewayApi`, raw polling refs, and old effect. Keep `beginScopedTask`: the file currently calls it four times in non-OAuth editor route/callback branches.

## Test plan

Follow replace-don’t-layer testing. New tests at the OAuth flow interface own lifecycle behavior. Screen tests retain only UI policy that remains outside the module.

### 1. Polling engine tests

Update `client/src/gateway/remote-action.test.ts` first.

Update every direct engine test to omit the dummy `MemoryGateway` and use `start(signal)` / `poll(signal)`. Keep `MemoryGateway` only in `runGatewayAction` route tests.

Add tests that:

- a supplied `timeoutError` Error instance is thrown unchanged after exactly the configured number of polls, and the factory receives that bound once;
- the existing generic timeout message, classified kind (`network`), and retryability remain unchanged when no factory is supplied;
- cancellation during backoff still leaves no timer when a timeout factory exists.

Existing tests for retries, Scope predicates, late start cancellation, in-flight poll cancellation, and gateway-action behavior must remain green.

### 2. OAuth flow interface tests

Create `client/src/gateway/oauth-flow.test.ts` using fake adapters, fake timers where needed, and a stub external opener. `MemoryGateway` is not part of this interface after the engine cleanup.

Required cases:

1. **Immediate terminal states**
   - start returns approved, denied, expired, or wire error in separate cases;
   - each publishes once, does not open or poll, and returns unchanged;
   - even a terminal start state carrying a URL does not invoke the opener.

2. **Waiting to approval ordering**
   - start returns waiting with URL;
   - start state publishes before opener runs;
   - opener runs once;
   - polls through waiting to approved;
   - each state publishes in order;
   - returns the approved context.

3. **Missing or blank authorization URL**
   - waiting states with `authorizationUrl` equal to `null`, `''`, and whitespace are valid separate cases;
   - opener is not called;
   - polling still completes.

4. **Nonfatal, concurrent opener**
   - a synchronous/early unsafe or popup rejection reaches `onError` as a classified error while Scope is current;
   - polling continues and may approve;
   - a never-settling opener does not delay the first poll or terminal return;
   - an opener that rejects after terminal return is ignored.

5. **Timeout classification**
   - bounded waiting returns `undefined`;
   - `onError` receives code `OAUTH_TIMEOUT`;
   - error is non-retryable;
   - details include `maxAttempts`;
   - adapter timeout copy is preserved.

6. **Transport failure**
   - start failure is classified and reported once;
   - a non-retryable poll failure and a retryable poll failure after the engine's four total attempts (`maxNetworkErrors` default 3, then the fourth error escapes) are each reported once;
   - passing an existing `GatewayError` through the engine/catch path preserves object identity.

7. **Caller abort before start**
   - start is not invoked;
   - no update or error callback fires;
   - result is undefined.

8. **Caller abort after publication or during backoff**
   - aborting from the initial `onUpdate` prevents opener and poll calls and resolves undefined;
   - aborting during backoff prevents a later poll;
   - no update or error callback fires after abort, and no timer remains.

9. **Scope changes after start**
    - cover a connection-only change, a profile-only change, and switch-away-then-back to the original pair while a poll is pending. The generation must make the last case stale too;
    - each late result does not publish, no error callback fires, and result is undefined.

10. **Scope/abort while opener is pending**
    - reject a pending opener after a Scope change and, separately, after caller abort;
    - neither rejection reaches `onError` in the next Scope or after cancellation.

11. **Engine-owned cleanup**
    - terminal completion and abort leave no polling timer. Listener removal and effective-controller abortion stay pinned in `remote-action.test.ts`; OAuth tests must not inspect or recreate that implementation detail.

Test observable behavior only. Do not inspect private helper state.

### 3. Adapter tests

Extend `client/src/features/settings/settings-api.test.ts`:

- provider PKCE start maps URL, waiting phase, and context;
- provider device-code start maps verification URL and user code;
- provider poll maps every status and error message;
- missing, empty, and whitespace-only provider session ids reject before polling; a nonblank opaque id is retained byte-for-byte;
- provider start and submit stay profile-bound while poll and cancel remain unscoped; pin encoded provider/session paths as the current route methods require;
- memory `connected: true` and `state: 'connected'` each map approved;
- memory pending and idle map waiting while disconnected;
- memory error preserves detail, but a contradictory connected+error payload maps approved;
- memory start and status paths remain profile-bound according to existing route behavior;
- polling constants and exact timeout copy are pinned.

Extend `client/src/features/capabilities/mcp-api.test.ts`:

- MCP start maps optional URL and context;
- `starting` and `authorization_required` map waiting while preserving the current distinct user instructions, including authorization-required with a null URL;
- approved and error map terminal states;
- missing, empty, and whitespace-only flow ids reject; a nonblank opaque id is retained byte-for-byte;
- context keeps the requested server name even if the response's `server_name` differs;
- profile-bound auth start plus unscoped poll and cancellation paths are pinned, including encoded names/ids;
- a URL first returned by poll is mapped for caller reopen without changing context;
- polling constants and exact timeout copy are pinned.

Do not duplicate generic polling tests in adapter suites.

### 4. Provider screen tests

Extend `settings-administration-screen.test.tsx` with a focused provider render helper and mocked external opener.

Cover:

- Connect starts the adapter and displays device code/state.
- Approval closes the card and refetches provider status.
- Device-code submit sends the correct provider/session/code.
- The one-shot field clears after successful and failed submission when unchanged, including whitespace-padded input; a newer edit made during the request is retained.
- Approved submission aborts the polling run before closing/refetching.
- Cancel aborts local polling before the unscoped delete request and clears the code before and after failure. A failed delete keeps the card.
- a second provider Connect click while one run is active is rejected by the busy/ref guard;
- Connection change, Profile change, and away-then-back suppress late provider effects.
- Start failure leaves no card; opener failure renders an error but leaves the flow card active and polling.

Keep these as caller-policy tests. Poll timing and retry belong to `oauth-flow.test.ts`.

### 5. Memory screen tests

Extend `memory-settings.test.tsx`:

- immediate connected start never polls and refreshes status;
- pending start polls to connected and updates the card;
- start error terminates without polling; post-start idle remains waiting rather than being treated as approval;
- approval invalidates the exact saved OAuth key and memory status key;
- timeout renders the adapter-specific message;
- selecting another memory provider aborts the old run and never polls the new provider under the old authorization;
- connection change, Profile change, away-then-back, and unmount abort without an error banner;
- no cancellation request is made.

Retain existing configuration and named-profile gate tests unchanged.

### 6. MCP screen tests

Create `mcp-screen.test.tsx`:

- Auth starts a flow and exposes the waiting card;
- null, empty, and whitespace-only authorization URLs neither call the opener nor render the reopen button, and still poll;
- approval renders Authentication complete;
- `OAUTH_TIMEOUT` copy renders without string inspection in the screen;
- Cancel aborts and calls the unscoped delete route;
- Dismiss aborts without calling delete;
- a second Auth click while one run is active is rejected by the busy/ref guard;
- connection change, Profile change, and away-then-back suppress a late result.

Use `MemoryGateway` and a QueryClient consistent with nearby screen tests.

### 7. Regression and build checks

Run from `client/` in this order:

```bash
npm test -- src/gateway/remote-action.test.ts src/gateway/gateway-api.test.ts src/gateway/oauth-flow.test.ts
npm test -- src/features/settings/settings-api.test.ts src/features/capabilities/mcp-api.test.ts
npm test -- src/features/settings/settings-administration-screen.test.tsx src/features/settings/memory-settings.test.tsx src/features/capabilities/mcp-screen.test.tsx
npm run typecheck
npm test
npm run build
```

The narrow checks should run first so interface failures are easy to locate. The full suite and production build verify that the new module does not leak React or native code into unrelated bundles.

### 8. Browser verification status

Browser verification is unavailable in the current repository fixture. `client/e2e/server.mjs` has no provider OAuth, memory OAuth, MCP auth, OAuth status, submit, or cancellation REST handlers; its unmatched `/api/*` branch returns `404 Fixture API route not found`. The MCP fixture row also lacks `auth: 'oauth'`, so it does not expose the Auth control. The only e2e MCP coverage navigates to the MCP screen.

Do not add the missing fake route families to this refactor just to duplicate the direct module and screen tests. Record this known limitation in the implementation result. A manual pass against a real OAuth-capable gateway remains useful after implementation, but it is not an executable acceptance gate in this repository. Typechecking and JSDOM do not prove native popup behavior; `platform-actions.test.ts` remains the direct witness for credential-free HTTP(S) validation.

## Implementation sequence

### Phase 1: pin the polling engine extension

1. Update engine tests to the signal-only callbacks and add failing cases for custom timeout creation and unchanged defaults.
2. Remove the unused GatewayPort option/callback arguments and `GatewayApi.gateway` escape hatch.
3. Add `timeoutError` to `RemoteActionOptions` and use it only at the existing attempt-bound branch.
4. Run the narrow engine and gateway API tests.

### Phase 2: build the deep module test-first

1. Add `oauth-flow.test.ts` with all immediate terminal phases, waiting-to-approved ordering, missing URL, nonblocking/late opener cases, timeout, abort, and the full Scope-staleness taxonomy.
2. Add `oauth-flow.ts` with the public types and `runOAuthFlow`.
3. Reuse `runRemoteAction`; do not add polling helpers.
4. Run engine and OAuth flow tests together.

### Phase 3: add feature adapters

1. Add provider and memory adapter tests to `settings-api.test.ts`.
2. Implement their context types and factories in `settings-api.ts`.
3. Add MCP adapter tests to `mcp-api.test.ts`.
4. Implement its context type and factory in `mcp-api.ts`.
5. Run both adapter suites.

### Phase 4: migrate provider OAuth

1. Add provider screen tests before changing production code.
2. Replace raw start/poll state with selected-provider plus normalized state and one active-run guard.
3. Preserve revision-safe device-code submit and cancel hygiene.
4. Remove old polling imports/effect/refs.
5. Run provider screen and adapter tests.

### Phase 5: migrate memory OAuth

1. Add immediate, pending, idle/error boundary, exact-invalidation, timeout, and stale-Scope tests.
2. Replace the old effect with `runOAuthFlow`.
3. Correctly invalidate the existing OAuth query key and memory status key after approval.
4. Remove old polling imports and state.
5. Run memory screen and adapter tests.

### Phase 6: migrate MCP OAuth

1. Create the focused MCP screen suite, including the one-active-run guard.
2. Replace auth mutation plus polling effect with `runOAuthFlow`.
3. Preserve reopen, Cancel, and Dismiss behavior.
4. Remove timeout string matching and old polling imports.
5. Run MCP screen and adapter tests.

### Phase 7: remove superseded tests and dead code

1. Delete old screen assertions that test polling internals now covered at the OAuth flow interface.
2. Keep route-scope tests in feature API suites.
3. Keep device-code secret hygiene, cache invalidation, explicit cancellation, and rendering tests in screen suites.
4. Search for remaining direct OAuth use of `runRemoteAction`; none should remain outside `gateway/oauth-flow.ts`.
5. Search for timeout message substring matching; none should remain.

Suggested checks:

```bash
rg -n "runRemoteAction" client/src/features/settings client/src/features/capabilities
rg -n "includes\(['\"]timed out|message.*timed out" client/src
rg -n "beginScopedTask" client/src/features/settings/memory-settings.tsx client/src/features/capabilities/mcp-screen.tsx
```

The first two searches must return no matches. The third must return none for memory settings and exactly the import plus four non-OAuth calls in MCP editor branches.

### Phase 8: full verification

1. Run typecheck.
2. Run all Vitest tests.
3. Run the production build.
4. Record browser flow verification as unavailable for the fixture, with the verified missing-route reason above.
5. Inspect `git diff --check`.
6. Confirm `CONTEXT.md` still describes the implemented ownership accurately. Update only if the final behavior differs; no new domain term is required by this plan.

## File-by-file change list

### New files

- `client/src/gateway/oauth-flow.ts`
  - normalized phases and state;
  - adapter and options types;
  - `runOAuthFlow` implementation;
  - Scope, abort, opening, polling, error, and timeout ownership.

- `client/src/gateway/oauth-flow.test.ts`
  - complete interface-level lifecycle coverage.

- `client/src/features/capabilities/mcp-screen.test.tsx`
  - MCP caller policy and visible state coverage.

### Modified files

- `client/src/gateway/remote-action.ts`
  - remove the unused GatewayPort pass-through;
  - add the optional timeout error factory.

- `client/src/gateway/remote-action.test.ts`
  - signal-only callback migration;
  - custom and default timeout behavior and engine-owned cleanup.

- `client/src/gateway/gateway-api.ts`
  - remove the now-unused public `gateway` escape hatch; request adapters still close over the same GatewayPort.

- `client/src/features/settings/settings-api.ts`
  - provider and memory adapter factories and context types.

- `client/src/features/settings/settings-api.test.ts`
  - adapter normalization and route-scope tests.

- `client/src/features/capabilities/mcp-api.ts`
  - MCP adapter factory and context type.

- `client/src/features/capabilities/mcp-api.test.ts`
  - adapter normalization, optional URL, and unscoped route tests.

- `client/src/features/settings/settings-administration-screen.tsx`
  - provider flow migrated to normalized state and shared lifecycle.

- `client/src/features/settings/settings-administration-screen.test.tsx`
  - provider submit, cancel, opener, approval, and secret-hygiene tests.

- `client/src/features/settings/memory-settings.tsx`
  - memory flow migrated; duplicated polling effect removed.

- `client/src/features/settings/memory-settings.test.tsx`
  - immediate/polled completion, timeout, and Scope tests.

- `client/src/features/capabilities/mcp-screen.tsx`
  - MCP flow migrated; duplicated polling effect and timeout string matching removed.

### Expected unchanged files

- `client/src/native/platform-actions.ts`
  - remains the production external URL adapter.

- `client/src/native/platform-actions.test.ts`
  - continues to pin safe credential-free HTTP(S) URL validation.

- `client/src/lib/types.ts` and `client/src/compat/hermes-types.ts`
  - existing wire types remain authoritative.

- `CONTEXT.md`
  - already names the OAuth flow module and the intended ownership accurately.


## Behavior matrix

| Flow | Start | External URL | Poll | Terminal phases | Caller-owned action |
|---|---|---|---|---|---|
| Provider PKCE | profile-bound | supplied by start; validated by opener | unscoped by session id | approved, denied, expired, error | unscoped remote cancel |
| Provider device code | profile-bound | verification URL supplied by start | unscoped by session id | approved, denied, expired, error | profile-bound submit, unscoped remote cancel, revision-safe code clearing |
| Memory provider | profile-bound | none in the declared wire type | profile-bound status | approved, error; idle remains waiting during a run | exact query invalidation; no remote cancel |
| MCP | profile-bound auth start | optional on start and poll | unscoped by flow id | approved, error | reopen latest URL, unscoped remote cancel, local-only dismiss |

## Risks and mitigations

### Risk: a shared adapter becomes a second wire vocabulary

Mitigation: adapters live beside `SettingsApi` and `McpApi`. `oauth-flow.ts` imports neither feature module and sees only normalized state.

### Risk: stale callbacks update a new Profile

Mitigation: the module captures Scope once and guards every update, error, and return. Tests change both connection and Profile while work is pending.

### Risk: abort and remote cancel become conflated

Mitigation: the interface accepts only a local abort signal. Provider and MCP screens explicitly call remote cancellation routes after aborting local polling. Memory never invents a cancel request.

### Risk: an opener blocks polling or rejects after the flow is over

Mitigation: publish start state first, launch without awaiting, and guard the rejection with the run's active flag plus Scope/signal checks. Tests use both never-settling and late-rejecting opener promises.

### Risk: timeout customization changes non-OAuth actions

Mitigation: `timeoutError` is optional. Existing default behavior and all `runGatewayAction` tests stay unchanged.

### Risk: device codes linger in state

Mitigation: keep device-code submission and cancellation in the provider caller, retain revision-safe clearing, and add both success and failure tests. Do not put submitted codes in adapter context, stores, query cache, logs, or error details.

### Risk: a memory flow is retargeted when selection changes

Mitigation: bind the adapter and invalidation keys at start, and make `chooseProvider` abort and clear the current run before switching. A screen test proves the new provider is not polled under the old run.

### Risk: two flow runs overlap in one Scope

Mitigation: provider and MCP use a busy state plus synchronous ref guard for their single flow slot; memory already disables its only start button while waiting. Each start aborts any controller left by a prior settled run before assigning the new one. Screen tests prove a second start is rejected rather than inventing multi-flow state.

### Risk: the shared module duplicates engine cancellation

Mitigation: callers own one controller and `runRemoteAction` owns the effective controller, listener, and timer. `runOAuthFlow` passes the signal through and adds no controller or timer.

## Acceptance criteria

The refactor is complete when all of the following are true:

- `client/src/gateway/oauth-flow.ts` exists and matches the ownership in `CONTEXT.md`.
- Provider, memory, and MCP screens no longer call `runRemoteAction` directly for OAuth.
- The OAuth flow module is the only OAuth caller of the generic polling engine.
- All three feature adapters return the normalized phase union; provider exercises all five phases, while memory and MCP emit only phases supported by their wire unions.
- Feature route paths and profile/unscoped behavior remain unchanged.
- External URLs still pass through `PlatformActions.openExternal` and its URL validation.
- Missing MCP authorization URLs remain valid.
- Opener failures do not stop polling.
- Scope changes and local aborts produce no stale updates or error banners.
- Provider device-code inputs clear after submit and cancel, including failure paths, without erasing a newer edit made during an in-flight submit.
- Provider and MCP explicit cancellation still call their existing unscoped routes.
- Memory authorization never calls a cancellation route.
- MCP no longer matches timeout error text.
- OAuth timeout errors have code `OAUTH_TIMEOUT` and are non-retryable.
- Existing generic remote-action scheduling and default timeout behavior are unchanged for non-OAuth callers; its unused GatewayPort parameter is gone.
- `GatewayApi` no longer exposes a transport solely for the polling engine.
- A pending external opener cannot delay polling, and late opener errors cannot land after terminal completion, abort, or Scope change.
- Direct module tests, adapter tests, and caller-policy screen tests pass.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
- Browser verification is recorded as unavailable because the checked-in fixture has none of the required OAuth REST routes.
- No unrelated files are reformatted or changed.

## Side effects and repository safety

- This root `plan.md` replaces the previous Workspace navigation plan in the working-tree diff.
- No ADR conflicts exist because the repository has no `docs/adr/` directory.
- No `CONTEXT.md` edit is needed. The OAuth flow term and ownership already exist.
- The pre-existing user modification in `client/src/navigation/workspace-navigation.test.ts` is unrelated and must remain untouched during implementation.
