import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { readConfiguration } from "../src/config.ts";
import { registerCommands } from "../src/commands.ts";

const KEY = { up: "\x1b[A", down: "\x1b[B", tab: "\t", shiftTab: "\x1b[Z", enter: "\r", esc: "\x1b", ctrlS: "\x13", space: " " };
const first = { provider: "one", id: "model-a" };
const second = { provider: "two", id: "organization/model-b" };
const theme = { fg: (_color, text) => text, bold: (text) => text };
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

async function harness(t, { models = [first, second], selections = [], confirm = true, busy = false, hasUI = true, custom = "none", keys = [], preset } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-fallback-command-"));
  const saved = { chain: process.env.PI_REFUSAL_FALLBACK_CHAIN, config: process.env.PI_REFUSAL_FALLBACK_CONFIG };
  delete process.env.PI_REFUSAL_FALLBACK_CHAIN;
  process.env.PI_REFUSAL_FALLBACK_CONFIG = join(dir, "settings.json");
  t.after(async () => {
    for (const [name, value] of [["PI_REFUSAL_FALLBACK_CHAIN", saved.chain], ["PI_REFUSAL_FALLBACK_CONFIG", saved.config]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  if (preset) await writeFile(process.env.PI_REFUSAL_FALLBACK_CONFIG, JSON.stringify(preset));
  const messages = [];
  const dialogs = [];
  const customCalls = [];
  const scripts = [...keys];
  let config = { source: "none", chain: [] };
  let error;
  let handler;
  let completions;
  const state = {
    getConfig: () => config, getError: () => error, getLastSummary: () => "Last run: completed.",
    isBusy: () => (typeof busy === "function" ? busy() : busy),
    reload: () => {
      try { config = readConfiguration({ agentDir: dir }); error = undefined; }
      catch (value) { config = { source: "none", chain: [] }; error = value.message; }
    },
    clearStatus: () => undefined,
  };
  registerCommands({ registerCommand: (_name, command) => { handler = command.handler; completions = command.getArgumentCompletions; } }, dir, state);
  state.reload();
  const ui = {
    notify: (message, severity) => messages.push({ message, severity }),
    select: async (title, options) => {
      dialogs.push({ title, options: [...options] });
      const value = selections.shift();
      return typeof value === "function" ? value(options) : value;
    },
    confirm: async () => (typeof confirm === "function" ? confirm() : confirm),
  };
  if (custom === "host") {
    ui.custom = async (factory) => {
      const script = scripts.shift() ?? [];
      let result;
      const component = await factory({ requestRender() {}, terminal: { rows: 24, columns: 100 } }, theme, keybindings, (value) => { result = value; });
      customCalls.push(component);
      for (const key of script) {
        if (typeof key === "function") await key();
        else component.handleInput(key);
        if (result) break;
      }
      component.dispose?.();
      return result;
    };
  } else if (custom === "unsupported") {
    ui.custom = async () => undefined; // plain RPC hosts resolve without ever calling the factory
  } else if (custom === "throws") {
    ui.custom = async () => { throw new Error("custom components are unavailable"); };
  }
  const ctx = {
    hasUI, isIdle: () => true,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    },
    ui,
  };
  return { dir, path: process.env.PI_REFUSAL_FALLBACK_CONFIG, run: (args) => handler(args, ctx), completions: (prefix) => completions(prefix), state, messages, dialogs, customCalls };
}
const choose = (needle) => (options) => options.find((option) => option.includes(needle));

test("setup opens one windowed screen, orders models and applies the saved file immediately", async (t) => {
  const h = await harness(t, { custom: "host", keys: [[KEY.down, KEY.enter, KEY.up, KEY.enter, KEY.ctrlS]] });
  await h.run("setup");
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")), { chain: [second, first] });
  assert.deepEqual(h.state.getConfig().chain, [second, first]);
  assert.equal(h.dialogs.length, 0, "no long select dialog is ever opened");
  const saved = h.messages.find((message) => message.message.includes("Saved 2 fallback model(s): model-b → model-a"));
  assert.ok(saved);
  assert.ok(!saved.message.includes(".bak"), "a first save has no previous file to mention");
});

test("setup starts from the current order, so an unchanged save writes nothing", async (t) => {
  const h = await harness(t, { custom: "host", preset: { chain: [second, first] }, keys: [[KEY.ctrlS]] });
  const before = await readFile(h.path, "utf8");
  await h.run("setup");
  assert.equal(await readFile(h.path, "utf8"), before);
  assert.deepEqual((await readdir(h.dir)).sort(), ["settings.json"], "not even a .bak file");
  assert.ok(h.messages.some((message) => message.message === "No changes to save."));
});

test("editing an existing order preserves untouched entries, backs up, and keeps non-default UI choices", async (t) => {
  const retired = { provider: "retired", id: "legacy" };
  const h = await harness(t, { custom: "host", preset: { chain: [first, retired], showStatus: false },
    keys: [[KEY.tab, KEY.enter, KEY.down, KEY.ctrlS]] });
  const before = await readFile(h.path, "utf8");
  await h.run("setup");
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")), { chain: [retired, first], showStatus: false });
  assert.equal(await readFile(`${h.path}.bak`, "utf8"), before);
  assert.ok(h.messages.some((message) => message.message.includes("The previous file was kept as .bak.")));
});

test("Options tab changes are saved as explicit false values only", async (t) => {
  const h = await harness(t, { custom: "host", keys: [[KEY.enter, KEY.tab, KEY.tab, KEY.enter, KEY.down, KEY.down, KEY.space, KEY.ctrlS]] });
  await h.run("setup");
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")), { chain: [first], retryMessages: false, notifications: false });
});

test("cancelling, double-Esc discard and a host-closed screen never write", async (t) => {
  for (const keys of [[KEY.esc], [KEY.enter, KEY.esc, KEY.esc], []]) {
    const h = await harness(t, { custom: "host", keys: [keys] });
    await h.run("setup");
    assert.deepEqual(await readdir(h.dir), [], JSON.stringify(keys));
  }
});

test("a run that starts while the screen is open prevents a late write", async (t) => {
  let busy = false;
  const h = await harness(t, { custom: "host", busy: () => busy, keys: [[KEY.enter, () => { busy = true; }, KEY.ctrlS]] });
  await h.run("setup");
  assert.deepEqual(await readdir(h.dir), []);
  assert.ok(h.messages.some((message) => message.message.includes("No configuration was written")));
});

test("overlapping setup commands are rejected and the lock is released afterwards", async (t) => {
  let release;
  const h = await harness(t, { custom: "host", keys: [[() => new Promise((resolve) => { release = resolve; })]] });
  const original = h.run("setup");
  await new Promise((resolve) => setImmediate(resolve));
  await h.run("setup");
  await h.run("reload");
  assert.ok(h.messages.every((message) => message.message.includes("already open")));
  release?.();
  await original;
  await h.run("reload");
  assert.ok(!h.messages.at(-1).message.includes("already open"));
});

test("clients without custom components get small pages instead of one long list", async (t) => {
  const many = Array.from({ length: 23 }, (_, i) => ({ provider: "bulk", id: `model-${String(i).padStart(2, "0")}` }));
  const h = await harness(t, { custom: "unsupported", models: many, selections: [
    "Add a model",
    choose("bulk"),                        // provider
    "Next page ▶", "Next page ▶", "Next page ▶", // fourth page
    choose("model-21"),
    "Save",
  ] });
  await h.run("setup");
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")).chain, [{ provider: "bulk", id: "model-21" }]);
  assert.ok(h.dialogs.every((dialog) => dialog.options.length <= 10), `largest dialog: ${Math.max(...h.dialogs.map((d) => d.options.length))}`);
  const pager = h.dialogs.filter((dialog) => /page \d\/\d/.test(dialog.title));
  assert.deepEqual(pager.map((dialog) => dialog.title.match(/page \d\/\d/)[0]), ["page 1/4", "page 2/4", "page 3/4", "page 4/4"]);
});

test("page-by-page setup can remove, reorder, change settings and cancel without writing", async (t) => {
  const h = await harness(t, { custom: "unsupported", preset: { chain: [first, second] }, selections: [
    "Move a model", choose("1. one/model-a"), "Move down",
    "Remove a model", choose("two/organization/model-b"),
    "Settings", choose("retry notices"),
    "Save",
  ] });
  await h.run("setup");
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")), { chain: [first], retryMessages: false });
  const cancelled = await harness(t, { custom: "unsupported", selections: ["Add a model", choose("one"), choose("model-a"), "Cancel"], confirm: true });
  await cancelled.run("setup");
  assert.deepEqual(await readdir(cancelled.dir), []);
});

test("a custom-component failure before rendering falls back to the page flow", async (t) => {
  const h = await harness(t, { custom: "throws", selections: ["Add a model", choose("one"), choose("model-a"), "Save"] });
  await h.run("setup");
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")).chain, [first]);
});

test("an environment chain is reported instead of saving an ignored file", async (t) => {
  const h = await harness(t, { custom: "host", keys: [[KEY.ctrlS]] });
  process.env.PI_REFUSAL_FALLBACK_CHAIN = "one/model-a";
  await h.run("setup");
  assert.equal(h.customCalls.length, 0);
  assert.deepEqual(await readdir(h.dir), []);
  assert.ok(h.messages.some((message) => message.message.includes("overrides files")));
});

test("setup without an authenticated model explains the next step", async (t) => {
  const h = await harness(t, { custom: "host", models: [] });
  await h.run("setup");
  assert.equal(h.customCalls.length, 0);
  assert.ok(h.messages.some((message) => message.message.includes("No authenticated models")));
});

test("non-interactive hosts do not open anything", async (t) => {
  const h = await harness(t, { custom: "host", hasUI: false });
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try { await h.run("setup"); } finally { console.error = original; }
  assert.equal(h.customCalls.length, 0);
  assert.ok(errors.some((message) => message.includes("interactive UI")));
});

test("reload and setup are blocked while a model run is active", async (t) => {
  const h = await harness(t, { custom: "host", busy: true });
  await h.run("reload");
  await h.run("setup");
  assert.equal(h.customCalls.length, 0);
  assert.ok(h.messages.every((message) => message.message.includes("Wait for the active run")));
});

test("argument completion suggests the three subcommands", async (t) => {
  const h = await harness(t);
  assert.deepEqual(h.completions("").map((item) => item.value), ["status", "setup", "reload"]);
  assert.deepEqual(h.completions("s").map((item) => item.value), ["status", "setup"]);
  assert.deepEqual(h.completions("RE").map((item) => item.value), ["reload"]);
  assert.equal(h.completions("zzz"), null);
  // Regression: with the whole word typed, a lingering popup made the first Enter a no-op.
  for (const word of ["status", "setup", "reload", " Setup "]) assert.equal(h.completions(word), null, word);
});

test("status shows readiness, file and the setup hint without opening a dialog", async (t) => {
  const h = await harness(t, { custom: "host", preset: { chain: [first, { provider: "gone", id: "x" }] } });
  await h.run("");
  const text = h.messages.at(-1).message;
  assert.match(text, /1\. one\/model-a\n2\. gone\/x \[missing model\]/);
  assert.match(text, /Last run: completed\./);
  assert.ok(text.includes(`File: ${h.path}`));
  assert.match(text, /\/refusal-fallback setup/);
  assert.equal(h.customCalls.length, 0);
  assert.equal(h.dialogs.length, 0);
});
