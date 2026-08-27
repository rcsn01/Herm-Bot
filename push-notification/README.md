# Bark Push Notifications for Hermes

Automatic iPhone push notifications when a Hermes turn runs long — no skill,
no agent action, no cron recipe. Tapping the notification opens Hermes Mobile
straight into that conversation.

This folder is the complete kit: plugin code, tests, and these instructions.

## How it works

```
Any Hermes turn (gateway, CLI, cron, background-task completion)
  → on_stream_start / on_stream_end hooks (fired by the agent core itself)
      → plugin debounces per turn, measures duration
          → turn ran ≥ min_turn_seconds (default 30s)?
              → POST to your bark-server relay
                  → Bark iOS app → APNs → iPhone
                      → tap → hermes://session/<id> → Hermes Mobile
```

- Lives entirely in `~/.hermes/plugins/` (the Hermes home) — no Hermes repo
  changes, survives `hermes update`.
- Short conversational turns stay silent; a multi-iteration tool loop pushes
  exactly once; failed stream attempts never push.
- Bonus: `hermes bark "message"` for manual pushes from any terminal that can
  run Hermes.

## Read this first: two different addresses

A bark-server URL is only useful **relative to a client**. The iPhone and the
Hermes process may need **different addresses**, and confusing them is the #1
setup failure — especially when Hermes itself runs in Docker, where
`localhost` inside the container means the container, not your host:

| Topology | `BARK_URL` (used by Hermes) | Phone registration URL |
|---|---|---|
| Bark service in the same Compose network as Hermes | `http://bark:8080` | `http://<host-tailnet-or-LAN>:8080` |
| Bark as its own published container on the Docker host | `http://<host-tailnet-or-LAN>:8080` | `http://<host-tailnet-or-LAN>:8080` |
| Hermes and Bark share the host network namespace | `http://127.0.0.1:8080` | `http://<host-tailnet-or-LAN>:8080` |

Both addresses are recorded in two places: `BARK_URL` in Hermes' `.env`
(Hermes' view) and the server you add in the Bark iOS app (the phone's view).
They are often NOT the same string.

## Paths: host vs container

When Hermes runs in a container, `$HERMES_HOME` is a path **inside the
container** (commonly `/opt/data`), bind-mounted from a **host** directory.
The plugin and `.env` live in the Hermes home — whichever side you edit, edit
the location Hermes actually reads at startup:

```text
Native Hermes:
  plugins:  $HERMES_HOME/plugins/bark-notify        (usually ~/.hermes/plugins/bark-notify)
  secrets:  $HERMES_HOME/.env                       (usually ~/.hermes/.env)

Docker Hermes (example layout — adjust to yours):
  container HERMES_HOME: /opt/data
  plugins:               /opt/data/plugins/bark-notify
  secrets:               /opt/data/.env
  host bind mount:       $HOME/docker/hermes/data    (docker cp / bind mounts
                          always resolve from the DOCKER HOST's filesystem)
```

## Who can do what

Some steps are operator-only by design — an agent cannot honestly complete
them for you:

| Step | Owner |
|---|---|
| Host-side Docker commands (unless the agent has daemon access) | Operator |
| Choosing network addresses (tailnet, LAN, firewall) | Operator |
| Installing the Bark app and registering the relay on the iPhone | Operator |
| Entering the device key (never paste it into chat) | Operator |
| Granting plugin tool-override permission (answer: **no** for this plugin) | Operator |
| Confirming the notification arrived and tap-through works | Operator |
| Rebuilding/signing Hermes Mobile | Operator |

Everything else — copying files into the Hermes home, enabling the plugin,
running verification commands — can be delegated to your Hermes agent.

---

## Setup A — Docker (Compose)

Run the blocks in order, on the **Docker host**, from any directory you can
read (`~` is fine — do not `cd` into the Hermes data directory). One block at
a time; check each block's expected output before continuing. Adjust Block 1
to your layout; nothing else hardcodes paths.

