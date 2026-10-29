import assert from "node:assert/strict";
import test from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { ChainEditor } from "../src/picker-model.ts";
import { ChainPicker } from "../src/picker-ui.ts";

const KEY = {
  up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", tab: "\t", shiftTab: "\x1b[Z",
  pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", del: "\x1b[3~", backspace: "\x7f", ctrlS: "\x13", ctrlC: "\x03",
};
const theme = { fg: (_color, text) => text, bold: (text) => text };
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const catalog = (count) => Array.from({ length: count }, (_, i) => ({
  provider: `provider-${String(Math.floor(i / 10)).padStart(2, "0")}`,
  id: `model-${String(i).padStart(3, "0")}`,
}));

function picker({ models = catalog(60), chain = [], options, rows = 24, limit = 128 } = {}) {
  const editor = new ChainEditor({ catalog: models, chain, limit,
    options: options ?? { retryMessages: true, showStatus: true, notifications: true, carryPartial: "off" } });
  let result;
  let renders = 0;
  const host = { terminal: { rows, columns: 100 }, requestRender: () => { renders += 1; } };
  const component = new ChainPicker(editor, { host, theme, keybindings, done: (value) => { result = value; }, file: "/tmp/refusal-fallback.json" });
  return {
    editor, component, host,
    get result() { return result; },
    get renders() { return renders; },
    send: (...keys) => { for (const key of keys) component.handleInput(key); },
    type: (text) => { for (const character of text) component.handleInput(character); },
    screen: (width = 100) => component.render(width),
    text: (width = 100) => component.render(width).join("\n"),
  };
}

test("the highlighted model is always on screen while moving through a long list", () => {
  const p = picker({ models: catalog(80), rows: 24 });
  const heights = new Set();
  for (let step = 0; step < 90; step += 1) {
    const screen = p.screen();
    heights.add(screen.length);
    const current = p.editor.models[p.editor.cursor()];
    const selected = screen.filter((line) => line.startsWith("→ "));
    assert.equal(selected.length, 1, `exactly one cursor row at step ${step}`);
    assert.ok(selected[0].includes(`${current.provider}/${current.id}`), `step ${step}: cursor row must show ${current.id}`);
    p.send(KEY.down);
  }
  assert.equal(heights.size, 1, "height stays stable so the editor area does not jump");
});

test("moving up from the first row wraps to the last row and shows it", () => {
  const p = picker({ models: catalog(80) });
  p.send(KEY.up);
  assert.match(p.text(), /→ \[ \]\s+provider-07\/model-079/);
  assert.match(p.text(), /80\/80/);
});

test("list height is bounded by the terminal, with an explicit position indicator", () => {
  for (const rows of [10, 16, 24, 40, 80]) {
    const p = picker({ rows, models: catalog(200) });
    const screen = p.screen();
    assert.ok(screen.length <= Math.max(14, rows - 2) || rows < 16, `rows=${rows} height=${screen.length}`);
    assert.ok(screen.some((line) => line.includes("↓ ") && line.includes(" below")), "scroll position is shown");
    p.send(KEY.pageDown, KEY.pageDown);
    assert.ok(p.text().includes("↑ "), "after paging there are rows above");
  }
});

test("Page keys, Home and End clamp to real rows and never expose an empty list", () => {
  const p = picker({ models: catalog(50) });
  p.send(KEY.end);
  assert.match(p.text(), /→ \[ \]\s+provider-04\/model-049/);
  p.send(KEY.pageUp, KEY.pageUp);
  assert.ok(p.screen().some((line) => line.startsWith("→ ")));
  p.send(KEY.home);
  assert.match(p.text(), /→ \[ \]\s+provider-00\/model-000/);
});

test("no rendered line is wider than the viewport at any practical width", () => {
  const wide = [{ provider: "한국어-provider", id: "모델/긴-이름-".repeat(8) }, ...catalog(30)];
  for (const width of [24, 30, 40, 60, 92, 140]) {
    const p = picker({ models: wide, chain: wide.slice(0, 4) });
    for (const tab of ["models", "order", "options", "review"]) {
      p.editor.tab = tab;
      for (const line of p.screen(width)) assert.ok(visibleWidth(line) <= width, `${tab}@${width}: ${visibleWidth(line)} > ${width}`);
    }
  }
});

test("typing filters by provider or model text, resets the cursor, and Esc clears before cancelling", () => {
  const p = picker();
  p.send(KEY.down, KEY.down);
  p.type("model-04");
  // Same fuzzy matcher as Pi's /model picker: contiguous matches rank first, looser ones follow.
  assert.deepEqual(p.editor.models.slice(0, 10).map((item) => item.id),
    Array.from({ length: 10 }, (_, i) => `model-${String(40 + i).padStart(3, "0")}`));
  assert.equal(p.editor.models.length, 15);
  assert.equal(p.editor.cursor(), 0);
  assert.ok(p.screen().some((line) => line.startsWith("→ ") && line.includes("model-040")));
  assert.match(p.text(), /Filter: model-04▌\s+15\/60/);
  p.send(KEY.backspace);
  assert.equal(p.editor.filter, "model-0");
  p.send(KEY.esc);
  assert.equal(p.editor.filter, "", "first Esc clears the filter");
  assert.equal(p.result, undefined, "and does not close the screen");
  p.send(KEY.esc);
  assert.deepEqual(p.result, { kind: "cancel" });
});

test("a filter with no match explains how to recover", () => {
  const p = picker();
  p.type("zzzz");
  assert.match(p.text(), /No matching models\. Press Esc to clear the filter\./);
  p.send(KEY.enter);
  assert.deepEqual(p.editor.chain, []);
});

test("Enter adds in selection order, shows positions, and removes on the second Enter", () => {
  const p = picker();
  p.send(KEY.enter, KEY.down, KEY.down, KEY.enter, KEY.down, KEY.enter);
  assert.deepEqual(p.editor.chain.map((item) => item.id), ["model-000", "model-002", "model-003"]);
  assert.match(p.text(), /\[1\]\s+provider-00\/model-000/);
  assert.match(p.text(), /\[2\]\s+provider-00\/model-002/);
  p.send(KEY.up, KEY.up, KEY.up, KEY.enter);
  assert.deepEqual(p.editor.chain.map((item) => item.id), ["model-002", "model-003"]);
  assert.match(p.text(), /Order \(2\)/);
});

test("existing configuration is the starting point and unavailable entries are never silently dropped", () => {
  const missing = { provider: "retired-provider", id: "old-model" };
  const p = picker({ chain: [catalog(60)[3], missing] });
  p.send(KEY.tab);
  const text = p.text();
  assert.match(text, /1\. provider-00\/model-003/);
  assert.match(text, /2\. retired-provider\/old-model\s+\(unavailable: kept until removed\)/);
  assert.match(text, /Order: model-003 → old-model!/);
  p.send(KEY.ctrlS);
  assert.deepEqual(p.result.chain, [catalog(60)[3], missing]);
});

test("Order tab: pick up, reorder, drop; Esc restores the original order", () => {
  const p = picker({ chain: catalog(4) });
  p.send(KEY.tab, KEY.enter, KEY.down, KEY.down);
  assert.deepEqual(p.editor.chain.map((item) => item.id), ["model-001", "model-002", "model-000", "model-003"]);
  assert.ok(p.screen().some((line) => line.startsWith("↕ ") && line.includes("model-000")));
  p.send(KEY.esc);
  assert.deepEqual(p.editor.chain.map((item) => item.id), ["model-000", "model-001", "model-002", "model-003"]);
  assert.equal(p.result, undefined);
  p.send(KEY.enter, KEY.down, KEY.enter, KEY.down);
  assert.deepEqual(p.editor.chain.map((item) => item.id), ["model-001", "model-000", "model-002", "model-003"]);
  assert.equal(p.editor.cursor(), 2, "after dropping, the cursor moves independently again");
});

test("Order tab: Delete, Backspace and x remove, but not while an item is picked up", () => {
  const p = picker({ chain: catalog(5) });
  p.send(KEY.tab, KEY.del);
  assert.equal(p.editor.chain.length, 4);
  p.send(KEY.backspace, "x");
  assert.equal(p.editor.chain.length, 2);
  p.send(KEY.enter, KEY.del, "x", KEY.backspace);
  assert.equal(p.editor.chain.length, 2);
});

test("Tab, Shift+Tab and Left/Right move between sections without losing state", () => {
  const p = picker();
  p.type("model-01");
  p.send(KEY.tab, KEY.shiftTab, KEY.right, KEY.left);
  assert.equal(p.editor.tab, "models");
  assert.equal(p.editor.filter, "model-01");
  p.send(KEY.shiftTab);
  assert.equal(p.editor.tab, "review");
});

test("Options tab toggles by Enter and Space and reports them on Review", () => {
  const p = picker();
  p.send(KEY.tab, KEY.tab, KEY.enter, KEY.down, " ");
  assert.deepEqual(p.editor.options, { retryMessages: false, showStatus: false, notifications: true, carryPartial: "off" });
  p.send(KEY.tab);
  assert.match(p.text(), /Settings: notices off · status off · warnings on/);
});

test("Ctrl+S and Review-Enter both return the same result", () => {
  const first = picker();
  first.send(KEY.enter, KEY.down, KEY.enter, KEY.ctrlS);
  const second = picker();
  second.send(KEY.enter, KEY.down, KEY.enter, KEY.shiftTab, KEY.enter);
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.result.chain.map((item) => item.id), ["model-000", "model-001"]);
});

test("unsaved changes need a second Esc; saving or undoing makes Esc immediate", () => {
  const p = picker();
  p.send(KEY.enter, KEY.esc);
  assert.equal(p.result, undefined);
  assert.match(p.text(), /Unsaved changes\. Press Esc again to discard them, or Ctrl\+S to save\./);
  p.send(KEY.down);
  p.send(KEY.esc);
  assert.equal(p.result, undefined, "another key re-arms the confirmation");
  p.send(KEY.esc);
  assert.deepEqual(p.result, { kind: "cancel" });
  const clean = picker();
  clean.send(KEY.esc);
  assert.deepEqual(clean.result, { kind: "cancel" });
  const reverted = picker();
  reverted.send(KEY.enter, KEY.enter, KEY.esc);
  assert.deepEqual(reverted.result, { kind: "cancel" });
});

test("Ctrl+C and the web Close button abort at once, even with unsaved changes", () => {
  const clean = picker();
  clean.send(KEY.ctrlC);
  assert.deepEqual(clean.result, { kind: "cancel" });
  const dirty = picker();
  dirty.send(KEY.enter, KEY.tab, KEY.enter, KEY.ctrlC);
  assert.deepEqual(dirty.result, { kind: "cancel" }, "also while an item is picked up");
});

test("short tabs stay compact while the searchable list keeps a stable height", () => {
  const p = picker({ chain: catalog(2) });
  const models = p.screen().length;
  p.type("model-01");
  assert.equal(p.screen().length, models, "filtering does not change the height");
  p.send(KEY.esc, KEY.tab);
  const order = p.screen();
  assert.ok(order.length <= models - 6, `Order tab is compact (${order.length} vs ${models})`);
  assert.ok(order.length >= 10, "but still large enough for title, tabs, list, summary and help");
});

test("a chunk of several typed characters (IME or fast paste) is one filter edit", () => {
  const p = picker();
  p.send("model-045");
  assert.equal(p.editor.filter, "model-045");
  assert.equal(p.editor.models[0].id, "model-045");
  p.send("한글");
  assert.equal(p.editor.filter, "model-045한글");
  assert.match(p.text(), /No matching models/);
  p.send(KEY.esc);
  assert.equal(p.editor.filter, "");
});

test("the model limit is enforced with feedback", () => {
  const p = picker({ limit: 2 });
  p.send(KEY.enter, KEY.down, KEY.enter, KEY.down, KEY.enter);
  assert.equal(p.editor.chain.length, 2);
  assert.match(p.text(), /limited to 2 models/);
});

test("an empty catalog explains the situation instead of showing a blank list", () => {
  const p = picker({ models: [] });
  assert.match(p.text(), /No authenticated models are available/);
  p.send(KEY.enter, KEY.down, KEY.up);
  assert.equal(p.result, undefined);
});

test("application-cursor arrows and mixed-case Kitty-style input do not break navigation", () => {
  const p = picker();
  p.send("\x1bOB", "\x1bOB", "\x1bOA");
  assert.equal(p.editor.cursor(), 1);
  p.type("DeepSeek");
  assert.equal(p.editor.filter, "DeepSeek");
  p.send("\x1b[200~model-005\x1b[201~");
  assert.ok(p.editor.filter.includes("model-005"));
});

test("a throwing host callback is contained: the screen closes cleanly", () => {
  const editor = new ChainEditor({ catalog: catalog(3), chain: [], limit: 128,
    options: { retryMessages: true, showStatus: true, notifications: true, carryPartial: "off" } });
  let result;
  const component = new ChainPicker(editor, {
    host: { requestRender: () => { throw new Error("render failed"); } }, theme, keybindings,
    done: (value) => { result = value; }, file: "x",
  });
  assert.throws(() => component.handleInput(KEY.down), /render failed/, "host failures are not swallowed as input errors");
  component.handleInput(KEY.esc);
  assert.deepEqual(result, { kind: "cancel" });
});

test("input after completion is ignored", () => {
  const p = picker();
  p.send(KEY.ctrlS);
  const first = p.result;
  p.send(KEY.enter, KEY.esc);
  assert.equal(p.result, first);
});

test("themes that throw for a colour name still render readable text", () => {
  const editor = new ChainEditor({ catalog: catalog(5), chain: [], limit: 128,
    options: { retryMessages: true, showStatus: true, notifications: true, carryPartial: "off" } });
  const component = new ChainPicker(editor, {
    host: { requestRender() {} }, theme: { fg() { throw new Error("unknown colour"); }, bold: () => { throw new Error("no bold"); } },
    keybindings, done() {}, file: "x",
  });
  assert.ok(component.render(80).join("\n").includes("Fallback model setup"));
});

const mouse = (extra) => ({ type: "click", button: "left", x: 4, y: 3, screenX: 4, screenY: 3, width: 100, height: 20,
  shift: false, alt: false, ctrl: false, ...extra });

test("mouse wheel moves the highlighted row instead of scrolling the transcript", () => {
  const p = picker({ models: catalog(80) });
  assert.deepEqual(p.component.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: 3 })), { handled: true, render: true });
  assert.equal(p.editor.cursor(), 3);
  p.component.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: -2 }));
  assert.equal(p.editor.cursor(), 1);
  p.component.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: -50 }));
  assert.equal(p.editor.cursor(), 0, "clamped at the top, no wrap-around from a wheel");
  p.component.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: 500 }));
  assert.equal(p.editor.cursor(), 6, "a burst is limited to six rows per event");
});

