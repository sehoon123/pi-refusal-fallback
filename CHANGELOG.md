# Changelog

## 0.5.0

### Removed

- **`carryPartial: "always"`.** Partial output is now handed over only to a model on a different provider (`cross-provider`) or not at all (`off`, the default). In a gateway test, a Claude answer sent back to Claude was blocked as "duplicating model outputs" (2 of 2, before any output; the same prompt without the notes was answered 14 of 14 times), so the same-provider handoff could only cost an extra request.
- Existing files with `"always"` keep working: the value is read as `cross-provider`, a warning is shown at start-up, after `reload` and in `status`, and the next setup save rewrites the file (even without other changes).

### Changed

- The Options screen offers `off` and `cross-provider` and explains why same-provider handoff is not offered.
- 138 offline tests on Pi 1.2.0 and 1.4.0.

## 0.4.0

### Added

- **Partial output handoff** (`carryPartial`: `off` | `cross-provider` | `always`, default `off`). When a response is cut off by a refusal, its visible reasoning and answer text can be passed to the next model as clearly labelled, untrusted notes. `cross-provider` passes them only when the next model uses a different provider id.
  - Appended to the single next request only, newest interruption only, capped at 8,000 / 4,000 characters (newest part kept), delimiter-safe, never written to the session. Redacted reasoning, signed reasoning blocks and unexecuted tool calls are not passed.
  - **Withdrawal:** if the model that received notes refuses before writing anything, it is retried once without them before the chain moves on. Found in a real gateway test where Claude -> Claude handoff was blocked as "duplicating model outputs".
  - Setup editor: new choice setting in Options with an explanation of the highlighted value; page-by-page setup and `/refusal-fallback status` show it; the transcript notice, last-run summary and session metadata (counts only) record when notes were passed or rejected.
- 135 offline tests; the real-terminal test also covers the new setting.

## 0.3.0


### Fixed

- **`/refusal-fallback setup` could not scroll.** Pi's built-in `select` draws every option with no viewport (terminal), and pi-web renders custom components into a plain text block, so with dozens of models the highlighted row left the screen and the list never followed it. Reproduced in a real `pi` TUI (25 x Down made the cursor vanish) and fixed with a dedicated editor that always draws a bounded window around the highlighted row.
- **Double Enter.** Argument completion kept a one-item popup open after a subcommand was fully typed, so the first Enter was swallowed. A fully typed subcommand now runs immediately.
- The save message claimed a `.bak` file was kept even on a first save. It now says so only when a previous file existed.
- The footer kept a stale `fallback completed` text after every clean run; it is now cleared, and unusual endings use a plain-language status.

### Changed

- **Retry notices are never sent to a model.** They were custom messages that Pi converts to a trailing pseudo-user message; with a terse notice a model could treat it as the latest request. A `context` handler now removes them from every provider request (including notices stored by earlier versions). `retryMessages` therefore only controls whether the one-line notice is shown.
- The notice names the model that declined and the model being tried, and renders as one compact line in the terminal UI instead of a duplicated header with blank lines.

### Added

- Setup editor with four sections (Models, Order, Options, Review): fuzzy search, add/remove, pick-up-and-move ordering with undo, option toggles, a final review, `Ctrl+S`, discard confirmation, mouse wheel/click support, and a starting point equal to your current configuration (entries that are temporarily unavailable are kept until you remove them).
- Page-by-page fallback (seven choices per page) for clients that cannot host custom components.
- `/refusal-fallback` argument completion; the status output lists the configuration file and the setup hint.
- `npm run test:e2e`: drives the real `pi` TUI in a private tmux server (its own socket; never the default server).
- 101 offline tests (Pi 1.2.0 and 1.4.0), including windowing at many catalog sizes and widths.

## 0.2.0


### Stability

- Narrow refusal classification: connection/proxy/authentication refusals and generic policy text no longer trigger model fallback. Ignore stale metadata on pending, aborted and tool-executing messages.
- Track model-selection ownership and respect explicit model/thinking changes, including changes racing an awaited fallback switch or final restoration. Report bounded recovery failure instead of looping.
- Respect an earlier extension's continuation. Refuse to fabricate new input when no runnable user/tool context remains.
- Report restoration failure and chain exhaustion explicitly. Preserve final refusal/error semantics.
- Validate UTF-8, regular-file type, a 64 KiB configuration limit and a 128-entry chain limit. Deduplicate once and use collision-free model keys.

### UI/UX

- Compact, deduplicated lifecycle progress in TUI/RPC status.
- Rich status: catalog/auth readiness, skip reasons, recent outcome, duration and restoration state; minimal non-context session summaries survive reload.
- `/refusal-fallback reload` applies configuration while idle without restarting all extensions.
- `/refusal-fallback setup` provides ordered authenticated-model selection, undo/cancel, confirmation, atomic private save and backup. Overlapping dialogs in one runtime are blocked; no writes occur on cancellation. Cross-process config saves remain last-writer-wins.
- Optional `retryMessages`, `showStatus` and `notifications` settings, defaulting to the previous visible behavior. Critical failures remain visible.

### Performance and verification

- Quiet mode avoids retry-notice transcript/context growth while retaining real continuation and status.
- No polling, timers, extra model calls or per-token stream hooks. Configuration is loaded only at startup or explicit reload/setup.
- 62 offline configuration, UI, lifecycle and native loopback HTTP tests, with Pi 1.2.0/1.4.0 compatibility checks.
- Real CLI validation covers a four-model chain with three consecutive fallback steps, including quiet mode. Synthetic refusal events are injected only after genuine upstream responses; no private model presets, credentials or live artifacts are shipped.

## 0.1.0

- Initial user-configurable, bounded fallback package.
- JSON/environment configuration, read-only status command, cancellation handling and original model/thinking restoration.
- Native HTTP and SDK regression coverage for chained refusals and exhaustion.