### Block 1 — identify your Compose project

```bash
export COMPOSE="$HOME/docker/hermes/docker-compose.yml"   # your compose file
export HERMES_SERVICE="hermes"                            # your hermes service name
export HERMES_HOME="/opt/data"                            # HERMES_HOME inside the container
export BARK_DATA="$HOME/docker/hermes/data/bark-data"     # host-side relay data dir
test -f "$COMPOSE" && docker compose -f "$COMPOSE" config --services
```

Expected: the service list includes your Hermes service. If `docker compose`
isn't available (older installs), substitute `docker-compose` throughout.

### Block 2 — get the plugin onto the host

**Option 1 — copy from your checkout (this Mac):**

```bash
scp -r apps/mobile/push-notification <user>@<gateway>:~/push-notification
```

**Option 2 — download from GitHub, pinned to a commit:**

```bash
export PLUGIN_REF="<full-40-char-SHA>"   # the kit commit you reviewed; run
                                         # `git log -1 --format=%H -- apps/mobile/push-notification`
                                         # on the checkout to find the current one
export PLUGIN_SOURCE="$HOME/push-notification"
mkdir -p "$PLUGIN_SOURCE"
curl -fsSL "https://raw.githubusercontent.com/<owner>/<repo>/$PLUGIN_REF/apps/mobile/push-notification/__init__.py" -o "$PLUGIN_SOURCE/__init__.py"
curl -fsSL "https://raw.githubusercontent.com/<owner>/<repo>/$PLUGIN_REF/apps/mobile/push-notification/plugin.yaml" -o "$PLUGIN_SOURCE/plugin.yaml"
```

(Downloading a moving branch ref is not recommended — pin a commit.)

### Block 3 — copy the plugin into the container

```bash
docker compose -f "$COMPOSE" exec -T -u 0 "$HERMES_SERVICE" \
  mkdir -p "$HERMES_HOME/plugins/bark-notify"
export HERMES_CONTAINER="$(docker compose -f "$COMPOSE" ps -q "$HERMES_SERVICE")"
test -n "$HERMES_CONTAINER" && printf 'container: %s\n' "$HERMES_CONTAINER"
docker cp "$PLUGIN_SOURCE/." "$HERMES_CONTAINER:$HERMES_HOME/plugins/bark-notify/"
```

### Block 4 — permissions + syntax check

```bash
docker compose -f "$COMPOSE" exec -T -u 0 \
  -e HIC="$HERMES_HOME" "$HERMES_SERVICE" sh -c '
chmod 755 "$HIC/plugins" "$HIC/plugins/bark-notify"
chmod 644 "$HIC/plugins/bark-notify/__init__.py" "$HIC/plugins/bark-notify/plugin.yaml"'
docker compose -f "$COMPOSE" exec -T -e HIC="$HERMES_HOME" "$HERMES_SERVICE" \
  python3 -c 'from pathlib import Path; import os
p = Path(os.environ["HIC"]) / "plugins/bark-notify/__init__.py"
compile(p.read_text(), str(p), "exec"); print("plugin syntax: ok")'
```

Expected: `plugin syntax: ok`.

### Block 5 — run the bark relay persistently

On the Docker host. Idempotent: safe to re-run; a pre-existing `bark`
container is reconfigured, not recreated. Pin the image digest in production
(record the digest from `docker pull` and replace `:latest` with
`finab/bark-server@sha256:...`).

```bash
export BARK_IMAGE="finab/bark-server:latest"
mkdir -p "$BARK_DATA"
docker pull "$BARK_IMAGE"
if docker container inspect bark >/dev/null 2>&1; then
  docker update --restart unless-stopped bark
  docker start bark >/dev/null 2>&1 || true
else
  docker run -dt --name bark --restart unless-stopped \
    --publish 8080:8080 \
    --mount "type=bind,source=$BARK_DATA,target=/data" \
    "$BARK_IMAGE"
fi
docker inspect bark --format \
  'status={{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}} ports={{json .HostConfig.PortBindings}}'
```

