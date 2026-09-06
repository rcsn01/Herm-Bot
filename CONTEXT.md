# Hermes Mobile — Domain Glossary

Terms used across `apps/mobile`. Add new concepts here when a refactor names something that didn't have a word.

- **Gateway** — the remote Hermes backend the app talks to (JSON-RPC over WebSocket for prompts/events, native HTTP for REST/uploads). Identified by a `remoteURL` + `profile` pair.
- **Profile** — an isolated Hermes instance on the gateway; the app scopes all state and queries to one profile at a time.
- **Scope** — the (connection, profile) pair captured when an async operation starts; results from a stale scope are discarded.
- **GatewaySession** — the deep module between `GatewayController` and the wire. Owns both transports (WebSocket JSON-RPC client + native HTTP plugin), error classification, scope/epoch guarding, and the session lifecycle (open, resume, create, branch, history). Interface: `GatewayPort` plus the session lifecycle methods.
- **Gateway API (profile-bound)** — the deep module between the feature API modules and the wire. `createGatewayApi(gateway, profile)` binds a GatewayPort to the active Profile and owns profile-path derivation (`?profile=` on scoped routes), response unwrapping, the deliberately-unscoped route tier (billing RPCs, `/api/actions/{name}/status`, OAuth flow/poll, `/api/status`), and the default-profile gate. Feature APIs (`createCronApi(api)`, `createSettingsApi(api)`, …) are thin route vocabulary over it; Scope staleness and error classification stay with the GatewaySession.
- **RuntimeSession** — a live session handle returned by the gateway (`session_id` + `stored_session_id` + contract info).
- **Transcript** — the rendered message list for a session, projected from gateway `SessionMessage`s via `toTranscript`.
- **Chat state (`$chat`)** — the nanostores atom holding the active session's transcript, running flag, pending prompt, and history paging.
- **Session bookmark** — the per-scope localStorage pointer to the last opened durable session.
- **Scoped operation** — an async operation that captures the Scope when it starts and discards its effects if the Scope changed before it lands. `gateway/scope-guard.ts` owns capture (`currentGatewayScope()`) and the staleness check (`isCurrentGatewayScope()`); callers place their own checks around the effects that must be discarded, since commit/cleanup/retry/error policy differs by call site.
- **Epoch counter** — a local generation guard a module uses to invalidate its own in-flight work (e.g. the GatewayController's reconnect lifecycle, the DeepLinkCoordinator's pending intents). Distinct from the global Scope generation, which tracks connection/profile changes.