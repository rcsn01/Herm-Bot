# Complete the OAuth flow module

## Goal

Create the promised deep OAuth flow module at `client/src/gateway/oauth-flow.ts` and route all in-app authorization polling through it.

The module will cover the three authorization flows already present in the app:

- provider accounts in `settings-administration-screen.tsx`;
- memory-provider authorization in `memory-settings.tsx`;
- MCP server authorization in `mcp-screen.tsx`.

It will own the common protocol work:

- Scope capture and stale-result discard;
- start and poll lifecycle;
- normalized phases of `waiting`, `approved`, `denied`, `expired`, and `error`;
- bounded polling through the existing `runRemoteAction` engine;
- automatic opening of an authorization URL when the wire response supplies one;
- explicit re-opening of the current authorization URL;
- cancellation of local polling on stop, Scope change, and unmount;
- typed timeout classification as `GatewayError` with code `OAUTH_TIMEOUT`.

Feature modules will keep their route vocabulary and protocol-specific policy. Provider device-code submission and remote cancellation remain at the provider call site. MCP remote cancellation remains at the MCP call site. Memory OAuth keeps its existing status-only contract because it has no flow handle, authorization URL, or cancel route.

Gateway login in `GatewayController.login` and `passwordLogin` is outside this work. It is a connection and redirect flow, not one of the provider, memory-provider, or MCP authorization flows described by `CONTEXT.md`.

## Why this work is needed

`CONTEXT.md` already names `gateway/oauth-flow.ts` as the deep module for provider, memory-provider, and MCP authorization, but that file does not exist.

The protocol is currently copied into three screen implementations:

- `client/src/features/capabilities/mcp-screen.tsx:57-121` owns the MCP start result, authorization URL, polling effect, abort controller, terminal mapping, timeout message, and cancel interaction.
- `client/src/features/settings/settings-administration-screen.tsx:197-321` owns provider start, external URL opening, provider polling, device-code submission, cancellation, mounted checks, refs for changing callbacks, and terminal mapping.
- `client/src/features/settings/memory-settings.tsx:102-157` owns memory OAuth polling, its separate pending flag, status mapping, invalidation, and error state.

All three call `runRemoteAction`, but that module only supplies backoff, abort, retry of temporary network errors, and a caller-provided completion predicate. It does not capture the Scope, normalize OAuth states, open authorization URLs, or classify an OAuth timeout.

The current tests cover route bytes and the generic polling engine, but not a shared OAuth interface:

- `client/src/features/settings/settings-api.test.ts:88-104` checks provider poll and cancel route scoping.
- `client/src/features/capabilities/mcp-api.test.ts:32-40` checks MCP cancel scoping.
- `client/src/features/settings/memory-settings.test.tsx:58-145` covers memory provider config and stale save handling, but not the OAuth state machine.
- `client/src/gateway/remote-action.test.ts:10-164` covers generic polling, cancellation, retries, and timeout bounds.
- There is no `client/src/gateway/oauth-flow.test.tsx`, no MCP screen flow test, and no provider OAuth screen flow test.

The deletion test supports the deepening. Delete the proposed module and the same start, poll, timeout, stale-scope, and cleanup rules return to three screens. The complexity does not disappear. It belongs behind one interface. The intended depth is the protocol lifecycle and its concurrency guarantees, while feature locality remains with route mapping, cache invalidation, rendering, and call-site policy.

## Decisions made

These are the recommended answers to the design questions for this candidate.

### 1. Cover all three in-app flows

Implement provider, memory-provider, and MCP authorization in one module. They share enough protocol behavior to justify a seam, and they already provide more than two concrete adapters:

- provider route adapter;
- memory-provider route adapter;
- MCP route adapter;
- in-memory test adapters.

Do not include Gateway login. Its redirect changes the connection lifecycle and can navigate the page before a flow result exists. Folding it into this module would make the interface less deep by mixing two different protocols.

### 2. Use a headless React hook as the public module

Use `useOAuthFlow` as the public interface in `client/src/gateway/oauth-flow.ts`.

A pure `runOAuthFlow` helper would remove some polling boilerplate, but each screen would still need its own effect, busy state, active abort controller, stale-result guard, and teardown. The hook hides those React lifecycle mechanics as well as the protocol mechanics. This gives the callers more leverage per fact they must learn, without taking route and presentation locality away from the feature.

The module can keep a private async runner inside the hook. Do not export that runner as a second public interface. The interface is the test surface.

### 3. Keep feature route vocabulary in feature adapters

The OAuth module must not import `SettingsApi` or `McpApi`. Feature modules will provide small adapters that call the existing route modules and return normalized snapshots.

The adapter seam is real, not hypothetical. Production uses three route adapters and tests use in-memory adapters. The OAuth module owns the protocol; the feature adapters own endpoint paths, profile scoping, raw response mapping, and feature-specific handles.

Do not change the route strings or move route ownership into `gateway/oauth-flow.ts`.

### 4. Inject external URL opening