Expected: `status=running`, `restart=unless-stopped`, host 8080 → 8080.
The relay now survives daemon restarts; data persists in `$BARK_DATA`.

*(Alternative: add `bark` as a service in the same compose project — then
`BARK_URL=http://bark:8080` and you skip host-address discovery entirely.
This is the preferred long-term topology.)*

### Block 6 — choose the Hermes-reachable relay address

```bash
export BARK_URL="http://<address-reachable-from-the-Hermes-container>:8080"
```

Pick from the topology table above. **Test it from inside the Hermes
container before touching the key** — `/ping` is an unauthenticated relay
endpoint, so nothing sensitive appears in this command:

```bash
docker compose -f "$COMPOSE" exec -T "$HERMES_SERVICE" \
  curl -sS -o /dev/null -w 'relay_http=%{http_code}\n' "$BARK_URL/ping"
```

Expected: `relay_http=200`. If you get `000`, fix networking first — no key
fixes a wrong address. (`localhost` inside the container is almost always
wrong here; in the deployment that motivated this guide, the host's tailnet
address worked and `localhost` did not.)

### Block 7 — register the Bark iOS app (operator, on the phone)

1. Install **Bark - Custom Notifications** from the App Store.
2. Add the **phone-reachable** server URL, e.g.
   `http://<gateway-tailnet-host>:8080`.
3. Copy the device key (the path segment the app shows).
4. Keep it private — see the security notes; the full endpoint is a bearer
   credential.

### Block 8 — store the key without printing it

`BARK_URL` comes from Block 6. The key never touches the command line, the
terminal scrollback, or chat:

```bash
read -r -s -p 'Paste the Bark device key (or full URL): ' BARK_INPUT; printf '\n'
printf '%s' "$BARK_INPUT" |
docker compose -f "$COMPOSE" exec -T -u 0 \
  -e BARK_RELAY_URL="$BARK_URL" -e HIC="$HERMES_HOME" "$HERMES_SERVICE" \
  python3 -c '
from pathlib import Path
import os, sys
raw = sys.stdin.read().strip()
if not raw or "\n" in raw or "\r" in raw:
    raise SystemExit("Empty or invalid Bark key")
key = raw.rstrip("/").rsplit("/", 1)[-1] if "://" in raw else raw.strip("/")
if not key:
    raise SystemExit("Could not extract a Bark key")
path = Path(os.environ["HIC"]) / ".env"
lines = path.read_text().splitlines() if path.exists() else []
updates = {"BARK_URL": os.environ["BARK_RELAY_URL"], "BARK_KEY": key}
out, seen = [], set()
for line in lines:
    name = line.split("=", 1)[0] if "=" in line else ""
    if name in updates:
        if name not in seen:
            out.append(f"{name}={updates[name]}"); seen.add(name)
    else:
        out.append(line)
for name, value in updates.items():
    if name not in seen:
        out.append(f"{name}={value}")
tmp = path.with_name(path.name + ".tmp")
tmp.write_text("\n".join(out) + "\n"); os.chmod(tmp, 0o600); os.replace(tmp, path)
print(f"Bark environment saved; key length: {len(key)}")'
unset BARK_INPUT
```

Expected: a confirmation showing **only the key length**.

Native Hermes equivalent: edit `~/.hermes/.env` directly, or
`printf 'BARK_KEY=%s\n' "$BARK_INPUT" >> ~/.hermes/.env` after the same
`read -s` prompt.

### Block 9 — enable the plugin, without tool override

```bash
docker compose -f "$COMPOSE" exec -T "$HERMES_SERVICE" \
  hermes plugins enable bark-notify --no-allow-tool-override
```

This plugin registers stream hooks and a CLI command only — it must never
replace built-in tools. If your Hermes build predates the flag, run
`hermes plugins enable bark-notify` and answer **n** at the override prompt.
If override was ever granted by mistake:

