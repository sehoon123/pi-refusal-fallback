import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_CONFIG_BYTES, readConfiguration, saveConfiguration } from "../src/config.ts";

const chain = [{ provider: "example-provider", id: "fallback-a" }, { provider: "other-provider", id: "organization/fallback-b" }];
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-fallback-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("missing default config has no baked-in models", async (t) => {
  const agentDir = await directory(t);
  assert.deepEqual(readConfiguration({ agentDir, env: {} }), { source: "none", chain: [] });
});

test("JSON configuration preserves the chosen provider/model order", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain }));
  assert.deepEqual(readConfiguration({ agentDir, env: {} }), { source: "file", chain });
});

test("an environment chain overrides the file and preserves nested model IDs", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), "not JSON");
  assert.deepEqual(readConfiguration({ agentDir, env: { PI_REFUSAL_FALLBACK_CHAIN: " example-provider/fallback-a , other-provider/organization/fallback-b " } }),
    { source: "environment", chain });
});

test("an explicitly empty environment chain disables fallback", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain }));
  assert.deepEqual(readConfiguration({ agentDir, env: { PI_REFUSAL_FALLBACK_CHAIN: " " } }), { source: "environment", chain: [] });
});

test("a custom file path resolves against the caller working directory", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "chosen.json"), JSON.stringify({ chain }));
  assert.deepEqual(readConfiguration({ agentDir: join(agentDir, "unused"), cwd: agentDir,
    env: { PI_REFUSAL_FALLBACK_CONFIG: "chosen.json" } }), { source: "file", chain });
});

test("an explicitly requested missing file is an error, not a silent default", async (t) => {
  const agentDir = await directory(t);
  assert.throws(() => readConfiguration({ agentDir, env: { PI_REFUSAL_FALLBACK_CONFIG: join(agentDir, "missing.json") } }), /Cannot read/);
});

test("JSON parse errors do not echo potentially private input", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), "not-json-PRIVATE-INPUT");
  assert.throws(() => readConfiguration({ agentDir, env: {} }), (error) =>
    /not valid JSON/.test(error.message) && !error.message.includes("PRIVATE-INPUT"));
});

test("invalid entries reject the entire environment chain", async (t) => {
  const agentDir = await directory(t);
  for (const raw of ["provider/model,", "provider/", "/model", "missing-separator", "provider/model,invalid", "provider/a\nb"]) {
    assert.throws(() => readConfiguration({ agentDir, env: { PI_REFUSAL_FALLBACK_CHAIN: raw } }));
  }
});

test("invalid JSON shapes and unknown fields are rejected", async (t) => {
  const agentDir = await directory(t);
  const bad = [null, [], {}, { other: [] }, { chain, extra: true }, { chain: "a/b" },
    { chain: [null] }, { chain: [{ provider: "a", id: "" }] }, { chain: [{ provider: "a", id: "b", secret: "PRIVATE-INPUT" }] }];
  for (const value of bad) {
    await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify(value));
    assert.throws(() => readConfiguration({ agentDir, env: {} }), (error) => !error.message.includes("PRIVATE-INPUT"));
  }
});

test("an empty JSON chain explicitly disables fallback", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain: [] }));
  assert.deepEqual(readConfiguration({ agentDir, env: {} }), { source: "file", chain: [] });
});

test("UI options are validated and duplicate models are normalized once", async (t) => {
  const agentDir = await directory(t);
  const options = { retryMessages: false, showStatus: true, notifications: false };
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain: [chain[0], chain[0], chain[1]], ...options }));
  assert.deepEqual(readConfiguration({ agentDir, env: {} }), { source: "file", chain, ...options });
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain, retryMessages: "false" }));
  assert.throws(() => readConfiguration({ agentDir, env: {} }), /boolean/);
});

test("configuration and chain size limits reject excessive work safely", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), " ".repeat(MAX_CONFIG_BYTES + 1));
  assert.throws(() => readConfiguration({ agentDir, env: {} }), /64 KiB/);
  assert.throws(() => readConfiguration({ agentDir, env: { PI_REFUSAL_FALLBACK_CHAIN: "a/" + "b".repeat(MAX_CONFIG_BYTES) } }), /64 KiB/);
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain: Array(129).fill(chain[0]) }));
  assert.throws(() => readConfiguration({ agentDir, env: {} }), /128/);
});

