import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfiguration } from "../src/config.ts";
import { registerCommands } from "../src/commands.ts";

const first = { provider: "one", id: "model-a" };
const second = { provider: "two", id: "organization/model-b" };
async function harness(t, { selections = [], confirm = true, busy = false, hasUI = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-fallback-command-"));
  const oldChain = process.env.PI_REFUSAL_FALLBACK_CHAIN;
  const oldPath = process.env.PI_REFUSAL_FALLBACK_CONFIG;
  delete process.env.PI_REFUSAL_FALLBACK_CHAIN;
  process.env.PI_REFUSAL_FALLBACK_CONFIG = join(dir, "settings.json");
  t.after(async () => {
    if (oldChain === undefined) delete process.env.PI_REFUSAL_FALLBACK_CHAIN;
    else process.env.PI_REFUSAL_FALLBACK_CHAIN = oldChain;
    if (oldPath === undefined) delete process.env.PI_REFUSAL_FALLBACK_CONFIG;
    else process.env.PI_REFUSAL_FALLBACK_CONFIG = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const messages = [];
  const dialogs = [];
  let config = { source: "none", chain: [] };
  let error;
  let handler;
  const state = {
    getConfig: () => config, getError: () => error, getLastSummary: () => undefined,
    isBusy: () => typeof busy === "function" ? busy() : busy,
    reload: () => {
      try { config = readConfiguration({ agentDir: dir }); error = undefined; }
      catch (value) { config = { source: "none", chain: [] }; error = value.message; }
    },
    clearStatus: () => undefined,
  };
  registerCommands({ registerCommand: (_name, command) => { handler = command.handler; } }, dir, state);
  const ctx = { hasUI, isIdle: () => true,
    modelRegistry: { getAvailable: () => [first, second], find: (provider, id) =>
      [first, second].find((model) => model.provider === provider && model.id === id) },
    ui: {
      notify: (message, severity) => messages.push({ message, severity }),
      select: async (title, options) => {
        dialogs.push({ title, options });
        const value = selections.shift();
        return typeof value === "function" ? value(options) : value;
      },
      confirm: async () => typeof confirm === "function" ? confirm() : confirm,
    },
  };
  return { dir, path: process.env.PI_REFUSAL_FALLBACK_CONFIG, run: (args) => handler(args, ctx), state, messages, dialogs };
}

test("setup selects exact model objects in order and applies the saved file", async (t) => {
  const h = await harness(t, { selections: [
    (options) => options.find((option) => option.includes("two :: organization/model-b")),
    (options) => options.find((option) => option.includes("one :: model-a")),
    "[Save this order]",
  ] });
  await h.run("setup");
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")).chain, [second, first]);
  assert.deepEqual(h.state.getConfig().chain, [second, first]);
  assert.ok(h.messages.some((message) => message.message.includes("Saved and applied 2")));
});

test("cancelled setup never writes or changes runtime configuration", async (t) => {
  const h = await harness(t, { selections: [undefined] });
  await h.run("setup");
  assert.deepEqual(await readdir(h.dir), []);
  assert.deepEqual(h.state.getConfig().chain, []);
});

test("declining confirmation preserves the existing file", async (t) => {
  const h = await harness(t, { selections: ["[Save this order]"], confirm: false });
  const old = JSON.stringify({ chain: [first] });
  await writeFile(h.path, old);
  await h.run("setup");
  assert.equal(await readFile(h.path, "utf8"), old);
  assert.equal((await readdir(h.dir)).length, 1);
});

test("setup aborts safely if a model run starts while the dialog is open", async (t) => {
  let busy = false;
  const h = await harness(t, { selections: ["[Save this order]"], busy: () => busy,
    confirm: () => { busy = true; return true; },
  });
  await h.run("setup");
  assert.deepEqual(await readdir(h.dir), []);
  assert.ok(h.messages.some((message) => message.message.includes("No configuration was written")));
});

test("an active run blocks reload and setup", async (t) => {
  const h = await harness(t, { busy: true });
  await h.run("reload");
  await h.run("setup");
  assert.equal(h.dialogs.length, 0);
  assert.ok(h.messages.every((message) => message.message.includes("Wait for the active run")));
});

test("environment precedence is clearly reported instead of saving an ignored file", async (t) => {
  const h = await harness(t);
  process.env.PI_REFUSAL_FALLBACK_CHAIN = "one/model-a";
  await h.run("setup");
  assert.equal(h.dialogs.length, 0);
  assert.deepEqual(await readdir(h.dir), []);
  assert.ok(h.messages.some((message) => message.message.includes("overrides files")));
});

test("undo removes only the last selected model", async (t) => {
  const h = await harness(t, { selections: [
    (options) => options.find((option) => option.includes("one :: model-a")),
    (options) => options.find((option) => option.includes("two :: organization/model-b")),
    "[Undo last choice]", "[Save this order]",
  ] });
  await h.run("setup");
  assert.deepEqual(h.state.getConfig().chain, [first]);
});

test("concurrent setup/reload cannot open overlapping dialogs and cancellation releases the lock", async (t) => {
  let finish;
  const h = await harness(t, { selections: [() => new Promise((resolve) => { finish = resolve; })] });
  const firstSetup = h.run("setup");
  try {
    await h.run("setup");
    await h.run("reload");
    assert.equal(h.dialogs.length, 1);
    assert.ok(h.messages.every((message) => message.message.includes("already open")));
  } finally {
    finish?.(undefined);
    await firstSetup;
  }
  await h.run("reload");
  assert.ok(!h.messages.at(-1).message.includes("already open"));
});