The hook receives an `openExternal` function. Production callers pass a bound callback such as `url => platformActions.openExternal(url)`, preserving the `PlatformActions` instance. Unit tests pass a spy adapter.

This preserves the existing URL validation in `validatedExternalURL` and makes the external opener testable without opening a browser or an iOS sheet. The OAuth module calls the opener only for a normalized snapshot that has an authorization URL. The memory adapter supplies no URL, so it does not fabricate one.

The hook automatically attempts the first open after a successful start. A failure to open the URL becomes a current flow error, but it does not abort server-side polling. The user can use the explicit Open authorization action again.

### 5. Normalize wire states, not wire response shapes

The public OAuth snapshot will contain only values the screens need:

```ts
export type OAuthPhase =
  | 'waiting'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'error'

export interface OAuthFlowSnapshot {
  authorizationURL?: string
  flowId?: string
  message?: string
  phase: OAuthPhase
  userCode?: string
}
```

`flowId` is an opaque handle for callers that own cancellation or device-code submission. It is optional because memory OAuth has no handle.

The module treats `waiting` as the only non-terminal phase. All other phases stop polling. The module preserves stable metadata such as `flowId`, `authorizationURL`, and `userCode` when a later poll response omits it.

Do not expose raw provider, memory, or MCP response objects through the OAuth module. The screens already know which feature they are rendering, and raw response types would make the shared interface shallow.

### 6. Reuse `runRemoteAction` and add a narrow timeout hook

Keep the existing polling engine as the implementation underneath OAuth. Extend `RemoteActionOptions` with one optional timeout factory:

```ts
timeoutError?: (maxAttempts: number) => GatewayError
```

When the polling bound expires, `runRemoteAction` uses the supplied factory. Without it, the current generic timeout behavior remains unchanged. OAuth passes a factory that creates a non-retryable `GatewayError` with:

- `code: 'OAUTH_TIMEOUT'`;
- `kind: 'server'`;
- `retryable: false`;
- the attempt count in `details`;
- a user-facing message that tells the user to start authorization again.

A deliberate poll bound is not a temporary network error. It must not be classified as retryable just because individual network errors are retried inside the polling engine. A timeout from one HTTP request remains the existing request error; only exhaustion of the OAuth poll-attempt bound receives `OAUTH_TIMEOUT`.

### 7. Preserve the current polling cadence

Keep the current feature behavior while moving it:

- provider OAuth: 1 second initial interval, 5 second ceiling, 60 polls;
- MCP OAuth: 1 second initial interval, 5 second ceiling, 60 polls;
- memory OAuth: 2 second initial interval, 10 second ceiling, 60 polls.

The provider response contains `poll_interval`, but the current client does not use it. Do not broaden this change to gateway-driven polling cadence. If a later contract requires it, the provider adapter can own that policy without changing the OAuth module interface.

### 8. Keep remote cancellation and device-code submission at the call site

The shared module stops local polling. It does not guess whether a provider or MCP flow has a remote cancellation route.

- Providers keep `oauthCancel` and `oauthSubmit` in the provider screen policy.
- MCP keeps `cancelOAuth` in the MCP screen policy.
- Memory has no remote cancellation operation and only stops local polling.

This matches the existing domain decision in `CONTEXT.md` and prevents the shared module from inventing a cancellation protocol that memory OAuth cannot satisfy.

## Proposed interface

Create `client/src/gateway/oauth-flow.ts` with the following public shape. Names may be adjusted during implementation to match local style, but the interface must remain this small.

```ts
import type { GatewayPort } from './gateway-port'
import type { GatewayError } from './gateway-error'

export type OAuthPhase =
  | 'waiting'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'error'

export interface OAuthFlowSnapshot {
  authorizationURL?: string
  flowId?: string
  message?: string
  phase: OAuthPhase
  userCode?: string
}

export interface OAuthFlowAdapter {
  readonly gateway: GatewayPort
  readonly polling?: {
    intervalMs?: number
    maxAttempts?: number
    maxIntervalMs?: number
  }
  start(signal: AbortSignal): Promise<OAuthFlowSnapshot>
  poll(current: OAuthFlowSnapshot, signal: AbortSignal): Promise<OAuthFlowSnapshot>
}

export interface OAuthFlowController {
  readonly busy: boolean
  readonly error: GatewayError | null
  readonly snapshot: OAuthFlowSnapshot | null
  start(adapter: OAuthFlowAdapter): void
  stop(): void
  openAuthorization(): Promise<void>
}

export function useOAuthFlow(options: {
  openExternal?: (url: string) => Promise<void>
}): OAuthFlowController
```

Interface invariants:

- `start` is a no-op while a run is active. The caller disables its start control using `busy`.
- `start` clears the previous snapshot and error, captures the current Scope, and begins a new local run generation.
- `stop` aborts local polling, invalidates the current run generation, and clears the local snapshot and error. It never calls a feature's remote cancel route.
- `openAuthorization` opens the current snapshot's URL through the injected opener. If no URL exists, it does nothing. It classifies a current opener failure without changing the flow phase.
- A `waiting` snapshot continues polling. A terminal snapshot does not.
- A result publishes only when both the local run generation and the captured Scope are current.
- A stale Scope or local abort never publishes an error, snapshot, busy transition, or completion side effect.