test("invalid UTF-8 and directories are rejected without dumping input", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), Buffer.from([0xff, 0xfe]));
  assert.throws(() => readConfiguration({ agentDir, env: {} }), /JSON\/UTF-8/);
  assert.throws(() => readConfiguration({ agentDir, env: { PI_REFUSAL_FALLBACK_CONFIG: agentDir } }), /regular file/);
});

test("setup writes atomically, keeps a private backup, and leaves no temporary files", async (t) => {
  const agentDir = await directory(t);
  const path = join(agentDir, "refusal-fallback.json");
  const old = JSON.stringify({ chain: [] });
  await writeFile(path, old);
  await saveConfiguration({ agentDir, env: {} }, { chain, retryMessages: false });
  assert.deepEqual(readConfiguration({ agentDir, env: {} }).chain, chain);
  assert.equal(await readFile(`${path}.bak`, "utf8"), old);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(`${path}.bak`)).mode & 0o777, 0o600);
  }
  assert.ok(!(await readdir(agentDir)).some((name) => name.endsWith(".tmp")));
});

test("setup never writes an ignored environment-overridden config", async (t) => {
  const agentDir = await directory(t);
  await assert.rejects(saveConfiguration({ agentDir, env: { PI_REFUSAL_FALLBACK_CHAIN: "" } }, { chain }), /overrides/);
  assert.deepEqual(await readdir(agentDir), []);
});

test("setup does not replace existing config symlinks", { skip: process.platform === "win32" }, async (t) => {
  const agentDir = await directory(t);
  const target = join(agentDir, "target.json");
  const old = JSON.stringify({ chain: [] });
  await writeFile(target, old);
  await symlink(target, join(agentDir, "refusal-fallback.json"));
  await assert.rejects(saveConfiguration({ agentDir, env: {} }, { chain }), /symlinks/);
  assert.equal(await readFile(target, "utf8"), old);
});

test("failed backup replacement leaves the original intact and cleans temporary files", async (t) => {
  const agentDir = await directory(t);
  const path = join(agentDir, "refusal-fallback.json");
  const old = JSON.stringify({ chain: [] });
  await writeFile(path, old);
  await mkdir(`${path}.bak`);
  await assert.rejects(saveConfiguration({ agentDir, env: {} }, { chain }));
  assert.equal(await readFile(path, "utf8"), old);
  assert.ok(!(await readdir(agentDir)).some((name) => name.endsWith(".tmp")));
});

test("carryPartial accepts off and cross-provider and defaults to nothing", async (t) => {
  const agentDir = await directory(t);
  for (const mode of ["off", "cross-provider"]) {
    await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain, carryPartial: mode }));
    assert.equal(readConfiguration({ agentDir, env: {} }).carryPartial, mode);
  }
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain }));
  assert.equal(readConfiguration({ agentDir, env: {} }).carryPartial, undefined);
  for (const bad of ["ALWAYS", "cross_provider", "yes", true, 1, null, ["always"], {}, ""]) {
    await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain, carryPartial: bad }));
    assert.throws(() => readConfiguration({ agentDir, env: {} }), /carryPartial option must be off or cross-provider/, JSON.stringify(bad));
  }
});

test("the removed \"always\" value is read as cross-provider with a warning, never as an error", async (t) => {
  const agentDir = await directory(t);
  await writeFile(join(agentDir, "refusal-fallback.json"), JSON.stringify({ chain, carryPartial: "always" }));
  const config = readConfiguration({ agentDir, env: {} });
  assert.equal(config.carryPartial, "cross-provider");
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /"always" is no longer supported/);
  await saveConfiguration({ agentDir, env: {} }, { chain, carryPartial: "always" });
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "refusal-fallback.json"), "utf8")), { chain, carryPartial: "cross-provider" },
    "a warnings field is never written");
  assert.equal(readConfiguration({ agentDir, env: {} }).warnings, undefined);
});

test("carryPartial survives a setup save round trip", async (t) => {
  const agentDir = await directory(t);
  await saveConfiguration({ agentDir, env: {} }, { chain, carryPartial: "cross-provider", showStatus: false });
  assert.deepEqual(readConfiguration({ agentDir, env: {} }), { source: "file", chain, carryPartial: "cross-provider", showStatus: false });
  await assert.rejects(saveConfiguration({ agentDir, env: {} }, { chain, carryPartial: "sometimes" }), /carryPartial/);
});
