# pi-refusal-fallback

[![CI](https://github.com/sehoon123/pi-refusal-fallback/actions/workflows/ci.yml/badge.svg)](https://github.com/sehoon123/pi-refusal-fallback/actions/workflows/ci.yml)

A [Pi](https://pi.dev) extension that retries a provider-refused turn on an **explicitly user-configured, ordered model chain**.

**No providers or model IDs are built in. No configuration means no automatic fallback.** You choose the initial model normally in Pi and choose your own fallback models separately. Each provider still applies its own policies and authentication requirements; this extension does not override them.

[한국어 문서](README.ko.md)

## Install

```sh
pi install git:github.com/sehoon123/pi-refusal-fallback@v0.1.0
```

Then run `/reload` in an existing session. Do not load both this package and an older standalone `refusal-fallback.ts`: move the old copy outside Pi's auto-loaded extensions directory before switching to the package.

Requires Node.js 22.19+ and a Pi host supporting actionable `agent_before_settle` boundaries. Automated compatibility checks target Pi **1.2.0 and 1.4.0**. This package uses the Pi-supplied peer modules and has no runtime npm dependencies.

## Choose your models

Your initial model remains whatever you select with `/model` or `pi --model ...`. Only models listed in your own chain are eligible for fallback. Configure models and authentication in Pi first; this package does not create providers, fetch keys, or silently substitute model IDs.

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
- Root fields: only `chain`. Entry fields: only `provider` and `id`, both nonempty strings.
- `{"chain": []}` disables automatic fallback.
- Configuration belongs outside the installed package checkout, so updates do not overwrite it.
- Run `/reload` after editing the file.

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

Check the active configuration in an interactive session:

```text
/refusal-fallback status
```

This command sends no model request and does not change settings.

## Behavior

1. Observe a finalized assistant refusal: `rawStopReason: "refusal"`, or an error with refusal/policy-related text.
2. At `agent_before_settle`, select the next explicitly configured usable model.
3. Append a `context_edit` omitting the failed assistant message from future model context, and a visible retry notice. Raw history and usage remain preserved.
4. Request one real continuation. If that model also refuses, advance to the next configured entry.
5. At final settlement, restore the original selected model and thinking level without changing global defaults.

The pre-settlement boundary matters: Pi's low-level error path calls `turn_end` but can ignore its continuation result. An extension that switches models and returns `continue: true` only from `turn_end` can display a retry notice without issuing the next request.

### Bounds and failure handling

- Each distinct configured model is attempted at most once per user run. The current/already-attempted model and duplicate entries are skipped.
- Missing catalog entries and targets without usable authentication are skipped, in order.
- Chain exhaustion leaves the final refusal intact; it does not start an infinite loop or invent a successful answer.
- An abort does not trigger another request. Aborting a later fallback still restores the original model.
- A new user run starts with a fresh chain budget.
- Ordinary successes, unrelated provider failures, quota errors and network errors do not trigger this extension unless classified as a refusal. Pi's normal retry policy remains separate.
- Other extensions' earlier boundary proposals are preserved. Other provider/routing extensions can still affect backend availability and accepted thinking options.

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
npm pack --dry-run
```

Tests use in-memory credentials/model catalogs and local loopback HTTP servers. **No real provider keys or paid model requests are required.** Coverage includes configuration precedence, nested IDs, disabled/invalid configuration, chained refusals, exhaustion, duplicate models, unavailable authentication, cancellation, state reset, context-history preservation and native HTTP cross-provider handoff.

The lifecycle implementation was additionally exercised in actual `pi -p` processes against a private gateway: a native refusal followed by a successful continuation, three repeated two-hop fallback runs, and bounded chain exhaustion. Repeated multi-hop tests used test-only refusal injection after actual upstream responses. Private credentials, provider/model choices, raw session logs and live-test artifacts are intentionally not published here. These checks do not promise availability of any particular model or gateway.

## License

[MIT](LICENSE).
