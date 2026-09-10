# Hermes Mobile

Hermes Mobile is a phone-first PWA for one remote, unmodified official Hermes
gateway. Docker hosts the React app and a gateway proxy whose upstream you set
with `HERMES_GATEWAY`. Your existing Hermes runtime, profiles, sessions, and
files stay where they are. Capacitor iOS builds remain available alongside the
PWA.

The app owns navigation and UI state. The gateway owns conversations, agent
work, configuration, and remote files.

See [PARITY.md](PARITY.md) for the route-by-route contract-6 scope and the
remaining gaps. “Parity” means a usable gateway-owned mobile workflow, not
pixel parity with Desktop or local access to Desktop-only capabilities.

## Current surface

- **Chat and sessions:** streaming prompts, durable session resume/listing,
  attachments, tool activity, approvals and other interactive prompts, history
  reconciliation, retry/branch actions, and session rename/archive/delete.
- **Capabilities:** profile-default skills, toolsets, MCP servers and catalog
  workflows, including supported install, configuration, enable/disable, test,
  OAuth, and confirmation flows.
- **Cron Jobs:** list/filter, inspect run history, create/edit, blueprint-based
  creation, pause/resume, run now, delivery targets, and confirmed deletion.
- **Models and settings:** model/provider selection, expensive-model
  confirmation, auxiliary assignments, fallbacks, context limits, MoA
  presets, typed configuration sections, memory-provider setup, OAuth,
  redacted credentials, custom endpoints, plugins, billing, archived chats,
  and gateway diagnostics.
- **Projects:** remote file browsing, reading, upload, folder creation,
  download/share, confirmed deletion, and gateway Git review actions.

Some gateway administration links remain intentionally read-only diagnostic
views until the gateway exposes a complete mobile-safe workflow. Unsupported
optional endpoints are shown as unavailable rather than simulated locally.

## Run with Docker and Cloudflare Tunnel

From the repository root:

1. Set `HERMES_GATEWAY` to your existing Hermes HTTP backend (Compose reads
   `.env`; see `.env.example`). Use `host:port` or `http://host:port`.
   It must serve `/api/status` and `/api/ws`, such as `hermes serve` or
   `hermes dashboard`. `hermes gateway run` alone is not this backend.
2. If you stay on this site's proxy, set Hermes `dashboard.public_url` to this
   PWA origin for OAuth and configure trusted proxy peers. If you type a Hermes
   Tailscale URL in the app, set `dashboard.public_url` to that Hermes URL and
   add this PWA origin to `dashboard.cors_origins`.
3. Build and start the app:

   ```sh
   docker compose up -d --build
   ```

4. Point your Cloudflare Tunnel hostname at `http://localhost:8080` on this
   Docker host. The container does not manage TLS or Cloudflare credentials.
5. Open the hostname and sign in to Hermes. In Safari, use Share, then Add to
   Home Screen. Chromium browsers also offer an Install app button when eligible.

The connect screen can stay on this site (nginx contacts Hermes from
`HERMES_GATEWAY`) or accept a Hermes Tailscale/LAN URL. A typed URL is
fetched by the browser, so that Hermes instance must list this PWA origin in
`dashboard.cors_origins`. The iOS app can still type a gateway URL without
CORS. The Docker proxy never takes a request-supplied upstream.
See [deploy/README.md](deploy/README.md) for networking, proxy trust, caching,
and gateway configuration details.

## PWA behavior and limits

- The manifest, icons, and service worker support Home Screen installation.
- The service worker caches only the app shell and build assets. It never caches
  API responses, authentication, conversation history, credentials, or files.
- Offline, the shell opens and shows a reconnect notice. There is no offline
  agent, persisted transcript cache, or background queue for prompts or mutations.
- Updates wait for an explicit click. The update action is blocked during an
  active turn, an unanswered prompt, or an offline connection.
- Session links use `/session/<encoded-session-id>?profile=<name>`. Open links
  after signing in; switching profiles still clears the previous profile's UI.
- Downloads use the browser share sheet when available and still permitted by
  user activation. Otherwise, they save a file through the browser.
