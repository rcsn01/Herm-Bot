# Mobile PWA container

This package builds only the existing React/Vite client and serves its static
`dist/` with unprivileged nginx. It does not contain Hermes, Python, Xcode,
backend state, Cloudflare credentials, or TLS termination.

Run commands from `apps/mobile`:

```sh
docker compose build
docker compose up -d
```

Compose publishes HTTP only on `127.0.0.1:8080`. Point a Cloudflare Tunnel (or
another trusted TLS reverse proxy) at that address. Do not expose port 8080
publicly. Serve this app at the hostname root, not under a path prefix.

If `cloudflared` runs in another container, `localhost` refers to that container.
Attach it to the Compose network and use `http://mobile:8080` as its origin
instead. Keep the mobile port private and do not commit tunnel credentials.

## Gateway

Set `HERMES_GATEWAY` (or `HERMES_URL`) to one existing Hermes HTTP backend
reachable from the container. Compose interpolates `apps/mobile/.env`. The
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

Configure Hermes `dashboard.public_url` to the external HTTPS PWA origin (for
example, `https://mobile.example.com`). The gateway uses that public hostname
for Host/Origin validation and OAuth redirects. Configure the gateway's trusted
proxy settings for the actual Cloudflare/reverse-proxy hop(s), and ensure the
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

A user can also type a different Hermes URL in the PWA. That traffic leaves the
proxy and is a browser request to that host. Set `dashboard.public_url` to the
PWA origin so the gateway can allow that Origin; cookie sign-in still belongs
on this site's proxy.

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

## Build context and inputs

The build context must be the repository root (`../..` from this directory), as
set in `compose.yaml`. `Dockerfile.dockerignore` is a deny-by-default allowlist.
The admitted build inputs are:

- mobile client package/lock files, Vite/TypeScript/Capacitor build config,
  `index.html`, `src/`, and `public/`;
- `apps/shared` package metadata, TypeScript config, and source (required by the
  lockfile's `file:../../shared` dependency and source aliases);
- the desktop `types/hermes.ts` contract and the small UI primitive set imported
  by the mobile compatibility layer, including `control.ts`;
- the nginx deployment files (`nginx.conf`, `gateway.conf`,
  `hermes-gateway.sh`, and `docker-entrypoint.sh`).

Local `.env`, `.hermes`, `node_modules`, iOS/Xcode outputs, repository secrets,
and backend sources are excluded by construction. If the client begins to
import another shared source file, add that precise input to both the Dockerfile
and its allowlist rather than broadening the context.
