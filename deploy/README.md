# Mobile PWA container

This package builds only the existing React/Vite client and serves its static
`dist/` with unprivileged nginx. It does not contain Hermes, Python, Xcode,
backend state, Cloudflare credentials, or TLS termination.

By default, `docker-compose.yml` pulls the published GHCR images; no source checkout
or local build is needed. Configure `WEBPUSH_PWA_URL`, `HERMES_GATEWAY`, and a
bridge credential in `.env` (or disable the completion bridge), then start the
stack from the directory containing `docker-compose.yml`:

```sh
docker compose up -d
```

The GHCR packages currently require authentication; run `docker login ghcr.io`
once before starting unless their visibility is made public. Set
`HERMES_MOBILE_VERSION` in `.env` to choose a release; it defaults to `0.1.0`.

To build from a source checkout, use the separate manifest:

```sh
docker compose -f compose.build.yaml build
docker compose -f compose.build.yaml up -d
```

Compose publishes HTTP on port `8080` on all host interfaces (LAN included).
Do not forward that port to the public internet. Point a Cloudflare Tunnel or
other TLS reverse proxy at `http://127.0.0.1:8080` if you want HTTPS. Serve
this app at the hostname root, not under a path prefix.

If `cloudflared` runs in another container, `localhost` refers to that container.
Attach it to the Compose network and use `http://mobile:8080` as its origin
instead. Keep the mobile port private and do not commit tunnel credentials.

## Gateway

Set `HERMES_GATEWAY` (or `HERMES_URL`) to one existing Hermes HTTP backend
reachable from the container. Compose interpolates `.env`. The
default is `host.docker.internal:8642`; Compose adds the Linux `host-gateway`
mapping. A gateway bound only to the host's loopback address is not generally
reachable through the Docker bridge. Use an existing authenticated backend
address reachable from the container, or a private host interface/firewall rule
restricted to the proxy. Do not disable gateway authentication to solve
reachability.

Examples:

```sh
HERMES_GATEWAY=host.docker.internal:8642
HERMES_GATEWAY=192.168.1.10:9119
HERMES_URL=http://h-lap02.tail3ce9b9.ts.net:9119
```

The upstream must serve Hermes HTTP/JSON-RPC, such as `hermes serve` or
`hermes dashboard`, not only `hermes gateway run`. HTTPS URLs are rejected:
TLS belongs on the browser-facing tunnel; the container talks to Hermes over
HTTP.

Do not derive the upstream from a request header, URL, query parameter, or
cookie. Restart after changing the environment:

```sh
docker compose up -d
```

To supply a raw nginx `upstream` block instead, mount it over
`/tmp/hermes-gateway.conf`.

Configure Hermes `dashboard.public_url` to the external HTTPS origin users
open for this PWA and configure the gateway's trusted proxy peers. OAuth and
Host checks must see the PWA origin because nginx presents that origin to the
browser.

The browser PWA always stays on this origin, so it needs no CORS allowlist for
Hermes. The Docker proxy uses only `HERMES_GATEWAY`/`HERMES_URL`; it never takes
a request-supplied upstream. The native iOS app may still connect directly to a
Tailscale or LAN URL.

When the PWA is reached through Cloudflare or another TLS reverse proxy,
configure the gateway's trusted proxy settings for that hop, and ensure the
outer proxy sets `X-Forwarded-Proto: https`. nginx accepts only `http` or
`https` for that header and otherwise uses its connection scheme.

Cloudflare Access may be an additional perimeter, but is **not** a substitute
for Hermes gateway authentication. This proxy does not add permissive CORS,
remove `Secure` from cookies, or bypass gateway auth. API, auth, WebSocket, and
streaming traffic is forwarded without caching or response buffering. Access
logs intentionally omit query strings and referrers because OAuth codes and
tokens can occur there. nginx upstream error logging is disabled on proxied
routes because its error format includes the full request URI; sanitized access
logs still report status codes. Configure gateway and tunnel logs to avoid
recording credentials too.

