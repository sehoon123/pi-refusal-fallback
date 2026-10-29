/** Bounded provider-refusal recovery using an explicitly user-selected model chain. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfiguration, type Configuration } from "./config.ts";

function isRefusal(message: AgentMessage): boolean {
  if (message.role !== "assistant" || message.stopReason === "aborted") return false;
  return message.rawStopReason === "refusal" || (
    message.stopReason === "error" && /refus|violative cyber|usage policy/i.test(message.errorMessage ?? "")
  );
}

export default function refusalFallback(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const debug = process.env.PI_REFUSAL_FALLBACK_DEBUG === "1";
  const log = (message: string): void => {
    if (!debug) return;
    try {
      appendFileSync(join(agentDir, "refusal-fallback.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
    } catch {
      // Debug output must never interrupt a request. No prompts, payloads or credentials are logged.
    }
  };
  let config: Configuration = { chain: [], source: "none" };
  let configError: string | undefined;
  try {
    config = readConfiguration({ agentDir });
  } catch (error) {
    configError = error instanceof Error ? error.message : "Cannot load the fallback configuration.";
  }
  pi.registerCommand("refusal-fallback", {
    description: "Show the user-configured fallback chain and configuration status",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "status") {
        ctx.ui.notify("Usage: /refusal-fallback [status]", "warning");
        return;
      }
      if (configError) {
        ctx.ui.notify(`[refusal-fallback] Disabled: ${configError}`, "error");
        return;
      }
      ctx.ui.notify(config.chain.length === 0
        ? "[refusal-fallback] Disabled: no fallback models configured. Set refusal-fallback.json or PI_REFUSAL_FALLBACK_CHAIN, then /reload."
        : `[refusal-fallback] Source: ${config.source}\n${config.chain.map((entry, index) => `${index + 1}. ${entry.provider}/${entry.id}`).join("\n")}`,
      "info");
    },
  });
  if (configError) {
    const message = `[refusal-fallback] Disabled: ${configError}`;
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
    });
    return;
  }
  const chain = config.chain;
  if (chain.length === 0) return;

  let originalModel: ExtensionContext["model"];
  let originalThinkingLevel: ExtensionContext["thinkingLevel"];
  let pendingRefusal: { entryId: string; modelKey: string } | undefined;
  let nextIndex = 0;
  const attemptedModels = new Set<string>();

  // The low-level error path invokes finishTurn, but ignores its continuation
  // decision and exits. Remember the entry here; start the next request at the
  // actionable pre-settlement boundary, not at turn_end or agent_settled.
  pi.on("turn_end", (event, ctx) => {
    const message = event.message;
    pendingRefusal = undefined;
    if (message.role !== "assistant") return;
    log(`turn_end stop=${message.stopReason} raw=${message.rawStopReason} model=${message.model}`);
    if (!isRefusal(message) || ctx.signal?.aborted) return;
    pendingRefusal = { entryId: event.messageEntryId, modelKey: `${message.provider}/${message.model}` };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const refused = pendingRefusal;
    pendingRefusal = undefined;
    if (!refused || event.outcome === "aborted" || ctx.signal?.aborted) return;
    const current = ctx.model;
    if (!current) return;
    attemptedModels.add(refused.modelKey);
    attemptedModels.add(`${current.provider}/${current.id}`);

    while (nextIndex < chain.length) {
      const entry = chain[nextIndex++];
      const modelKey = `${entry.provider}/${entry.id}`;
      if (attemptedModels.has(modelKey)) {
        log(`fallback ${modelKey} already attempted; skipping`);
        continue;
      }
      attemptedModels.add(modelKey);
      const target = ctx.modelRegistry.find(entry.provider, entry.id);
      if (!target) {
        log(`fallback ${modelKey} not found in catalog; skipping`);
        continue;
      }
      const thinkingLevel = pi.getThinkingLevel();
      try {
        if (!(await pi.setModel(target))) {
          log(`setModel(${modelKey}) failed; skipping`);
          continue;
        }
      } catch {
        log(`setModel(${modelKey}) threw; skipping`);
        continue;
      }
      if (!originalModel) {
        originalModel = current;
        originalThinkingLevel = thinkingLevel;
      }
      log(`refusal on ${refused.modelKey} -> retry ${modelKey} before settlement`);
      return {
        entries: [
          ...event.entries,
          { type: "context_edit" as const, targetId: refused.entryId, replacement: null },
          {
            type: "custom_message" as const, customType: "refusal-fallback", display: true,
            content: `[refusal-fallback] The previous model did not complete this request. Retrying with ${modelKey}.`,
          },
        ],
        continue: true,
      };
    }
    log(`refusal but no fallback remains (${chain.length} configured); leaving the final refusal intact`);
  });

  pi.on("agent_settled", async () => {
    const back = originalModel;
    const thinkingLevel = originalThinkingLevel;
    originalModel = undefined;
    originalThinkingLevel = undefined;
    pendingRefusal = undefined;
    nextIndex = 0;
    attemptedModels.clear();
    if (back && await pi.setModel(back)) {
      if (thinkingLevel !== undefined) pi.setThinkingLevel(thinkingLevel);
      log(`run settled; restored ${back.id}`);
    }
  });
}
