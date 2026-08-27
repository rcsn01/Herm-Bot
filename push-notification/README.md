# Bark Push Notifications for Hermes

Automatic iPhone push notifications when a Hermes turn runs long — no skill,
no agent action, no cron recipe. Tapping the notification opens Hermes Mobile
straight into that conversation.

This folder is the complete kit: the plugin code plus these instructions.
Link or copy it into the gateway machine's `~/.hermes/plugins/` and you're
one agent prompt away from done.

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

- Lives entirely in `~/.hermes/plugins/` on the gateway machine — no Hermes
  repo changes, survives `hermes update`.
- Short conversational turns stay silent; a multi-iteration tool loop pushes
  exactly once; failed stream attempts never push.
- Bonus: `hermes bark "message"` for manual pushes from any terminal on the
  gateway box.

## Layout

```
push-notification/
├── plugin.yaml    # plugin manifest (name: bark-notify)
├── __init__.py    # plugin code: stream hooks + `hermes bark` CLI
└── README.md      # this file
```

## Prerequisites

1. **Hermes gateway** running on a machine you control (the plugin deploys
   there — the hooks fire inside the Hermes process, so this Mac doesn't need
   Hermes at all).
2. **Bark iOS app** — "Bark - Custom Notifications" from the App Store. It
   owns the APNs entitlement, so **no paid Apple Developer account** is
   needed.
3. **Hermes Mobile with the `hermes://` URL scheme** — tap-through needs the
   app rebuilt from a checkout containing the deep-link support (this repo,
   `apps/mobile/client`):

   ```bash
   cd apps/mobile/client
   npm run cap:sync && npm run ipa
   ```

   Older IPAs still receive pushes; the tap just won't open the app.

## Setup on the gateway machine

### 1. Deploy the plugin

The installed name must be `bark-notify` (the plugin id). From this Mac:

```bash
scp -r apps/mobile/push-notification <user>@<gateway>:~/push-notification
ssh <user>@<gateway> 'mkdir -p ~/.hermes/plugins && ln -sfn ~/push-notification ~/.hermes/plugins/bark-notify'
```

(A plain copy into `~/.hermes/plugins/bark-notify/` works identically; the
symlink just means future edits propagate by re-copying to `~/push-notification`.)

### 2. Run the bark relay

On the gateway machine:

```bash
docker run -dt --name bark -p 8080:8080 -v ~/.hermes/bark-data:/data finab/bark-server
```

No Docker? Download a bark-server release binary and run it on port 8080.

### 3. Register the Bark iOS app (phone, one time)

Install Bark, add server `http://<gateway-tailnet-host>:8080` (Tailscale or
any network the phone can reach — this is the only time the phone contacts
the relay; delivery afterwards is APNs, Apple → phone, no inbound exposure).
Copy the device key — the URL path the app shows (e.g. `AbCd123…`).

### 4. Secrets in `~/.hermes/.env` (on the gateway machine)

```
BARK_URL=http://localhost:8080
BARK_KEY=<device key>
```

`BARK_URL` is what the **gateway machine** uses to reach the relay
(`localhost:8080` when it runs there). `.env` is for secrets only — the
device key is a bearer credential for your relay.

### 5. Enable + restart

```bash
hermes plugins enable bark-notify
# then restart the gateway so it loads the plugin and the new env
```

Profiles: repeat per profile `HERMES_HOME` you want covered (each profile
has its own plugins dir, `.env`, and `plugins.enabled`).

### 6. Test

```bash
hermes bark "Bark channel is live" --url "hermes://session/test"
```

→ push arrives on the phone; tapping opens Hermes Mobile (unknown session
ids fall back to the sessions list).

Then the real thing: run any prompt that takes over 30 seconds — you'll get
an automatic "Hermes — task finished (Ns)" push with the reply preview,
deep-linked to that session.

## Tuning — `config.yaml` on the gateway machine

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

Value changes take effect next turn; no restart needed.

## CLI reference

```
hermes bark "message" [--title ...] [--url hermes://session/<id>]
                      [--level active|timeSensitive|critical|passive] [--group ...]
```

## Troubleshooting

| Symptom | Check |
|---|---|
| No push; log says `BARK_URL/BARK_KEY not set` | `.env` missing the vars, or gateway not restarted after adding them |
| No push; no log at all | plugin not enabled (`hermes plugins list`, then `hermes plugins enable bark-notify`) or gateway not restarted |
| Log shows `push failed: ...` | bark-server down or wrong `BARK_URL` — probe: `curl -s http://localhost:8080/<key> -H 'Content-Type: application/json' -d '{"body":"t"}'` |
| Push arrives, tap does nothing | IPA predates the `hermes://` scheme — rebuild (`npm run cap:sync && npm run ipa`) |
| Push arrives, tap opens the wrong session | expected only for the synthetic `test` id — real pushes carry the live session id |
| Too noisy / too quiet | raise/lower `min_turn_seconds`, `min_push_interval_seconds` |

Logs: `hermes logs` on the gateway box; entries are tagged `bark-notify`.

## Hand this to your Hermes agent (on the gateway machine)

> Set up Bark push notifications. A `bark-notify` plugin is already installed
> at ~/.hermes/plugins/bark-notify — do NOT modify it, and do NOT create any
> skill for this. Your steps:
> 1. Run the bark relay on this machine: `docker run -dt --name bark -p 8080:8080 -v ~/.hermes/bark-data:/data finab/bark-server`. If Docker is unavailable, download a bark-server release binary instead. Then tell me the URL my **phone** can reach it at (we're on Tailscale, so the tailnet host:port is fine — I only need it once, for app registration).
> 2. I will install the "Bark — Custom Notifications" iOS app, add that server, and paste you the device key.
> 3. Add exactly two lines to ~/.hermes/.env: `BARK_URL=http://localhost:8080` (the relay address as reachable **from this machine**) and `BARK_KEY=<my device key>`. Never log the key or commit it anywhere.
> 4. Enable the plugin: `hermes plugins enable bark-notify`, then restart the gateway so it loads.
> 5. Verify: run `hermes bark "Bark channel is live" --url "hermes://session/test"` and ask me to confirm it arrived on my phone. Then run a prompt that takes over 30 seconds and confirm I got an automatic "task finished" push whose tap opens Hermes Mobile.
> 6. Finally, show me the current tuning knobs in ~/.hermes/config.yaml under `plugins.entries.bark-notify.settings` (min_turn_seconds defaults to 30, min_push_interval_seconds to 60).

## Security notes

- Traffic stays inside your tailnet except Apple's APNs relay — the same
  path every push app uses.
- `BARK_KEY` is a bearer credential for your relay: keep it in `.env` only.
- Relay payloads go over plain HTTP by default; fine on a tailnet or
  localhost. Put bark-server behind HTTPS before exposing it beyond that.