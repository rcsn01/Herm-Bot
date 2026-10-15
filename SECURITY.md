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

Persistent recovery requires an authenticated gateway identity with a stable
user ID. Organization accounts use organization/user IDs. Gateway-local accounts
with an explicitly empty organization use provider/user IDs in a distinct local
namespace. Missing organization fields or incomplete local identities remain
memory-only. Records also include the gateway, profile, and conversation identity.
Gateways without that identity use memory-only drafts and display a warning.
Account-aware session bookmarks use a new namespace; old account-blind bookmarks
are not imported. Authentication changes retire pending callbacks.

Logout removes this account's draft records locally even if remote sign-out
fails. Browser storage restrictions can prevent writes or removal, so a device
with unavailable storage cannot guarantee restart recovery or physical deletion.
Clear site data through the browser when handing a device to someone else.
Logout also removes this account's transcript snapshots and all-profile session bookmarks. Authentication expiry
locks both stores and clears the private workspace without deleting recoverable
records. Another tab's owner lock retires transcript memory and invalidates late
history writes.

Files, audio recordings, credentials, secret responses, and administrator-password
responses are not stored by draft recovery. Attachment names and references are
stored, but require file selection again after a page restart or runtime change.
Normal message text can itself contain sensitive information; draft storage does
not detect or redact secrets users paste into the ordinary composer.

Newly selected supported raster images can have local object-URL previews. These
URLs are not saved, fetched from gateway reference strings, or restored after a
reload. Removal and context retirement release them. Speech audio and late
transcription results remain in memory. A late result enters ordinary draft
storage only when explicitly inserted. Read-aloud audio stops when the chat workspace or
document is hidden. Local cancellation retires callbacks and requests but does not
promise server rollback, uploaded-file deletion, or cancellation of queued prompts.
An attachment becomes ready only after a nonempty gateway reference is returned.

Draft storage is limited to 50 conversation records and 1 MiB of serialized UTF-8
data per account. Exceeding a limit keeps new work in memory and warns the user;
it does not silently evict older unfinished messages. Pending or unconfirmed
submissions are never retried automatically. Check conversation history before
sending a recovered message again.

## Answer and code copying

Answer and code copying writes plain text to the system clipboard only after an
explicit click or keyboard action. Answer copying includes the source Markdown;
code copying excludes prose, fence markers, and controls. Streaming copies capture
the text at click time. No clipboard reads, HTML clipboard output, payload logging,
or new persistence are used by these controls.

Clipboard failures expose the captured text in a labelled, selectable field for
manual copying. That fallback and copy feedback remain in memory and retire on
workspace/context changes, logout, or local-data clearing. Clearing local app data
does not clear the system clipboard, and an already-issued platform clipboard write
cannot be recalled. Other apps or clipboard managers may retain copied text.

## Notification setup and ownership

Relay registrations are versioned and bound to an opaque hash of a server-verified
gateway/account identity. Browser-provided owner headers are not trusted. Cookie
or session-token credentials are forwarded only to the configured fixed gateway's
`/api/auth/me`; unavailable or malformed identity fails closed. The completion
bridge verifies its own owner before fanout. Legacy ownerless subscriptions remain
inactive until explicitly re-enabled, without changing VAPID keys.

Registration status, replacement, binding-specific deletion and test sends enforce
owner isolation inside the relay as well as proxy authentication. Tests target one
stored binding, never an arbitrary submitted URL, and contain fixed nonsensitive
text with app-root navigation. Provider acceptance is not a delivery receipt.
Vendor-owned push HTTPS destinations are allowlisted; arbitrary/local targets and
custom ports are rejected. The Web Push transport does not follow redirects. Raw
provider diagnostics are not returned to clients. Mutation routes require exact
configured app Origin and JSON content type, bounded bodies and no-store responses.
Tests have bounded concurrency, per-account cooldown and short-lived idempotency
records. Restart/crash uncertainty means exactly-once delivery is not guaranteed.

Client operations capture owner/gateway/privacy generation and retire stale
publication and cleanup. Subscription state is browser-wide, not per bot.
Logout does not revoke an already registered OS subscription; users can explicitly
disable it. Normal completion content may still include response previews, unlike
the fixed test payload. OS notifications already shown cannot be recalled by logout.
Session notification links require authenticated relay-owner verification before
profile/exact-ID resume. Missing provenance falls back to root; failed, stale or
superseded selection cannot authorize navigation. Worker messages must come from
the controlling same-origin worker, and clicks use one existing or cold window.

