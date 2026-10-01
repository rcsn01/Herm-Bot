# Herm-Bot

Herm-Bot is a phone-first PWA for one remote, unmodified official Hermes
gateway. Docker hosts the React app, the fixed-origin gateway proxy, and the Web
Push relay. Set the upstream once with `HERMES_GATEWAY`; the browser stays on
the PWA origin for REST, WebSockets, OAuth, and push registration. Your
existing Hermes runtime, profiles, sessions, and files stay where they are.
Capacitor iOS builds remain available alongside the PWA.

The app owns navigation and UI state. The gateway owns conversations, agent
work, configuration, and remote files.

See [PARITY.md](PARITY.md) for the route-by-route contract-6 scope and the
remaining gaps. “Parity” means a usable gateway-owned mobile workflow, not
pixel parity with Desktop or local access to Desktop-only capabilities.

## Run with Docker and Cloudflare Tunnel

From the repository root:

1. Set `HERMES_GATEWAY` to your existing Hermes HTTP backend (Compose reads
   `.env`; see `.env.example`). Use `host:port` or `http://host:port`.
   It must serve `/api/status` and `/api/ws`, such as `hermes serve` or
   `hermes dashboard`. `hermes gateway run` alone is not this backend.
2. Set Hermes `dashboard.public_url` to this PWA origin for OAuth and configure
   trusted proxy peers. The browser always uses this site's proxy; direct
   gateway URLs remain available to the native iOS app.
3. Set `WEBPUSH_PWA_URL` in `.env`. Give the completion bridge an existing
   Hermes credential with either `HERMES_BRIDGE_TOKEN` or
   `HERMES_BRIDGE_USERNAME` and `HERMES_BRIDGE_PASSWORD`. The bridge uses the
   normal Gateway API and does not change Hermes.
4. Start the app from the released images:

   ```sh
   docker compose up -d
   ```

5. Point your Cloudflare Tunnel hostname at `http://localhost:8080` on this
   Docker host. The container does not manage TLS or Cloudflare credentials.
6. Open the hostname and sign in to Hermes. In Safari, use Share, then Add to
   Home Screen. Chromium browsers also offer an Install app button when eligible.

The browser PWA stays on this site's origin; nginx contacts Hermes from
`HERMES_GATEWAY`. The iOS app can still type a gateway URL directly. The Docker
proxy never takes a request-supplied upstream, so one `.env` selects the
browser's gateway while authentication, WebSockets, OAuth, and Web Push all
stay on this one origin.

The default `docker-compose.yml` pulls pinned GHCR images and does not need a
source build. The current packages require GHCR authentication (`docker login
ghcr.io`) unless their visibility is changed to public. To build from a source
checkout instead, run `docker compose -f compose.build.yaml up -d --build`.
See [deploy/README.md](deploy/README.md) for required settings, networking,
proxy trust, caching, and gateway configuration.

## Release Docker images

The client and relay versions (including their lockfiles) must match. For
each release, bump both together and commit the changes to `main`:

```sh
VERSION=0.3.0
(cd client && npm version --no-git-tag-version "$VERSION")
(cd web-push-relay && npm version --no-git-tag-version "$VERSION")
```

From a clean, up-to-date `main` checkout, preview and run the release:

```sh
npm run release:dry-run
npm run release
```

The release command requires Docker and an authenticated GitHub CLI (`gh auth
login`). It checks that the worktree is clean, local `main` matches
`origin/main`, the version is newer than every existing version tag, and both
Docker images build locally. It then creates and pushes an annotated
`v<version>` tag. The old, cancelled `v0.2.0` tag means the script cannot be
used for a `0.1.x` release; push its tag manually instead.
GitHub Actions publishes the images to GHCR and creates the GitHub Release only
after both image builds and pushes succeed.

Images are built for `linux/amd64` and `linux/arm64`:

```text
ghcr.io/rcsn01/herm-bot-pwa:<version>
ghcr.io/rcsn01/herm-bot-web-push-relay:<version>
```

Each release also gets a full-commit-SHA tag. Stable releases update `latest`;
pre-releases such as `1.0.0-rc.1` do not. GHCR packages are private by default;
change their visibility in GitHub Packages settings only if public pulls are
intended. This publishes images but does not deploy them or change the
source-build Compose setup above.

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

The Vite proxy uses that fixed target while the browser remains on the app
origin. The proxy binds to `127.0.0.1` and never accepts a request-supplied
destination. The Vite development proxy is not a production server. PWA
caching runs only in production builds; `npm run preview` previews assets but
does not proxy a remote gateway.

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
