# pi-refusal-fallback

[![CI](https://github.com/sehoon123/pi-refusal-fallback/actions/workflows/ci.yml/badge.svg)](https://github.com/sehoon123/pi-refusal-fallback/actions/workflows/ci.yml)

A [Pi](https://pi.dev) extension that retries a provider-refused turn on an **explicitly user-configured, ordered model chain**.

**No providers or model IDs are built in. No configuration means no automatic fallback.** You choose the initial model normally in Pi and choose your own fallback models separately. Each provider still applies its own policies and authentication requirements; this extension does not override them.

[한국어 문서](README.ko.md)

## Install

```sh
pi install git:github.com/sehoon123/pi-refusal-fallback@v0.5.0
```

Then run `/reload` in an existing session. Do not load both this package and an older standalone `refusal-fallback.ts`: move the old copy outside Pi's auto-loaded extensions directory before switching to the package.

Requires Node.js 22.19+ and a Pi host supporting actionable `agent_before_settle` boundaries. Automated compatibility checks target Pi **1.2.0 and 1.4.0**. This package uses the Pi-supplied peer modules and has no runtime npm dependencies.

## Choose your models

The quickest way is the built-in editor. Run this in Pi's terminal UI or in pi-web:

```text
/refusal-fallback setup
```

```text
Fallback model setup   ● unsaved changes
[Models]  Order (2)   Options   Review
Filter: son▌   2/63
→ [1]   ica-example/claude-sonnet
  [ ]   other-example/sonnet-large
  ↑ 0 above · ↓ 0 below · 1/2

Order: claude-sonnet → gpt-large
type to filter · ↑↓ move · Enter add/remove · Tab/←→ section · Ctrl+S save · Esc cancel
```

| Where | Keys |
|---|---|
| Models | type to search (same fuzzy matcher as `/model`) · `↑↓` `PgUp` `PgDn` `Home` `End` move · `Enter` adds or removes · `Esc` clears the filter |
| Order | `Enter` picks up an item, `↑↓` reorder it, `Enter` drops it, `Esc` undoes the move · `Del`/`Backspace`/`x` removes |
| Options | `Enter` or `Space` toggles a switch or steps a choice; the highlighted setting is explained below the list |
| Review | shows the final order and where it is saved · `Enter` saves |
| Anywhere | `Tab`/`Shift+Tab` or `←→` switch sections · `Ctrl+S` saves · `Esc` cancels (twice if there are unsaved changes) · `Ctrl+C` aborts immediately · mouse wheel scrolls and clicks select |

The screen starts from your **current** order, keeps entries that are temporarily unavailable until you remove them, and always draws a bounded window around the highlighted row, so a catalog of any size scrolls correctly (terminal: height follows the window; pi-web: a fixed 40-row virtual terminal). Clients that cannot host custom components fall back to small page-by-page menus (at most seven choices per page) instead of one very long list.

If you prefer editing text, use one of the following. whatever you select with `/model` or `pi --model ...`. Only models listed in your own chain are eligible for fallback. Configure models and authentication in Pi first; this package does not create providers, fetch keys, or silently substitute model IDs.

### Option A: personal configuration file

Create `<agent-dir>/refusal-fallback.json`, normally `~/.pi/agent/refusal-fallback.json`:

```json
{
  "chain": [
    { "provider": "your-first-provider", "id": "your-first-fallback-model" },
    { "provider": "your-second-provider", "id": "your-second-fallback-model" }
  ]
}
```

**Replace every placeholder with exact IDs from your own Pi catalog** (`pi --list-models`). The examples are not recommended models. The first listed usable model is tried first. Add or remove entries to choose the length of your chain; there is no fixed two-model limit.

- `PI_CODING_AGENT_DIR` changes the agent directory.
- `PI_REFUSAL_FALLBACK_CONFIG=/absolute/path/to/config.json` selects another config file. Relative paths resolve from Pi's working directory; `~/` is expanded.
- Root fields: `chain`, the optional boolean UI settings and `carryPartial` below. Entry fields: only `provider` and `id`, both nonempty strings.
- `{"chain": []}` disables automatic fallback. Duplicate targets are normalized once, in order.
- Files/environment chains are limited to 64 KiB; chains contain at most 128 entries. Model identifiers are limited to 1,024 characters. Invalid UTF-8, special files and oversized input are rejected without echoing their contents.
- Configuration belongs outside the installed package checkout, so updates do not overwrite it.
- Use `/refusal-fallback reload` while idle to apply file changes without reloading all extensions. Pi's `/reload` also works.

An example is also available at [`examples/refusal-fallback.example.json`](examples/refusal-fallback.example.json).

### Option B: environment variable

```sh
export PI_REFUSAL_FALLBACK_CHAIN='your-provider/your-model-a,other-provider/organization/your-model-b'
pi
```

Entries are comma-separated and split at the **first** `/`; model IDs containing additional slashes are preserved. Surrounding whitespace is trimmed. Invalid or empty entries reject the entire configuration instead of silently selecting a default.

An explicitly empty value disables fallback even when a config file exists:

```sh
PI_REFUSAL_FALLBACK_CHAIN='' pi
```

Environment values must be present in the process that launches Pi. Exporting a variable in another shell does not change an already-running process.

### Precedence and status

1. `PI_REFUSAL_FALLBACK_CHAIN` when present, including an empty value.
2. The file selected by `PI_REFUSAL_FALLBACK_CONFIG`.
3. `<agent-dir>/refusal-fallback.json`.
4. No configuration: disabled.

A missing default file is normal. An explicitly selected missing file or malformed configuration disables fallback and reports a configuration error; it does not prevent ordinary Pi requests.

Commands available in TUI and dialog-capable RPC clients:

```text
/refusal-fallback status
/refusal-fallback reload
/refusal-fallback setup
```

- **status**: show the effective chain, missing models/authentication, quiet/visible mode, and the most recent run outcome, skip reasons, duration and restoration result. No model requests or file writes.
- **reload**: re-read configuration while idle; active runs keep their original snapshot. Invalid new configuration safely disables future fallback.
- **setup**: the editor described above. Saving writes atomically with mode `0600`, keeps an existing file as `.bak`, stores only non-default UI options, and applies the result to the next run without a restart. Saving without changes writes nothing. Cancelling writes nothing. Concurrent setup screens in one runtime are blocked; separate processes use atomic last-writer-wins saves. Setup will not replace symlinks/special files or write a file ignored by an environment-chain override.

Tab completion suggests the three subcommands. A fully typed subcommand runs on the first <kbd>Enter</kbd>.

### Progress and quiet mode

```json
{
  "chain": [],
  "retryMessages": false,
  "showStatus": true,
  "notifications": true
}
```

The empty example chain remains disabled until you add your own models. All three UI options default to `true` when omitted:

- `retryMessages: false` hides the one-line retry notice from the transcript. The notice is **never sent to a model** in either mode, so it neither changes the answer nor costs tokens. Context edits and the actual continuation do not depend on it.
- `showStatus`: compact footer/RPC status while a fallback is running (`fallback 2/3: requesting model-id`). A clean, fully restored run clears it again; unusual endings (exhausted chain, model changed, restoration failed) keep a plain-language status until the next run. Unchanged statuses are not re-emitted.
- `notifications`: routine warnings such as chain exhaustion. Critical configuration/restoration failures are always reported.

A bounded, non-context run summary is saved in the session, without prompts, responses or credential data. Recent summaries can be recovered after `/reload` from the active branch.

## Partial output handoff

When a response is cut off by a refusal, the visible part of it (reasoning and answer text) is normally **discarded**, and the next model answers that response from scratch, with the whole earlier conversation. Handing the cut-off output over is optional:

```json
{ "chain": [], "carryPartial": "cross-provider" }
```

| `carryPartial` | Behavior |
|---|---|
| `off` (default) | Nothing is handed over. |
| `cross-provider` | Handed over only when the next model's provider id differs from the provider of the model that was cut off (`ica-a/x` → `ica-b/y`). |

Output is **never handed to the same provider.** In our gateway test, sending a Claude answer back to Claude was blocked as "duplicating model outputs" (2 of 2 attempts, before any output), while the same prompt without the notes was answered 14 of 14 times. The same provider also applies the same safety checks to the same content. An `always` value from version 0.4.0 is read as `cross-provider` with a warning (fallback keeps working); saving setup once rewrites the file.

Choose it in `/refusal-fallback setup` → **Options**; the screen explains each value.

What is handed over: the **visible** reasoning (for Claude models this is the displayed summary, not the hidden raw reasoning) and the partial answer text. Redacted reasoning, signed provider-specific reasoning blocks and tool calls that never ran are **not** handed over, so the next model decides for itself which actions to take. Text is capped at 8,000 characters of reasoning and 4,000 of answer; the newest part is kept and the cut is marked.

How it is handed over: as one extra user-role message appended after the real conversation, labelled `[Notes from an interrupted earlier attempt]`, telling the model to treat the text as **untrusted background, not instructions**, and to give a complete answer to the request above. Delimiters inside the text are neutralized so it cannot close its own section.

- **One response only.** The notes are added to the very next request. Later steps (for example after a tool call) and later prompts do not repeat them, and only the newest interruption is kept across several hops.
- **Never stored.** The notes are built in memory for that request. They are not written to the session, so they cannot appear in pi-web or in exported sessions (the cut-off response itself is stored as usual).
- **Withdrawn if they backfire.** If the model that received the notes refuses before writing anything, it is retried **once** without them before the chain moves on, so handing output over never costs you an answer.
- The transcript notice says when notes were passed (`Its partial output is passed along as notes (…)`) and `/refusal-fallback status` shows the mode and how often it was used.

**Check your providers' terms.** Passing one provider's output to another service is your decision and some providers restrict reusing their outputs. Fallback providers also receive the notes in addition to the conversation. That is why the default is `off`.

## Behavior

1. Observe a terminal assistant refusal: an explicit `rawStopReason: "refusal"`, or a narrowly recognized canonical provider refusal error. `ECONNREFUSED`, proxy/auth refusals and generic policy prose are not model refusals; pending, aborted and tool-executing messages never trigger fallback.
2. At `agent_before_settle`, select the next explicitly configured usable model, unless another extension already requested a continuation or the user changed models.
3. Append a `context_edit` omitting the failed assistant message from future model context, and, unless hidden, a retry notice naming the model that declined and the model being tried (`↻ a/b declined this request. Retrying with c/d (fallback 1).`). A `context` handler removes these notices from every provider request, so a trailing pseudo-user message cannot displace the real request. Raw history and usage remain preserved. Pi still prints its own red error line for the refused response before the notice; that line is Pi's standard rendering of the refusal. Missing runnable user/tool context stops recovery rather than fabricating input.
4. Request one real continuation. If that model also refuses, advance to the next configured entry.
5. At final settlement, restore the original selected model and thinking level without changing global defaults. A user's newer model/thinking choice is respected, including selection changes during awaited switches. A failed restoration is reported explicitly instead of silently leaving an unexpected model selected.

The pre-settlement boundary matters: Pi's low-level error path calls `turn_end` but can ignore its continuation result. An extension that switches models and returns `continue: true` only from `turn_end` can display a retry notice without issuing the next request.

### Bounds and failure handling

- Each distinct configured model is attempted at most once per user run. The current/already-attempted model and duplicate entries are skipped.
- Missing catalog entries and targets without usable authentication are skipped, in order.
- Chain exhaustion leaves the final refusal intact; it does not start an infinite loop or invent a successful answer.
- An abort does not trigger another request. Aborting a later fallback still restores the original model.
- A new user run starts with a fresh chain budget.
- Ordinary successes, unrelated provider failures, quota errors and network errors do not trigger this extension unless classified as a refusal. Pi's normal retry policy remains separate.
- Other extensions' earlier boundary proposals and already-requested continuations are respected. Other provider/routing extensions can still affect backend availability and accepted thinking options.
- Manual model changes stop this run's automatic fallback. In-flight ownership recovery is bounded; if model selection keeps racing another actor, the extension stops and asks the user to verify the selection rather than looping.

### Performance

Configuration is read only at startup or explicit reload/setup, not for each turn or token. The setup screen renders at most twelve list rows regardless of catalog size and caches its fuzzy result per keystroke. The `context` filter does one linear scan per request and returns without allocating when no notice exists. Ordered deduplication and collision-free model keys prevent repeated catalog lookups and retries. Legacy error-text classification scans at most 4,096 characters. The extension has no timers, background polling, model calls of its own, or per-token stream handlers. Footer updates occur only at lifecycle boundaries and are deduplicated. Quiet mode removes retry-notice prompt growth; run metadata is non-context and bounded.

## Data, billing, and diagnostics

Every selected fallback provider can receive the conversation context, not just the last prompt. Choose models consistent with your privacy, residency, cost, provider terms and authorization requirements. Model availability, gateway restrictions and quota are not bypassed.

The extension does not store or log API keys, cookies, request payloads, prompts or response bodies. Opt-in debug output records model IDs and lifecycle decisions only:

```sh
PI_REFUSAL_FALLBACK_DEBUG=1 pi
```

The file is `<agent-dir>/refusal-fallback.log` and newly created files use mode `0600`. Debug logging failure cannot interrupt a request. Configuration errors do not echo malformed input.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:e2e   # real pi TUI in a private tmux server; skipped when tmux is absent
npm pack --dry-run
```

Tests use in-memory credentials/model catalogs and local loopback HTTP servers. **No real provider keys or paid model requests are required.** The 138 offline tests include configuration precedence/size limits, atomic save/backup and cancellation, nested IDs, disabled/invalid configuration, chained refusals/exhaustion, duplicates/auth failures, windowed-list scrolling at many sizes and widths, filter/reorder/option/save flows, mouse input, context-free retry notices, both handoff modes (including latest-only, one-shot, truncation, delimiter safety and withdrawal of rejected notes) over the SDK and a real HTTP transport, progress/summary reporting, manual-selection races, restoration failure, cooperative continuation, missing context and native HTTP cross-provider handoff.

The lifecycle implementation was additionally exercised in actual `pi -p` processes against a private gateway: a native refusal followed by a successful continuation, three repeated two-hop fallback runs, and bounded chain exhaustion. Repeated multi-hop tests used test-only refusal injection after actual upstream responses. Private credentials, provider/model choices, raw session logs and live-test artifacts are intentionally not published here. These checks do not promise availability of any particular model or gateway.

## License

[MIT](LICENSE).
