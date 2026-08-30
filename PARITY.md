# Hermes Mobile contract-6 parity

This is the authoritative scope and delivery checklist for Hermes Mobile.
“Parity” means that an iPhone or iPad connected to one **remote, unmodified
official Hermes gateway** can complete the gateway-owned workflows below. It
does not mean pixel parity with Desktop, reuse of Desktop navigation, or access
to capabilities that exist only in Electron or on the client machine.

The gateway remains the source of truth. Mobile uses official authenticated HTTP
routes and JSON-RPC methods, preserves profile boundaries, and reports an
explicit unsupported state when a gateway does not advertise an optional
capability. Versioned gateways must advertise contract 6 or newer; unversioned
legacy gateways remain supported. Mobile reports unsupported operations at the
feature that needs them rather than attempting Desktop-only behavior.

## Status and milestones

| Mark | Meaning |
|---|---|
| **Foundation — complete** | Transport, authentication, reconnect, contract negotiation, profile propagation, event reduction, responsive shell, and unsupported states are implemented and tested. |
| **Partial** | A purpose-built workflow exists, but a domain still lacks part of its Desktop surface, advanced lifecycle controls, or the complete mutation/integration test matrix. |
| **Planned** | In parity scope; no adequate mobile workflow exists yet. |
| **Excluded** | Deliberately outside mobile parity. |
| **Complete** | A dedicated, tested mobile workflow covers the full in-scope contract, including relevant mutation, error, profile, reconnect, and unsupported paths. |

Milestones are ordering, not release promises:

- **M0 — foundation:** secure connection/authentication, contract negotiation,
  profile-safe requests, reconnect/reconciliation, responsive shell, and
  truthful unsupported states.
- **M1 — daily work:** chat, sessions, profiles, projects/files/Git/artifacts,
  and model selection.
- **M2 — capabilities:** settings, providers/credentials, skills, toolsets,
  MCP, memory, and plugins inventory.
- **M3 — operations:** messaging, pairing, webhooks, cron, agents, learning,
  analytics, billing, and logs.
- **M4 — administration:** backups, remote updates, and maintenance/lifecycle
  workflows.

“Profile scope” means every request must carry or derive the selected gateway
profile; changing profile invalidates and reloads profile-owned data rather than
blending caches. **Session** means the session identifies its profile and
mutations remain bound to it. **Gateway** means installation-wide data may be
returned, while authorization and any profile filters still come from the
selected connection.

The current primary navigation has four destinations: **Sessions**,
**Capabilities**, **Cron Jobs**, and **Settings**. The former generic Operations
and More surfaces are not separate tabs; their supported workflows are placed
in Cron, Capabilities, Projects, or Settings. The generic authenticated request
form is intentionally not a parity workflow.

## Desktop route accounting

Every core route declared by `apps/desktop/src/app/routes.ts` is accounted for
here. Mobile owns its navigation, so a Desktop URL need not become an iOS URL.