Do not configure a Cloudflare Cache Everything rule for this hostname. `/api`,
`/auth`, `/login`, `/index.html`, `/sw.js`, and `/manifest.webmanifest` must not be
edge-cached. Preserve WebSocket upgrades. If Cloudflare Access expires while the
app is open, reload the page to complete Access sign-in, then reconnect to Hermes.
No Cloudflare service token belongs in the JavaScript bundle.

The proxy forwards uploads up to 72 MB to accommodate the app's 50 MB file limit
and JSON/base64 overhead. It never injects a gateway token. Static-token mode
still requires the user to enter a token; interactive mode keeps gateway cookies
HttpOnly and uses one-use WebSocket tickets.

`GET /healthz` is a local static health check and does not attest to gateway
availability. After deployment, check gateway sign-in, a streamed chat, profile
switching, file upload/download, and OAuth through the real tunnel. Browser
fixture tests do not certify the proxy or your identity provider.

To update, rebuild and recreate the container. Open clients offer an update
button rather than reloading an active conversation. Keep the previous image
for rollback. A rolled-back service worker still needs the normal update/reload
cycle; if an installation is stuck, clear that site's data and sign in again.
This never deletes gateway sessions.

## Web Push notifications

Compose includes a private Web Push relay with persistent VAPID keys,
subscriptions, and completion-event state. nginx exposes only registration and
the public VAPID key under `/push`. The relay has no published host port and
needs no shared Web Push token.

The relay's completion bridge connects to the existing `HERMES_GATEWAY`. Give
it one existing Hermes credential in `.env`:

```sh
# Preferred when the dashboard already uses password authentication.
HERMES_BRIDGE_USERNAME=your-existing-username
HERMES_BRIDGE_PASSWORD=your-existing-password

# Or use an existing static Hermes session token instead.
# HERMES_BRIDGE_TOKEN=your-existing-token
```

The bridge signs in through `/auth/password-login`, requests one-use WebSocket
tickets, polls `session.active_list`, and attaches observer sockets with
`session.activate`. It sends pushes for `message.complete` events. It neither
creates nor resumes sessions. No plugin, outbound hook, delivery channel, or
Web Push secret is installed in Hermes.

For reconnect recovery, the bridge stores session sequence watermarks and
notification IDs in the `web-push-data` volume. It calls
`session.events.since` before resuming live observation and deduplicates
replayed completion events. Hermes keeps that replay history in a bounded
in-memory ring. Delivery is at least once: a crash after the push provider
accepts a message but before the relay saves its delivery ID can repeat a push.
The relay uses a stable notification tag so browsers can replace that retry.
A turn can still be missed if the bridge never observed its runtime session
and the whole turn began and ended while the bridge was down. Keep the relay
running whenever Hermes is in use. Set
`HERMES_COMPLETION_BRIDGE_ENABLED=false` only when completion pushes are not
wanted; bridge credentials are then optional.

Deploy, open the installed PWA, sign in, then choose
**Settings → Notifications → Enable notifications**:

```sh
docker compose up -d
```

Registration mutations require the PWA's Hermes cookie or session token
against the fixed `HERMES_GATEWAY`; `/api/status` is not used because it is a
public liveness endpoint. Start a normal Hermes turn, put the PWA in the
background, and verify that the completion notification opens the stored
session.

The relay removes expired browser subscriptions automatically. Back up the
`web-push-data` volume if subscriptions and replay watermarks must survive a
host migration. Container rebuilds preserve the volume.

## Build context and inputs

The build context is the repository root, as set in `compose.build.yaml`.
`Dockerfile.dockerignore` is a deny-by-default allowlist. It admits only the
client build inputs and nginx deployment files. The gateway contracts and UI
primitives used by the client live under `client/src/compat/`, so a Hermes
Agent checkout is not needed to build the image.

Local `.env`, `.hermes`, `node_modules`, iOS/Xcode outputs, repository secrets,
and unrelated source files are excluded by construction. If the client begins
to import another standalone source file, add that precise input to both the
Dockerfile and its allowlist rather than broadening the context.