The adapter is the only place that knows which route starts or polls a flow. The caller still owns what it does when the normalized phase becomes `approved`, `denied`, `expired`, or `error`.

## Protocol adapters

Add feature-owned adapter constructors. These are route vocabulary adapters, not new domain modules.

### Provider OAuth adapter

Add `client/src/features/settings/oauth-sources.ts` with a provider adapter constructor that accepts the existing `SettingsApi`, the existing `GatewayPort`, and a provider id.

Start behavior:

- call `settings.oauthStart(providerId, signal)`;
- map PKCE `auth_url` and device-code `verification_url` to `authorizationURL`;
- map `session_id` to `flowId`;
- map `user_code` when the response is a device-code flow;
- map both start variants to `phase: 'waiting'`;
- reject malformed responses that have no usable session id or authorization URL instead of starting an unpollable run.

Poll behavior:

- require the normalized `flowId`;
- call `settings.oauthPoll(providerId, flowId, signal)`;
- preserve the handle and authorization metadata;
- map `pending` to `waiting`;
- map `approved` to `approved`;
- map `denied` to `denied`;
- map `expired` to `expired`;
- map `error` to `error` and carry `error_message` as `message`.

Do not move `oauthSubmit` or `oauthCancel` into this adapter. They remain explicit provider policy in the provider screen.

### Memory-provider OAuth adapter

Keep the adapter beside the settings feature, in the same `oauth-sources.ts` file.

Start behavior:

- call `settings.startMemoryOAuth(provider, signal)`;
- map `connected` to `approved`;
- map `pending` to `waiting`;
- map `error` to `error` and carry `detail` as `message`;
- map an active-run response of `idle` to `error` with `detail` when present, or a fixed message explaining that the gateway did not start authorization;
- do not invent `flowId` or `authorizationURL`.

Poll behavior:

- call `settings.memoryOAuthStatus(provider, signal)`;
- map the same four states for an active run;
- continue polling a `pending` result even though it has no handle;
- retain no remote cancel policy because the existing `SettingsApi` has no memory OAuth cancel method.

The `idle` mapping must be covered by a test. It is a valid baseline status, but it does not prove that an authorization run is active. Treating active `idle` as `waiting` would poll until timeout, while treating it as approval would dismiss a provider that has not connected. The ordinary status query may continue to render baseline `idle` as disconnected.

### MCP OAuth adapter

Add `client/src/features/capabilities/mcp-oauth.ts` with a constructor that accepts the existing `McpApi`, the existing `GatewayPort`, and the server name.

Start behavior:

- call `mcpApi.auth(serverName, signal)`;
- map `flow_id` to `flowId`;
- map `authorization_url` to `authorizationURL`;
- map `starting` and `authorization_required` to `waiting`;
- map `approved` to `approved`;
- map `error` to `error` and carry the wire error as `message`.

Poll behavior:

- require the normalized `flowId`;
- call `mcpApi.oauthStatus(flowId, signal)` through the existing deliberately unscoped route;
- preserve the handle and URL;
- map the same MCP states.

Do not add `denied` or `expired` to `McpOAuthFlow` without a backend contract. The normalized phase union can support them for provider flows while MCP continues to expose only the states its wire type declares.

Remote cancellation remains `mcpApi.cancelOAuth(flowId, signal)` in `McpScreen`.

## Internal behavior of `useOAuthFlow`

### Start and Scope capture

`start(adapter)` will:

1. check a synchronous `activeRunRef` and return immediately if a run is already active;
2. set `activeRunRef` before the first state update so same-tick clicks cannot start two runs;
3. increment a private run generation;
4. abort any defensively retained controller from the previous run;
5. clear the previous snapshot and error;
6. create a fresh `AbortController`;
7. capture `beginScopedTask()` for the current connection and Profile;
8. set `busy` to true;
9. invoke the adapter through `runRemoteAction`.

Pass the captured task's `isCurrent` predicate to `runRemoteAction`. The local run generation is still required because a user can stop a run or start a new terminal run while the old promise is resolving under the same Scope.

### Start publication and external opening

When the adapter start resolves:

- validate the normalized snapshot's phase and required metadata;
- publish it only if the run and Scope remain current;
- if it contains `authorizationURL`, attempt to open it through `openExternal`;
- catch opener errors, classify them, and publish the current `error` without aborting polling;
- keep polling if the server flow is still waiting.

The module must not call `window.open` or the native plugin directly. `PlatformActions.openExternal` remains the production adapter and continues to reject non-HTTP(S) URLs or URLs with embedded credentials.

### Poll publication

Use `runRemoteAction` with the adapter's polling values. Each poll:

