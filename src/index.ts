/** Bounded, user-owned fallback with explicit lifecycle and model-selection ownership. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm, getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readConfiguration, type Configuration } from "./config.ts";
import { buildHandoff, collectPartial, shouldCarry, type PartialOutput } from "./handoff.ts";
import { registerCommands } from "./commands.ts";
import { isRefusal, modelKey, modelLabel } from "./refusal.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Thinking = NonNullable<ExtensionContext["thinkingLevel"]>;
type Outcome = "running" | "completed" | "failed" | "aborted" | "exhausted" | "model-changed" | "no-context";
interface Run {
  config: Configuration;
  startedAt: number;
  source?: Model;
  originalThinking?: Thinking;
  userThinking?: Thinking;
  ownedModel?: string;
  overridden: boolean;
  externalSelection?: Model;
  externalRevision: number;
  hadRefusal: boolean;
  pending?: { entryId: string; key: string; label: string; provider: string; partial?: PartialOutput };
  /** Notes for the next request only; deliberately never written to the session. */
  carry?: string;
  /** Model that received notes in the latest hop, while its first response is outstanding. */
  handedTo?: string;
  /** Models already retried once without notes, so a rejection can never loop. */
  withoutNotes: Set<string>;
  carried: { hop: number; reasoning: number; answer: number; rejected?: boolean }[];
  nextIndex: number;
  attempted: Set<string>;
  targets: string[];
  skipped: { entry: number; reason: string }[];
  outcome: Outcome;
}
const statusKey = "refusal-fallback";
const summaryType = "refusal-fallback-run";
const noticeType = "refusal-fallback";

