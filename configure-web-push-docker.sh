#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mobile_env=${MOBILE_ENV:-"$script_dir/.env"}

env_value() {
  awk -F= -v wanted="$1" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$mobile_env"
}

if [ ! -f "$mobile_env" ]; then
  echo "Mobile environment file not found: $mobile_env" >&2
  exit 1
fi

ssh_target=$(env_value WEBPUSH_SSH_TARGET)
compose_file=$(env_value WEBPUSH_COMPOSE_FILE)
hermes_service=$(env_value WEBPUSH_HERMES_SERVICE)
hermes_home=$(env_value WEBPUSH_HERMES_HOME)
pwa_url=$(env_value WEBPUSH_PWA_URL)
token=$(env_value HERMES_WEB_PUSH_TOKEN)
pwa_url=${pwa_url%/}

if [ -z "$ssh_target" ] || [ -z "$compose_file" ] || [ -z "$hermes_service" ] \
  || [ -z "$hermes_home" ] || [ -z "$pwa_url" ] || [ "${#token}" -lt 32 ]; then
  echo "Web Push settings or relay secret are incomplete in $mobile_env." >&2
  exit 1
fi
case "$ssh_target:$compose_file:$hermes_service:$hermes_home" in
  *[!A-Za-z0-9_./:@-]*) echo "Invalid character in remote Docker settings." >&2; exit 2 ;;
esac
case "$pwa_url" in
  https://[A-Za-z0-9._:/-]*) ;;
  *) echo "WEBPUSH_PWA_URL must be a simple HTTPS origin." >&2; exit 2 ;;
esac

remote_tmp=$(ssh "$ssh_target" 'umask 077; mktemp -d')
case "$remote_tmp" in
  /tmp/*|/var/tmp/*) ;;
  *) echo "Remote mktemp returned an unexpected path." >&2; exit 1 ;;
esac
cleanup() {
  ssh "$ssh_target" "rm -rf '$remote_tmp'" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

local_tmp=$(mktemp -d)
trap 'rm -rf "$local_tmp"; cleanup' EXIT HUP INT TERM
mkdir "$local_tmp/plugin"
cp "$script_dir/mobile-push-delivery/__init__.py" \
   "$script_dir/mobile-push-delivery/plugin.yaml" \
   "$local_tmp/plugin/"
printf '%s' "$token" > "$local_tmp/token"
chmod 600 "$local_tmp/token"
scp -q -r "$local_tmp/plugin" "$local_tmp/token" "$ssh_target:$remote_tmp/"
rm -rf "$local_tmp"

ssh "$ssh_target" sh -s -- \
  "$remote_tmp" "$compose_file" "$hermes_service" "$hermes_home" "$pwa_url" <<'REMOTE'
set -eu
remote_tmp=$1
compose_file=$2
hermes_service=$3
hermes_home=$4
pwa_url=$5

container=$(docker compose -f "$compose_file" ps -q "$hermes_service")
if [ -z "$container" ]; then
  echo "Hermes service is not running: $hermes_service" >&2
  exit 1
fi

docker exec -u 0 "$container" mkdir -p \
  "$hermes_home/plugins/mobile-push-delivery"
docker cp "$remote_tmp/plugin/." \
  "$container:$hermes_home/plugins/mobile-push-delivery/"
docker exec -u 0 "$container" \
  chmod 755 "$hermes_home/plugins" \
            "$hermes_home/plugins/mobile-push-delivery"
docker exec -u 0 "$container" \
  chmod 644 "$hermes_home/plugins/mobile-push-delivery/__init__.py" \
            "$hermes_home/plugins/mobile-push-delivery/plugin.yaml"

cat "$remote_tmp/token" | docker exec -i -u 0 \
  -e HERMES_INSTALL_HOME="$hermes_home" \
  -e HERMES_WEB_PUSH_URL="$pwa_url/push/v1/notify" \
  "$container" python3 -c '
import os
from pathlib import Path
import tempfile
import yaml

home = Path(os.environ["HERMES_INSTALL_HOME"])
token = input().strip()

env_path = home / ".env"
env_lines = env_path.read_text().splitlines() if env_path.exists() else []
env_entry = f"HERMES_WEB_PUSH_TOKEN={token}"
env_result = []
replaced = False
for line in env_lines:
    if line.startswith("HERMES_WEB_PUSH_TOKEN="):
        if not replaced:
            env_result.append(env_entry)
            replaced = True
    else:
        env_result.append(line)
if not replaced:
    env_result.append(env_entry)
env_path.write_text("\n".join(env_result) + "\n")
env_path.chmod(0o600)

config_path = home / "config.yaml"
config = yaml.safe_load(config_path.read_text()) if config_path.exists() else {}
if not isinstance(config, dict):
    raise SystemExit("config.yaml root must be a mapping")
hooks = config.setdefault("hooks", {})
outbound = hooks.setdefault("outbound", [])
if not isinstance(outbound, list):
    raise SystemExit("hooks.outbound must be a list")
outbound[:] = [
    target for target in outbound
    if not isinstance(target, dict) or target.get("name") != "mobile-web-push"
]
plugins = config.setdefault("plugins", {})
if not isinstance(plugins, dict):
    raise SystemExit("plugins must be a mapping")
enabled = plugins.setdefault("enabled", [])
if not isinstance(enabled, list):
    raise SystemExit("plugins.enabled must be a list")
if "mobile-push-delivery" not in enabled:
    enabled.append("mobile-push-delivery")
disabled = plugins.get("disabled")
if isinstance(disabled, list):
    plugins["disabled"] = [
        name for name in disabled if name != "mobile-push-delivery"
    ]
entries = plugins.setdefault("entries", {})
entries["mobile-push-delivery"] = {
    "enabled": True,
    "allow_tool_override": False,
}
platforms = config.setdefault("platforms", {})
if not isinstance(platforms, dict):
    raise SystemExit("platforms must be a mapping")
platforms["webpush"] = {
    "enabled": True,
    "gateway_restart_notification": False,
    "home_channel": {
        "platform": "webpush",
        "chat_id": "all",
        "name": "All subscribed devices",
    },
    "extra": {
        "relay_url": os.environ["HERMES_WEB_PUSH_URL"],
    },
}
if isinstance(entries.get("webpush-notify"), dict):
    entries["webpush-notify"]["enabled"] = False

with tempfile.NamedTemporaryFile(
    "w", dir=config_path.parent, delete=False, prefix=".config.", suffix=".tmp"
) as handle:
    yaml.safe_dump(config, handle, sort_keys=False)
    temporary = Path(handle.name)
temporary.chmod(0o600)
temporary.replace(config_path)
'

docker compose -f "$compose_file" restart "$hermes_service"
REMOTE

echo "Hermes Mobile every-turn delivery plugin configured."
