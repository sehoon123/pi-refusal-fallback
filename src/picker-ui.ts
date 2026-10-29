import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ChainEditor, OPTION_ROWS, optionValue, TABS, type SetupResult, type Tab } from "./picker-model.ts";
import { modelLabel } from "./refusal.ts";

export interface PickerHost {
  requestRender(): void;
  terminal?: { rows?: number; columns?: number };
}
export interface KeybindingsLike { matches(data: string, id: string): boolean }
export interface ThemeLike {
  fg(color: never, text: string): string;
  bold(text: string): string;
}
export interface PickerContext {
  host: PickerHost;
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  done(result: SetupResult): void;
  file: string;
}

const TAB_TITLES: Record<Tab, string> = { models: "Models", order: "Order", options: "Options", review: "Review" };
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const lastSegment = (id: string): string => id.slice(id.lastIndexOf("/") + 1) || id;
/** Output line where the first list row is drawn (title, tab bar, prompt). */
const LIST_TOP = 3;

/**
 * Bounded editor for the fallback order. The visible list is a window around the
 * cursor, so it works with hosts that render only text lines (Pi TUI and pi-web).
 */
export class ChainPicker implements Component {
  private readonly filterInput = new Input();
  private readonly editor: ChainEditor;
  private readonly context: PickerContext;
  private closed = false;

  constructor(editor: ChainEditor, context: PickerContext) {
    this.editor = editor;
    this.context = context;
  }

  invalidate(): void {}
  dispose(): void { this.closed = true; }

  private paint(color: string, text: string): string {
    try { return this.context.theme.fg(color as never, text); } catch { return text; }
  }
  private strong(text: string): string {
    try { return this.context.theme.bold(text); } catch { return text; }
  }
  private get listRows(): number {
    return clamp((this.context.host.terminal?.rows ?? 24) - 14, 3, 12);
  }

  render(width: number): string[] {
    const columns = Math.max(24, Math.floor(width));
    try {
      return this.draw(columns);
    } catch {
      return [truncateToWidth("Fallback setup could not be drawn. Press Esc to close.", columns, "…")];
    }
  }

  private draw(width: number): string[] {
    const editor = this.editor;
    const rows = this.listRows;
    const fit = (line: string): string => truncateToWidth(line, width, "…");
    const out: string[] = [
      fit(this.strong(this.paint("accent", "Fallback model setup")) + (editor.dirty ? this.paint("warning", "   ● unsaved changes") : "")),
      fit(this.tabBar()),
      fit(this.promptLine()),
    ];
    const list = editor.tab === "review" ? this.reviewLines(rows) : this.listLines(rows, width);
    // Only the searchable list keeps a fixed height, so typing a filter does not make the screen jump.
    // Short tabs stay compact instead of leaving a tall empty gap.
    const height = editor.tab === "models" ? rows : Math.min(rows, 4);
    while (list.length < height) list.push("");
    // Options explain the highlighted row below the list, so they may use a little more than the usual four lines.
    out.push(...list.slice(0, editor.tab === "options" ? Math.max(rows, 9) : rows).map(fit));
    out.push(fit(this.indicator(rows)));
    out.push("");
    out.push(fit(this.summary()));
    const help = this.helpLines(width);
    while (help.length < 2) help.push("");
    out.push(...help);
    return out;
  }

  private tabTitle(tab: Tab): string {
    const title = tab === "order" ? `Order (${this.editor.chain.length})` : TAB_TITLES[tab];
    return tab === this.editor.tab ? `[${title}]` : ` ${title} `;
  }

  private tabBar(): string {
    return TABS.map((tab) => {
      const text = this.tabTitle(tab);
      return tab === this.editor.tab ? this.strong(this.paint("accent", text)) : this.paint("muted", text);
    }).join(" ");
  }

  private promptLine(): string {
    const editor = this.editor;
    if (editor.tab === "models") {
      const filter = editor.filter
        ? `${editor.filter}▌`
        : `▌${this.paint("dim", "type to search by provider or model")}`;
      return `Filter: ${filter}${this.paint("dim", `   ${editor.models.length}/${editor.catalogSize}`)}`;
    }
    if (editor.tab === "order") return this.paint("dim", "Fallbacks are tried from top to bottom after a refusal.");
    if (editor.tab === "options") return this.paint("dim", "Enter or Space changes the highlighted setting (choices cycle).");
    return this.paint("dim", "Check the result, then press Enter to save.");
  }