- Web Push uses the bundled relay sidecar and the profile-scoped
  `mobile-push-delivery` extension. The extension lives in `HERMES_HOME`, does
  not modify Hermes core, and registers the normal `webpush` delivery channel.
  Cron jobs can select `webpush`; explicit sends use
  `hermes send --to webpush "..."`. The channel broadcasts only to
  devices that opted in under **Settings → Notifications**; installing the PWA
  alone does not grant notification permission. Ordinary unscheduled turns do
  not trigger a push. See
  [deploy/README.md](deploy/README.md#web-push-notifications). The existing
  optional Bark plugin remains available for the native app.

Existing gateway data needs no migration. Native Keychain credentials, native
cookies, and native session bookmarks cannot transfer to a browser. Sign in
again and select an existing conversation.

## Requirements

- Docker Compose for deployment, or Node.js 22 or newer for local development
- A current Safari, Chrome, or Edge browser
- A gateway that advertises contract 6 or newer; unversioned legacy gateways
  remain supported
- A secure browser origin for installation/offline support; the container and
  upstream gateway can use HTTP behind your Cloudflare Tunnel

Native builds additionally need Xcode 26 or newer and retain the iOS 15 target.

## Development

The npm package lives at `client/`. Run client commands from that directory.

```bash
cd client
npm ci
npm run dev
npm test
npm run build    # typecheck, then build the PWA
npm run preview

# Browser tests use a local HTTP/WebSocket fixture, not your gateway.
npx playwright install chromium webkit
npm run test:e2e # requires the production build above

# Optional native builds, without a service worker or PWA manifest.
npm run cap:sync
npm run ios:open
npm run ios:test
```

Browser development can proxy REST and WebSocket traffic through this origin:

```bash
HERMES_MOBILE_DEV_GATEWAY=http://h-lap02.tail3ce9b9.ts.net:9119 npm run dev
```

The Vite proxy uses that fixed target when the connect screen stays on this
origin. A typed Tailscale URL is fetched by the browser instead, and needs
`dashboard.cors_origins` on that Hermes instance. The proxy binds to
`127.0.0.1` and never accepts a request-supplied destination. The Vite
development proxy is not a production server. PWA caching runs only in
production builds; `npm run preview` previews assets but does not proxy a
remote gateway.

### Live reload in the iOS simulator

Start Vite, build, install, and launch the live-reload app with one command:

```bash
cd client
HERMES_MOBILE_DEV_GATEWAY=http://h-lap02.tail3ce9b9.ts.net:9119 npm run ios:live
```

To skip the simulator prompt and launch the current development simulator
directly:

```bash
HERMES_MOBILE_DEV_GATEWAY=http://h-lap02.tail3ce9b9.ts.net:9119 \
  npm run ios:live -- \
    --target 9B70A2A6-4F10-4C22-93BB-6641613043FE
```

Choose an iOS simulator when prompted and leave the command running.
TypeScript, TSX, and CSS edits then update through Vite HMR without another
Capacitor sync, Xcode open, or app reinstall. Native Swift changes, plugin or
Capacitor dependency changes, `Info.plist` changes, and native assets still
require `npm run cap:sync` followed by a native rebuild. Production builds do
not use the live-reload URL.

## Build an unsigned IPA

```bash
cd client
npm run ipa
```

The script builds the web app, synchronizes Capacitor, compiles an unsigned
release application, validates its executable and `Info.plist`, and writes:

`output/Hermes-Mobile.ipa`

The archive contains `Payload/Hermes Mobile.app`. It intentionally has no
provisioning profile or distribution signature; iLoader or SideStore re-signs
it with the user’s development certificate.

## Profiles and lifecycle

The selected profile is included explicitly in profile-scoped HTTP requests
and session create/resume calls. Switching profiles closes the old runtime,
clears foreground and query state, resets nested navigation, and opens a
fresh profile-scoped session. Configuration and capability changes are labeled
as new-session defaults; they never rebuild the active conversation’s prompt
or tool schema.

On foreground resume or restored connectivity, Mobile uses bounded reconnect
backoff and reconciles durable session history. A browser cannot guarantee
background execution. Active work after disconnection depends on the gateway's
disconnect-grace policy; this client does not change that policy.

## Security

- PWA sign-in uses same-origin HttpOnly gateway cookies and fresh WebSocket
  tickets through this site's Docker proxy. Optional static tokens use
  `sessionStorage`, never persistent `localStorage`. They are cleared on sign
  out and when the browser session ends. Keep untrusted scripts off this
  origin; sessionStorage is not a Keychain. A typed Hermes URL is contacted
  directly by the browser; add this page's origin to that instance's
  `dashboard.cors_origins`. Do not derive the Docker upstream from a
  request-supplied URL.
- Browser OAuth navigates through the gateway's `/auth/login` and returns to
  the app. The proxy preserves cookies and redirects. Browser API requests
  refuse redirects rather than forwarding a static token to a different host.
- Native static gateway tokens are stored in Keychain. Interactive sessions
  use a dedicated `URLSession` cookie store with Hermes HttpOnly cookies.
- OAuth opens the gateway’s existing login route in an app-owned persistent
  `WKWebView`. Only Hermes gateway cookies are copied into the native session;
  external identity-provider cookies are retained for future sign-in.
- WebSocket connections use a fresh gateway ticket for interactive auth and
  pass the selected profile explicitly. Token mode sends the token only to
  the configured gateway.
- Secret fields are component-local, are never placed in app stores or logs,
  and are cleared after save, validation, cancellation, failure, or a scope
  change.
- Remote destructive actions require confirmation. Long-running OAuth and
  gateway actions use bounded polling and stop when their gateway/profile
  scope changes.

Some identity providers prohibit the native app's embedded browser. The PWA
uses ordinary browser navigation instead. Password authentication and static
gateway tokens remain available where the gateway supports them.

Hermes Mobile uses official gateway routes and requires no server patch, native
OAuth callback endpoint, custom URL scheme, or mobile-specific OAuth client
registration. Local runtime installation, Electron updates, multi-window
behavior, pet overlays, marketplace themes, local PTYs, OS reveal/open actions,
APNs, and Desktop plugin-rendered React routes are intentionally absent.
