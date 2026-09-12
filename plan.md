# Deepen the scoped screen scaffold

Candidate 1 from the architecture review (September 12, 2026). This plan covers only that candidate. The report lives at `/var/folders/th/_8dpnzf515n6h74y89jpky5h0000gn/T/architecture-review-20260912-145341.html`; the design vocabulary (module, interface, seam, depth, locality, leverage) comes from the codebase-design skill; domain terms come from `CONTEXT.md`.

## Problem

Every feature screen re-wires the same data interface by hand:

```tsx
const preferences = useStore($preferences)
const key = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'settings', 'providers')
const providers = useQuery({ queryFn: ({ signal }) => settings.oauthProviders(signal), queryKey: [...key, 'oauth'] })
// + a useScopedTask and manual isCurrent() → invalidateQueries after every mutation
// + classifyGatewayError(error).message rendered into an error-banner / unsupported-card ternary
// + useEffect(() => { ...reset local state... }, [preferences.profile, preferences.remoteURL])
```

The reset idiom appears 7 times in `settings-administration-screen.tsx` alone and 15 more times across the other migrated screens: 12 across cron (4), models (1), and capabilities (7), plus one each in `memory-settings.tsx`, `config-section-screen.tsx`, and the `mcp-server-editor` form. The kind-based error-render ternary (`kind === 'unsupported' ? 'unsupported-card' : 'error-banner'`) is re-implemented 9 times — seven plain sites (cron jobs, cron delivery targets, skills, toolsets, toolset-detail config, mcp servers, memory status) plus two richer private clones in `remote-resource.tsx` and `memory-settings.tsx` — beside a third idiom, the always-unavailable phrase card (`X is unavailable: {message}`), 5 times. The mutation side already runs on `useScopedMutation` in 11 screens; `settings-administration-screen.tsx` still hand-rolls `useScopedTask` + manual `invalidateQueries` after every mutation, and the query side has no hook anywhere. The deletion test is unambiguous: delete the copy-paste and complexity vanishes; it earns no keep. The scoped-fetch pattern has no seam, so no test can hit it once.

## Goal

One home for the scoped screen pattern, inside the scoped-operation toolkit that `CONTEXT.md` already names:

- `useScopeKey`, `useScopedQuery`, `useScopeReset` in `client/src/gateway/scope-guard.ts`
- `GatewayErrorBanner` in a new `client/src/gateway/gateway-error-banner.tsx`

After the migration a screen reads: derive the key, run the query, render the error, reset on scope change. Four calls, no hand-wiring. Route vocabulary (domain, parts, fetcher, gates) and what-to-reset stay with the call site, exactly as `CONTEXT.md` splits toolkit plumbing from call-site policy.

## Decisions

The user authorized recommended answers for all clarification questions. The grilling tree, walked and settled:

**Q1. Where do the new hooks live?**
Recommended: extend `gateway/scope-guard.ts`, the module `CONTEXT.md` declares as owning the scoped-operation toolkit. A query-side counterpart belongs beside `useScopedMutation`, not in a sibling file. The banner goes next to `gateway-error.ts`, whose classification it renders.
Settled: yes.

**Q2. Does `useScopedQuery` derive the cache key internally, or accept it?**
Option A: `useScopedQuery({ domain, parts, queryFn })` derives internally; invalidation sites call a second hook with repeated arguments. Option B: `useScopeKey(domain, parts)` returns the key; `useScopedQuery(key, { queryFn })` accepts it.
Recommended: B. Twelve screens need the key anyway, for `invalidateQueries` prefixes and `useScopedMutation` optimistic configs. One derivation per domain feeds query, invalidation, and optimistic config. The seam is the `GatewayScopeKey`, already the shared cache vocabulary of `cancelGatewayQueries`, `clearGatewayQueries`, and `useScopedMutation.optimistic`. Two consumer families make it a real seam, not a hypothetical one.
Settled: B.

**Q3. Does the hook classify errors at runtime?**
Recommended: yes. Wrap the fetcher, classify on throw, type the result `UseQueryResult<TData, GatewayError>`. Callers stop importing `classifyGatewayError` for query errors; the interface carries the classified error, not an `unknown`.
Consequence to accept: the shared client's retry policy (`query-client.ts`: retry when `error.retryable`, max 2) starts working for queries. Today raw fetch errors carry no `retryable` flag, so queries never retry; after migration, network and server kinds retry. This matches the intent already written in `query-client.ts`. Call sites that opt out pass `retry: false` (the memory OAuth status query does).
Settled: yes, classify in the hook.