| Desktop route | Mobile mapping | Official route/RPC surface | Profile scope | Milestone | Workflow status |
|---|---|---|---|---|---|
| `/` (new chat) and `/:sessionId` | **Sessions** → Chat | `prompt.submit`, `session.interrupt`, session events/history, `image.attach_bytes`, `file.attach`; HTTP `/api/audio/speak` | Session | M1 | **Partial** — streaming chat, attachments, interrupt, approvals/prompts, TTS, and foreground reconciliation exist; the full Desktop composer/transcript command and media workflow is not yet parity-tested. |
| `/settings` | **Settings** plus dedicated capability/admin screens | `config.set`; `/api/config`, `/api/model/info`, `/api/env`, and domain routes below | Profile; some model controls are profile defaults | M2 | **Partial** — typed configuration sections, model/provider controls, memory, credentials, OAuth, billing, archived chats, and gateway administration are reachable; some administration remains diagnostic or provider-specific. |
| `/command-center` | No command-center clone; supported work is placed in task-specific screens | Domain RPC/HTTP operations and command catalog where appropriate | Profile/session | M2–M4 | **Excluded** — the generic action form was removed rather than presented as a misleading substitute for task workflows. |
| `/skills` | **Capabilities** → Skills, Toolsets, MCP, and related capability screens | `/api/skills`, `/api/tools/toolsets`, `/api/mcp/servers`, `/api/memory`, `/api/dashboard/plugins` | Profile | M2 | **Partial** — installed-skill, hub, toolset, MCP, memory, and plugin workflows exist; not every Desktop/provider-specific maintenance operation is exposed. |
| `/messaging` | **Settings** → Gateways → Messaging | `/api/messaging/platforms` plus official pairing/platform operations | Profile | M3 | **Partial** — a bounded remote inventory is shown; setup, pairing, test delivery, policy, and lifecycle UX remain. |
| `/webhooks` | **Settings** → Gateways → Webhooks | Official `/api/webhooks` collection/item/test operations | Profile | M3 | **Partial** — a bounded remote inventory is reachable; create, rotate, test, and lifecycle controls remain. |
| `/artifacts` | **Settings** → Projects and Files → Artifacts | `/api/files?path=.hermes/artifacts` and official file read/download routes | Profile/project | M1 | **Partial** — remote artifact listing is available; previews, metadata, sharing, provenance, and retention controls remain. |
| `/cron` | **Cron Jobs** | `/api/cron/jobs`, run history, blueprint, delivery-target, pause/resume/run operations | Profile | M3 | **Partial** — list/filter, detail, create/edit, blueprints, delivery targets, pause/resume, run now, run history, and confirmed deletion are implemented; broader scheduler administration and integration coverage remain. |
| `/profiles` | **Settings** → Gateways → Profiles plus the profile picker | `/api/profiles` and official profile/soul operations | Gateway list; mutations target a profile | M1 | **Partial** — selection and a profile-scoped inventory exist; create/edit/clone/delete, souls, and routing workflows remain. |
| `/agents` | **Settings** → Gateways → Agents | `/api/agents` and official delegation/run operations | Profile | M3 | **Partial** — bounded remote inventory only; launch, inspect, control, and result workflows remain. |
| `/starmap` | **Settings** → Gateways → Learning | `/api/learning/graph` and official learning operations | Profile | M3 | **Partial** — the remote learning view is available as a bounded diagnostic; graph/detail/maintenance UI remains. |
| contributed/plugin routes | No renderer mapping | Plugin data and supported generic gateway APIs only | Profile or gateway, per plugin contract | — | **Excluded** — mobile does not execute Desktop plugin-rendered React routes. |

## Remote-domain parity checklist

Route names identify the contract surface, not permission to invent endpoints.
Before implementation, use the contract-6 capability/status response and the same
official routes used by the web/Desktop clients. Optional or newer operations
must show “unsupported,” never silently disappear or be simulated locally.