- receives the latest normalized snapshot;
- calls the feature adapter;
- merges stable metadata from the previous snapshot when the wire response omits it;
- publishes only while the run and Scope remain current;
- returns the normalized phase as the remote-action status.

The module must not reopen an authorization URL on every poll. The hook owns the automatic open after start; the caller invokes `openAuthorization` only for an explicit reopening afterward.

### Terminal handling

When polling returns a terminal snapshot:

- set the snapshot to that value;
- set `busy` to false;
- clear an earlier operation-level opener or transport error;
- keep protocol error text in `snapshot.message` rather than converting a provider rejection into a transport error;
- leave completion decisions to the caller.

A provider screen can respond to `approved` by refreshing its provider list. MCP can keep its existing completed card. Memory can invalidate its status and OAuth queries. The shared module does not know which cache to refresh.

### Timeout and transport errors

When `runRemoteAction` exhausts its bound, the timeout factory produces `OAUTH_TIMEOUT`. The hook publishes the current snapshot as an error phase and exposes the classified error.

For a non-abort transport failure:

- classify it with `classifyGatewayError`;
- expose it through `error` while the Scope is current;
- retain the last snapshot when it contains useful flow metadata;
- set `busy` to false.

For an abort or stale Scope:

- do not publish an error;
- do not publish a terminal phase;
- do not call a caller completion callback;
- do not leave a backoff timer behind.

### Stop and cleanup

`stop()` will abort the current controller and invalidate its run generation before clearing local state. The hook's unmount cleanup performs the same abort and generation invalidation, but must not call React state setters after unmount.

A Scope change uses the existing `useScopeReset` mechanism inside the hook. It stops the current run and clears local state. The hook must not rely only on a screen's `useScopeReset`, because the stale-scope guarantee belongs to the OAuth module and every caller must receive it.

The hook must remain safe under React effect cleanup and development Strict Mode. Adapter objects used by screens should be created at the click or provider-selection seam, not recreated on every render while a run is active.

### Explicit authorization reopening

`openAuthorization()` will:

- return immediately when there is no current authorization URL;
- capture the current Scope and current run generation;
- call the injected opener;
- classify and expose an opener error only while both the Scope and run generation remain current;
- leave the poll run untouched.

The generation guard matters when a user stops or replaces a flow while an earlier opener promise is still pending.

This supports device-code flows where the user may need to reopen the verification page after copying the code.

## Screen migrations

### Provider settings

Modify `client/src/features/settings/settings-administration-screen.tsx`.

Keep `ProvidersSettings` responsible for the provider list, endpoint list, endpoint actions, list refetch, and the selected provider identity. Replace the raw `OAuthStartResponse` state with the selected `OAuthProvider` used to mount the flow card.

Change the provider Connect action to select the provider and mount `ProviderOAuthFlow`. It must no longer call `settings.oauthStart` from the parent.

Refactor `ProviderOAuthFlow` to:

- create the provider route adapter;
- call `useOAuthFlow` and start it when the selected provider card mounts;
- render `snapshot.message`, `snapshot.phase`, `snapshot.authorizationURL`, and `snapshot.userCode` from the normalized state;
- rely on the hook's automatic open after start;
- use `oauth.openAuthorization()` only for the explicit Open provider button;
- keep device-code submission as a local `useScopedTask` operation using `snapshot.flowId`;
- stop local polling before calling `settings.oauthCancel` on Cancel;
- clear the code before and after cancellation or submission, preserving the existing one-shot input behavior;
- use a local completion guard in `ProviderOAuthFlow` so a late poll approval and a successful device-code submission cannot complete the flow twice;
- call the existing `onDone` policy after the guarded approval so the provider query refetches and the card closes;
- display `oauth.error` alongside the existing screen error without replacing endpoint errors.

Keep the existing provider status labels and endpoint behavior. Do not move custom endpoint persistence, billing, or other administration pages into the OAuth module.

Remove from this screen only the provider polling implementation: the direct `runRemoteAction` import for OAuth, polling abort ref, mounted ref used only by that poll, and start-level OAuth task. Keep `useScopedTask` for device-code submission, cancellation, external endpoint actions, and other settings policy that still needs it.

### MCP screen

Modify `client/src/features/capabilities/mcp-screen.tsx`.

Replace `flow`, `pollAbort`, and `authMutation` with:

- an active server name or null;
- one `useOAuthFlow` controller;
- the MCP route adapter created when authentication starts.

The Auth button will select the server and call `oauth.start(adapter)`. The screen will use:

- `oauth.busy` for the Auth button and status text;
- `oauth.snapshot` for authorization URL, phase, flow handle, and error message;
- the hook's automatic URL open after start and `oauth.openAuthorization()` for explicit reopening;
- the existing `cancelAuth` scoped mutation for remote cancellation;
- `oauth.stop()` before remote cancellation or dismissal.

On Cancel, capture `snapshot.flowId` before stopping. If a handle exists, invoke `mcpApi.cancelOAuth`; if no handle exists, dismiss locally. Preserve the existing behavior when cancellation fails: show the classified error and do not claim that the remote flow was cancelled.

