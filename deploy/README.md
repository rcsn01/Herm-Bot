# Mobile PWA container

This package builds only the existing React/Vite client and serves its static
`dist/` with unprivileged nginx. It does not contain Hermes, Python, Xcode,
backend state, Cloudflare credentials, or TLS termination.

Run commands from the repository root:

```sh
docker compose build
docker compose up -d
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

Configure Hermes `dashboard.public_url` to the external HTTPS origin of the
dashboard itself when OAuth/Host checks need it (for example the Tailscale
Serve URL of Hermes). That is **not** the PWA origin.

If the PWA will type a Hermes Tailscale URL and talk to it directly from the
phone browser, add this PWA origin to `dashboard.cors_origins` on that Hermes
instance:

```yaml
dashboard:
  cors_origins:
    - http://mac.tail3ce9b9.ts.net:8080
    - http://192.168.1.10:8080
```

Exact origins only. Cookie/OAuth sign-in from the PWA works when both hosts
share a tailnet MagicDNS site (`*.<tailnet>.ts.net`). A gateway token works
from any allowlisted origin. The Docker proxy still uses `HERMES_GATEWAY` when
the PWA stays on this site; it never takes a request-supplied upstream.

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

Compose includes a private Web Push relay with persistent VAPID keys and
subscriptions. It is reached through `/push` on the existing PWA origin, so it
does not need another hostname or published port.

Generate the relay bearer secret once in `.env`, then deploy:

```sh
umask 077
printf '\nHERMES_WEB_PUSH_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
docker compose up -d --build
```

Do not repeat the append command if the variable already exists. Set the
`WEBPUSH_*` deployment values shown in `.env.example`. For a remote Docker
gateway, install the profile-scoped delivery extension:

```sh
./configure-web-push-docker.sh
```

The script securely copies the extension and relay secret into the remote
`HERMES_HOME`, removes the unreliable process-scoped outbound target if
present, registers `webpush` as a normal delivery channel, and restarts only
the Hermes service:

```yaml
plugins:
  enabled:
    - mobile-push-delivery
  entries:
    mobile-push-delivery:
      enabled: true
      allow_tool_override: false
platforms:
  webpush:
    enabled: true
    gateway_restart_notification: false
    home_channel:
      platform: webpush
      chat_id: all
      name: All subscribed devices
    extra:
      relay_url: https://mobile.example/push/v1/notify
```

This extension is loaded through Hermes' supported user-plugin layer; it does
not change `/opt/hermes` or the container image and survives image updates
because it lives under the mounted `HERMES_HOME`. The `webpush` home channel
means all devices subscribed to this Mobile deployment. Select `webpush` as a
cron delivery target, use `webpush:all` explicitly, or send directly:

```sh
hermes send --to webpush "The deployment finished."
```

Ordinary unscheduled Hermes turns do not send Web Push notifications.

Open the installed PWA after deploying its update, sign in, then choose
**Settings → Notifications → Enable notifications**. Registration mutations
are accepted only when the PWA's Hermes cookie or session token authenticates
against the fixed `HERMES_GATEWAY`; `/api/status` is deliberately not used
because it is a public liveness endpoint. Test end-to-end with `hermes send` or
a cron job configured to deliver to `webpush`.

The relay removes expired browser subscriptions automatically. Back up the
`web-push-data` volume if retaining subscriptions across a host migration
matters; ordinary container rebuilds preserve it.

## Build context and inputs

The build context is the repository root, as set in `compose.yaml`.
`Dockerfile.dockerignore` is a deny-by-default allowlist. It admits only the
client build inputs and nginx deployment files. The gateway contracts and UI
primitives used by the client live under `client/src/compat/`, so a Hermes
Agent checkout is not needed to build the image.

Local `.env`, `.hermes`, `node_modules`, iOS/Xcode outputs, repository secrets,
and unrelated source files are excluded by construction. If the client begins
to import another standalone source file, add that precise input to both the
Dockerfile and its allowlist rather than broadening the context.
