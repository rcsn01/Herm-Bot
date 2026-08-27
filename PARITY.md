# Hermes Mobile contract-6 parity

This is the authoritative scope and delivery checklist for Hermes Mobile. “Parity” means that an iPhone or iPad connected to one **remote, unmodified official Hermes gateway** can complete the gateway-owned workflows below through backend contract 6 or newer. It does not mean pixel parity with Desktop, reuse of Desktop navigation, or access to capabilities that exist only in Electron or on the client machine.

The gateway remains the source of truth. Mobile must use official authenticated HTTP routes and JSON-RPC methods, preserve profile boundaries, and degrade explicitly when a contract-6 gateway does not advertise an optional capability. A raw JSON response or generic API request form is useful diagnostic scaffolding, but it is **not a completed workflow**.

## Status and milestones

| Mark | Meaning |
|---|---|
| **Foundation — in progress** | Transport, authentication, reconnect, contract negotiation, profile propagation, event reduction, and shared mobile UI primitives are still being hardened. |
| **Partial** | Some route/RPC access or UI exists, but the end-to-end user workflow is incomplete, raw, or insufficiently tested. |
| **Planned** | In parity scope; no adequate mobile workflow exists yet. |
| **Excluded** | Deliberately outside mobile parity. |
| **Complete** | A dedicated, tested mobile workflow covers read and relevant mutation/error/reconciliation paths. No domain currently earns this label. |

Milestones are ordering, not release promises:

- **M0 — foundation:** secure connection/authentication, contract 6 negotiation, profile-safe requests, reconnect/reconciliation, responsive shell, and truthful unsupported states.
- **M1 — daily work:** chat, sessions, profiles, projects/files/Git/artifacts, and model selection.
- **M2 — capabilities:** settings, providers/credentials, skills, toolsets, MCP, memory, and plugins inventory.
- **M3 — operations:** messaging, pairing, webhooks, cron, agents, learning, analytics, billing, and logs.
- **M4 — administration:** backups, remote updates, and maintenance/lifecycle workflows.

“Profile scope” below means every request must carry or derive the selected gateway profile; changing profile must invalidate/reload profile-owned data rather than blend caches. **Session** means the session identifies its profile and mutations remain bound to it. **Gateway** means installation-wide data may be returned, while authorization and any profile filters still come from the selected connection.

## Desktop route accounting

Every core route declared by `apps/desktop/src/app/routes.ts` is accounted for here. Mobile owns its navigation, so a Desktop URL need not become an iOS URL.

