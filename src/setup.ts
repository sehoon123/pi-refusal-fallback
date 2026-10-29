import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChainEntry } from "./config.ts";
import { ChainEditor, OPTION_ROWS, type PickerOptions, type SetupResult } from "./picker-model.ts";
import { ChainPicker, type ThemeLike } from "./picker-ui.ts";
import { modelLabel } from "./refusal.ts";

export interface SetupInput {
  chain: readonly ChainEntry[];
  options: PickerOptions;
  file: string;
  limit: number;
}

const PAGE_SIZE = 7;
const lastSegment = (id: string): string => id.slice(id.lastIndexOf("/") + 1) || id;

/**
 * Prefer the windowed editor (Pi TUI and pi-web). Hosts that cannot create custom
 * components receive small page-by-page dialogs, never one very long list.
 */
export async function collectSetup(ctx: ExtensionCommandContext, input: SetupInput): Promise<SetupResult> {
  const catalog = ctx.modelRegistry.getAvailable().map(({ provider, id }) => ({ provider, id }));
  const editor = new ChainEditor({ catalog, chain: input.chain, options: input.options, limit: input.limit });
  let rendered = false;
  if (typeof ctx.ui.custom === "function") {
    try {
      const result = await ctx.ui.custom<SetupResult>((tui, theme, keybindings, done) => {
        rendered = true;
        return new ChainPicker(editor, { host: tui, theme: theme as unknown as ThemeLike, keybindings, done, file: input.file });
      });
      if (result) return result;
      // The factory ran but no result arrived: the host closed or aborted the screen.
      if (rendered) return { kind: "cancel" };
    } catch {
      if (rendered) throw new Error("The setup screen stopped unexpectedly.");
    }
  }
  return pagedSetup(ctx, editor);
}

async function pick(ctx: ExtensionCommandContext, title: string, labels: readonly string[]): Promise<number | undefined> {
  const pages = Math.max(1, Math.ceil(labels.length / PAGE_SIZE));
  const previous = "◀ Previous page";
  const next = "Next page ▶";
  const back = "↩ Back";
  let page = 0;
  for (;;) {
    const start = page * PAGE_SIZE;
    const visible = labels.slice(start, start + PAGE_SIZE);
    const options = [...visible, ...(page > 0 ? [previous] : []), ...(page < pages - 1 ? [next] : []), back];
    const selected = await ctx.ui.select(pages > 1 ? `${title} (page ${page + 1}/${pages})` : title, options);
    if (selected === undefined || selected === back) return undefined;
    if (selected === previous) page -= 1;
    else if (selected === next) page += 1;
    else {
      const index = visible.indexOf(selected);
      return index >= 0 ? start + index : undefined;
    }
  }
}

async function pagedSetup(ctx: ExtensionCommandContext, editor: ChainEditor): Promise<SetupResult> {
  for (;;) {
    const order = editor.chain.length ? editor.chain.map((item) => lastSegment(item.id)).join(" → ") : "none (fallback disabled)";
    const action = await ctx.ui.select(`Fallback order: ${order}`, ["Add a model", "Remove a model", "Move a model", "Settings", "Save", "Cancel"]);
    if (action === undefined || action === "Cancel") {
      if (editor.dirty && !(await ctx.ui.confirm("Discard changes?", "The fallback list has unsaved changes."))) continue;
      return { kind: "cancel" };
    }
    if (action === "Save") {
      const preview = editor.chain.length ? editor.chain.map(modelLabel).join("\n→ ") : "Disable automatic fallback (empty list).";
      if (await ctx.ui.confirm("Save fallback configuration?", `${preview}\n\nEvery listed provider receives the conversation context.`)) return editor.result();
    } else if (action === "Add a model") {
      const providers = [...new Set(editor.catalogEntries.map((entry) => entry.provider))];
      const providerIndex = await pick(ctx, "Provider", providers);
      if (providerIndex === undefined) continue;
      const models = editor.catalogEntries.filter((entry) => entry.provider === providers[providerIndex] && editor.position(entry) === 0);
      if (models.length === 0) {
        ctx.ui.notify("Every model from that provider is already in the list.", "info");
        continue;
      }
      const modelIndex = await pick(ctx, `Add from ${providers[providerIndex]}`, models.map((entry) => entry.id));
      if (modelIndex !== undefined && !editor.addEntry(models[modelIndex])) ctx.ui.notify("The list is full.", "warning");
    } else if (action === "Remove a model" || action === "Move a model") {
      if (editor.chain.length === 0) {
        ctx.ui.notify("The list is empty.", "info");
        continue;
      }
      const index = await pick(ctx, action === "Move a model" ? "Move which model?" : "Remove which model?", editor.chain.map((item, position) => `${position + 1}. ${modelLabel(item)}`));
      if (index === undefined) continue;
      if (action === "Remove a model") editor.removeAt(index);
      else {
        const move = await ctx.ui.select(`Move ${editor.chain[index].id}`, ["Move up", "Move down", "Move to top", "Move to bottom", "↩ Back"]);
        if (move === "Move up") editor.moveItem(index, index - 1);
        else if (move === "Move down") editor.moveItem(index, index + 1);
        else if (move === "Move to top") editor.moveItem(index, 0);
        else if (move === "Move to bottom") editor.moveItem(index, editor.chain.length - 1);
      }
    } else if (action === "Settings") {
      const rows = OPTION_ROWS.map((row) => `[${editor.options[row.key] ? "x" : " "}] ${row.label}`);
      const index = await pick(ctx, "Toggle a setting", rows);
      if (index !== undefined) editor.setOption(OPTION_ROWS[index].key, !editor.options[OPTION_ROWS[index].key]);
    }
  }
}