Keep toggle, delete, test, catalog, editor, server-list invalidation, and selected-server routing unchanged. Remove only the direct OAuth polling effect, its `AbortController`, and the direct external URL action used by that flow.

### Memory settings

Modify `client/src/features/settings/memory-settings.tsx`.

Replace `oauthPending` and `oauthError` with the shared OAuth controller and a memory route adapter created for the selected provider.

The Start button will call `oauth.start(adapter)`. The memory card will render:

- `oauth.busy` as its pending state;
- `oauth.snapshot.message` for a terminal provider error;
- `oauth.error?.message` for transport or timeout errors;
- the existing `oauth.data` query status when no active flow snapshot exists.

When the normalized phase becomes `approved`, invalidate the memory status and provider OAuth query keys exactly as the current implementation does. When it becomes `error`, keep the wire detail visible. There is no external opener for this adapter because the existing memory route does not return an authorization URL.

If a memory start response is `pending`, continue polling the status route even though there is no handle. If the selected provider changes while the Scope is otherwise unchanged, stop the old local run before constructing the new provider adapter. The baseline status query can still display raw `idle` as disconnected; only an `idle` response received by an active OAuth adapter is normalized to an error.

Remove the direct `runRemoteAction` import and the memory OAuth polling effect. Keep the existing status query, provider selection, provider config editor, setup action, reset actions, and named-profile gate unchanged.

## `runRemoteAction` changes

Modify `client/src/gateway/remote-action.ts` only as needed to support protocol-specific timeout classification.

Add the optional timeout factory to `RemoteActionOptions`. At the existing timeout branch, call the factory when supplied and keep the current generic `classifyGatewayError(new Error(...))` fallback when absent.

Do not change:

- abort behavior;
- Scope predicate checks;
- temporary network-error retry count;
- backoff calculation;
- `runGatewayAction` start and terminal handling;
- action failure code `ACTION_FAILED`.

Extend `client/src/gateway/remote-action.test.ts` with one custom timeout test that asserts the factory's `GatewayError` is returned. Keep the existing generic timeout assertion to pin backward compatibility.

## Test plan

Use direct tests at the new module interface, then keep screen tests at the visible composition seam. Do not layer the old screen-level polling tests on top of the new hook tests.

### Step 1: Add the shared hook test seam

Create `client/src/gateway/oauth-flow.test.tsx`.

Use `renderHook`, a `MemoryGateway`, `$preferences`, and fake external opener functions. Each adapter in this file should be an in-memory `OAuthFlowAdapter`; the test must not call feature route constructors for the hook's protocol tests.

Cover these cases:

1. Starting a waiting adapter sets `busy`, publishes the waiting snapshot, and eventually publishes an approved snapshot.
2. A start snapshot with an authorization URL opens it once automatically.
3. `openAuthorization()` opens the same URL again without restarting polling.
4. A start snapshot without a URL never calls the opener.
5. A start opener rejection becomes a visible classified error while polling continues.
6. A terminal start snapshot does not poll.
7. A waiting poll maps to approved, denied, expired, and error phases without another poll after terminal state.
8. Stable `flowId`, URL, and user code survive a poll response that omits them.
9. `stop()` aborts a poll during backoff, clears state, and leaves no timer behind.
10. An unmount aborts the run and produces no late state update.
11. A Profile change suppresses a late poll result and late transport error.
12. A connection change followed by a switch back to the same Profile still suppresses the old run because the Scope generation changed.
13. A non-retryable poll error is classified and exposed while the Scope is current.
14. Temporary network errors are retried through `runRemoteAction` before the adapter reaches a terminal state.
15. Poll exhaustion exposes a `GatewayError` with `code: 'OAUTH_TIMEOUT'`, `retryable: false`, and the configured attempt count.
16. A delayed explicit opener result after `stop()` or replacement cannot publish an error into the next run.
17. Calling `start` in the same tick twice does not create a second active poll lane; the synchronous active-run ref wins before React state updates.
18. Starting again after a terminal state creates a fresh run and does not reuse the old snapshot or error.

Use deferred promises and `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync`. Assert request and poll counts before resolving each deferred response. Do not use real one-second sleeps.

### Step 2: Test feature adapters

Create `client/src/features/settings/oauth-sources.test.ts`.

Provider cases:

- PKCE start maps `auth_url` and `session_id` to a waiting snapshot.
- Device-code start maps `verification_url`, `session_id`, and `user_code`.
- Poll maps each provider terminal status and carries the error message.
- A missing session id or missing authorization URL rejects as an invalid start response.
- Poll uses the handle from the normalized snapshot.

Memory cases:

- `connected` maps to approved.
- An active `pending` response maps to waiting and remains pollable without a handle.
- An active `idle` response maps to error instead of creating a fake active flow.
- `error` maps to error and carries `detail`.
- No memory snapshot invents a handle or URL.
- A baseline status query may continue to render raw `idle` as disconnected.

