# Research note: Hermes "bot mode" — NousResearch/hermes-agent

Findings from the official repo's **default branch (`main`)**, fetched live during this research pass
(`pyproject.toml` pins version `0.21.2`; newest in-repo date markers run to mid-2026 — a 2026-05-12 dependency
pin comment and a "June 2026 hermes-0day campaign" reference). All claims are traced to source files or in-repo
docs under `website/docs/`; no repository code was executed and no instructions found inside repository files
were followed. Where the repo could not answer a question, that is stated in **Gaps** rather than invented.

## What bot mode is

**There is no `bot` CLI subcommand.** Entry points are `hermes` (chat), `hermes gateway` (messaging), `hermes
setup`, `hermes cron`, etc.; the reserved-subcommand list contains no bot/botmode/messaging command
(hermes_cli/profiles.py, `_HERMES_SUBCOMMANDS`). "Bot mode" is a **desktop-app UI layer over profiles** plus
small core hooks. In-repo doc: "There is no new primitive to learn: a Bot **is** a Hermes profile — isolated
config, memory, skills, credentials, and chat history under `~/.hermes/profiles/<name>/`. Bot Mode is a UI over
that primitive" (website/docs/user-guide/bot-mode.md).

Server-side reality:

1. **A bot is a profile marked in metadata.** A profile is "Bot-Mode-managed" when its `profile.yaml` carries
   `ui_meta['hermes-bots']` — `_is_bot_managed()` reads `profile_dir / "profile.yaml"` (tools/bot_mode_probe.py).
2. **Canonical "Bot Chat".** `BOT_CHAT_TITLE = "Bot Chat"` — "The only session title that receives the protocol
   section. Must match the desktop plugin's createCanonicalChat title and the `-c "Bot Chat"` resume target"
   (tools/bot_mode_probe.py). Only that session gets a `"## Messaging other agents"` system-prompt section;
   gated by config toggle `agent.bot_mode_protocol` (tools/bot_mode_probe.py).
