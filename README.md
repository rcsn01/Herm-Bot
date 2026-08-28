# Hermes Mobile (iOS)

Hermes Mobile is an iPhone-first Capacitor client for one remote, unmodified official Hermes gateway. It supports iPad layouts, multiple profiles on that gateway, gateway-owned sessions and agent work, interactive OAuth/password login, static gateway tokens, streaming chat, remote administration, and remote project/files/git views.

See [PARITY.md](PARITY.md) for the authoritative contract-6 scope, route mapping, milestones, and current workflow status.

The npm package intentionally lives at `apps/mobile/client/`, below the root `apps/*` workspace glob. It has its own `.npmrc`, lockfile, dependencies, Capacitor project, tests, and build output. Root npm files are not involved.

## Requirements

- Node.js 22 or newer
- Xcode 26 or newer
- iOS 15 deployment target
- A reachable HTTP or HTTPS/WSS Hermes gateway running backend contract 6 or newer

HTTP is accepted for any host, on the assumption that self-hosted gateways ride an already-encrypted network (for example Tailscale). Use public plain-HTTP endpoints at your own risk.

## Development

```bash
cd apps/mobile/client
npm install
npm run dev
npm test
npm run typecheck

npm run cap:sync  # build and synchronize the Capacitor iOS project
npm run ios:open  # open the synchronized project in Xcode
npm run ios:test
```

Browser development can proxy REST and WebSocket traffic through the fixed localhost origin when a gateway does not allow credentialed cross-origin requests:

```bash
HERMES_MOBILE_DEV_GATEWAY=http://h-lap02.tail3ce9b9.ts.net:9119 npm run dev
```

The Connect URL must match that target. The proxy binds to `127.0.0.1` and never accepts a request-supplied destination.

### Live reload in the iOS simulator

Start Vite, build, install, and launch the live-reload app with one command:

```bash
cd apps/mobile/client
HERMES_MOBILE_DEV_GATEWAY=http://h-lap02.tail3ce9b9.ts.net:9119 npm run ios:live
```

To skip the simulator prompt and launch the current development simulator directly:

```bash
HERMES_MOBILE_DEV_GATEWAY=http://h-lap02.tail3ce9b9.ts.net:9119 \
  npm run ios:live -- \
    --target 9B70A2A6-4F10-4C22-93BB-6641613043FE
```

Choose an iOS simulator when prompted and leave the command running. TypeScript, TSX, and CSS edits then update through Vite HMR without another Capacitor sync, Xcode open, or app reinstall. If Vite is already running on `127.0.0.1:5175`, the command reuses it instead of starting another server. If the simulator app is closed, launch it again while the command is still running.

Live reload is deliberately localhost-only and therefore targets the iOS simulator. Native Swift changes, plugin or Capacitor dependency changes, `Info.plist` changes, and native assets still require `npm run cap:sync` followed by a native rebuild. Production builds never use the live-reload URL.

The mobile client imports `@hermes/shared` from `file:../../shared` and type-only desktop API contracts. It reuses a small explicit compatibility set of stable desktop visual primitives, but owns its navigation, state, transcript composition, responsive CSS, and native behavior.

## Build an unsigned IPA

```bash
cd apps/mobile/client
npm run ipa
```

The script builds the web app, synchronizes Capacitor, compiles an unsigned release application, validates its executable and `Info.plist`, and writes:

`apps/mobile/output/Hermes-Mobile.ipa`

The archive contains `Payload/Hermes Mobile.app`. It intentionally has no provisioning profile or distribution signature; iLoader or SideStore re-signs it with the user’s development certificate.

## Security and lifecycle

- The remote URL and UI preferences use non-secret native preferences.
- Static gateway tokens use Keychain.
- Interactive sessions use a dedicated `URLSession` cookie store with Hermes HttpOnly access/refresh cookies.
- OAuth opens the gateway's existing `/auth/login` route in an app-owned, persistent `WKWebView`. After login, only Hermes session cookies for that gateway are copied into `URLSession` and verified through `/api/auth/me`.
- OAuth browser state persists across launches. Hermes logout removes only Hermes gateway cookies from WebKit and `URLSession`, retaining external identity-provider cookies for faster future login.
- Some identity providers prohibit embedded browsers. Hermes Mobile reports that limitation and leaves password authentication (when the gateway provider supports it) and static gateway tokens available as fallbacks.
- Each interactive WebSocket connection mints a fresh `/api/auth/ws-ticket`; token mode attaches the Keychain token only to its fresh WebSocket URL.
- Background execution and APNs are not requested. The remote agent continues; foreground resume drops stale transport, reconnects with bounded backoff, resumes the durable session, and reconciles history from gateway truth.

Hermes Mobile uses only official gateway routes and requires no server patch, native OAuth callback endpoint, custom URL scheme, or mobile-specific OAuth client registration.

Local runtime installation, Electron updates, multi-window behavior, pet overlays, marketplace themes, local PTYs, OS reveal/open actions, and desktop plugin-rendered React routes are intentionally absent.
