# Changelog

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