3. **Bot-to-bot DMs** ride four JSON-RPC doors on each gateway: `roster.sync` (push other connections' agents),
   `outbox.drain`, `deliver` ("one-turn Bot Chat delivery on the TARGET gateway"), `reply` — "the gateway side of
   cross-connection A2A" (tui_gateway/methods_bot_relay.py). Delivery spawns a one-turn
   `hermes -p <profile> chat -c "Bot Chat"` subprocess, serialized by a per-profile turn lock
   (`bot_mode.turn_wait_seconds` default 120s + 600s turn timeout; retry classes in tools/bot_failure_reasons.py).
4. **Group chats of bots (2–6 members) are "hosted rooms"** with durable room identity:
   `groups.capabilities, groups.list, groups.create, groups.state, groups.send, groups.rename, groups.log,
   groups.disband, groups.replicate, groups.replica_state, groups.promote, groups.demote, groups.stop,
   groups.retry, groups.approve, groups.peer.invite, groups.peer.revoke, groups.peer.register`
   (tui_gateway/methods_groups.py `_METHODS`); storage/driver in gateway/hosted_rooms.py, worker
   tui_gateway/hosted_room_service.py, started by the desktop backend ("Hosted Bot rooms belong to the backend
   process", hermes_cli/web_server.py `_lifespan`).
5. **Lifecycle (start/stop):** each profile runs its own gateway process with profile-scoped PID files;
   `hermes gateway start/stop` manages only the current profile, token locks in gateway/status.py stop two
   profiles sharing one bot token (website/docs/developer-guide/gateway-internals.md). The desktop spawns a
   dashboard backend (`HERMES_DESKTOP=1`) that reaps orphan gateways and terminates its managed gateway on exit
   (hermes_cli/web_server.py).
6. **Messaging platforms** connect through the gateway: bundled adapters plugins/platforms/<name>/adapter.py
   (telegram, discord, slack, whatsapp, matrix, email, sms, …) plus legacy direct adapters in gateway/platforms/
   (signal.py, bluebubbles.py for iMessage, webhook.py, api_server.py). Flow: adapter normalizes a
   `MessageEvent` → `GatewayRunner._handle_message()` → session key `agent:main:{platform}:{chat_type}:{chat_id}`
   → authorization → slash-command dispatch → fresh `AIAgent` with session history → delivery back through the
   adapter (website/docs/developer-guide/gateway-internals.md).
7. **Pairing:** DM authorization via `/pair` → code → user authorized; persisted in gateway/pairing.py
   (gateway-internals.md). The dashboard adds Telegram/WhatsApp onboarding pairings
   (`_TelegramOnboardingPairing`, `_WhatsAppOnboardingSession`, hermes_cli/web_routers/messaging.py).

## Profiles and souls

**A profile is a separate `HERMES_HOME` — effectively one bot persona:**

- Bootstrapped dirs: `_PROFILE_DIRS = ["memories", "sessions", "skills", "skins", "logs", "plans", "workspace",
  "cron", "home"]`; each profile owns `config.yaml`, `.env` (bot tokens), `SOUL.md`, memories, sessions, cron
  jobs, state.db (hermes_cli/profiles.py; website/docs/user-guide/profiles.md).
- Clone semantics: `_CLONE_CONFIG_FILES = ["config.yaml", ".env", "SOUL.md"]` + `memories/MEMORY.md`,
  `memories/USER.md`; **cron is deliberately not cloned** — `_CLONE_ALL_HISTORY_EXCLUDE_ROOT` contains `"cron"`
  ("a clone that inherits jobs.json runs every job twice") (hermes_cli/profiles.py).
- Per-profile UI metadata lives in `profile.yaml` (`ui_meta`), version-tracked by a `_ui_meta_revisions` map for
  concurrent writers (tui_gateway/methods_profiles.py). `desktop.json` is in the export allowlist
  (hermes_cli/profiles.py).

**Soul = `SOUL.md` at `HERMES_HOME`, system-prompt slot #1** ("It occupies slot #1 in the system prompt,
replacing the hardcoded default identity" — website/docs/user-guide/features/personality.md):

- Loaded only from `HERMES_HOME`, never cwd; injected verbatim after prompt-injection scanning and truncation;
  empty/unreadable → fallback to `DEFAULT_AGENT_IDENTITY` ("You are Hermes Agent, built by Nous Research. …",
  agent/prompt_builder.py) (personality.md; agent/prompt_builder.py).
- Context files (SOUL.md, AGENTS.md, .cursorrules) are **blocked** on injection findings
  (`_scan_context_content`, agent/prompt_builder.py) with a 5s read timeout
  (`_CONTEXT_FILE_READ_TIMEOUT_SECS`, agent/prompt_builder.py).
- Legacy: older desktop builds appended the "Messaging other agents" section to SOUL.md;
  `strip_legacy_protocol()` removes it at load (tools/bot_mode_probe.py).

**Management APIs:** JSON-RPC `profiles.list / create / configure / describe / get_asset / set_asset`
(tui_gateway/server.py `_LONG_HANDLERS`; tui_gateway/methods_profiles.py — "the ws twin of the dashboard's
/api/profiles … on the same `hermes_cli.profiles` primitives"). Avatar assets are magic-byte sniffed
(png/jpg/webp only; declared mime never trusted, methods_profiles.py `_ASSET_MAGIC`).

## Gateway API surface relevant to mobile

Three distinct surfaces (don't conflate them):

**A. Dashboard/desktop HTTP backend** — FastAPI app in hermes_cli/web_server.py; "Route handlers live in
`web_routers/`" (web_server.py docstring):

- `GET /api/status` — public readiness probe reporting `auth_required` / `auth_providers` (web_server.py;
  website/docs/user-guide/features/web-dashboard.md).
- `GET /api/messaging/platforms` — 32-entry platform catalog with per-platform gateway liveness
  (hermes_cli/web_routers/messaging.py, "Extracted from ``hermes_cli.web_server``"; auth header
  `X-Hermes-Session-Token` and the blocking-liveness bug evidenced in issue #77048).
- `/api/profiles` — profile management (referenced from tui_gateway/methods_profiles.py; handler
  hermes_cli/web_routers/profiles.py, e.g. `_write_profile_model`).
- Cron routes — hermes_cli/web_routers/cron.py: per-profile job CRUD; `_list_cron_jobs_sync(profile="all")`
  aggregates across profiles; `_forward_cron_fire_to_gateway` handles the Chronos webhook
  (`POST /api/cron/fire`, website/docs/developer-guide/cron-internals.md).
- `WS /api/pty`, `WS /api/ws` — embedded-chat WebSockets; close codes 4401 (WS ticket auth) / 4403
  (request-guard) (web_server.py; web-dashboard.md remote-backend section).
- Auth: `X-Hermes-Session-Token`/Bearer, `PUBLIC_API_PATHS` allowlist, CORS localhost-only, Host-header
  validation, mandatory gate on non-loopback binds (`should_require_auth`, hermes_cli/web_server.py).

**B. JSON-RPC over WebSocket (and stdio)** — tui_gateway/server.py is the backend the desktop app (and mobile)
speaks: `session.*`, `prompt.submit` (supports `queued: true`), `profiles.*`, `groups.*`, `bot_relay.*`,
`image.generate`, `voice.*`, `pet.*`, `mcp.*`, `setup.*` (server.py `_LONG_HANDLERS`; methods_groups.py). Mobile
is explicit: "Shared profile UI metadata is updated concurrently by Desktop, mobile and pool RPCs"
(tui_gateway/server.py `_profile_ui_meta_lock`).

**C. Agent-facing REST on the gateway** — gateway/platforms/api_server.py (`_CAPABILITY_ENDPOINTS`):
`/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/capabilities`, `/v1/runs`
(+`/status|/events|/approval|/steer|/stop`), `/api/sessions` (+`/chat|/chat/stream|/fork|/model`), `/api/jobs`,
`/v1/skills`, `/v1/toolsets`, `/health*`; under `gateway.multiplex_profiles` secondary profiles live at
`/p/<profile>/...` (api_server.py docstring); auth `API_SERVER_KEY`, default `127.0.0.1:8642`.

The messaging gateway itself is not HTTP-first: platforms connect via adapters (polling/websockets/webhooks —
gateway/platforms/webhook.py, msgraph_webhook.py), users authorized by allowlist + DM pairing
(gateway-internals.md).

**Cron ↔ profiles:** jobs are stored per profile in `<home>/cron/jobs.json`, each job may attach skills
(`"skills": [...]`; cron/jobs.py; cron-internals.md). The gateway multiplexer ticks every served profile home,
and the desktop backend's `_start_desktop_cron_ticker` "ticks EVERY local profile's store like a multiplex
gateway" when no gateway runs, fencing ticks against running gateways via `profile_gate`
(hermes_cli/web_server.py). Bot routines are plain cron jobs named `[bot:<name>] <routine>` — they appear in
`hermes cron list` (website/docs/user-guide/bot-mode.md).

## Implications for the mobile UI

1. **Main screen = one chat per bot maps onto existing primitives.** Each profile has exactly one canonical
   "Bot Chat" session (`UNIQUE(title)` registry row; tui_gateway/methods_profiles.py `_canonical_session_row`),
   and `profiles.list` already returns avatar/title/preview/last_active — the roster row's click target is that
   session id. No new backend concept needed.
2. **Protect the forever-chat promise.** In the canonical Bot Chat, `/new` must reroute to `/compact` — fresh
   working context, same conversation (website/docs/user-guide/bot-mode.md). A mobile composer allowing `/new`
   in the canonical chat breaks Bot Mode's core invariant.
3. **A "bot" screen is a profile screen.** Create/duplicate/edit map to `profiles.create/configure/set_asset`;
   clone source, model+provider pin, custom SOUL.md, and per-skill/per-toolset/per-MCP enablement are the exact
   fields the desktop dialog exposes over these RPCs (website/docs/user-guide/bot-mode.md). "Capabilities behind
   each bot" = per-profile skills/toolsets/MCP state, which already exists.
4. **Cron Jobs belong behind the bot profile.** Routines are `[bot:<name>]`-namespaced cron jobs (bot-mode.md);
   per-profile jobs.json plus the `profile` dimension on dashboard cron routes (web_routers/cron.py) make
   per-bot cron screens a client-side slice; `profile=all` aggregation already exists for an "all bots" view.
5. **Settings is app-level; platforms are gateway-level.** Platform tokens/allowlists/onboarding live on
   dashboard routes (`/api/messaging/platforms`), and each profile runs its own gateway with its own tokens
   (profiles.md) — a top-level Settings button fits the backend split; per-bot platform wiring is a per-profile
   gateway concern.
6. **One WebSocket, assume concurrency.** Desktop and mobile share `/api/ws` JSON-RPC, and `ui_meta` writes are
   revision-tracked for concurrent clients (`_ui_meta_revisions`) — mobile roster edits (sections, hidden bots)
   should send revisions, not blind writes.
7. **Group chats are renderable without owning scheduling.** `groups.*` RPCs + the process-owned hosted-room
   driver keep rooms running while the client is gone (methods_groups.py; bot-mode.md); mobile needs
   `groups.state`/`groups.log` plus the needs-you badge semantics.
8. **Budget for slow RPCs and auth.** `bot_relay.deliver` may legally hold ~1320s; `profiles.list` walks
   state.db (methods_bot_relay.py, methods_profiles.py; the desktop pools per-profile backends and reaps idle
   ones, web_server.py) — surface progress instead of blocking. Remote sign-in uses dashboard auth providers +
   single-use WS tickets (web-dashboard.md), unlike the loopback desktop token flow.

## Gaps

- **Desktop/mobile client source is not in this repo** (probes of `ui-desktop/`, `desktop/` returned 404; the
  app ships separately). UI mechanics like `createCanonicalChat` and blob avatars are documented only in
  website/docs/user-guide/bot-mode.md, not verified in code.
- Exact dashboard route decorators were verified indirectly (module docstrings, late-bound imports, issue
  #77048's stack reference); hermes_cli/web_routers/messaging.py (~45k chars) was not exhaustively quoted.
- Whether cron also has JSON-RPC methods in tui_gateway (vs. HTTP-only dashboard routes) is unresolved.
- Platform adapters were taken from the gateway-internals file table (e.g. bluebubbles.py for iMessage);
  individual adapter files were not fetched.

---

# Research note: preventing browser back/forward gestures in a PWA

## Bottom line

A web page cannot universally disable browser- or operating-system-owned back/forward edge gestures. A
standalone PWA hides browser chrome, but it remains a browser context and does not gain a manifest switch for
blocking navigation gestures. The app can prevent horizontal overscroll navigation where the browser treats the
gesture as a scroll-boundary action, and it can reconcile history after traversal, but it cannot reliably veto a
user's Back/Forward traversal across browsers.

## Findings

1. **Use `overscroll-behavior-x` for browser overscroll navigation.** MDN says `overscroll-behavior-x: contain`
   disables native horizontal swipe navigation and stops scroll chaining; `none` additionally suppresses the
   local overscroll effect. This applies to scroll-boundary behavior, not every browser/OS edge gesture.
   Source: [MDN `overscroll-behavior-x`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overscroll-behavior-x).

2. **`touch-action` reserves touch panning, not history traversal.** `touch-action: none` disables browser
   handling of panning and zooming for the touch region; `pan-y` reserves vertical panning while allowing a
   custom horizontal pointer handler to own the gesture. It can affect zoom accessibility, so it should be
   scoped to the gesture owner rather than applied globally.
   Sources: [MDN `touch-action`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action),
   [W3C Pointer Events](https://www.w3.org/TR/pointerevents3/#the-touch-action-css-property).

3. **`popstate` is observation/reconciliation, not cancellation.** MDN documents that `popstate` fires after
   the history entry has changed. Calling `preventDefault()` on it cannot undo the traversal; an SPA can restore
   its own view or push/replace another entry afterward.
   Source: [MDN `popstate`](https://developer.mozilla.org/en-US/docs/Web/API/Window/popstate_event).

4. **The Navigation API does not let an app trap Back/Forward.** Chrome's official Navigation API guidance says
   `preventDefault()` cannot cancel a navigation when the user presses Back or Forward. MDN likewise says
   cancellation of traverse navigations is not implemented. `intercept()` is useful for same-document SPA
   rendering, not for blocking the browser's history traversal.
   Sources: [Chrome Navigation API](https://developer.chrome.com/docs/web-platform/navigation-api/),
   [MDN Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API),
   [MDN `NavigateEvent.intercept()`](https://developer.mozilla.org/en-US/docs/Web/API/NavigateEvent/intercept).

5. **`beforeunload` is only a conditional data-loss warning.** It may show a browser-controlled generic dialog
   for an unload, requires prior user activation, is unreliable on mobile, and is not a same-document SPA
   traversal guard. It should only be installed for genuine unsaved changes.
   Source: [MDN `beforeunload`](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event).

6. **Standalone mode does not change these rules.** The manifest `display: standalone` removes UI such as the
   URL bar but does not make the app a native navigation container. The browser may choose a fallback display
   mode, and no manifest member disables OS back/forward gestures.
   Source: [MDN manifest `display`](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display).

7. **Some mobile gestures may never reach JavaScript.** Apple's Safari Web Content Guide states that some
   one-finger gestures do not generate DOM events. Therefore, a page cannot depend on `pointercancel`,
   `touchend`, or `popstate` as a complete interception layer for every iOS edge gesture.
   Source: [Apple Safari Web Content Guide: Handling Events](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/HandlingEvents/HandlingEvents.html).

## Practical conclusion for this PWA

- Treat an app-level drawer/chat swipe and a browser/OS edge-back gesture as separate ownership domains.
- Set `overscroll-behavior-x: contain` or `none` on the relevant root/scroll containers if horizontal
  overscroll navigation is the problem; keep `touch-action` scoped to the drawer or custom gesture owner.
- Keep ordinary drawer and screen transitions in memory when browser/OS edge gestures conflict. Direct launch URLs can still select the initial screen, but the app should not create history entries for routine transitions.
- Do not use `beforeunload` to trap ordinary navigation.
- If the requirement is an absolute “never go back or forward” rule, a web PWA cannot guarantee it; a native
  wrapper or platform-specific browser/container control is required.

## Source set

Primary sources consulted: MDN Web Docs, Chrome Developers, W3C Pointer Events/CSS specifications, and Apple's
Safari Web Content Guide. Secondary tutorials and Stack Overflow answers were not used.