**Q4. Does the toolkit own the reset-on-scope-change idiom?**
Recommended: yes, as `useScopeReset(reset, ...extraDeps)`. The toolkit owns when (Scope changed: connection or profile), the caller owns what (the reset body, optionally returning a cleanup). This preserves the declared split: capture/check plumbing in the toolkit, policy at the call site.
Settled: yes.

**Q5. How much render policy does `GatewayErrorBanner` absorb?**
Recommended: every query-error render site. The seven kind-based clones (cron jobs, cron delivery targets, skills, toolsets, toolset-detail config, mcp servers, memory status), the two rich clones (remote-resource, models MoA), the nine plain message banners (archived chats, provider endpoints, config + schema, cron run history, skill content, skill-hub search, mcp catalog, cron blueprints), and five "always unavailable" phrase cards that opt in via a prop (billing, OAuth providers, credential management, plugins, memory provider editor). Soft-fail muted lines (gateway health, toolset models, voice catalog) and mutation-driven local error strings stay call-site policy.
Settled: yes.

**Q6. Migration scope?**
Recommended: every feature screen and `features/shared/remote-resource.tsx`. Excluded: `state/gateway-controller.ts` (its sessions query is module-internal, deep, and tested), `features/models/model-editing.ts` (builds keys from explicit params inside the model-editing module), `components/files-screen.tsx` (no direct `useQuery`), the chat surface, OAuth poll loops (candidate 2), model write queues (candidate 3).
Settled: full screen migration, one PR, staged commits.

**Q7. Test strategy?**
Per the codebase-design principle that the interface is the test surface: write tests at the new interface, keep existing screen tests passing unchanged. Screen tests already drive a `MemoryGateway` behaviorally, so they survive the refactor; that is the point of them.
Settled: interface tests for the three hooks and the banner; screen suites must stay green without edits except where they pin normalized copy.

## Interfaces

### `client/src/gateway/scope-guard.ts` (additions)

```ts
import { useEffect } from 'react'                      // add to existing react import
import { useStore } from '@nanostores/react'           // new import
import { useQuery, type UseQueryResult } from '@tanstack/react-query'  // extend existing import

/** Derive the scope-keyed cache key for one domain of route vocabulary. */
export function useScopeKey(
  domain: string,
  parts?: readonly unknown[],
  opts?: { unscoped?: boolean }
): GatewayScopeKey {
  const preferences = useStore($preferences)
  return gatewayScopeKey(
    { connectionKey: preferences.remoteURL, profile: opts?.unscoped ? null : preferences.profile },
    domain,
    ...(parts ?? [])
  )
}

export interface ScopedQueryOptions<TData> {
  queryFn: (signal: AbortSignal) => Promise<TData>
  enabled?: boolean
  retry?: boolean | number
}

export type ScopedQueryResult<TData> = UseQueryResult<TData, GatewayError>

/** Run one scope-keyed query; failures are classified before they reach the caller. */
export function useScopedQuery<TData>(
  key: QueryKey,
  options: ScopedQueryOptions<TData>
): ScopedQueryResult<TData> {
  return useQuery<TData, GatewayError>({
    enabled: options.enabled,
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        return await options.queryFn(signal)
      } catch (caught) {
        throw classifyGatewayError(caught)
      }
    },
    retry: options.retry
  })
}

/** Reset call-site local state whenever the Scope changes; the caller owns what to reset. */
export function useScopeReset(
  reset: () => void | (() => void),
  ...extraDeps: readonly unknown[]
): void {
  const preferences = useStore($preferences)
  // Dependency list is explicit by design: Scope fields plus caller extras.
  useEffect(() => reset(), [preferences.remoteURL, preferences.profile, ...extraDeps])
}
```