Create `client/src/features/capabilities/mcp-oauth.test.ts`.

MCP cases:

- Start maps `authorization_required`, URL, and flow id.
- Start maps an already approved response without polling.
- Poll maps approved and error states while preserving the flow id.
- The adapter uses the existing unscoped poll route through `McpApi` rather than appending a Profile query.

Keep `settings-api.test.ts` and `mcp-api.test.ts` as route-shape tests. Adapter tests should focus on normalized meaning, not duplicate every route assertion.

### Step 3: Migrate provider screen tests

Extend `client/src/features/settings/settings-administration-screen.test.tsx` with provider flow coverage. Mock or spy on `PlatformActions.openExternal` so tests never open a real external URL.

Use `MemoryGateway` handlers for:

- `/api/providers/oauth` provider list;
- scoped provider start;
- unscoped provider poll;
- unscoped provider cancel;
- provider list refetch after approval.

Cover:

- Connect renders the waiting flow and opens the returned URL.
- Approval clears the flow and refetches the provider list.
- Device-code providers show the code, submit it with the session handle, and clear the input after the request settles.
- A rejected device code stays visible with the gateway message.
- Cancel aborts local polling and sends the existing unscoped DELETE route.
- A late poll result after a Profile change does not close the provider flow or publish an error.
- An opener failure is visible and the explicit Open provider action can retry it.

Retain the existing provider settings, endpoint, plugin, and profile-gate tests. Do not turn them into OAuth protocol tests.

### Step 4: Add MCP screen tests

Create `client/src/features/capabilities/mcp-screen.test.tsx` with a `QueryClientProvider`, `GatewayProvider`, and a fake external opener.

Cover:

- The server list renders an OAuth-authenticated server.
- Auth starts the scoped route, opens the URL, and polls the unscoped flow route.
- Approval renders the completed state.
- Cancel stops local polling and calls the unscoped cancel route.
- Dismiss stops local polling without calling the remote cancel route.
- Poll error and timeout use the shared error path.
- A Scope change suppresses a late status response.

Keep MCP editor, toggle, delete, catalog, and test behavior outside this test file unless an existing test already covers it.

### Step 5: Extend memory screen tests

Add to `client/src/features/settings/memory-settings.test.tsx`:

- start returns pending, status polling returns pending once and connected next, and the memory status and OAuth queries are invalidated after approval;
- an `error` status displays its `detail` without attempting to open an external URL;
- a timeout displays the shared OAuth timeout message and stops the pending state;
- a Profile change suppresses a late status response and clears the active flow.

Keep the current declared provider config, secret clearing, stale save, and named-profile tests unchanged.

### Step 6: Add one browser path

Extend `client/e2e/server.mjs` with the smallest deterministic MCP OAuth fixture. Keep the fixture state per browser session.

Add handlers for:

- `GET /api/mcp/servers?profile=default`, returning one enabled server with `auth: 'oauth'`;
- `POST /api/mcp/servers/<name>/auth?profile=default`, returning a waiting flow with a safe HTTPS authorization URL and `flow_id`;
- unscoped `GET /api/mcp/oauth/flows/<flow_id>`, returning waiting on the first poll and approved on the next;
- unscoped `DELETE /api/mcp/oauth/flows/<flow_id>`, recording cancellation and returning success.

Record the profile query on the start route and assert that the poll and cancel paths do not receive a Profile query.

Add one test to `client/e2e/pwa-foundation.spec.ts` that:

1. logs in through the existing fixture;
2. opens the Capabilities page and MCP page;
3. clicks Auth on the fixture server;
4. verifies the waiting flow and the authorization URL opener through a popup or intercepted `window.open`;
5. verifies the normalized approved state after polling;
6. verifies the recorded start, poll, and optional cancel paths through `/api/fixture-calls`.

Keep the test deterministic by using the fixture's second-poll approval. The hook tests remain authoritative for timing, Scope changes, and timeout behavior. The browser test proves that the rendered MCP flow reaches the production adapter and user-visible state.

## Required behavior matrix

### Shared protocol

- A run captures the current connection and Profile Scope.
- A stale Scope cannot publish a snapshot, error, busy transition, or completion effect.
- A local stop aborts polling and invalidates the run generation.
- Unmount leaves no active backoff timer or late state update.
- Only one poll run can be active per hook instance.
- A waiting phase polls; every other normalized phase is terminal.
- Temporary network errors use the existing retry policy.
- Poll exhaustion produces `GatewayError` code `OAUTH_TIMEOUT` and is not retryable.
- Authorization URL opening uses the injected external opener and existing URL validation.
- Opener failure does not cancel the server-side flow.

### Provider OAuth

- PKCE and device-code starts normalize to waiting.
- PKCE uses `auth_url`.
- Device-code uses `verification_url` and exposes `user_code`.
- Provider poll handles remain unscoped through `SettingsApi`.
- Approved, denied, expired, and error statuses stop polling.
- Device-code submission remains a separate caller operation.
- Remote cancellation remains a separate caller operation.
- Approval refetches the provider list and closes the card.