test("clicking selects a row and clicking the selected row toggles it", () => {
  const p = picker();
  p.component.handleMouse(mouse({ y: 3 + 4 }));
  assert.equal(p.editor.cursor(), 4);
  assert.deepEqual(p.editor.chain, []);
  p.component.handleMouse(mouse({ y: 3 + 4 }));
  assert.deepEqual(p.editor.chain.map((item) => item.id), ["model-004"]);
  assert.equal(p.component.handleMouse(mouse({ y: 3 + 40 })), undefined, "clicks below the list are ignored");
  assert.equal(p.component.handleMouse(mouse({ button: "right" })), undefined);
});

test("clicking a tab title switches sections", () => {
  const p = picker({ chain: catalog(2) });
  const bar = p.screen()[1];
  p.component.handleMouse(mouse({ y: 1, x: bar.indexOf("Options") + 1 }));
  assert.equal(p.editor.tab, "options");
  p.component.handleMouse(mouse({ y: 1, x: p.screen()[1].indexOf("Review") }));
  assert.equal(p.editor.tab, "review");
  p.component.handleMouse(mouse({ y: 1, x: p.screen()[1].indexOf("Order") }));
  assert.equal(p.editor.tab, "order");
  assert.equal(p.component.handleMouse(mouse({ type: "move", button: "none" })), undefined);
});