| Desktop route | Mobile mapping | Official route/RPC surface | Profile scope | Milestone | Workflow status |
|---|---|---|---|---|---|
| `/` (new chat) and `/:sessionId` | **Chat** tab; new or resumed conversation | `prompt.submit`, `session.interrupt`, session events/history, `image.attach_bytes`, `file.attach`; HTTP `/api/audio/speak` | Session | M1 | **Partial** — streaming chat, attachments, interrupt, approvals/prompts, TTS, and foreground reconciliation exist, but the full Desktop composer/transcript command and media workflow is not yet parity-tested. |
| `/settings` | **Settings** plus dedicated capability/admin screens | `config.set`; `/api/config`, `/api/model/info`, `/api/env`, and domain routes below | Profile; connection preferences are device-local | M2 | **Partial** — profile picker and a few per-session controls exist; broad settings are only raw remote data/actions. |
| `/command-center` | No command-center clone; workflows are placed in task-specific mobile screens | Domain RPC/HTTP operations and command catalog where appropriate | Profile/session | M2–M4 | **Planned** — the old generic API action form has been removed; each mutation still needs its task-specific workflow. |
| `/skills` | **Capabilities** → Skills/Toolsets/MCP/Memory/Plugins | `/api/skills`, `/api/tools/toolsets`, `/api/mcp/servers`, `/api/memory`, `/api/dashboard/plugins` | Profile | M2 | **Partial** — inventories can be loaded as raw data; install/configure/enable/test/remove workflows are not complete. |
| `/messaging` | **Operations** → Messaging | `/api/messaging/platforms` plus official pairing/platform operations | Profile | M3 | **Partial** — raw platform inventory only; setup, pairing, test, policy, and lifecycle UX remain. |
| `/webhooks` | Future **Webhooks** workflow | Official `/api/webhooks` collection/item/test operations | Profile | M3 | **Planned** — not presently exposed as a dedicated or seeded raw view. |
| `/artifacts` | **Projects → Artifacts** | `/api/files?path=.hermes/artifacts` and official file read/download routes | Profile/project | M1 | **Partial** — raw listing exists; previews, metadata, share/download, and artifact lifecycle are incomplete. |
| `/cron` | **Operations** → Cron | `/api/cron/jobs` and official job/run operations | Profile | M3 | **Partial** — job listing, recent run history, pause/resume, manual trigger, and delete are available; create/edit, blueprints, and delivery-target editing remain. |
| `/profiles` | **More** → Profiles plus the profile picker | `/api/profiles` and official profile/soul operations | Gateway list; mutations target a profile | M1 | **Partial** — selection exists and sessions remain scoped; create/edit/clone/delete/soul/routing workflows remain. |
| `/agents` | **Operations** → Agents | `/api/agents` and official delegation/run operations | Profile | M3 | **Partial** — raw inventory only; launch, inspect, control, and result workflows remain. |
| `/starmap` | **More** → Learning | `/api/learning/graph` and official learning operations | Profile | M3 | **Partial** — raw graph response only; usable graph/detail/maintenance UI remains. |
| contributed/plugin routes | No renderer mapping | Plugin data and supported generic gateway APIs only | Profile or gateway, per plugin contract | — | **Excluded** — mobile does not execute Desktop plugin-rendered React routes. |

## Remote-domain parity checklist

Route names identify the contract surface, not permission to invent endpoints. Before implementation, use the contract-6 capability/status response and the same official routes used by the web/Desktop clients. Optional or newer operations must show “unsupported,” never silently disappear or be simulated locally.

