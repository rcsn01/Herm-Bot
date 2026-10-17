# PWA slash commands

## Composer behavior

- Type `/` to discover gateway commands and skills. Type more to filter them.
- Selecting a command inserts it and requests its argument/subcommand options.
- `/model` opens model choices from the current session's `model.options` inventory. Search by model or provider name. The current model is marked when the gateway supplies its identity.
- Selecting a model fills `/model <model> --provider <provider> --session`. It does not execute anything. Press Send to apply the change to this conversation rather than persist a profile default.
- Arrow keys move through suggestions. Enter or Tab selects an option while the list is open. Escape or Close dismisses it. Shift+Enter still inserts a newline, and IME Enter is not intercepted.
- Suggestions remain scrollable above the composer on small screens. Selection returns focus and the caret to the message input.

## Gateway boundary

`Conversation` owns discovery and execution. `ChatInteraction` owns suggestion state, insertion, draft recovery, and submission feedback. `ChatScreen` owns list rendering and keyboard/touch selection.

Completion uses `complete.slash` with the current `session_id`, or `profile` when no session is selected. The gateway supplies `replace_from` for argument insertion. Model choices use `model.options` because the backend completer does not supply dynamic model names. Inventory requests are coalesced and cached for 30 seconds per gateway scope, session, and current model; execution invalidates that cache.

Slash submissions use `slash.exec`, not `prompt.submit`. Only an explicit legacy 4018 redirect saying to use `command.dispatch` permits a second RPC. A `send` or `skill` directive submits the expanded prompt as a model turn while preserving its display text through optimistic rendering and history reconciliation. Legacy skill scaffolding is also projected to its invocation by Transcript when loading history after a reload. Notices remain visible in submission feedback. Alias directives resolve with a bounded recursion limit, and `prefill` directives restore editable text without automatically sending it or overwriting a newer draft. Ordinary command output appears in the composer feedback area without a fake user message or working indicator. Failures are not retried automatically as chat prompts.

Commands run with the gateway's authorization and busy-state rules. The PWA does not execute shell commands locally or bypass backend confirmations.

## Current limits

- Terminal-only commands are rejected with guidance to use Hermes in a terminal.
- Conversation creation, branching, and switching remain in the conversation menu. Their slash spellings are rejected before execution to avoid changing gateway identity without the PWA's selection lifecycle.
- `/help` displays the live command catalog. Commands needing an unsupported client-side interaction or a guarded model confirmation return guidance instead of claiming success.
- This is not full desktop-command parity. Dedicated desktop dialogs and RPC-only actions are not reimplemented here.

## Contract evidence and verification

Inspected NousResearch/hermes-agent at commit `e31c674f7c523070f48f3baad0650c2fdd7ef6e5`:

- `tui_gateway/command_discovery.py`: completion payloads and replacement offsets.
- `tui_gateway/methods_tools.py`: `slash.exec`, legacy dispatch redirects, and dispatch directives.
- `gateway/session_config.py`: session-scoped `model.options`.
- `hermes_cli/model_switch.py`: model/provider/session argument parsing.
- `apps/shared/src/skill-scaffold.ts`: legacy skill-invocation display projection.
- `apps/desktop/src/app/session/hooks/use-prompt-actions/slash.ts`: bare `/model` opens a picker; model arguments execute on the backend.

Unit tests cover completion validation, scope/session changes, model inventory filtering, insertion, failures, execution routing, and draft recovery. `client/e2e/slash-commands.spec.ts` covers discovery through model selection/execution, argument selection, touch focus, keyboard behavior, a small viewport, command failures, guarded changes, skills, and commands during an active model turn in Chromium and WebKit.

Browser tests use a gateway fixture. They do not certify the version or behavior of a deployed gateway, a physical mobile keyboard, or a screen reader.