  private row(selected: boolean, text: string, marker = "→ "): string {
    return selected ? this.paint("accent", marker) + this.paint("accent", text) : `  ${text}`;
  }

  private listLines(rows: number, width: number): string[] {
    const editor = this.editor;
    const { top, end } = editor.window(rows);
    const cursor = editor.cursor();
    const lines: string[] = [];
    if (editor.tab === "models") {
      if (editor.catalogSize === 0) return [this.paint("warning", "  No authenticated models are available. Configure providers in Pi first.")];
      if (editor.models.length === 0) return [this.paint("dim", "  No matching models. Press Esc to clear the filter.")];
      for (let index = top; index < end; index += 1) {
        const entry = editor.models[index];
        const position = editor.position(entry);
        const marker = (position ? `[${position}]` : "[ ]").padEnd(5);
        lines.push(this.row(index === cursor, `${marker} ${modelLabel(entry)}`));
      }
    } else if (editor.tab === "order") {
      if (editor.chain.length === 0) return [this.paint("dim", "  No fallback models yet. Open Models and press Enter on a model.")];
      for (let index = top; index < end; index += 1) {
        const item = editor.chain[index];
        const text = `${String(index + 1).padStart(2)}. ${modelLabel(item)}`;
        const suffix = item.available ? "" : this.paint("warning", "  (unavailable: kept until removed)");
        lines.push(this.row(index === cursor, text, editor.grabbed && index === cursor ? "↕ " : "→ ") + suffix);
      }
    } else {
      OPTION_ROWS.forEach((option, index) => lines.push(this.row(index === cursor, optionValue(editor.options, option))));
      // Explain the highlighted setting; wrapped so it stays readable on narrow terminals and in pi-web.
      lines.push("");
      for (const line of wrapTextWithAnsi(OPTION_ROWS[cursor]?.hint ?? "", Math.max(20, width - 2)).slice(0, 4)) lines.push(this.paint("dim", `  ${line}`));
    }
    return lines;
  }

  private reviewLines(rows: number): string[] {
    const editor = this.editor;
    const chain = editor.chain;
    const capacity = Math.max(1, rows - 5);
    const lines = [chain.length
      ? this.strong(`Save ${chain.length} fallback model${chain.length === 1 ? "" : "s"}?`)
      : this.strong("Save an empty list? Automatic fallback will be disabled.")];
    chain.slice(0, capacity).forEach((item, index) => lines.push(`  ${String(index + 1).padStart(2)}. ${modelLabel(item)}${item.available ? "" : "  (unavailable)"}`));
    if (chain.length > capacity) lines.push(this.paint("dim", `  … and ${chain.length - capacity} more`));
    const on = (value: boolean): string => (value ? "on" : "off");
    lines.push(this.paint("dim", `Settings: notices ${on(editor.options.retryMessages)} · status ${on(editor.options.showStatus)} · warnings ${on(editor.options.notifications)} · partial output: ${editor.options.carryPartial}`));
    lines.push(this.paint("warning", "Every listed provider receives the conversation context."));
    lines.push(this.paint("dim", `File: ${this.context.file}  (an existing file is kept as .bak)`));
    return lines;
  }

  private indicator(rows: number): string {
    const editor = this.editor;
    if (editor.message) return this.paint("warning", editor.message);
    if (editor.tab === "review") return "";
    const count = editor.length();
    if (count <= rows) return "";
    const { top, end } = editor.window(rows);
    return this.paint("dim", `  ↑ ${top} above · ↓ ${count - end} below · ${editor.cursor() + 1}/${count}`);
  }

  private summary(): string {
    const chain = this.editor.chain;
    if (chain.length === 0) return this.paint("dim", "Order: none (automatic fallback is disabled)");
    return `Order: ${chain.map((item) => lastSegment(item.id) + (item.available ? "" : "!")).join(" → ")}`;
  }