Notes:
- The additions above list only genuinely new imports; extend the existing `'./gateway-scope'` import with `gatewayScopeKey` and `type GatewayScopeKey` (`QueryKey`, `classifyGatewayError`, and `$preferences` are already imported).
- No memoization needed; `gatewayScopeKey` is pure and React Query compares keys structurally.
- `useScopeKey` with no parts returns the domain prefix `['gateway', connection, profile, domain]`, which is exactly what `invalidateQueries` wants for a domain-wide invalidation.
- `unscoped: true` pins the key's profile slot to `'default'` (via `gatewayScopeKey`'s `profile ?? 'default'`), so process-scoped routes keep one cache entry per connection. It changes only the key; the fetch route stays call-site vocabulary.
- The key parameter is typed `QueryKey`, so sub-keys built by spreading (`[...key, 'runs']`) typecheck. The `['gateway', connection]` prefix discipline is preserved because every key starts from `useScopeKey`; `cancelGatewayQueries` and `clearGatewayQueries` keep matching.
- `retry: undefined` falls through to the shared client default (classified, retryable-aware). That is the behavior change accepted in Q3.

### `client/src/gateway/gateway-error-banner.tsx` (new)

```tsx
import { classifyGatewayError } from './gateway-error'

const DEFAULT_UNSUPPORTED_TEXT = 'This gateway does not provide this optional capability.'

export interface GatewayErrorBannerProps {
  /** Raw query error, GatewayError, or an unclassified value (plain Error, message string). */
  error: unknown
  /** Rich mode lead: "Could not load {subject}" / "{subject} unavailable". */
  subject?: string
  /** Copy shown when the classified kind is 'unsupported'. */
  unsupportedText?: string
  /** Declare the capability unavailable on any failure: unsupported-card with "{phrase}: {message}". */
  unavailablePhrase?: string
  role?: 'alert' | 'status'
}

export function GatewayErrorBanner({ error, subject, role = 'alert', unsupportedText, unavailablePhrase }: GatewayErrorBannerProps) {
  if (error == null || error === '') return null
  const classified = classifyGatewayError(error)
  if (unavailablePhrase) {
    return <div className="unsupported-card" role={role}>{unavailablePhrase}: {classified.message}</div>
  }
  if (classified.kind === 'unsupported') {
    const text = unsupportedText ?? DEFAULT_UNSUPPORTED_TEXT
    return subject
      ? <div className="unsupported-card" role={role}><strong>{subject} unavailable</strong><p>{text}</p></div>
      : <div className="unsupported-card" role={role}>{text}</div>
  }
  return subject
    ? <div className="error-banner" role={role}><strong>Could not load {subject}</strong><p>{classified.message}</p></div>
    : <div className="error-banner" role={role}>{classified.message}</div>
}
```

Render rules, in order: falsy error renders nothing; `unavailablePhrase` forces the unavailable card; otherwise the classified kind picks the card and `subject` upgrades it to the rich two-part form. Unclassified inputs go through the same classify path — a plain `Error` lands as kind `server`; a string renders its message unless the text itself matches a kind pattern. No string branch exists because no call site passes a ready string, and mutation-driven strings stay call-site policy per Q5.

## File-by-file migration

Domain and parts come straight from the key each screen builds today, so cache entries keep their exact identity. `conn` below means `preferences.remoteURL`.

### `features/settings/settings-administration-screen.tsx`

| Sub-screen | Keys today | After |
|---|---|---|
| BillingSettings | `gatewayScopeKey({conn, profile: null}, 'settings', 'billing')`; queries `[...billingKey, 'state']`, `[...billingKey, 'subscription']`; invalidates `billingKey` | `const billingKey = useScopeKey('settings', ['billing'], { unscoped: true })`; queries via `useScopeKey('settings', ['billing', 'state'], { unscoped: true })` and `['billing', 'subscription']`; invalidation unchanged, key from `useScopeKey` |
| GatewaySettings | `gatewayScopeKey({conn, profile: null}, 'settings', 'gateway')` | `useScopeKey('settings', ['gateway'], { unscoped: true })`; the muted health line stays bespoke |
| ProvidersSettings | `'settings', 'providers'`; queries `[...key, 'oauth']`, `[...key, 'endpoints']`; invalidates `[...key, 'endpoints']` | `useScopeKey('settings', ['providers'])` with sub-keys `useScopeKey('settings', ['providers', 'oauth'])` and `['providers', 'endpoints']` (the endpoints key serves the activate-endpoint invalidation); `providers.error` renders `<GatewayErrorBanner error={providers.error} unavailablePhrase="OAuth providers are unavailable" />`; `endpoints.error` renders `<GatewayErrorBanner error={endpoints.error} />` |
| CustomEndpointForm | reset on `[endpoint?.id, profile, remoteURL]` | `useScopeReset(reset, endpoint?.id)` |
| ToolsKeysSettings | `'settings', 'env'`; invalidates `key`; reset on `[connection.phase, profile, remoteURL]` with timer cleanup | `useScopeKey('settings', ['env'])`; `useScopeReset(reset, connection.phase)` (reset body returns the timer cleanup); `variables.error` renders `<GatewayErrorBanner error={variables.error} unavailablePhrase="Credential management is unavailable" />` |
| ArchivedChatsSettings | `'settings', 'archived-chats'`; invalidates `key` | `useScopeKey('settings', ['archived-chats'])`; `sessions.error` renders the banner |
| PluginsSettings | `'settings', 'plugins'` with `profile: null`; `enabled: supportsPluginManagement` | `useScopeKey('settings', ['plugins'], { unscoped: true })` + `enabled` pass-through; `plugins.error` renders `<GatewayErrorBanner error={plugins.error} unavailablePhrase="Plugin management is unavailable" />` |