test("the handoff setting cycles off -> cross-provider -> always -> off and explains itself", () => {
  const p = picker();
  p.send(KEY.tab, KEY.tab, KEY.down, KEY.down, KEY.down);
  assert.match(p.text(), /→ Pass interrupted partial output to the next model: off/);
  assert.match(p.text().replace(/\s+/g, " "), /same provider would likely refuse again/, "the highlighted setting is explained");
  p.send(KEY.enter);
  assert.equal(p.editor.options.carryPartial, "cross-provider");
  p.send(" ");
  assert.equal(p.editor.options.carryPartial, "always");
  p.send(KEY.enter);
  assert.equal(p.editor.options.carryPartial, "off");
  assert.equal(p.editor.dirty, false, "returning to the original value is not a change");
  p.send(KEY.enter, KEY.tab);
  assert.match(p.text(), /Settings: notices on · status on · warnings on · partial output: cross-provider/);
});

test("the explanation of the highlighted setting follows the cursor and wraps to any width", () => {
  for (const width of [24, 40, 60, 92]) {
    const p = picker();
    p.send(KEY.tab, KEY.tab);
    const first = p.screen(width).join("\n");
    assert.match(first, /never sent to a model|shown to you only/i);
    p.send(KEY.down, KEY.down, KEY.down);
    const choice = p.screen(width);
    assert.ok(choice.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.match(choice.join(" "), /cross-provider/);
  }
});

test("clicking the handoff row selects it and a second click cycles it", () => {
  const p = picker();
  p.send(KEY.tab, KEY.tab);
  p.component.handleMouse(mouse({ y: 3 + 3 }));
  assert.equal(p.editor.cursor(), 3);
  p.component.handleMouse(mouse({ y: 3 + 3 }));
  assert.equal(p.editor.options.carryPartial, "cross-provider");
});