  private helpLines(width: number): string[] {
    const editor = this.editor;
    const common = ["Tab/←→ section", "Ctrl+S save", "Esc cancel"];
    const parts = editor.tab === "models"
      ? ["type to filter", "↑↓ move", "Enter add/remove", ...common]
      : editor.tab === "order"
        ? editor.grabbed
          ? ["↑↓ reorder", "Enter drop", "Esc undo move"]
          : ["↑↓ move", "Enter pick up", "Del remove", ...common]
        : editor.tab === "options"
          ? ["↑↓ move", "Enter/Space toggle", ...common]
          : ["Enter save", "Shift+Tab back", "Esc cancel"];
    const lines: string[] = [];
    let current = "";
    for (const part of parts) {
      const next = current ? `${current} · ${part}` : part;
      if (current && visibleWidth(next) > width) {
        lines.push(current);
        current = part;
      } else current = next;
    }
    if (current) lines.push(current);
    return lines.slice(0, 3).map((line) => this.paint("dim", truncateToWidth(line, width, "…")));
  }

  /** Fullscreen terminals route the wheel and clicks here; without it the transcript would scroll instead. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return undefined;
    const editor = this.editor;
    if (event.type === "wheel" && event.wheelDelta) {
      editor.message = "";
      const steps = Math.min(6, Math.max(1, Math.abs(Math.trunc(event.wheelDelta))));
      editor.jump(editor.cursor() + (event.wheelDelta < 0 ? -steps : steps));
      return { handled: true, render: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    editor.message = "";
    editor.confirmDiscard = false;
    if (event.y === 1) {
      let start = 0;
      for (const tab of TABS) {
        const end = start + visibleWidth(this.tabTitle(tab));
        if (event.x >= start && event.x < end) { editor.gotoTab(tab); return { handled: true, render: true }; }
        start = end + 1;
      }
      return { handled: true };
    }
    if (editor.tab === "review") return undefined;
    const rows = this.listRows;
    const { top, end } = editor.window(rows);
    const index = top + event.y - LIST_TOP;
    if (event.y < LIST_TOP || index < top || index >= end) return undefined;
    if (index === editor.cursor() && !editor.grabbed) editor.activate();
    else editor.select(index);
    return { handled: true, render: true };
  }

  handleInput(data: string): void {
    if (this.closed) return;
    try {
      this.dispatch(data);
    } catch {
      this.finish({ kind: "cancel" });
    }
    if (!this.closed) this.context.host.requestRender();
  }

  private finish(result: SetupResult): void {
    if (this.closed) return;
    this.closed = true;
    this.context.done(result);
  }

  private dispatch(data: string): void {
    const editor = this.editor;
    const kb = this.context.keybindings;
    const cancel = kb.matches(data, "tui.select.cancel");
    editor.message = "";
    if (!cancel) editor.confirmDiscard = false;
    // Ctrl+C (and the web Close button, which sends it) is an explicit abort. Esc asks first.
    if (cancel && !matchesKey(data, Key.escape)) return this.finish({ kind: "cancel" });
    if (cancel) return this.cancel(true);
    if (matchesKey(data, Key.ctrl("s"))) return this.finish(editor.result());
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return editor.cycleTab(1);
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return editor.cycleTab(-1);
    if (kb.matches(data, "tui.select.up")) return editor.move(-1);
    if (kb.matches(data, "tui.select.down")) return editor.move(1);
    if (kb.matches(data, "tui.select.pageUp")) return editor.page(-1, this.listRows);
    if (kb.matches(data, "tui.select.pageDown")) return editor.page(1, this.listRows);
    if (matchesKey(data, Key.home)) return editor.jump(0);
    if (matchesKey(data, Key.end)) return editor.jump(Number.MAX_SAFE_INTEGER);
    if (kb.matches(data, "tui.select.confirm")) {
      if (editor.activate()) this.finish(editor.result());
      return;
    }
    if (editor.tab === "order" && (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace) || data === "x")) return editor.removeCurrent();
    if (editor.tab === "options" && data === " ") return editor.toggleOption();
    if (editor.tab === "models") {
      this.filterInput.handleInput(data);
      editor.setFilter(this.filterInput.getValue());
    }
  }

  private cancel(isEscape: boolean): void {
    const editor = this.editor;
    if (editor.cancelGrab()) return;
    if (isEscape && editor.tab === "models" && editor.filter) {
      this.filterInput.setValue("");
      editor.setFilter("");
      return;
    }
    if (editor.dirty && !editor.confirmDiscard) {
      editor.confirmDiscard = true;
      editor.message = "Unsaved changes. Press Esc again to discard them, or Ctrl+S to save.";
      return;
    }
    this.finish({ kind: "cancel" });
  }
}
