import { fuzzyFilter } from "@earendil-works/pi-tui";
import { CARRY_MODES, type CarryMode, type ChainEntry } from "./config.ts";
import { modelKey, modelLabel } from "./refusal.ts";

export interface PickerOptions {
  retryMessages: boolean;
  showStatus: boolean;
  notifications: boolean;
  carryPartial: CarryMode;
}
export type Tab = "models" | "order" | "options" | "review";
export const TABS: readonly Tab[] = ["models", "order", "options", "review"];
export type OptionRow =
  | { kind: "toggle"; key: "retryMessages" | "showStatus" | "notifications"; label: string; hint: string }
  | { kind: "choice"; key: "carryPartial"; label: string; hint: string };
export const OPTION_ROWS: readonly OptionRow[] = [
  { kind: "toggle", key: "retryMessages", label: "Show retry notices in the transcript",
    hint: "A one-line notice after each retry. It is shown to you only and is never sent to a model." },
  { kind: "toggle", key: "showStatus", label: "Show fallback progress in the status area",
    hint: "Footer text while a fallback runs. A clean run clears it; unusual endings keep it until the next run." },
  { kind: "toggle", key: "notifications", label: "Show routine warnings (for example, chain exhausted)",
    hint: "Critical problems such as a failed model restore are always shown." },
  { kind: "choice", key: "carryPartial", label: "Pass interrupted partial output to the next model",
    hint: "off: the next model starts that response from scratch. cross-provider: pass the visible partial reasoning and answer only when the next model uses a different provider. Same-provider handoff is not offered: a provider can block its own output being sent back to it. Passed text is labelled as untrusted notes." },
];
export const optionValue = (options: PickerOptions, row: OptionRow): string =>
  row.kind === "toggle" ? `[${options[row.key] ? "x" : " "}] ${row.label}` : `${row.label}: ${options[row.key]}`;
export interface OrderItem extends ChainEntry { available: boolean }
export type SetupResult =
  | { kind: "save"; chain: ChainEntry[]; options: PickerOptions }
  | { kind: "cancel" };
export interface EditorInit {
  /** Authenticated models that can actually be selected as fallback targets. */
  catalog: readonly ChainEntry[];
  chain: readonly ChainEntry[];
  options: PickerOptions;
  limit: number;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const label = (entry: ChainEntry): string => modelLabel(entry);
const signature = (chain: readonly ChainEntry[]): string => chain.map(modelKey).join("\n");

/**
 * UI-independent editing state. A list window is derived from the cursor, so the
 * selected row can never leave the visible part of a list.
 */
export class ChainEditor {
  tab: Tab = "models";
  grabbed = false;
  message = "";
  confirmDiscard = false;
  chain: OrderItem[];
  options: PickerOptions;
  private readonly catalog: ChainEntry[];
  private readonly available: Set<string>;
  private readonly limit: number;
  private readonly initialChain: string;
  private readonly initialOptions: string;
  private filterText = "";
  private filteredCache: ChainEntry[];
  private grabSnapshot?: { chain: OrderItem[]; cursor: number };
  private readonly cursors: Record<Tab, number> = { models: 0, order: 0, options: 0, review: 0 };
  private readonly tops: Record<Tab, number> = { models: 0, order: 0, options: 0, review: 0 };

  constructor(init: EditorInit) {
    this.catalog = [...init.catalog].sort((a, b) => label(a).toLowerCase().localeCompare(label(b).toLowerCase()) || label(a).localeCompare(label(b)));
    this.available = new Set(this.catalog.map(modelKey));
    this.limit = init.limit;
    this.chain = init.chain.map((entry) => ({ provider: entry.provider, id: entry.id, available: this.available.has(modelKey(entry)) }));
    this.options = { ...init.options };
    this.initialChain = signature(this.chain);
    this.initialOptions = JSON.stringify(this.options);
    this.filteredCache = this.catalog;
    this.cursors.order = 0;
  }

  get filter(): string { return this.filterText; }
  get catalogSize(): number { return this.catalog.length; }
  get catalogEntries(): readonly ChainEntry[] { return this.catalog; }
  get dirty(): boolean {
    return signature(this.chain) !== this.initialChain || JSON.stringify(this.options) !== this.initialOptions;
  }
  get models(): readonly ChainEntry[] { return this.filteredCache; }
  cursor(tab: Tab = this.tab): number { return this.cursors[tab]; }
  length(tab: Tab = this.tab): number {
    return tab === "models" ? this.filteredCache.length : tab === "order" ? this.chain.length : tab === "options" ? OPTION_ROWS.length : 0;
  }
  position(entry: ChainEntry): number {
    const key = modelKey(entry);
    return this.chain.findIndex((item) => modelKey(item) === key) + 1;
  }

  setFilter(value: string): void {
    if (value === this.filterText) return;
    this.filterText = value;
    const query = value.trim();
    this.filteredCache = query ? fuzzyFilter([...this.catalog], query, label) : this.catalog;
    this.cursors.models = 0;
    this.tops.models = 0;
  }

  /** Returns top/end indexes of the list rows to draw. */
  window(rows: number, tab: Tab = this.tab): { top: number; end: number } {
    const count = this.length(tab);
    const size = Math.max(1, rows);
    const cursor = clamp(this.cursors[tab], 0, Math.max(0, count - 1));
    this.cursors[tab] = cursor;
    let top = this.tops[tab];
    if (cursor < top) top = cursor;
    else if (cursor >= top + size) top = cursor - size + 1;
    top = clamp(top, 0, Math.max(0, count - size));
    this.tops[tab] = top;
    return { top, end: Math.min(count, top + size) };
  }