```bash
hermes config set plugins.entries.bark-notify.allow_tool_override false
```

### Block 10 — restart Hermes

Plugin enablement, `.env` changes, **and tuning changes** all require a fresh
Hermes process (settings are read once at plugin load):

```bash
docker compose -f "$COMPOSE" restart "$HERMES_SERVICE"
docker compose -f "$COMPOSE" ps "$HERMES_SERVICE"
```

### Block 11 — verify the env loaded, without exposing the key

```bash
docker compose -f "$COMPOSE" exec -T -e HIC="$HERMES_HOME" "$HERMES_SERVICE" \
  python3 -c '
from hermes_cli.env_loader import load_hermes_dotenv
import os
load_hermes_dotenv(hermes_home=os.environ["HIC"], load_external_secrets=False)
print("BARK_URL set:", bool(os.getenv("BARK_URL")))
print("BARK_KEY length:", len(os.getenv("BARK_KEY", "")))'
```

Expected: `BARK_URL set: True` and a non-zero key length. Never print the
value itself.

### Block 12 — manual push + human receipt check

```bash
docker compose -f "$COMPOSE" exec -T "$HERMES_SERVICE" \
  hermes bark "Bark channel is live" --url "hermes://session/test"
```

Expected: `Pushed.` — this means the **relay accepted** the request. Now
confirm on the iPhone that the notification actually arrived, and tap it
(unknown session ids fall back to Hermes Mobile's sessions list). "Pushed."
without a phone receipt proves networking, not delivery.

### Block 13 — deterministic long-turn test

One turn, above the 30s default threshold. Wait out the 5s debounce, then
check the phone. Don't fire repeated auto-tests — the 60s rate limit will
silently swallow them:

```bash
docker compose -f "$COMPOSE" exec -T "$HERMES_SERVICE" \
  hermes chat --quiet -q 'Use the terminal to run exactly `sleep 35`. After it finishes, reply exactly: Long-turn test completed.'
```

Expected: one automatic "Hermes — task finished (~35s)" push carrying a
`hermes://session/<live-id>` link; tapping it opens that conversation in
Hermes Mobile. If you scripted this as a cron job, remove or pause it after
the test (`hermes cron remove` / `hermes cron pause`).

---

## Setup B — native Hermes (no Docker)

```bash
# 1. plugin
scp -r apps/mobile/push-notification <user>@<gateway>:~/push-notification
ssh <user>@<gateway> 'mkdir -p ~/.hermes/plugins && ln -sfn ~/push-notification ~/.hermes/plugins/bark-notify'

# 2. relay (persistent + idempotent)
docker run -dt --name bark --restart unless-stopped -p 8080:8080 \
  -v ~/.hermes/bark-data:/data finab/bark-server

# 3. secrets — ~/.hermes/.env on the gateway machine
BARK_URL=http://127.0.0.1:8080     # address reachable FROM the Hermes process
BARK_KEY=<device key>              # enter silently; never paste into chat

# 4. enable + restart
hermes plugins enable bark-notify --no-allow-tool-override
# restart the gateway

# 5. tests
hermes bark "Bark channel is live" --url "hermes://session/test"   # + phone receipt
# then a >30s prompt for the automatic push
```

Profiles: repeat per profile `HERMES_HOME` you want covered — each has its
own plugins dir, `.env`, and `plugins.enabled`.

## Tuning — `config.yaml` in the Hermes home

```yaml
plugins:
  entries:
    bark-notify:
      settings:
        min_turn_seconds: 30          # only turns that ran at least this long push
        debounce_seconds: 5           # quiet period after the last stream event before pushing
        min_push_interval_seconds: 60 # global rate limit between pushes
        level: timeSensitive          # active | timeSensitive | critical | passive
        group: hermes                 # Bark notification group
        title: Hermes                 # title prefix ("Hermes — task finished (Ns)")
```

Settings are loaded once at plugin startup — **restart the gateway after
changing them** (also required after enabling the plugin or changing
`BARK_URL`/`BARK_KEY`).

## CLI reference

```
hermes bark "message" [--title ...] [--url hermes://session/<id>]
                      [--level active|timeSensitive|critical|passive] [--group ...]
```

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| Log: `BARK_URL/BARK_KEY not set` | `.env` missing the vars, wrong Hermes home, or no restart after adding them |
| No push, no log at all | plugin not enabled (`hermes plugins list`) or gateway not restarted |
| Log: `cannot reach bark relay: ...` | wrong `BARK_URL` for this network namespace — re-run the Block 6 `/ping` check from inside Hermes |
| Log: `relay rejected push (http 401/403)` | device key invalid/rotated — re-register on the phone; if the key was ever pasted into chat/logs, treat it as compromised and rotate |
| `connection refused` | bark container stopped, other port, or host firewall |
| `Pushed.` but no phone notification | phone-side: Bark server registration, iOS notification permissions, Focus mode, phone-reachable URL |
| Notification arrives, tap does nothing | installed Hermes Mobile predates the `hermes://` scheme — rebuild (`npm run cap:sync && npm run ipa`) |
| Tap opens the wrong session | only expected for the synthetic `test` id; real pushes carry the live session id |
| Auto-push fires too often / too rarely | tune `min_turn_seconds`, `min_push_interval_seconds` (then restart) |

Logs: `hermes logs` on the gateway box (entries tagged `bark-notify`);
relay side: `docker logs bark`.

## Hand this to your Hermes agent

> Set up Bark push notifications. The `bark-notify` plugin kit is already
> available at ~/push-notification (or apps/mobile/push-notification in the
> checkout) — read its README.md first and follow Setup A step by step. Do
> NOT modify the plugin code and do NOT create any skill for this. Rules:
> - Work block by block; verify each block's expected output before the next.
> - Never print, log, or repeat the Bark device key. I will enter it myself
>   via the silent prompt in the README. Do not ask me to paste it into chat.
> - Enable the plugin with `--no-allow-tool-override`; never grant built-in
>   tool override permission.
> - Steps you cannot do (iPhone registration, host firewall, choosing
>   network addresses, confirming phone receipt): hand me a precise
>   instruction and wait for my confirmation.
> - Verify with: the /ping check from inside the Hermes container, then
>   `hermes bark "Bark channel is live" --url "hermes://session/test"`, and
>   ask me to confirm receipt AND tap-through on my phone. Then run one
>   `sleep 35` long-turn test for the automatic push.

## Verification checklist

- [ ] Fresh operator can follow the guide without entering protected data dirs
- [ ] Docker host, Hermes container, and phone identified as separate contexts
- [ ] `BARK_KEY` never in chat, shell history, or command args
- [ ] Bark container survives daemon restart (`--restart unless-stopped`)
- [ ] Re-running setup doesn't fail on an existing `bark` container
- [ ] Plugin enabled **without** built-in tool override
- [ ] `/ping` returns 200 from inside the actual Hermes container
- [ ] `hermes bark` returns `Pushed.`
- [ ] Operator confirms phone receipt
- [ ] Operator confirms tap-through (or documents that the IPA predates the scheme)
- [ ] One long-turn test → exactly one automatic push
- [ ] Test cron jobs removed/paused
- [ ] Restart performed after enable / env / settings changes

## Security notes

- Traffic stays inside your tailnet except Apple's APNs relay — the same
  path every push app uses.
- The full Bark device URL (`http://relay/<key>`) is a **bearer credential**.
  If it ever lands in chat, an issue, a ticket, or shared logs, rotate the
  device key (re-register the app) before relying on it.
- Relay payloads go over plain HTTP by default; acceptable on a tailnet or
  localhost. Put bark-server behind HTTPS before exposing it beyond that.
- This plugin deliberately registers no built-in-tool override capability;
  keep it that way (`plugin.yaml` declares hooks and env vars only).