export default function refusalFallback(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const debug = process.env.PI_REFUSAL_FALLBACK_DEBUG === "1";
  let config: Configuration = { chain: [], source: "none" };
  let configError: string | undefined;
  let run: Run | undefined;
  let expectedSelection: string | undefined;
  let lastStatus: string | undefined;
  let lastSummary: string | undefined;
  const log = (message: string): void => {
    if (!debug) return;
    try { appendFileSync(join(agentDir, "refusal-fallback.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }); }
    catch { /* No request should depend on debug I/O. Never log payloads or credentials. */ }
  };
  const reload = (): void => {
    try { config = readConfiguration({ agentDir }); configError = undefined; }
    catch (error) {
      config = { chain: [], source: "none" };
      configError = error instanceof Error ? error.message : "Cannot load fallback configuration.";
    }
  };
  const status = (ctx: ExtensionContext, text: string | undefined): void => {
    if (!ctx.hasUI) return;
    const next = (run?.config ?? config).showStatus === false ? undefined : text;
    if (lastStatus === next) return;
    try { ctx.ui.setStatus(statusKey, next); lastStatus = next; }
    catch { /* UI clients can ignore unsupported presentation methods. */ }
  };
  const notify = (ctx: ExtensionContext, message: string, critical = false): void => {
    if (!critical && (run?.config ?? config).notifications === false) return;
    const text = `[refusal-fallback] ${message}`;
    try {
      if (ctx.hasUI) ctx.ui.notify(text, critical ? "error" : "warning");
      else console.error(text);
    } catch { /* Notification errors must not change model execution. */ }
  };
  const selectModel = async (model: Model): Promise<boolean> => {
    expectedSelection = modelKey(model);
    try { return await pi.setModel(model); }
    finally { expectedSelection = undefined; }
  };
  const honorExternalChoice = async (currentRun: Run, ctx: ExtensionContext): Promise<boolean> => {
    const desired = currentRun.externalSelection;
    if (!desired || (ctx.model && modelKey(ctx.model) === modelKey(desired))) return true;
    const revision = currentRun.externalRevision;
    let restored = false;
    try { restored = await selectModel(desired); } catch { /* Selection ownership was lost during an awaited switch. */ }
    if (!restored || currentRun.externalRevision !== revision) {
      notify(ctx, "Model selection changed during an in-flight switch. Automatic fallback stopped; verify your selected model.", true);
      return false;
    }
    return true;
  };
  // The retry notice is for people. Keeping it out of every provider request avoids
  // a trailing pseudo-user message that can displace the real request, and saves tokens.
  pi.on("context", (event) => {
    const isNotice = (message: (typeof event.messages)[number]): boolean => message.role === "custom" && message.customType === noticeType;
    const hasNotice = event.messages.some(isNotice);
    const carry = run?.carry;
    if (!hasNotice && !carry) return;
    const messages = hasNotice ? event.messages.filter((message) => !isNotice(message)) : [...event.messages];
    // Appended after the real conversation for exactly the next request; never persisted.
    if (carry) messages.push({ role: "user", content: [{ type: "text", text: carry }], timestamp: Date.now() });
    return { messages };
  });
  // The notes only help the response that follows the interruption; later steps already have the new model's own work.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (run?.carry && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
      run.carry = undefined;
      run.handedTo = undefined;
    }
  });
  // One compact line in the terminal. Hosts without renderer support show the same text unchanged.
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(noticeType, (message, options, theme) => {
      const raw = typeof message.content === "string" ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      return new Text(theme.fg("warning", "↻ ") + theme.fg("muted", raw.replace(/^\[refusal-fallback\]\s*/, "")), options.outputPad, 0);
    });
  }
  reload();
  registerCommands(pi, agentDir, {
    getConfig: () => config, getError: () => configError, getLastSummary: () => lastSummary,
    isBusy: () => run !== undefined, reload,
    clearStatus: (ctx) => status(ctx, undefined),
  });

  pi.on("session_start", (_event, ctx) => {
    const previous = ctx.sessionManager.getBranch().slice(-200).findLast((entry) => entry.type === "custom" && entry.customType === summaryType);
    if (previous?.type === "custom") {
      const data = previous.data as { version?: unknown; summary?: unknown } | undefined;
      if (data?.version === 1 && typeof data.summary === "string" && data.summary.length <= 2048 &&
          !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(data.summary)) lastSummary = data.summary;
    }
    if (configError) notify(ctx, `Disabled: ${configError}`, true);
    for (const warning of config.warnings ?? []) notify(ctx, warning);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    status(ctx, undefined);
    run = config.chain.length ? {
      config, startedAt: Date.now(), source: ctx.model, originalThinking: pi.getThinkingLevel(),
      overridden: false, externalRevision: 0, hadRefusal: false, nextIndex: 0, attempted: new Set(), targets: [], skipped: [], carried: [], withoutNotes: new Set(), outcome: "running",
    } : undefined;
  });
  pi.on("model_select", (event, ctx) => {
    if (!run || expectedSelection === modelKey(event.model)) return;
    // Respect another extension or the user's explicit choice. Never force the
    // next fallback or restore the old source over a newer selected model.
    run.overridden = true;
    run.externalSelection = event.model;
    run.externalRevision += 1;
    run.pending = undefined;
    run.outcome = "model-changed";
    if (run.hadRefusal) status(ctx, "fallback stopped: model changed by user/extension");
  });
  pi.on("thinking_level_select", (event, ctx) => {
    if (run && (!expectedSelection || !ctx.model || expectedSelection !== modelKey(ctx.model))) run.userThinking = event.level;
  });
  pi.on("before_provider_request", (_event, ctx) => {
    if (run?.targets.length && !run.overridden) {
      status(ctx, `fallback ${run.targets.length}/${run.config.chain.length}: requesting ${ctx.model?.id ?? "model"}`);
    }
  });
  pi.on("turn_end", (event, ctx) => {
    const currentRun = run;
    if (!currentRun) return;
    currentRun.pending = undefined;
    if (event.message.role !== "assistant") return;
    const message = event.message;
    const refused = isRefusal(message);
    if (refused) currentRun.hadRefusal = true;
    if (currentRun.overridden) return;
    if (message.stopReason === "aborted" || ctx.signal?.aborted) { currentRun.outcome = "aborted"; return; }
    currentRun.outcome = message.stopReason === "error" ? "failed" : "completed";
    if (!refused) return;
    currentRun.pending = {
      entryId: event.messageEntryId,
      key: modelKey({ provider: message.provider, id: message.model }),
      label: modelLabel({ provider: message.provider, id: message.model }),
      provider: message.provider,
      partial: currentRun.config.carryPartial && currentRun.config.carryPartial !== "off" ? collectPartial(message) : undefined,
    };
    log(`refusal recorded; fallback count=${currentRun.targets.length}`);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const currentRun = run;
    const refused = currentRun?.pending;
    if (!currentRun || !refused) return;
    currentRun.pending = undefined;
    if (currentRun.overridden || event.outcome === "aborted" || ctx.signal?.aborted) return;
    // Another extension already chose a continuation; do not compete with it.
    if (event.continue) return;
    const current = ctx.model;
    if (!current) return;
    const projected = convertToLlm(event.context.contextEntries
      .filter((entry) => entry.sourceEntry.id !== refused.entryId).flatMap((entry) => entry.messages));
    if (!projected.some((message) => message.role !== "system") || projected.at(-1)?.role === "assistant") {
      currentRun.outcome = "no-context";
      notify(ctx, "Cannot retry without runnable user/tool context. The refusal was preserved.");
      return;
    }
    currentRun.attempted.add(refused.key);
    currentRun.attempted.add(modelKey(current));
    // The model that was handed notes refused before writing anything: the notes may be what it objected to
    // (one gateway blocked a Claude answer fed back to Claude as "duplicating model outputs"). Handing output over
    // must never cost an answer, so try that same model once more without them before moving down the chain.
    if (currentRun.handedTo === refused.key && refused.partial === undefined && !currentRun.withoutNotes.has(refused.key) && modelKey(current) === refused.key) {
      currentRun.withoutNotes.add(refused.key);
      currentRun.handedTo = undefined;
      currentRun.carry = undefined;
      const last = currentRun.carried.at(-1);
      if (last) last.rejected = true;
      currentRun.outcome = "running";
      status(ctx, `fallback ${currentRun.targets.length}/${currentRun.config.chain.length}: ${current.id} refused the notes, retrying without them`);
      log(`notes rejected by ${refused.label}; retrying the same model without them`);
      const retryEntries: SessionBoundaryDraft[] = [...event.entries, { type: "context_edit", targetId: refused.entryId, replacement: null }];
      if (currentRun.config.retryMessages !== false) retryEntries.push({
        type: "custom_message", customType: noticeType, display: true,
        content: `[refusal-fallback] ${refused.label} refused the passed-along notes before answering. Retrying it once without them.`,
      });
      return { entries: retryEntries, continue: true };
    }
    while (currentRun.nextIndex < currentRun.config.chain.length) {
      const entryNumber = ++currentRun.nextIndex;
      const entry = currentRun.config.chain[entryNumber - 1];
      const key = modelKey(entry);
      if (currentRun.attempted.has(key)) {
        currentRun.skipped.push({ entry: entryNumber, reason: "already-attempted" });
        continue;
      }
      currentRun.attempted.add(key);
      const target = ctx.modelRegistry.find(entry.provider, entry.id);
      if (!target) {
        currentRun.skipped.push({ entry: entryNumber, reason: "missing-model" });
        log(`chain entry ${entryNumber} missing from catalog`);
        continue;
      }
      const thinkingBeforeSwitch = pi.getThinkingLevel();
      let switched = false;
      try { switched = await selectModel(target); }
      catch { /* A failed target does not silently terminate the remaining chain. */ }
      if (!switched) {
        currentRun.skipped.push({ entry: entryNumber, reason: "unavailable-or-switch-failed" });
        continue;
      }
      if (run !== currentRun) return;
      if (currentRun.overridden) { await honorExternalChoice(currentRun, ctx); return; }
      if (ctx.signal?.aborted) return;
      if (!currentRun.targets.length) {
        currentRun.source = current;
        currentRun.originalThinking = thinkingBeforeSwitch;
      }
      currentRun.ownedModel = key;
      currentRun.targets.push(modelLabel(entry));
      currentRun.outcome = "running";
      status(ctx, `fallback ${currentRun.targets.length}/${currentRun.config.chain.length}: queued ${entry.id}`);
      log(`fallback ${currentRun.targets.length} -> ${modelLabel(entry)}`);
      // Only the newest interruption is handed over; notes for an earlier hop are replaced or dropped.
      const handOver = refused.partial !== undefined && shouldCarry(currentRun.config.carryPartial, refused.provider, target.provider);
      currentRun.carry = handOver ? buildHandoff(refused.partial!) : undefined;
      currentRun.handedTo = handOver ? key : undefined;
      if (handOver) currentRun.carried.push({ hop: currentRun.targets.length, reasoning: refused.partial!.reasoning.length, answer: refused.partial!.answer.length });
      const entries: SessionBoundaryDraft[] = [
        ...event.entries, { type: "context_edit", targetId: refused.entryId, replacement: null },
      ];
      const handoffNote = handOver
        ? ` Its partial output is passed along as notes (${refused.partial!.reasoning.length.toLocaleString("en-US")} characters of reasoning, ${refused.partial!.answer.length.toLocaleString("en-US")} of answer).`
        : "";
      if (currentRun.config.retryMessages !== false) entries.push({
        type: "custom_message", customType: noticeType, display: true,
        content: `[refusal-fallback] ${refused.label} declined this request. Retrying with ${modelLabel(entry)} (fallback ${currentRun.targets.length}).${handoffNote}`,
      });
      return { entries, continue: true };
    }
    currentRun.outcome = "exhausted";
    notify(ctx, `Chain exhausted: ${currentRun.targets.length} fallback(s), ${currentRun.skipped.length} skipped. Final refusal preserved. See /refusal-fallback status.`);
  });

  pi.on("agent_settled", async (event, ctx) => {
    const currentRun = run;
    if (!currentRun) return;
    let restoration = "not-needed";
    try {
      if (currentRun.targets.length && currentRun.source) {
        if (currentRun.overridden || !ctx.model || modelKey(ctx.model) !== currentRun.ownedModel) {
          restoration = await honorExternalChoice(currentRun, ctx) ? "user-choice" : "failed";
        } else {
          restoration = "failed";
          try {
            if (await selectModel(currentRun.source)) {
              if (currentRun.overridden) {
                restoration = await honorExternalChoice(currentRun, ctx) ? "user-choice" : "failed";
              } else {
                expectedSelection = modelKey(currentRun.source);
                try { pi.setThinkingLevel(currentRun.userThinking ?? currentRun.originalThinking ?? pi.getThinkingLevel()); }
                finally { expectedSelection = undefined; }
                restoration = "restored";
              }
            }
          } catch { /* Report restoration failure rather than hiding it or looping. */ }
          if (restoration === "failed") notify(ctx, "Could not restore the original model. Select it manually; no further retry was started.", true);
        }
      }
      if (!currentRun.hadRefusal) return;
      const outcome = currentRun.overridden ? "model-changed" : event.aborted ? "aborted" : currentRun.outcome;
      const elapsedMs = Math.max(0, Date.now() - currentRun.startedAt);
      lastSummary = `Last run: ${outcome}; ${currentRun.targets.length} fallback(s), ${currentRun.skipped.length} skipped${currentRun.carried.length ? `, partial output passed on ${currentRun.carried.length}${currentRun.carried.some((item) => item.rejected) ? ` (rejected on ${currentRun.carried.filter((item) => item.rejected).length}, retried without)` : ""}` : ""}; ${elapsedMs} ms; model ${restoration}.`;
      const skipped = currentRun.skipped.slice(0, 10).map((entry) => `entry ${entry.entry}: ${entry.reason}`).join(", ");
      if (skipped) lastSummary += `\nSkipped: ${skipped}${currentRun.skipped.length > 10 ? ` (+${currentRun.skipped.length - 10} more)` : ""}`;
      const clean = outcome === "completed" && (restoration === "restored" || restoration === "not-needed");
      status(ctx, clean ? undefined : `fallback ${outcome} · ${currentRun.targets.length} retr${currentRun.targets.length === 1 ? "y" : "ies"} · model ${restoration}`);
      try {
        pi.appendEntry(summaryType, { version: 1, summary: lastSummary, outcome, restoration, elapsedMs,
          source: currentRun.source ? modelLabel(currentRun.source) : undefined,
          targets: currentRun.targets, skipped: currentRun.skipped, carried: currentRun.carried });
      } catch { /* Metadata reporting is independent from completion. */ }
      log(lastSummary.replaceAll("\n", " "));
    } finally {
      if (run === currentRun) run = undefined;
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    run = undefined;
    expectedSelection = undefined;
    status(ctx, undefined);
  });
}