  cycleTab(direction: 1 | -1): void {
    this.dropGrab();
    this.message = "";
    const index = TABS.indexOf(this.tab);
    this.tab = TABS[(index + direction + TABS.length) % TABS.length];
  }

  move(delta: -1 | 1): void {
    const count = this.length();
    if (count === 0) return;
    const cursor = this.cursors[this.tab];
    if (this.tab === "order" && this.grabbed) {
      const target = clamp(cursor + delta, 0, count - 1);
      if (target !== cursor) {
        [this.chain[cursor], this.chain[target]] = [this.chain[target], this.chain[cursor]];
        this.cursors.order = target;
      }
      return;
    }
    this.cursors[this.tab] = (cursor + delta + count) % count;
  }

  jump(target: number): void {
    const count = this.length();
    if (count === 0) return;
    const next = clamp(target, 0, count - 1);
    if (this.tab === "order" && this.grabbed) {
      const cursor = this.cursors.order;
      const [item] = this.chain.splice(cursor, 1);
      this.chain.splice(next, 0, item);
    }
    this.cursors[this.tab] = next;
  }

  /** Mouse selection: point the cursor at a row without activating it. */
  select(index: number): void {
    const count = this.length();
    if (count === 0 || this.grabbed) return;
    this.cursors[this.tab] = clamp(index, 0, count - 1);
  }

  gotoTab(tab: Tab): void {
    if (tab === this.tab) return;
    this.dropGrab();
    this.message = "";
    this.tab = tab;
  }

  page(direction: -1 | 1, rows: number): void { this.jump(this.cursors[this.tab] + direction * Math.max(1, rows - 1)); }

  /** Enter on the current row. Returns true when the Review tab asked to save. */
  activate(): boolean {
    this.message = "";
    if (this.tab === "models") this.toggleModel();
    else if (this.tab === "order") this.grabbed ? this.dropGrab() : this.pickUp();
    else if (this.tab === "options") this.toggleOption();
    else return true;
    return false;
  }

  toggleOption(): void {
    if (this.tab === "options") this.cycleOption(this.cursors.options);
  }

  /** Toggle a switch, or step a choice through its values (wrapping). */
  cycleOption(index: number): void {
    const row = OPTION_ROWS[index];
    if (!row) return;
    if (row.kind === "toggle") this.options[row.key] = !this.options[row.key];
    else this.options.carryPartial = CARRY_MODES[(CARRY_MODES.indexOf(this.options.carryPartial) + 1) % CARRY_MODES.length];
  }

  removeCurrent(): void {
    if (this.tab !== "order" || this.grabbed || this.chain.length === 0) return;
    const [removed] = this.chain.splice(this.cursors.order, 1);
    this.cursors.order = clamp(this.cursors.order, 0, Math.max(0, this.chain.length - 1));
    this.message = `Removed ${label(removed)}.`;
  }

  /** Esc while moving restores the pre-move order. */
  cancelGrab(): boolean {
    if (!this.grabSnapshot) return false;
    this.chain = this.grabSnapshot.chain;
    this.cursors.order = this.grabSnapshot.cursor;
    this.grabSnapshot = undefined;
    this.grabbed = false;
    this.message = "Move cancelled.";
    return true;
  }

  /** Programmatic edits used by the page-by-page fallback for clients without custom components. */
  addEntry(entry: ChainEntry): boolean {
    const key = modelKey(entry);
    if (this.chain.length >= this.limit || this.chain.some((item) => modelKey(item) === key)) return false;
    this.chain.push({ provider: entry.provider, id: entry.id, available: this.available.has(key) });
    return true;
  }

  removeAt(index: number): void {
    if (index >= 0 && index < this.chain.length) this.chain.splice(index, 1);
  }

  moveItem(from: number, to: number): void {
    if (from < 0 || from >= this.chain.length) return;
    const target = clamp(to, 0, this.chain.length - 1);
    const [item] = this.chain.splice(from, 1);
    this.chain.splice(target, 0, item);
  }

  result(): SetupResult {
    return { kind: "save", chain: this.chain.map(({ provider, id }) => ({ provider, id })), options: { ...this.options } };
  }

  private toggleModel(): void {
    const entry = this.filteredCache[this.cursors.models];
    if (!entry) return;
    const key = modelKey(entry);
    const index = this.chain.findIndex((item) => modelKey(item) === key);
    if (index >= 0) {
      this.chain.splice(index, 1);
      this.message = `Removed ${label(entry)}.`;
      this.cursors.order = clamp(this.cursors.order, 0, Math.max(0, this.chain.length - 1));
    } else if (this.chain.length >= this.limit) {
      this.message = `The chain is limited to ${this.limit} models.`;
    } else {
      this.chain.push({ provider: entry.provider, id: entry.id, available: true });
      this.message = `Added as fallback #${this.chain.length}.`;
    }
  }

  private pickUp(): void {
    if (this.chain.length === 0) return;
    this.grabbed = true;
    this.grabSnapshot = { chain: this.chain.map((item) => ({ ...item })), cursor: this.cursors.order };
    this.message = "Picked up: ↑↓ reorder, Enter drop, Esc undo.";
  }

  private dropGrab(): void {
    this.grabbed = false;
    this.grabSnapshot = undefined;
  }
}
