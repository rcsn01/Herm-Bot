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


## Local message drafts

Herm stores ordinary composer text, edit text, completed or interrupted attachment
metadata, and failed or unconfirmed submission snapshots in this origin's
`localStorage`. These records are not encrypted and are accessible to other
scripts on the same origin. Do not use local draft recovery as a secure backup.

Persistent recovery requires a gateway identity with stable organization and
user IDs. Records also include the gateway, profile, and conversation identity.
Gateways without that identity use memory-only drafts and display a warning.
Account-aware session bookmarks use a new namespace; old account-blind bookmarks
are not imported. Authentication changes retire pending callbacks.

Logout removes this account's draft records locally even if remote sign-out
fails. Browser storage restrictions can prevent writes or removal, so a device
with unavailable storage cannot guarantee restart recovery or physical deletion.
Clear site data through the browser when handing a device to someone else.
Logout also removes this account's transcript snapshots. Authentication expiry
locks both stores and clears the private workspace without deleting recoverable
records. Another tab's owner lock retires transcript memory and invalidates late
history writes.

Files, audio recordings, credentials, secret responses, and administrator-password
responses are not stored by draft recovery. Attachment names and references are
stored, but require file selection again after a page restart or runtime change.
Normal message text can itself contain sensitive information; draft storage does
not detect or redact secrets users paste into the ordinary composer.

Draft storage is limited to 50 conversation records and 1 MiB of serialized UTF-8
data per account. Exceeding a limit keeps new work in memory and warns the user;
it does not silently evict older unfinished messages. Pending or unconfirmed
submissions are never retried automatically. Check conversation history before
sending a recovered message again.

## Saved conversation history

`hermes.transcript.v2:` records include the verified gateway and organization/user
principal, nullable profile, stored conversation ID, title, source, start time
when known, last successful synchronization time, and up to 80 projected rows.
Null profiles do not collide with a profile literally named `default`. The
account-blind v1 cache is removed and is never imported or displayed, even when
its removal fails.

Each owner's cache is limited to 20 conversations and 2 MiB of serialized UTF-8
persistent data including keys. Oldest synchronized snapshots are evicted first;
draft records are never evicted by history storage. An individually oversized
snapshot remains in memory without truncating its messages. Storage denial or
quota failure does not imply that history or drafts will survive a restart.
History records are not encrypted. Treat normal message text and tool output as
private data accessible to scripts on this origin.

Persistent history cannot be read until identity verification in the current
app lifetime. A warm verified workspace remains readable during ordinary network
failure; cold offline startup remains locked. Gateways without a stable principal
use memory only. Cached content and last-known model/usage values are not live
agent status, delivery receipts, or authority to edit remote history. Reconnect
never sends a message. Send becomes available only after authoritative history
reconciliation, and the user must invoke it intentionally.

Runtime IDs, active turns, pending approvals, secret/sudo responses, credentials,
and optimistic or incomplete streaming results are not persisted as confirmed
history. Private API responses, drafts, and transcript snapshots are not stored
in service-worker caches. User-facing Clear local data and a persistent-history
preference remain separate work; use browser site-data deletion before sharing a
device when local removal cannot be confirmed.
