import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configurationPath, MAX_CHAIN_ENTRIES, saveConfiguration, type ChainEntry, type Configuration } from "./config.ts";
import type { PickerOptions } from "./picker-model.ts";
import { modelKey, modelLabel } from "./refusal.ts";
import { collectSetup } from "./setup.ts";

export interface CommandState {
  getConfig(): Configuration;
  getError(): string | undefined;
  getLastSummary(): string | undefined;
  isBusy(): boolean;
  reload(): void;
  clearStatus(ctx: ExtensionCommandContext): void;
}

const SUBCOMMANDS = [
  { value: "status", label: "status", description: "Show the fallback order, readiness and the last run" },
  { value: "setup", label: "setup", description: "Choose, search and reorder fallback models" },
  { value: "reload", label: "reload", description: "Re-read the configuration while idle" },
];
const OPTION_KEYS = ["retryMessages", "showStatus", "notifications", "carryPartial"] as const;
const sameChain = (a: readonly ChainEntry[], b: readonly ChainEntry[]): boolean =>
  a.length === b.length && a.every((entry, index) => modelKey(entry) === modelKey(b[index]));

export function registerCommands(pi: ExtensionAPI, agentDir: string, state: CommandState): void {
  let setupBusy = false;
  const file = (): string => configurationPath({ agentDir });
  pi.registerCommand("refusal-fallback", {
    description: "Fallback status, reload, or interactive model setup",
    getArgumentCompletions: (prefix) => {
      const typed = prefix.trim().toLowerCase();
      // A fully typed subcommand must run on the first Enter, not just accept a no-op completion.
      if (SUBCOMMANDS.some((item) => item.value === typed)) return null;
      const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(typed));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") {
        const config = state.getConfig();
        const available = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
        const lines = config.chain.map((entry, index) => {
          const registered = ctx.modelRegistry.find(entry.provider, entry.id);
          const suffix = !registered ? " [missing model]" : !available.has(modelKey(entry)) ? " [no usable auth]" : "";
          return `${index + 1}. ${modelLabel(entry)}${suffix}`;
        });
        const headline = state.getError() ? `Disabled: ${state.getError()}`
          : config.chain.length ? `Source: ${config.source}` : "Disabled: no fallback models configured";
        const text = [`[refusal-fallback] ${headline}`, ...lines,
          `Retry notices: ${config.retryMessages === false ? "hidden" : "shown"} · status: ${config.showStatus === false ? "off" : "on"} · warnings: ${config.notifications === false ? "off" : "on"}`,
          `Partial output handoff: ${config.carryPartial ?? "off"}`,
          ...(config.warnings ?? []).map((warning) => `Warning: ${warning}`),
          ...(state.getLastSummary() ? [state.getLastSummary()!] : []),
          `File: ${file()}`,
          "Use /refusal-fallback setup to change the order."].join("\n");
        ctx.ui.notify(text, state.getError() ? "error" : "info");
        return;
      }
      if (action !== "reload" && action !== "setup") {
        ctx.ui.notify("Usage: /refusal-fallback [status|setup|reload]", "warning");
        return;
      }
      if (setupBusy) {
        ctx.ui.notify("Fallback setup is already open. Finish or cancel it first.", "warning");
        return;
      }
      if (state.isBusy() || !ctx.isIdle()) {
        ctx.ui.notify("Wait for the active run to finish before changing fallback settings.", "warning");
        return;
      }
      if (action === "reload") {
        state.reload();
        state.clearStatus(ctx);
        const reloadWarnings = (state.getConfig().warnings ?? []).map((warning) => `\nWarning: ${warning}`).join("");
        ctx.ui.notify(state.getError() ? `[refusal-fallback] Disabled: ${state.getError()}` :
          `[refusal-fallback] Reloaded ${state.getConfig().chain.length} fallback model(s).${reloadWarnings}`, state.getError() ? "error" : reloadWarnings ? "warning" : "info");
        return;
      }
      if (!ctx.hasUI) {
        console.error("[refusal-fallback] Setup requires an interactive UI. Edit refusal-fallback.json or use PI_REFUSAL_FALLBACK_CHAIN.");
        return;
      }
      if (process.env.PI_REFUSAL_FALLBACK_CHAIN !== undefined) {
        ctx.ui.notify("PI_REFUSAL_FALLBACK_CHAIN overrides files. Unset it and restart Pi before using setup.", "warning");
        return;
      }
      if (ctx.modelRegistry.getAvailable().length === 0) {
        ctx.ui.notify("No authenticated models are available. Configure providers in Pi first.", "warning");
        return;
      }
      const config = state.getConfig();
      const current: PickerOptions = {
        retryMessages: config.retryMessages !== false,
        showStatus: config.showStatus !== false,
        notifications: config.notifications !== false,
        carryPartial: config.carryPartial ?? "off",
      };
      setupBusy = true;
      let result;
      try {
        result = await collectSetup(ctx, { chain: config.chain, options: current, file: file(), limit: MAX_CHAIN_ENTRIES });
      } catch {
        ctx.ui.notify("The setup screen could not be shown. Edit refusal-fallback.json instead.", "error");
        return;
      } finally {
        setupBusy = false;
      }
      if (result.kind === "cancel") return;
      if (state.isBusy() || !ctx.isIdle()) {
        ctx.ui.notify("A run started during setup. No configuration was written; retry when idle.", "warning");
        return;
      }
      // A file with a removed value is rewritten even without edits, so its warning goes away.
      if (sameChain(result.chain, config.chain) && OPTION_KEYS.every((key) => result.options[key] === current[key]) && !config.warnings?.length) {
        ctx.ui.notify("No changes to save.", "info");
        return;
      }
      try {
        // Only non-default UI options are stored, keeping the file easy to read and edit.
        const document: Record<string, unknown> = { chain: result.chain };
        for (const key of ["retryMessages", "showStatus", "notifications"] as const) if (!result.options[key]) document[key] = false;
        if (result.options.carryPartial !== "off") document.carryPartial = result.options.carryPartial;
        const { backedUp } = await saveConfiguration({ agentDir }, document);
        state.reload();
        state.clearStatus(ctx);
        const order = result.chain.length ? `: ${result.chain.map((entry) => entry.id.slice(entry.id.lastIndexOf("/") + 1)).join(" → ")}` : "";
        ctx.ui.notify(state.getError() ? `[refusal-fallback] Saved, but disabled: ${state.getError()}` :
          `[refusal-fallback] Saved ${result.chain.length} fallback model(s)${order}.${backedUp ? " The previous file was kept as .bak." : ""}`,
        state.getError() ? "error" : "info");
      } catch {
        ctx.ui.notify("Could not save fallback configuration. Existing settings were preserved; check file permissions, size and symlinks.", "error");
      }
    },
  });
}
