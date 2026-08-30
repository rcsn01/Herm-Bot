# Hermes Mobile (iOS)

Hermes Mobile is an iPhone-first Capacitor client for one remote, unmodified
official Hermes gateway. It also supports iPad layouts and multiple profiles on
that gateway. The app owns its navigation and state; the gateway remains the
source of truth for sessions, agent work, configuration, and remote files.

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

## Requirements

- Node.js 22 or newer
- Xcode 26 or newer
- iOS 15 deployment target
- A reachable HTTP or HTTPS/WSS Hermes gateway that advertises contract 6 or
  newer (unversioned legacy gateways remain supported); contract 6 is the
  full-parity floor for versioned gateways

HTTP is accepted for any host, on the assumption that self-hosted gateways use
an already-encrypted network (for example Tailscale). Use public plain-HTTP
endpoints at your own risk.

## Development

The npm package intentionally lives at `apps/mobile/client/`, below the root
`apps/*` workspace glob. Run all mobile commands from that directory.

```bash
cd apps/mobile/client
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run ios:test

npm run cap:sync  # build and synchronize the Capacitor iOS project
npm run ios:open  # open the synchronized project in Xcode
```

Browser development can proxy REST and WebSocket traffic through the fixed
localhost origin when a gateway does not allow credentialed cross-origin
requests:

```bash
HERMES_MOBILE_DEV_GATEWAY=http://h-lap02.tail3ce9b9.ts.net:9119 npm run dev
```

The Connect URL must match that target. The proxy binds to `127.0.0.1` and
never accepts a request-supplied destination.

### Live reload in the iOS simulator

Start Vite, build, install, and launch the live-reload app with one command:

```bash
cd apps/mobile/client
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
cd apps/mobile/client
npm run ipa
```

The script builds the web app, synchronizes Capacitor, compiles an unsigned
release application, validates its executable and `Info.plist`, and writes:

`apps/mobile/output/Hermes-Mobile.ipa`

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

Remote work continues when the app is closed. On foreground resume, Mobile
uses bounded reconnect backoff and reconciles the durable session history.
There is no APNs or background-execution claim.

## Security

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

Some identity providers prohibit embedded browsers. Hermes Mobile reports that
limitation and leaves password authentication (when supported) and static gateway tokens available as fallbacks.

Hermes Mobile uses official gateway routes and requires no server patch, native
OAuth callback endpoint, custom URL scheme, or mobile-specific OAuth client
registration. Local runtime installation, Electron updates, multi-window
behavior, pet overlays, marketplace themes, local PTYs, OS reveal/open actions,
APNs, and Desktop plugin-rendered React routes are intentionally absent.