### Memory-provider OAuth

- Start and status routes remain Profile-scoped.
- Connected maps to approved.
- Active pending maps to waiting and remains pollable without a handle.
- Active idle maps to error instead of creating a fake active flow.
- Error maps to error with the provider detail.
- No handle, URL, or remote cancellation is fabricated.
- Baseline raw idle remains the disconnected status shown before a run starts.
- Approval invalidates memory status and OAuth queries.
- The existing memory card remains the visible policy owner.

### MCP OAuth

- Start remains Profile-scoped.
- Poll and cancel remain deliberately unscoped.
- `flow_id` remains opaque and is only used by MCP policy.
- Authorization URL opens through the shared opener.
- Approved and error stop polling.
- Cancel stops local polling before the remote DELETE.
- Dismiss stops local polling without remote cancellation.

### Compatibility

- Existing wire paths, verbs, bodies, Profile queries, and unscoped routes remain unchanged.
- Existing `SettingsApi` and `McpApi` route interfaces remain the feature adapter seam.
- Gateway login behavior remains unchanged.
- Existing CSS classes and visible labels remain unchanged except for the shared timeout text if a screen currently supplies a feature-specific variant.
- No new runtime dependency is added.
- Update the existing OAuth glossary entry in `CONTEXT.md` to say that provider and MCP flows may expose an opaque handle, while memory-provider OAuth is status-only and has no handle, URL, or cancel route. Also make the Gateway API entry's unscoped OAuth wording name only the routes that are actually unscoped. No new domain term is needed.

## Implementation sequence

Use vertical red-green slices. Do not write all tests first and then move the implementation in one large change.

### Step 1: Add the timeout extension

Modify `client/src/gateway/remote-action.ts` and its test first. Add the optional timeout factory and preserve the generic fallback. Run the focused remote-action tests.

### Step 2: Build the OAuth hook behind its direct interface

Create `client/src/gateway/oauth-flow.ts` and `client/src/gateway/oauth-flow.test.tsx`.

Implement Scope capture, run generations, abort cleanup, snapshot publication, external URL opening, normalized terminal handling, and the `OAUTH_TIMEOUT` path. Keep the adapter in-memory in this slice so the module is tested without feature route details.

Do not add screen imports yet. Get the hook's concurrency and cleanup behavior green first.

### Step 3: Add normalized feature adapters

Create:

- `client/src/features/settings/oauth-sources.ts`;
- `client/src/features/settings/oauth-sources.test.ts`;
- `client/src/features/capabilities/mcp-oauth.ts`;
- `client/src/features/capabilities/mcp-oauth.test.ts`.

Reuse the existing `SettingsApi` and `McpApi` methods. Do not change route factories unless a type or signal issue prevents the adapter from using them correctly.

### Step 4: Migrate the provider flow

Refactor the parent provider selection and `ProviderOAuthFlow` as described above. Add screen tests before deleting the old polling code. Once the new tests pass, remove the old `runRemoteAction` effect, refs, and raw wire-state handling.

### Step 5: Migrate MCP

Replace the MCP auth mutation and polling effect with the shared hook and adapter. Add the screen test, then delete the old flow state and `AbortController`.

### Step 6: Migrate memory OAuth

Replace the memory pending flag and polling effect with the shared hook and adapter. Add terminal, timeout, and stale-Scope tests. Keep the memory route and query ownership in `MemorySettings`.

### Step 7: Add the browser fixture path

Add the deterministic MCP OAuth fixture and one Playwright test. Use it to catch integration mistakes that unit tests cannot prove, especially route scoping, production `PlatformActions`, and the rendered status path.

### Step 8: Clean up and document

Search for direct OAuth polling imports and verify only `gateway/oauth-flow.ts` uses `runRemoteAction` for these three flows. The following direct screen responsibilities should be gone:

- provider and MCP polling `useEffect` blocks;
- screen-owned OAuth poll abort refs;
- feature screens passing raw wire status into shared-looking UI;
- feature screens classifying generic polling timeout strings.

Keep direct `useScopedTask` calls for provider device-code submission, remote cancellation, and unrelated settings actions. Keep `runRemoteAction` for Gateway actions and no-flow remote operations.

Update the existing OAuth and Gateway API glossary wording in `CONTEXT.md` to record the optional handle and the scoped versus unscoped route split. Do not add a second glossary term for the adapter or normalized phase types.

## Verification sequence

Run from `client/` in increasing breadth:

1. Shared polling and timeout behavior:
   ```bash
   npm test -- src/gateway/remote-action.test.ts src/gateway/oauth-flow.test.tsx
   ```
2. Feature adapter and route contracts:
   ```bash
   npm test -- src/features/settings/oauth-sources.test.ts src/features/settings/settings-api.test.ts src/features/capabilities/mcp-oauth.test.ts src/features/capabilities/mcp-api.test.ts
   ```
