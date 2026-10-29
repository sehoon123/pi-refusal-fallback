// Real-terminal smoke test. Starts the actual `pi` TUI inside a private tmux server (-L socket, never the
// user's default server) with a throwaway agent directory and 60 fake models. No network, no credentials.
// Run: npm run test:e2e   (skips cleanly when tmux is not installed)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pi = join(root, "node_modules", ".bin", "pi");
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
if (!hasTmux || !existsSync(pi)) {
  console.log("SKIP: tmux and the pi dev dependency are required for the terminal smoke test.");
  process.exit(0);
}
const socket = `pi-refusal-e2e-${process.pid}`;
const tmux = (...args) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const dir = await mkdtemp(join(tmpdir(), "pi-refusal-e2e-"));
const agent = join(dir, "agent");
await mkdir(agent, { recursive: true });
await mkdir(join(dir, "work"));
const providers = {};
for (let p = 0; p < 6; p += 1) {
  providers[`mock-p${p}`] = { baseUrl: "http://127.0.0.1:9/unused", api: "openai-completions", apiKey: "not-a-secret",
    models: Array.from({ length: 10 }, (_, i) => ({ id: p < 5 ? `model-${p}${i}` : `org/nested-${i}` })) };
}
await writeFile(join(agent, "models.json"), JSON.stringify({ providers }));
await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "mock-p0", defaultModel: "model-00",
  defaultThinkingLevel: "off", quietStartup: true, enableInstallTelemetry: false, collapseChangelog: true }));
const command = ["env", "-i", `HOME=${process.env.HOME}`, `PATH=${process.env.PATH}`, "TERM=xterm-256color", "LANG=C.UTF-8",
  `PI_CODING_AGENT_DIR=${agent}`, "PI_OFFLINE=1", "PI_TELEMETRY=0", "PI_SKIP_VERSION_CHECK=1",
  pi, "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-ne",
  "-e", join(root, "src", "index.ts")].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
const screen = () => tmux("capture-pane", "-p", "-t", "e2e").stdout.split("\n").map((line) => line.trimEnd()).join("\n");
const keys = (...values) => tmux("send-keys", "-t", "e2e", ...values);
const waitFor = async (pattern, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(screen())) return screen();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.\n${screen()}`);
};
let failed;
try {
  assert.equal(tmux("new-session", "-d", "-s", "e2e", "-x", "110", "-y", "30", `cd '${join(dir, "work")}' && exec ${command}`).status, 0);
  await waitFor(/\(mock-p0\) model-00/, "the pi footer");
  keys("-l", "/refusal-fallback setup");
  await new Promise((resolve) => setTimeout(resolve, 500));
  keys("Enter"); // regression: ONE Enter must run the command, not just accept a completion
  await waitFor(/Fallback model setup/, "the setup screen after a single Enter");

  for (let i = 0; i < 25; i += 1) keys("Down");
  const scrolled = await waitFor(/26\/60/, "scroll position 26/60");
  assert.match(scrolled, /^→ \[ \]\s+mock-p2\/model-25$/m, "regression: the highlighted row must stay on screen");
  assert.match(scrolled, /↑ 14 above · ↓ 34 below/);

  keys("-l", "nested");
  await waitFor(/Filter: nested▌\s+10\/60/, "filter results");
  keys("Enter", "Down", "Enter", "C-s");
  await waitFor(/Saved 2 fallback model\(s\): nested-0 → nested-1/, "the saved notification");
  const saved = JSON.parse(await readFile(join(agent, "refusal-fallback.json"), "utf8"));
  assert.deepEqual(saved.chain, [{ provider: "mock-p5", id: "org/nested-0" }, { provider: "mock-p5", id: "org/nested-1" }]);

  // The partial-output handoff setting: cycle off -> cross-provider, see its explanation, save, and check the file.
  keys("-l", "/refusal-fallback setup");
  await new Promise((resolve) => setTimeout(resolve, 500));
  keys("Enter");
  await waitFor(/Order \(2\)/, "setup reopened with the saved order");
  keys("Tab", "Tab", "Down", "Down", "Down");
  const options = await waitFor(/Pass interrupted partial output to the next model: off/, "the handoff row");
  assert.match(options.replace(/\s+/g, " "), /the same provider would likely refuse again/, "the highlighted setting is explained");
  keys("Enter");
  await waitFor(/next model: cross-provider/, "the handoff mode after one Enter");
  keys("C-s");
  await waitFor(/Saved 2 fallback model\(s\)/, "the second save");
  assert.equal(JSON.parse(await readFile(join(agent, "refusal-fallback.json"), "utf8")).carryPartial, "cross-provider");

  keys("-l", "/refusal-fallback status");
  await new Promise((resolve) => setTimeout(resolve, 500));
  keys("Enter");
  await waitFor(/1\. mock-p5\/org\/nested-0\n\s*2\. mock-p5\/org\/nested-1/, "the status list");
  await waitFor(/Partial output handoff: cross-provider/, "the handoff mode in status");
  console.log("PASS: real pi TUI — single-Enter open, long-list scrolling, filter, save, handoff setting and status.");
} catch (error) {
  failed = error;
} finally {
  tmux("kill-server");
  await rm(dir, { recursive: true, force: true });
}
if (failed) {
  console.error(failed.message);
  process.exit(1);
}