All seven reset effects (Billing, Gateway, Providers, CustomEndpointForm, ToolsKeys, ArchivedChats, Plugins) become `useScopeReset` calls. Billing's always-unavailable card becomes `<GatewayErrorBanner error={billing.error ?? subscription.error} unavailablePhrase="Billing is unavailable" />`.

### `features/settings/memory-settings.tsx`

- `statusKey` becomes `useScopeKey('settings', ['memory'])` (the current `useMemo` wrapper is unnecessary; the hook returns a fresh structurally-equal array).
- `config` query: `useScopeKey('settings', ['memory', 'provider', providerKey])`, keep `enabled: Boolean(providerKey)`.
- `oauth` query: `useScopeKey('settings', ['memory', 'oauth', providerKey])`, keep `enabled` and keep today's existing `retry: false`.
- `MemoryError` local component is deleted; `status.error` renders `<GatewayErrorBanner error={status.error} unsupportedText="Memory management is unavailable on this gateway." />`.
- `MemoryProviderEditor`'s always-unavailable card becomes `<GatewayErrorBanner error={error} unavailablePhrase="Provider settings unavailable" />`.
- Reset effect becomes `useScopeReset`.

### `features/settings/config-section-screen.tsx`

- `key` becomes `useScopeKey('settings', ['config'])`; `schema` query uses `useScopeKey('settings', ['config', 'schema'])`. The bespoke save queue keeps using `queryClient.setQueryData(key, ...)` and `invalidateQueries({ queryKey: key })`.
- Reset effect (with cleanup and extra deps `[category, settings]`) becomes `useScopeReset(reset, category, settings)`.
- `config.error` and `schema.error` render the banner.
- `VoiceProviderResources`: voices query uses `useScopeKey('settings', ['voice', 'elevenlabs'])`; the muted soft-fail line stays bespoke.

### `features/cron/cron-screen.tsx`

- `scopeKey` becomes `useScopeKey('cron', ['jobs'])`.
- The kind-based ternary becomes `<GatewayErrorBanner error={jobs.error} unsupportedText="Cron Jobs are unavailable on this gateway." />`.
- Reset effect becomes `useScopeReset`.

### `features/cron/cron-job-detail.tsx`

- `key` becomes `useScopeKey('cron', ['job', jobId])`; `runs` uses `useScopeKey('cron', ['job', jobId, 'runs'])`.
- The action's `onSettled` invalidates the domain prefix via `useScopeKey('cron')`.
- `runs.error` renders the banner; reset becomes `useScopeReset(reset, jobId)`.

### `features/cron/cron-blueprints-screen.tsx`

- Key `'cron', 'blueprints'` with `profile: null` becomes `useScopeKey('cron', ['blueprints'], { unscoped: true })`; keep the `enabled: defaultProfile` pass-through — dropping it would fire the query on named profiles.
- The plain error banner becomes `<GatewayErrorBanner error={blueprints.error} />` behind the existing `defaultProfile &&` gate; reset becomes `useScopeReset`.

### `features/cron/cron-job-editor.tsx`