| Domain and required mobile workflow | Route/RPC | Profile scope | Milestone | Status |
|---|---|---|---|---|
| **Chat:** create/resume, stream, tool activity, approvals/clarification/secrets, interrupt, attachments, audio, errors, reconnect and history reconciliation | JSON-RPC `prompt.submit`, `session.interrupt`, attachment methods and session/event methods; `/api/audio/speak` | Session | M1 | **Partial** |
| **Sessions:** list/search, open, rename, delete, new, compact/fork where supported, running state and durable refresh | Session JSON-RPC plus `/api/sessions` item operations | Profile | M1 | **Partial** — list/open/rename/delete and refresh exist; the full lifecycle does not. |
| **Profiles:** select without data leakage; list/create/edit/clone/delete; souls and routing | `/api/profiles` and official profile operations | Gateway list / targeted profile | M1 | **Partial** |
| **Projects:** list/select project, inspect metadata, bind work/session context | Official project APIs and `/api/fs/default-cwd` | Profile | M1 | **Partial** — the current “Projects” tab is principally a path-based file browser, not project management. |
| **Files:** browse/read/preview/download/upload/create/delete/rename safely, including binary and large-file states | `/api/files`, `/api/files/read`, `/api/files/upload`, `/api/files/mkdir` and official item operations | Profile/project | M1 | **Partial** — basic browse/read/upload/mkdir/delete exists. |
| **Git:** status/diff, branches, stage/unstage, commit, push and create PR with confirmations and useful errors | `/api/git/status`, `/api/git/branches`, `/api/git/review/*` | Profile/project | M1 | **Partial** — several mutations exist, but output is raw and review/diff/selection safety is incomplete. |
| **Artifacts:** list, preview/download/share where supported, provenance and delete/retention | Official artifact/file APIs; current fallback `/api/files?path=.hermes/artifacts` | Profile/project/session | M1 | **Partial** — raw file response only. |
| **Models, providers, credentials and config:** catalog/status, select models, provider setup/test, redacted credential edit/removal, validated config edit | `/api/model/info`, `/api/env`, `/api/config`; JSON-RPC `config.set` | Profile; some model overrides are session-scoped | M1–M2 | **Partial** — a few session settings and raw reads exist. |
| **Skills, toolsets, MCP, memory and plugins:** inventory plus install/configure/enable/disable/test/update/remove and provider-specific maintenance where contract-supported | `/api/skills`, `/api/tools/toolsets`, `/api/mcp/servers`, `/api/memory`, `/api/dashboard/plugins` | Profile | M2 | **Partial** — raw views only. Plugin-rendered routes remain excluded. |
| **Messaging and pairing:** platform status, configure credentials/policies, pair/unpair, start/stop/restart and test delivery | `/api/messaging/platforms` and official platform/pairing operations | Profile | M3 | **Partial** — raw inventory only. |
| **Webhooks:** list/create/edit/rotate/test/enable/disable/delete and delivery status | Official `/api/webhooks` APIs | Profile | M3 | **Planned** |
| **Cron:** list/create/edit/pause/resume/run/delete, run history and delivery configuration | `/api/cron/jobs` and official job/run APIs | Profile | M3 | **Partial** — list, recent history, pause/resume, run, and delete are implemented; create/edit, blueprints, and delivery configuration remain. |
| **Agents:** list, launch/delegate, inspect progress/results, interrupt and retry | `/api/agents` and official agent/delegation methods | Profile/session | M3 | **Partial** — raw inventory only. |
| **Learning:** graph/detail, controls and maintenance supported by the gateway | `/api/learning/graph` and official learning APIs | Profile | M3 | **Partial** — raw graph only. |
| **Analytics:** useful usage breakdowns by time/model/provider/skill and cost where available | `/api/analytics/usage` and official analytics APIs | Profile or authorized gateway aggregate | M3 | **Partial** — raw response only. |
| **Billing:** plan/entitlement/limits/usage and official billing-management handoff where configured | Official contract-6 billing/entitlement APIs | Account/gateway; never inferred across profiles | M3 | **Planned** |
| **Logs:** filter/tail/download by source/level/session with bounded payloads and redaction | `/api/logs` and official log stream/download APIs | Profile unless explicitly fleet-authorized | M3 | **Partial** — raw response only. |
| **Backups:** capability/status, create/export/import/restore with explicit destructive confirmations and progress | `/api/ops/backup` and official backup/import APIs | Profile; fleet operations explicitly identified | M4 | **Partial** — raw capability/action form only. |
| **Updates:** plan, preflight, apply, progress, fleet restart/verification and receipt; never update the iOS app through Hermes | Official remote update/receipt APIs advertised by contract 6 | Gateway/fleet | M4 | **Planned** |
| **Maintenance:** health/version, gateway lifecycle, diagnostics and supported repair/cleanup actions | `/api/status` and official lifecycle/maintenance APIs | Gateway/fleet, authorization-gated | M4 | **Partial** — status/raw actions only. |

## Explicit exclusions

These are not parity gaps:

- Installing or running a local Hermes runtime, model, terminal, PTY, browser, filesystem, Git checkout, gateway, or agent on iOS.
- Electron lifecycle/updater behavior, local backend spawning, multi-window controls, pet overlays, marketplace themes, tray/menu integration, and OS reveal/open actions.
- APNs, background push delivery, or background execution. Remote work continues on the gateway; foreground resume reconnects and reconciles gateway truth.
- Desktop plugin-rendered routes or arbitrary plugin React/HTML execution. Supported plugin data and generic gateway administration may still be shown through native mobile UI.

## Completion gate

A row may move to **Complete** only when it has a purpose-built mobile workflow, contract-6 compatibility/unsupported handling, profile-isolation coverage, mutation confirmation and error states, reconnect/reconciliation behavior where relevant, and tests at the appropriate controller/component/native boundary. Merely adding a Remote list entry, rendering JSON, or exposing the generic authenticated request form must remain **Partial**.
