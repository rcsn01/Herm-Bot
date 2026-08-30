Hermes Mobile navigation and administration migration

 Summary

 Create refactorplan.md in the repository root with this migration plan.

 Hermes Mobile will replace its current Sessions, Capabilities, Operations, and More navigation with this ordered drawer
 navigation:

 1. Capabilities
 2. Cron Jobs
 3. Settings
 4. Sessions

 Sessions remains the default launch destination. The active chat stays mounted while users visit other tabs. The
 searchable session list remains in the drawer.

 The work will ship as complete vertical slices. Raw JSON views may remain temporarily for secondary administration pages,
 but they do not count as feature parity.

 Implementation

 ### 1. Replace the primary navigation and route stacks

 - Files:
     - apps/mobile/client/src/navigation/routes.ts
     - apps/mobile/client/src/navigation/navigation-store.ts
     - apps/mobile/client/src/app.tsx
     - apps/mobile/client/src/components/side-navigation-drawer.tsx
     - apps/mobile/client/src/styles.css
 - Symbols:
     - MOBILE_TABS
     - MobileTab
     - RoutesByTab
     - ROOT_ROUTES
     - initialNavigationState
     - DESTINATION_TITLES
     - PRIMARY_NAVIGATION
 - Current behavior:
     - Primary destinations are Sessions, Capabilities, Operations, and More.
     - Cron is nested under Operations.
     - Settings is nested under More.
     - Sessions has a separate drawer heading and list.
     - ChatScreen stays mounted while hidden, which preserves live stream and draft state.
 - Required change:
     - Define tabs in drawer order as capabilities, cron, settings, sessions.
     - Keep sessions as the initial active tab.
     - Add independent route stacks for:
         - Capabilities root, section, and detail routes.
         - Cron list, job detail, editor, and blueprint routes.
         - Settings index, category, and administration routes.
         - Sessions root.
     - Render Cron and Settings directly from App.
     - Change the model badge shortcut to open Settings → Model.
     - Put Sessions in PRIMARY_NAVIGATION as the fourth item.
     - Rename the drawer’s lower session section to “Recent sessions” so Sessions is not presented as two navigation
       entries.
     - Preserve session search, new, resume, delete, focus trapping, swipe gestures, and drawer-close behavior.
 - Invariants:
     - Switching tabs must not remount ChatScreen.
     - Each tab retains its own navigation stack.
     - Opening the current session must not issue another resume request.
     - Background events must not navigate away from the selected tab.
 - Verification:
     - Update:
         - apps/mobile/client/src/app-navigation.test.tsx
         - apps/mobile/client/src/navigation/navigation-store.test.ts
         - apps/mobile/client/src/components/side-navigation-drawer.test.tsx
     - Assert the exact four-item order, Sessions default, stack retention, direct Cron and Settings access, model
       shortcut behavior, and stable chat instance identity.

 ### 2. Make gateway and profile scoping safe for every new screen

 - Files:
     - apps/mobile/client/src/gateway/gateway-scope.ts
     - apps/mobile/client/src/gateway/query-client.ts
     - apps/mobile/client/src/gateway/remote-action.ts
     - apps/mobile/client/src/state/gateway-controller.ts
     - New: apps/mobile/client/src/gateway/profile-path.ts
 - Required change:
     - Add one profile-path helper that converts the mobile default profile from null to the explicit backend key default.
     - Use explicit profile parameters for Cron, Capabilities, Settings, and administration requests.
     - Continue keying query caches by connection and profile through gatewayScopeKey.
     - Abort or ignore stale responses after a connection or profile switch.
     - Use runRemoteAction for background installs, updates, setup commands, and OAuth polling.
     - Render classifyGatewayError(...).kind === 'unsupported' as a feature-specific unavailable state.
 - Invariants:
     - A default-profile request must never fall back to an all-profile backend default.
     - Profile A data and mutation results must never appear after switching to profile B.
     - Secret values must not enter nanostores, Capacitor Preferences, query persistence, or logs.
     - HTTP 404 and JSON-RPC -32601 mean unsupported capability, not an empty result.
 - Verification:
     - Add apps/mobile/client/src/gateway/profile-path.test.ts.
     - Extend gateway controller and remote-action tests with profile-switch races, explicit default-profile paths,
       aborts, unsupported routes, and bounded polling.

 ### 3. Rebuild Capabilities around Skills, Tools, and MCP

 - Files:
     - Replace the descriptor-only implementation in:
         - apps/mobile/client/src/features/capabilities/api.ts
         - apps/mobile/client/src/features/capabilities/capabilities-screen.tsx
     - Add:
         - apps/mobile/client/src/features/capabilities/skills-api.ts
         - apps/mobile/client/src/features/capabilities/skills-screen.tsx
         - apps/mobile/client/src/features/capabilities/skill-detail.tsx
         - apps/mobile/client/src/features/capabilities/skill-hub-screen.tsx
         - apps/mobile/client/src/features/capabilities/toolsets-api.ts
         - apps/mobile/client/src/features/capabilities/toolsets-screen.tsx
         - apps/mobile/client/src/features/capabilities/toolset-detail.tsx
         - apps/mobile/client/src/features/capabilities/mcp-api.ts
         - apps/mobile/client/src/features/capabilities/mcp-screen.tsx
         - apps/mobile/client/src/features/capabilities/mcp-server-editor.tsx
         - apps/mobile/client/src/features/capabilities/mcp-catalog-screen.tsx
     - Extend type exports in:
         - apps/mobile/client/src/lib/types.ts
 - Required change:
     - Match the Desktop Capabilities information architecture with three top tabs: Skills, Tools, and MCP.
     - Remove Models, Providers, Credentials, Memory, Plugins, and Computer Use from the Capabilities index. Their
       workflows move to Settings.

 #### Skills

 - Use the official routes from hermes_cli/web_routers/skills.py and apps/desktop/src/api/skills.ts.
 - Support:
     - Installed-skill list, search, category and activation filters.
     - Full SKILL.md detail.
     - Enable and disable with optimistic rollback.
     - Learned-skill editing through /api/learning/node.
     - Learned-skill archive with confirmation through /api/learning/node.
     - Hub source selection, search, preview, security scan, install, update, and uninstall.
     - Background action polling through /api/actions/{name}/status.
 - Use 45-second request timeouts for Hub search, preview, and scan.
 - Show provenance so bundled skills are not offered destructive learned-skill actions.

 #### Tools

 - Use official routes from hermes_cli/web_routers/tools.py and apps/desktop/src/api/toolsets.ts.
 - Support:
     - Toolset list, search, requirements, status, and enable toggles.
     - Confirmation before clearing all enabled toolsets.
     - Provider and model selection where the toolset supports them.
     - Required credential entry without retaining plaintext.
     - Post-setup actions with bounded polling.
     - Clear unsupported states when a provider or setup operation is absent on an older gateway.

 #### MCP

 - Use official routes from hermes_cli/web_routers/mcp.py and apps/desktop/src/api/mcp.ts.
 - Support:
     - Server list, enable toggle, detail, test, add, edit, and remove.
     - URL and stdio server forms.
     - Catalog browsing and installation.
     - OAuth start, validated external browser opening, polling, cancellation, and retry.
     - Tool, prompt, resource, and schema-cost summaries returned by tests.
 - Use 60-second request timeouts for test, authentication, and catalog installation.
 - Dedicated add, delete, and toggle endpoints handle those operations.
 - Editing must fetch the latest mcp_servers map and use PUT /api/mcp/servers, which replaces the entire map. Preserve
   untouched keys and secret placeholders. Never construct a replacement map from the redacted summary response.
 - Invariants:
     - Capability changes apply to new sessions.
     - Mobile must not rebuild the active conversation’s tool schema or system prompt.
     - Do not automatically reload MCP into the current session.
     - Every destructive action requires confirmation and rollback or authoritative refetch after failure.
 - Verification:
     - Replace apps/mobile/client/src/features/capabilities/capabilities-screen.test.tsx.
     - Add API and screen tests for all three tabs, optimistic rollback, stale profile results, action polling, secret
       handling, MCP replacement semantics, OAuth cancellation, and unsupported gateways.

 ### 4. Promote Cron Jobs and complete its workflow

 - Files:
     - apps/mobile/client/src/features/cron/api.ts
     - apps/mobile/client/src/features/cron/cron-screen.tsx
     - Add:
         - apps/mobile/client/src/features/cron/cron-job-detail.tsx
         - apps/mobile/client/src/features/cron/cron-job-editor.tsx
         - apps/mobile/client/src/features/cron/cron-blueprints-screen.tsx
         - apps/mobile/client/src/features/cron/cron-schedule-fields.tsx
         - apps/mobile/client/src/features/cron/cron-delivery-fields.tsx
 - Current behavior:
     - Cron is nested under Operations.
     - Mobile can list jobs and recent runs, pause, resume, trigger, and delete.
     - It cannot create or edit jobs or use delivery targets and blueprints.
 - Required change:
     - Make Cron Jobs a root tab whose initial screen is the job list.
     - Add search, status filtering, pull-to-refresh, empty, stale, loading, and unsupported states.
     - Tapping a job opens its detail and run history.
     - Support create and edit for:
         - Name and prompt.
         - Duration, natural schedule preset, cron expression, and one-shot timestamp.
         - Enabled state.
         - Delivery targets.
         - Skills.
         - Model and provider overrides.
         - Script, context chaining, work directory, toolsets, and no_agent advanced options.
     - Add the backend blueprint gallery and typed instantiation forms.
     - Keep Run Now, Pause, Resume, and Delete on job detail.
     - Preserve the 24-hour trigger request timeout. Leaving the screen must not cancel work already accepted by the
       gateway.
     - Explicitly request profile=default when the selected profile is represented locally as null.
 - Edge cases:
     - Show 409 trigger-claim conflicts without retrying automatically.
     - Show validation details for 400 and 422 responses.
     - Distinguish a saved job that failed scheduler registration with status 424.
     - Never schedule work on the iOS device.
 - Verification:
     - Expand apps/mobile/client/src/features/cron/cron-screen.test.tsx.
     - Add editor, blueprint, schedule, delivery, profile-isolation, conflict, validation, and navigation tests.

 ### 5. Build the Settings index and shared configuration metadata

 - Files:
     - Move the current screen into:
         - apps/mobile/client/src/features/settings/settings-screen.tsx
     - Add:
         - apps/mobile/client/src/features/settings/settings-registry.ts
         - apps/mobile/client/src/features/settings/settings-api.ts
         - apps/mobile/client/src/features/settings/config-section-screen.tsx
         - apps/mobile/client/src/features/settings/config-field.tsx
         - apps/mobile/client/src/features/settings/settings-page-shell.tsx
     - Share config section metadata through:
         - New: apps/shared/src/settings-sections.ts
         - apps/shared/src/index.ts
         - apps/desktop/src/app/settings/constants.ts
 - Required change:
     - Create a touch-first Settings index in this order:
         1. Model
         2. Chat
         3. Appearance
         4. Workspace
         5. Safety
         6. Browser
         7. Memory & Context
         8. Voice
         9. Advanced
         10. Notifications
         11. Billing
         12. Providers
         13. Gateways
         14. Keyboard Shortcuts
         15. Tools & Keys
         16. Plugins
         17. Archived Chats
         18. About
     - Extract the eight backend config section IDs and key allowlists from Desktop’s SECTIONS into data-only shared
       metadata. Desktop and Mobile map their own icon sets onto that metadata.
     - Load /api/config and /api/config/schema.
     - Render only explicitly allowed fields for each mobile category.
     - Save minimal nested partial records through PUT /api/config; do not submit a stale full document.
     - Use per-field optimistic cache updates, rollback, and debounced writes where appropriate.
     - Reset drafts and cancel delayed saves when profile or connection scope changes.
 - Invariants:
     - Settings edit profile defaults, not just the active runtime session.
     - Model and capability changes state that they apply to new sessions.
     - Renderer-only Desktop settings must not leak into backend config.
     - Shared metadata remains data-only and has no React or icon dependency.
 - Verification:
     - Add tests for registry order, schema filtering, nested partial writes, rollback, debouncing, and scope changes.
     - Update Desktop settings tests after extracting the shared section metadata.

 ### 6. Port the backend-supported settings categories

 #### Model

 - Rehome the existing apps/mobile/client/src/features/models/ implementation under Settings → Model.
 - Keep main and auxiliary assignments, reasoning defaults, fast tier, context length, fallback models, and Mixture of
   Agents.
 - Keep expensive-model confirmation and stale auxiliary warnings.
 - Remove Models from Capabilities.

 #### Chat

 - Edit profile defaults for personality, timezone, reasoning display, and image-input mode.
 - Remove the current dependency on an active runtime session.
 - Keep active-chat model switching as a separate composer concern.

 #### Appearance

 - Keep theme as device-local state through savePreferences.
 - Follow iOS for system theme and reduced motion.
 - Do not port Desktop window translucency, pets, marketplace themes, or window scale controls.

 #### Workspace

 - Edit remote workspace and execution settings from the shared config allowlist.
 - Link to the existing remote Projects and Files workflow.
 - Do not present the iOS filesystem, a local PTY, or local Git checkout as the gateway workspace.

 #### Safety

 - Edit approval, timeout, allowlist, redaction, private URL, MCP confirmation, and checkpoint settings.
 - Move remote pairing administration here as a clearly labelled gateway administration subsection.

 #### Browser

 - Edit remote browser policy and display remote computer-use reachability.
 - Do not present an Electron webview, an iOS browser profile, or local browser permissions as gateway capabilities.

 #### Memory & Context

 - Edit memory, context-engine, and compression settings.
 - Add memory provider status, setup, OAuth, and provider-specific configuration using official memory routes.
 - Move Learning under an administration subsection while its purpose-built mobile graph remains unfinished.

 #### Voice

 - Edit gateway-owned STT, TTS, voice-provider, and recording-limit configuration.
 - Hide Desktop-only global record keys and local inference controls.
 - Do not imply that APNs or background microphone execution exists.

 #### Advanced

 - Edit remote terminal backend, output limits, checkpoints, agent retries, service tier, and delegation settings.
 - Move Agents and System diagnostics under explicit administration subsections.
 - Exclude Desktop Quick Entry, F12 handling, keep-awake controls, and Electron updates.

 ### 7. Port specialized settings pages

 - Add modules under apps/mobile/client/src/features/settings/ for the following pages.

 #### Notifications

 - Present foreground notification preferences supported by Mobile.
 - State that APNs and background execution are not implemented.
 - Do not show disabled controls for Desktop native notifications as if they could work.

 #### Billing

 - Use the existing shared billing types and policy modules.
 - Implement plan, entitlement, balance, usage, and official billing-management handoff only when the gateway advertises
   those methods.
 - Place the former Usage destination in this page’s gateway administration subsection.
 - Never infer billing state across profiles or accounts.

 #### Providers

 - Support provider accounts, OAuth start/poll/cancel, redacted API-key management, validation, and custom endpoint CRUD.
 - Use /api/providers/* and /api/env.
 - Open OAuth URLs through PlatformActions.openExternal.

 #### Gateways

 - Show the active remote gateway, authentication mode, health, selected profile, profile management, reconnect,
   change-gateway, and sign-out actions.
 - Mobile remains connected to one remote gateway at a time.
 - Do not port Desktop local-runtime, SSH registry, multi-window, or backend-spawn controls.
 - Place Messaging, Webhooks, and Logs under a separate “Gateway administration” subsection rather than mixing them into
   connection fields.

 #### Keyboard Shortcuts

 - Do not reuse Desktop’s renderer keybinding registry.
 - Initially show the shortcuts actually implemented by Mobile and an explicit unsupported state for rebinding.
 - Add customization only after Mobile owns a command registry and persisted device-local shortcut format.

 #### Tools & Keys

 - Support redacted credential status, set, reveal, delete, and provider validation.
 - Keep secret drafts in component memory only and clear them after save, navigation, logout, or profile change.

 #### Plugins

 - Show plugin inventory and supported enable, disable, setup, and removal actions through official plugin methods.
 - Never execute Desktop plugin-rendered React or HTML routes on iOS.

 #### Archived Chats

 - List only archived sessions for the selected profile.
 - Support restore and permanent delete with confirmation.
 - Reuse stable session identity and existing session cache reconciliation rules.

 #### About

 - Show Mobile app version, gateway version, backend contract, connection status, and support links.

 - Keep remote diagnostics available.

 - Do not offer Hermes runtime updates as an iOS app update mechanism.

 - Verification:
     - Add one API test and one behavioral screen test for each specialized page.
     - Test secret clearing, OAuth cancellation, unsupported capabilities, profile routing, mutation rollback, and
       destructive confirmations.

 ### 8. Move current More and Operations destinations without claiming false parity

 - Files:
     - apps/mobile/client/src/features/more/more-screen.tsx
     - apps/mobile/client/src/features/operations/api.ts
     - apps/mobile/client/src/features/operations/operations-screen.tsx
     - apps/mobile/client/src/features/shared/remote-resource.tsx
 - Required change:
     - Remove More and Operations from primary navigation.
     - Preserve their current destinations under Settings → Gateway administration:
         - Projects and Files
         - Profiles
         - Messaging
         - Pairing
         - Webhooks
         - Agents
         - Learning
         - System
         - Logs
         - Usage
     - Reuse FilesScreen for Projects and Files.
     - Raw RemoteResourceScreen views may remain as transitional diagnostics.
     - Label transitional screens as limited previews and keep their parity status Partial.
     - Delete the old More and Operations modules only after every destination has a Settings route.
 - Verification:
     - Test that every former destination remains reachable.
     - Test that no raw response screen is described as a complete management workflow.

 ### 9. Update documentation and deliver in gated stages

 - Files:
     - refactorplan.md
     - apps/mobile/PARITY.md
     - apps/mobile/README.md
     - apps/mobile/client/scripts/contract-smoke.mjs
 - Delivery order:
     1. Navigation, route stacks, and profile-scope hardening.
     2. Cron root tab and full CRUD.
     3. Skills management.
     4. Tools management.
     5. MCP management.
     6. Settings index and shared config editor.
     7. Specialized Settings pages.
     8. Administration destination migration and old route removal.
 - Completion gate for each stage:
     - Purpose-built mobile workflow.
     - Explicit selected-profile routing.
     - Loading, empty, stale, unsupported, and recoverable failure states.
     - Confirmation for destructive changes.
     - Optimistic rollback or authoritative refetch.
     - Stale-response protection.
     - Component and API tests.
     - PARITY.md updated only when the workflow meets its stated completion gate.
 - Verification commands:
     - cd apps/mobile/client && npm test
     - cd apps/mobile/client && npm run typecheck
     - cd apps/mobile/client && npm run build
     - cd apps/mobile/client && npm run contract:smoke against a contract-6 test gateway
     - cd apps/shared && npm run check
     - cd apps/desktop && npm run typecheck
     - cd apps/desktop && npm run test:ui

 Data flow and state transitions

 1. Navigation selects a tab without unmounting the active chat.
 2. Each backend screen derives an explicit connection and profile scope.
 3. TanStack Query loads backend-owned state using a connection/profile/domain key.
 4. A mutation snapshots cached data, applies an optimistic update where safe, and sends the official request.
 5. Failure restores the snapshot and displays the classified error.
 6. Success invalidates the narrow domain query and reconciles with backend truth.
 7. A profile or gateway switch cancels old queries, resets local drafts and dialogs, and prevents old responses from
    publishing.
 8. Skill, tool, MCP, model, and profile-default config changes affect new sessions. They never rewrite the current
    conversation’s prompt or tool schema.
 9. Cron and remote actions continue on the gateway after the user leaves their screen. Mobile later reconciles their
    state.

 Interfaces and schemas

 - MobileTab becomes:
     - capabilities
     - cron
     - settings
     - sessions
 - New route families:
     - CapabilitiesRoute
     - CronRoute
     - SettingsRoute
     - SessionsRoute
 - @hermes/shared exports data-only config section specifications.
 - Mobile adds typed adapters for Skills, Toolsets, MCP, Cron, Config, Providers, Credentials, Memory, Plugins, Billing,
   and archived sessions.
 - No new model tools, HERMES_* environment variables, or mobile-only backend endpoints are introduced.
 - Existing backend persistence formats remain unchanged.

 Decisions and alternatives

 - Sessions remains the launch destination even though it appears fourth in the drawer. Changing the drawer order does not
   justify disrupting the chat-first startup behavior.
 - The session list stays in the drawer. A separate sessions landing page would add a step before reaching conversations
   and would risk remounting chat state.
 - Capabilities contains only Skills, Tools, and MCP, matching the Desktop page shown in the reference. Models, providers,
   credentials, memory, and plugins belong in Settings.
 - Cron becomes a root tab instead of remaining under a generic Operations hub.
 - Settings uses schema-driven controls only for a curated key allowlist. Specialized domains keep purpose-built modules
   because generic field rendering cannot safely express OAuth, secret handling, model assignment, billing, memory setup,
   or MCP replacement semantics.
 - Desktop React modules are not imported into Mobile. Only data contracts and pure shared metadata are reused.
 - Existing raw administration views remain transitional and explicitly Partial. Rendering JSON is not treated as feature
   parity.
 - The migration is staged. Shipping all settings, capabilities, and Cron changes as one release would make profile
   routing, mutation safety, and compatibility failures difficult to isolate.