- `targets` query key `'cron', 'delivery-targets'` with `profile: null` and `enabled: defaultProfile` becomes `useScopeKey('cron', ['delivery-targets'], { unscoped: true })` plus the `enabled` pass-through.
- The kind-based ternary on `targets.error` becomes `<GatewayErrorBanner error={targets.error} unsupportedText="Delivery targets are unavailable on this gateway." />`.
- Reset effect becomes `useScopeReset(reset, job?.id)`.

### `features/models/models-screen.tsx`

- `scopeKey` becomes `useScopeKey('models')`; the five queries use `useScopeKey('models', ['info'])`, `['options']`, `['auxiliary']`, `['config']`, `['moa']` (today's `keyFor(domain)` shape, unchanged).
- The MoA optimistic callbacks passed to `MoaEditor` keep their `beginScopedTask` guards (that is candidate 3 territory) but take the MoA key from `useScopeKey('models', ['moa'])`.
- The `moa.error` IIFE becomes `<GatewayErrorBanner error={moa.error} subject="Mixture of Agents" unsupportedText="This gateway does not provide the MoA endpoint. The rest of Models still works." role="status" />`.
- The load error becomes `<GatewayErrorBanner error={loadError} subject="Models" />`. Copy normalizes: the lead becomes "Could not load Models", and an `unsupported` kind now renders the unavailable card (consistent with sibling screens). Verified: no test pins the load-error lead; `models-screen.test.tsx` pins the MoA copy ('Mixture of Agents unavailable' plus the unsupported paragraph), which the banner reproduces verbatim — no test edit needed.
- Reset effect becomes `useScopeReset`.

### `features/capabilities/skills-screen.tsx`

- `queryKey` becomes `useScopeKey('skills', ['list'])`; the toggle's optimistic config and the `SkillDetail` archived invalidation reuse it (the `beginScopedTask` guard there stays).
- The kind-based ternary becomes `<GatewayErrorBanner error={skills.error} unsupportedText="Skills are unavailable on this gateway." />`.
- Reset effect becomes `useScopeReset`.

### `features/capabilities/skill-detail.tsx`

- The content query uses `useScopeKey('skills', ['content', skill.name])`.
- `content.error` renders `<GatewayErrorBanner error={content.error} />`; reset becomes `useScopeReset(reset, skill.name)`.
- Keep the exported `skillDetailQueryKey(connectionKey, profile, name)` helper untouched; it is module vocabulary for cross-screen invalidation with explicit params.

### `features/capabilities/skill-hub-screen.tsx`

- `scopeKey` becomes `useScopeKey('skills', ['hub'])`; `sources` uses `useScopeKey('skills', ['hub', 'sources'])`, `search` uses `useScopeKey('skills', ['hub', 'search', submitted, source])` with its `enabled` gate kept, and the install mutation invalidates the hub key.
- `search.error` renders `<GatewayErrorBanner error={search.error} />`; reset becomes `useScopeReset`.

### `features/capabilities/toolsets-screen.tsx`

- `queryKey` becomes `useScopeKey('tools', ['list'])`; the toggle's optimistic config reuses it.
- The kind-based ternary becomes `<GatewayErrorBanner error={toolsets.error} unsupportedText="Toolsets are unavailable on this gateway." />`.
- Reset effect becomes `useScopeReset`.

### `features/capabilities/toolset-detail.tsx`

- `config` query: `useScopeKey('tools', [toolset.name, 'config'])`; `models` query: `useScopeKey('tools', [toolset.name, 'models', selectedProvider])` with `enabled: Boolean(selectedProvider)`.
- The toggle invalidates the domain prefix via `useScopeKey('tools')`.
- The kind-based ternary on `config.error` becomes `<GatewayErrorBanner error={config.error} unsupportedText="Toolset setup is unavailable on this gateway." />`; the muted models line stays bespoke.
- Reset becomes `useScopeReset(reset, toolset.name)`.

### `features/capabilities/mcp-screen.tsx`

- `queryKey` becomes `useScopeKey('mcp', ['servers'])`. The OAuth poll loop is untouched (candidate 2).
- The kind-based ternary on `servers.error` becomes `<GatewayErrorBanner error={servers.error} unsupportedText="MCP is unavailable on this gateway." />`; reset becomes `useScopeReset`.

### `features/capabilities/mcp-catalog-screen.tsx`

- `scopeKey` becomes `useScopeKey('mcp', ['catalog'])`; the install mutation invalidates it.
- `catalog.error` renders `<GatewayErrorBanner error={catalog.error} />`; reset becomes `useScopeReset`.

### `features/capabilities/mcp-server-editor.tsx`

- No query and no query key here; only the reset effect becomes `useScopeReset(reset, server?.name)` so gate 3 can demand zero hand-wired reset effects.

### `features/shared/remote-resource.tsx`

- The query becomes `useScopedQuery(useScopeKey(definition.id, undefined, { unscoped: !isProfileScoped }), { enabled: !isUnavailableForProfile, queryFn: ... })`; the fetcher keeps choosing `api.request` vs `api.unscoped`.
- `ResourceError` is deleted; the banner renders `<GatewayErrorBanner error={error} subject={definition.title} />`. Copy normalizes: the unsupported lead "Unavailable" becomes "{title} unavailable". The existing test asserts the profile-gate card ("Unavailable for this profile"), which is a different element and unaffected.

## Behavior changes to accept

1. Queries retry on retryable failures. Classified network and server errors now satisfy the shared client's retry policy (max 2). Aligned with the intent documented in `query-client.ts`. Call sites needing the old behavior pass `retry: false` (memory OAuth status).
2. Small copy normalization on migrated banners: remote-resource's unsupported lead gains the subject; models' load-error lead capitalizes to "Could not load Models"; an `unsupported` kind in models' load error now renders the unavailable card. Deliberate, consistent with sibling screens.
3. Four formerly role-less cards gain `role="alert"` when they become banner call sites (OAuth providers, credential management, plugins, memory provider editor). Every kind-based site already carries `role="alert"`, models' MoA card keeps `role="status"` via the prop, and billing's card already carries `role="alert"`.
4. Cache keys keep their exact shape (`['gateway', connection, profileKey, domain, ...parts]`), so `cancelGatewayQueries`, `clearGatewayQueries`, and existing cached entries are unaffected.

## Test plan

New tests at the interface, following the harness in `gateway/scope-guard.test.tsx` (renderHook, QueryClientProvider wrapper, `bumpProfile` on `$preferences`, clients built with `retry: false`).

`gateway/scope-guard.test.tsx`, describe "scoped query scaffold":

1. `useScopeKey` derives `['gateway', connection, profile, domain, ...parts]` from the active preferences.
2. `useScopeKey` re-derives when the profile changes (renderHook + `bumpProfile`, assert the tuple changes).
3. `useScopeKey` with `unscoped: true` pins the profile slot to `'default'` and stays stable across profile flips.
4. `useScopedQuery` resolves data on the happy path.
5. `useScopedQuery` classifies failures: a fetcher throwing `TypeError('Failed to fetch')` lands as `GatewayError` with kind `'network'` and `retryable: true` on `result.error`.
6. `useScopedQuery` with `enabled: false` never calls the fetcher.
7. `useScopedQuery` keeps per-scope cache entries: fetch under profile A, flip to B, wait for the refetch under B's key, assert profile A's cache entry is untouched.
8. `useScopeReset` runs once on mount, again on profile or remoteURL change, not on unrelated rerenders.
9. `useScopeReset` fires on extra-dep changes and invokes a returned cleanup on scope change and unmount.

`gateway/gateway-error-banner.test.tsx` (plain render, no query client):

1. `null`, `undefined`, and `''` render nothing.
2. A string error renders `error-banner` with that message and `role="alert"`; `role="status"` is honored. (Strings ride the same classify path — no special branch.)
3. An `unsupported` GatewayError renders `unsupported-card` with the default text; `unsupportedText` replaces it.
4. `subject` + `unsupported` renders the rich card: strong "{subject} unavailable" plus the unsupported text.
5. `subject` + a network error renders `error-banner` with strong "Could not load {subject}" plus the classified message.
6. `unavailablePhrase` renders `unsupported-card` with "{phrase}: {message}" for any failure kind.
7. A plain `Error` (unclassified input) renders `error-banner` with its message (classified as `server`).

Existing screen suites must pass unchanged; they test through `MemoryGateway` and assert behavior, not wiring. No pinned copy changes: no test asserts the models load-error lead, and the pinned MoA copy is reproduced verbatim by the banner.

## Rollout

Seven commits, each leaving `npm run typecheck` and `npm test` green. Working directory for all commands: `client/`.

1. `feat(gateway): add useScopeKey, useScopedQuery, and useScopeReset to the scope-guard module` plus the hook tests. `CONTEXT.md` already carries the Scoped query term (added when the decision settled); adjust the wording here if the implementation drifts.
2. `feat(gateway): add GatewayErrorBanner` plus its tests.
3. `refactor(settings): run settings screens on the scoped query scaffold` (settings-administration-screen, memory-settings, config-section-screen).
4. `refactor(cron): run cron screens on the scoped query scaffold` (cron-screen, cron-job-detail, cron-blueprints-screen, cron-job-editor).
5. `refactor(models): run the Models screen on the scoped query scaffold`.
6. `refactor(capabilities): run capability and remote-resource screens on the scoped query scaffold` (skills-screen, skill-detail, skill-hub-screen, toolsets-screen, toolset-detail, mcp-screen, mcp-catalog-screen, mcp-server-editor's scope reset, features/shared/remote-resource).
7. `chore: sweep the scoped screen scaffold` with the grep gates below and a full build.

## Verification

```sh
cd client
npm run typecheck
npm test
npm run build        # typecheck + vite build, final gate
```

Grep gates (from the repo root):

```sh
# 1. Only module-internal key builders may remain outside gateway/
rg -n "gatewayScopeKey\(" client/src/features client/src/components
#    expected survivors: features/models/model-editing.ts, features/capabilities/skill-detail.tsx (exported helper)

# 2. classifyGatewayError remains only at deliberate soft-fail renders and mutation/poll error munging
rg -n "classifyGatewayError" client/src/features
#    expected survivors:
#    soft-fail muted renders: gateway health line (settings-administration), toolset-detail models
#      line, config-section voice line
#    classified kind check: memory-settings startOAuth ('unsupported' → OAuth copy)
#    mutation and poll munging (stay by design): every useScopedMutation onError handler
#      (memory-settings ×4, skill-detail, skill-hub, mcp-catalog, mcp-screen ×5, toolsets, skills,
#      toolset-detail ×5, cron-blueprints), the memory/provider-authorization/MCP poll loops' catch,
#      config-section's save-queue catch, cron-job-editor's formatCronError (also drives
#      cron-job-detail's job.error render), models-screen's MoA optimistic error path,
#      and features/models/model-editing.ts

# 3. No migrated file hand-wires the scope reset idiom (anchored on the effect dep-array tail:
#    catches the plain shape and the extras shapes like [endpoint?.id, …], [connection.phase, …],
#    [job?.id, …], and config-section's [category, settings] suffix)
rg -n "\}, \[.*remoteURL.*\]" client/src/features
#    expected: no matches — today this hits exactly the 22 reset-effect dep arrays; after migration
#    they all come from useScopeReset. The memory statusKey useMemo also becomes useScopeKey (a
#    leftover there is caught by gate 1, since the memo still calls gatewayScopeKey). Note the
#    GatewaySettings form-state line `const [remoteURL, setRemoteURL] = useState(preferences.remoteURL)`
#    is not a reset effect and does not match this pattern.
```

## Risks

1. Retry goes live and a screen test with a transient fake-gateway failure now retries. Mitigation: hook tests and screen tests already build clients with `retry: false`; keep that convention.
2. The dependency spread in `useScopeReset` trips `react-hooks/exhaustive-deps` in editors. The repo has no lint script; the justifying comment in the hook covers it.
3. A screen overlooked in the checklist still hand-wires keys. Mitigation: grep gate 1 catches it before the final commit.
4. Sub-key drift: a screen spreading `[...key, 'sub']` from a `useScopeKey` base keeps the `['gateway', connection, profile]` prefix by construction, so cache clearing and invalidation prefixes stay correct. No drift path exists as long as keys start from `useScopeKey`.

## Out of scope

- Candidate 2 (OAuth flow module), candidate 3 (model write queues), candidate 6 (`$chat` read seam).
- The chat surface, `components/files-screen.tsx`, `state/gateway-controller.ts`, `features/models/model-editing.ts` internals.
- `gateway-scope.ts`, `gateway-error.ts`, and `query-client.ts` are read-only for this work.
- Dead-directory cleanup (`mobile-push-delivery/`) is noted in the review but is a separate one-line commit; do it independently if desired.