| Domain and required mobile workflow | Route/RPC | Profile scope | Milestone | Status |
|---|---|---|---|---|
| **Chat:** create/resume, stream, tool activity, approvals/clarification/secrets, interrupt, attachments, audio, errors, reconnect and history reconciliation | JSON-RPC `prompt.submit`, `session.interrupt`, attachment methods and session/event methods; `/api/audio/speak` | Session | M1 | **Partial** |
| **Sessions:** list/search, open, rename, delete, new, branch where supported, running state and durable refresh | Session JSON-RPC plus `/api/sessions` item operations | Profile | M1 | **Partial** — list/open/rename/delete/new/branch and refresh exist; compact and the complete Desktop lifecycle do not. |
| **Profiles:** select without data leakage; list/create/edit/clone/delete; souls and routing | `/api/profiles` and official profile operations | Gateway list / targeted profile | M1 | **Partial** — the picker and bounded inventory are available. |
| **Projects:** list/select project, inspect metadata, bind work/session context | Official project APIs and `/api/fs/default-cwd` | Profile | M1 | **Partial** — Projects is currently a remote path/file/Git surface, not full project management. |
| **Files:** browse/read/preview/download/upload/create/delete/rename safely, including binary and large-file states | `/api/files`, `/api/files/read`, `/api/files/upload`, `/api/files/mkdir` and official item operations | Profile/project | M1 | **Partial** — browse/read/upload/folder creation/download/share/delete exist; rename, richer previews, and large-file UX remain. |
| **Git:** status/diff, branches, stage/unstage, commit, push and create PR with confirmations and useful errors | `/api/git/status`, `/api/git/branches`, `/api/git/review/*` | Profile/project | M1 | **Partial** — review actions and confirmations exist, but output and selection/review UX remain limited. |
| **Artifacts:** list, preview/download/share where supported, provenance and delete/retention | Official artifact/file APIs; current fallback `/api/files?path=.hermes/artifacts` | Profile/project/session | M1 | **Partial** — bounded raw listing only. |
| **Models, providers, credentials and config:** catalog/status, select models, provider setup/test, redacted credential edit/removal, validated config edit | `/api/model/info`, `/api/env`, `/api/config`; JSON-RPC `config.set` | Profile; model defaults apply to new sessions | M1–M2 | **Partial** — model/MoA/auxiliary/fallback controls, typed config, provider OAuth/endpoints, redacted credentials, and memory/provider setup are purpose-built; full account/provider lifecycle remains. |
| **Skills, toolsets, MCP, memory and plugins:** inventory plus install/configure/enable/disable/test/update/remove and provider-specific maintenance where contract-supported | `/api/skills`, `/api/tools/toolsets`, `/api/mcp/servers`, `/api/memory`, `/api/dashboard/plugins` | Profile | M2 | **Partial** — dedicated screens cover the supported operations, but optional/provider-specific maintenance is incomplete. |
| **Messaging and pairing:** platform status, configure credentials/policies, pair/unpair, start/stop/restart and test delivery | `/api/messaging/platforms` and official platform/pairing operations | Profile | M3 | **Partial** — bounded inventory views only. |
| **Webhooks:** list/create/edit/rotate/test/enable/disable/delete and delivery status | Official `/api/webhooks` APIs | Profile | M3 | **Partial** — bounded inventory view only. |
| **Cron:** list/create/edit/pause/resume/run/delete, run history and delivery configuration | `/api/cron/jobs` and official job/run APIs | Profile | M3 | **Partial** — the core job workflow is present; scheduler-wide administration and complete integration coverage remain. |
| **Agents:** list, launch/delegate, inspect progress/results, interrupt and retry | `/api/agents` and official agent/delegation methods | Profile/session | M3 | **Partial** — bounded inventory only. |
| **Learning:** graph/detail, controls and maintenance supported by the gateway | `/api/learning/graph` and official learning APIs | Profile | M3 | **Partial** — bounded graph/diagnostic view only. |
| **Analytics:** useful usage breakdowns by time/model/provider/skill and cost where available | `/api/analytics/usage` and official analytics APIs | Profile or authorized gateway aggregate | M3 | **Partial** — bounded remote response view only. |
| **Billing:** plan/entitlement/limits/usage and official billing-management handoff where configured | Official contract-6 billing/entitlement APIs | Account/gateway; never inferred across profiles | M3 | **Partial** — billing state, portal handoff, and preview-before-change are present where advertised; full provider lifecycle remains. |
| **Logs:** filter/tail/download by source/level/session with bounded payloads and redaction | `/api/logs` and official log stream/download APIs | Profile unless explicitly fleet-authorized | M3 | **Partial** — bounded remote response view only. |
| **Backups:** capability/status, create/export/import/restore with explicit destructive confirmations and progress | `/api/ops/backup` and official backup/import APIs | Profile; fleet operations explicitly identified | M4 | **Planned** |
| **Updates:** plan, preflight, apply, progress, fleet restart/verification and receipt; never update the iOS app through Hermes | Official remote update/receipt APIs advertised by contract 6 | Gateway/fleet | M4 | **Planned** |
| **Maintenance:** health/version, gateway lifecycle, diagnostics and supported repair/cleanup actions | `/api/status` and official lifecycle/maintenance APIs | Gateway/fleet, authorization-gated | M4 | **Partial** — health, version, reconnect, and connection administration exist; repair and lifecycle actions remain. |

## Explicit exclusions

These are not parity gaps:

- Installing or running a local Hermes runtime, model, terminal, PTY, browser,
  filesystem, Git checkout, gateway, or agent on iOS.
- Electron lifecycle/updater behavior, local backend spawning, multi-window
  controls, pet overlays, marketplace themes, tray/menu integration, and OS
  reveal/open actions.
- APNs, background push delivery, or background execution. Remote work
  continues on the gateway; foreground resume reconnects and reconciles gateway
  truth.
- Desktop plugin-rendered routes or arbitrary plugin React/HTML execution.
  Supported plugin data and generic gateway administration may still be shown
  through native mobile UI.

## Completion gate

A row may move to **Complete** only when it has a purpose-built mobile workflow,
contract-6 compatibility/unsupported handling, profile-isolation coverage,
mutation confirmation and error states, reconnect/reconciliation behavior where
relevant, and tests at the appropriate controller/component/native boundary.
Merely adding a Remote list entry, rendering JSON, or exposing the generic
authenticated request form remains **Partial**.