3. Screen flows:
   ```bash
   npm test -- src/features/settings/settings-administration-screen.test.tsx src/features/settings/memory-settings.test.tsx src/features/capabilities/mcp-screen.test.tsx
   ```
4. Existing nearby scope and platform regressions:
   ```bash
   npm test -- src/gateway/scope-guard.test.tsx src/native/platform-actions.test.ts
   ```
5. Typecheck:
   ```bash
   npm run typecheck
   ```
6. Full unit suite:
   ```bash
   npm test
   ```
7. Production build:
   ```bash
   npm run build
   ```
8. Browser flow:
   ```bash
   npm run test:e2e -- pwa-foundation.spec.ts --grep "MCP OAuth"
   ```

Before calling the work complete, inspect the built browser flow rather than relying only on TypeScript and unit output. Verify that a user can start MCP authorization, reopen its URL, see a waiting state, and reach the approved state. Verify that the fixture records Profile scoping on start and no Profile query on poll or cancel.

## Acceptance criteria

- `client/src/gateway/oauth-flow.ts` exists and is the only module that owns the common OAuth start, poll, Scope, external-open, and timeout protocol.
- Provider, memory-provider, and MCP screens use the shared hook through feature-owned adapters.
- No screen owns a direct OAuth polling effect or OAuth-specific backoff loop.
- The public hook interface exposes only `busy`, `error`, `snapshot`, `start`, `stop`, and `openAuthorization` behavior.
- The adapter interface contains route start and poll behavior, a Gateway transport, and optional polling values, but no screen state or cache policy.
- At most one OAuth run is active per hook instance.
- Stale Scope, local stop, and unmount suppress late success and failure effects.
- Poll exhaustion produces `GatewayError` code `OAUTH_TIMEOUT` with `retryable: false`.
- Provider PKCE and device-code flows preserve their URL, handle, and code behavior.
- Provider device-code submission and remote cancellation remain call-site policy.
- MCP start remains Profile-scoped, while poll and cancel remain unscoped.
- Memory OAuth does not gain a fabricated handle, URL, or cancel route.
- Authorization URLs pass through `PlatformActions.openExternal` and existing URL validation.
- Existing feature route tests remain green without changed request bytes.
- Screen tests verify visible composition and protocol-policy actions without duplicating the hook's full concurrency matrix.
- One Playwright test proves the rendered MCP flow against the production adapter and fixture.
- `CONTEXT.md` accurately describes the completed OAuth flow module.
- No new runtime dependency, generic OAuth framework, global flow registry, or Gateway login refactor is introduced.

## Risks and mitigations

### The shared hook becomes a pass-through around `runRemoteAction`

Keep Scope capture, run generations, normalized snapshots, external opening, timeout classification, and cleanup inside the hook. The caller should not need to know about `AbortController`, `isCurrentScope`, `runRemoteAction`, or raw wire statuses.

### Memory OAuth does not match the handle-based flows

Keep its adapter status-only. `flowId`, `authorizationURL`, and remote cancel remain optional or absent. Do not force memory into the provider or MCP response model.

### A poll approval races with device-code submission

The provider card must use one completion path. A successful device-code submit calls `oauth.stop()` before the completion callback. The hook suppresses a stopped or replaced poll snapshot, and a local `completionRef` in the provider card makes the approval effect and submit callback idempotent. Add a test with a deferred poll and a deferred submit to prove only one completion occurs.

### An external opener is blocked or fails

Keep the explicit Open authorization button. Opening is best effort and does not stop polling. Use the existing `PlatformActions` validation and expose the classified opener error so the user can retry.

### A stale Scope settles after the user switches away and back

Use both the `ScopedTask` predicate and a local run generation. The Scope generation in `scope-guard.ts` changes even when the user returns to the same connection and Profile, so a previous run cannot publish into the new foreground lifecycle.

### A timeout is mistaken for a retryable network error

Create `OAUTH_TIMEOUT` with `retryable: false` in the timeout factory. Keep temporary network retry inside `runRemoteAction`, but do not retry after the poll bound is exhausted.

### Adapter objects restart the hook on every render

Screens should construct an adapter on the explicit start action or memoize it by the provider/server identity. The hook captures the adapter for one run and never reads a changing adapter object after start.

### Remote cancellation races with local stop

Capture the opaque handle before calling `stop()`. Stop local polling first, then issue the existing scoped cancellation mutation. If the remote request fails, leave the user-visible error and local dismissed state consistent with the current feature policy rather than claiming cancellation succeeded.

### Browser popup behavior differs across platforms

Keep URL opening behind `PlatformActions`. Unit tests inject a fake opener. The Playwright test observes the opener through a popup or intercepted `window.open` and does not navigate the test page to the external provider.

### The module grows into a generic authorization framework

Do not add provider registries, persistence, refresh-token management, cross-screen flow storage, or generic cancel and submit commands. The module owns one active in-app authorization run. Feature adapters and callers keep the differences that are real.
