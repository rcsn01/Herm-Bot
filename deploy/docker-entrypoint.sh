#!/bin/sh
set -eu
/usr/local/bin/hermes-gateway.sh write /tmp/hermes-gateway.conf
if [ "$#" -eq 0 ]; then
  set -- nginx -g 'daemon off;'
fi
if [ -x /docker-entrypoint.sh ]; then
  exec /docker-entrypoint.sh "$@"
fi
exec "$@"