No test receipt telemetry, native APNs, persistent client discovery index, new
credentials, or automatic notification sends are added. Container health does not
establish gateway identity, bridge readiness or real device delivery.

## Conversation discovery

Session search matches loaded titles only, not message bodies or a verified
complete remote history. Row previews are gateway-provided plain text, never
Markdown or executable HTML. The list does not prefetch transcript bodies for
previews. Search terms and new discovery feedback stay in memory and reset on
owner, gateway, profile, authentication-generation, and local privacy changes.
Offline discovery uses only the existing owner/profile-scoped saved snapshots;
excerpt length and save time are not represented as full remote history metadata.

Archive discovery uses the existing profile-bound HTTP request for up to 100
rows. Remote search, complete archive pagination, and direct archived resume are
not established by the repository's client contracts. Restore and open explicitly
restores before using the normal selection path; restore acknowledgement alone
does not authorize navigation. Pending operations cannot navigate after page or
scope retirement, or over a superseding selection. A remote mutation already
issued may still finish after departure; it cannot be recalled by hiding the UI.
No new discovery index, query persistence, or offline archive cache is added.

## Saved conversation history

`hermes.transcript.v2:` records include the verified gateway and organization/user
principal (or gateway-local provider/user principal), nullable profile, stored conversation ID, title, source, start time
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
in service-worker caches.

## Local privacy controls

Settings > Privacy is available during connection interruptions. Its controls
cover regular chats, not the separate shared group-room store.

"Save conversation history on this device" applies to the browser origin or
native WebView installation, across all accounts, gateways, and profiles. It is
on by default when no choice has been saved. Turning it off disables persistent
history reads/writes and removes existing `hermes.transcript.v2:` and legacy v1
history, including malformed history records. Verified in-memory history stays
readable until the app closes. Turning it on saves future authoritative
synchronizations, not an automatic dump of previously visited memory history.
An unreadable privacy preference disables history saving rather than granting
storage access. Removal or preference-write failures are reported separately
from successful changes.

Draft recovery is independent of history saving. Turning history off does not
remove drafts, attachment metadata, session bookmarks, or credentials. Use sign
out or Clear local data to remove this account's regular-chat drafts.

"Clear local data" requires confirmation and removes the currently verified
account's regular-chat history, ordinary/edit/provisional drafts, attachment
metadata, submission/conflict recovery records, and bookmarks across every
profile on the current gateway. Its scope excludes other accounts/gateways,
preferences, authentication, notifications, remote conversations, and remotely
running agents. Principal-less connections can clear their current memory only.
Active local turns, approvals, submissions, uploads, and transcription must finish
or be resolved before confirming. Cancel does not change data.

Clear retires local operations and resets the selected conversation without
signing out or navigating away from Privacy. Connection recovery can re-establish
the transport, but it does not restore or create a conversation after clearing.
Explicitly opening a conversation can load remote history again and save new
snapshots if history saving is enabled. Other tabs showing the account reset
their views; they do not sign out or delete new work created after the reset.

`hermes.privacy.v1` stores the installation-wide policy.
`hermes.privacy.reset.v1:` markers contain only the owner key and a random reset
revision. Draft/history records and post-reset bookmarks carry that revision,
so undeleted old records, delayed storage events, and stale callbacks cannot
restore pre-reset content. Markers remain after clearing to protect against
stale tabs. They do not contain conversation text or credentials.

Storage restrictions can prevent enumeration, marker publication, preference
writes, or deletion. A partial result is not confirmation of removal. Retry,
close other tabs, and use browser site-data deletion before sharing a device
when removal cannot be confirmed. Failed preference writes disable history in
the current process but cannot guarantee that choice survives restart or reaches
other tabs. These controls do not promise physical secure erasure or protection
against other scripts on the origin.

Group-room working copies use `hermes.group-chats.v4` and older migration keys.
They are shared rather than account-scoped and remain outside these controls,
including regular-chat history opt-out and sign-out cleanup. Use browser site-data
deletion for a full local reset. Account-scoping group persistence requires a
separate migration; current-account cleanup must not silently delete every
account's group logs. Native WebView storage is separate from browser storage;
clearing one installation does not clear the other or reset native credentials.
