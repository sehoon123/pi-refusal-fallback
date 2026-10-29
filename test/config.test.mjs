import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfiguration } from "../src/config.ts";

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
