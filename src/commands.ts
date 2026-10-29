import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configurationPath, MAX_CHAIN_ENTRIES, saveConfiguration, type Configuration } from "./config.ts";
import { modelKey, modelLabel } from "./refusal.ts";

export interface CommandState {
  getConfig(): Configuration;
  getError(): string | undefined;
  getLastSummary(): string | undefined;
  isBusy(): boolean;
  reload(): void;
  clearStatus(ctx: ExtensionCommandContext): void;
}
export function registerCommands(pi: ExtensionAPI, agentDir: string, state: CommandState): void {
  let setupBusy = false;
  pi.registerCommand("refusal-fallback", {
    description: "Fallback status, reload, or interactive ordered-model setup",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        const config = state.getConfig();
        const available = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
        const lines = config.chain.map((entry, index) => {
          const registered = ctx.modelRegistry.find(entry.provider, entry.id);
          const suffix = !registered ? " [missing model]" : !available.has(modelKey(entry)) ? " [no usable auth]" : "";
          return `${index + 1}. ${modelLabel(entry)}${suffix}`;
        });
        const text = [`[refusal-fallback] ${state.getError() ? `Disabled: ${state.getError()}` : config.chain.length ? `Source: ${config.source}` : "Disabled: no fallback models configured"}`,
          ...lines, `Retry messages: ${config.retryMessages === false ? "quiet" : "visible"}`,
          ...(state.getLastSummary() ? [state.getLastSummary()!] : []),
          "Commands: /refusal-fallback setup | reload"].join("\n");
        ctx.ui.notify(text, state.getError() ? "error" : "info");
        return;
      }
      if (action !== "reload" && action !== "setup") {
        ctx.ui.notify("Usage: /refusal-fallback [status|reload|setup]", "warning");
        return;
      }
      if (setupBusy) {
        ctx.ui.notify("Another fallback setup is already open. Finish or cancel it first.", "warning");
        return;
      }
      if (state.isBusy() || !ctx.isIdle()) {
        ctx.ui.notify("Wait for the active run to finish before changing fallback settings.", "warning");
        return;
      }
      if (action === "reload") {
        state.reload();
        state.clearStatus(ctx);
        ctx.ui.notify(state.getError() ? `[refusal-fallback] Disabled: ${state.getError()}` :
          `[refusal-fallback] Reloaded ${state.getConfig().chain.length} fallback model(s).`, state.getError() ? "error" : "info");
        return;
      }
      if (!ctx.hasUI) {
        console.error("[refusal-fallback] Setup requires a TUI/RPC UI. Edit refusal-fallback.json or use PI_REFUSAL_FALLBACK_CHAIN.");
        return;
      }
      if (process.env.PI_REFUSAL_FALLBACK_CHAIN !== undefined) {
        ctx.ui.notify("PI_REFUSAL_FALLBACK_CHAIN overrides files. Unset it and restart Pi before using setup.", "warning");
        return;
      }
      const models = ctx.modelRegistry.getAvailable();
      if (models.length === 0) {
        ctx.ui.notify("No authenticated models are available. Configure providers in Pi first.", "warning");
        return;
      }
      const chosen: { provider: string; id: string }[] = [];
      const save = "[Save this order]";
      const undo = "[Undo last choice]";
      const cancel = "[Cancel without changes]";
      setupBusy = true;
      try {
        while (true) {
          const selectedKeys = new Set(chosen.map(modelKey));
          const choices = new Map((chosen.length >= MAX_CHAIN_ENTRIES ? [] : models.filter((model) => !selectedKeys.has(modelKey(model))))
            .map((model, index) => [`${index + 1}. ${model.provider} :: ${model.id}`, { provider: model.provider, id: model.id }]));
          const title = chosen.length ? `${chosen.length} fallback(s) selected; last: ${chosen.at(-1)!.id}` : "Choose fallback models in order";
          const selected = await ctx.ui.select(title, [save, ...(chosen.length ? [undo] : []), cancel, ...choices.keys()]);
          if (selected === undefined || selected === cancel) return;
          if (selected === undo) { chosen.pop(); continue; }
          if (selected !== save) {
            const model = choices.get(selected);
            if (model) chosen.push(model);
            continue;
          }
          const preview = chosen.length ? chosen.map(modelLabel).join("\n→ ") : "Disable automatic fallback (empty chain).";
          if (!await ctx.ui.confirm("Save fallback configuration?", `${preview}\n\nFallback providers receive conversation context.\nFile: ${configurationPath({ agentDir })}`)) return;
          if (state.isBusy() || !ctx.isIdle()) {
            ctx.ui.notify("A run started during setup. No configuration was written; retry when idle.", "warning");
            return;
          }
          try {
            const { source: _source, ...options } = state.getConfig();
            await saveConfiguration({ agentDir }, { ...options, chain: chosen });
            state.reload();
            state.clearStatus(ctx);
            ctx.ui.notify(state.getError() ? `[refusal-fallback] Saved, but disabled: ${state.getError()}` :
              `[refusal-fallback] Saved and applied ${chosen.length} fallback model(s). An existing file is backed up as .bak.`,
            state.getError() ? "error" : "info");
          } catch {
            ctx.ui.notify("Could not save fallback configuration. Existing settings were preserved; check file permissions, size and symlinks.", "error");
          }
          return;
        }
      } finally {
        setupBusy = false;
      }
    },
  });
}
