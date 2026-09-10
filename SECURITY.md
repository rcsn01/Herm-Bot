# Security policy

Hermes Mobile is a client and deployment layer for a Hermes Agent gateway. It
must not receive gateway credentials, OAuth secrets, Cloudflare credentials, or
VAPID private keys in source, issues, pull requests, browser bundles, or logs.

## Reporting a vulnerability

Do not open a public issue for a security vulnerability. Report it privately
through the [Nous Research security contact](https://github.com/NousResearch/hermes-agent/security/policy).
Include the affected commit or release, deployment mode, reproduction steps,
and the smallest useful log or request example. Redact tokens, cookies,
subscription keys, and private URLs.

The mobile container is not an authentication boundary. Keep it behind a TLS
reverse proxy or private network and keep Hermes gateway authentication enabled.
The Docker proxy accepts a fixed upstream configured by the operator; it must
never be changed from a request header, query parameter, or cookie.
