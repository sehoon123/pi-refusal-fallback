import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { fixture, PRIMARY, FIRST, SECOND, key, notices } from "./helpers.mjs";

const prompt = "Reply to this harmless offline test prompt.";
const modelsCalled = (calls) => calls.map((call) => call.model);
const lastReport = (session) => session.sessionManager.getBranch().findLast((entry) =>
  entry.type === "custom" && entry.customType === "refusal-fallback-run")?.data;

test("error turn sends an actual second SDK request before final settlement", async (t) => {
  const { session, calls, errors, events, settingsManager } = await fixture(t);
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST)]);
  assert.equal(session.getLastAssistantText(), "Test response completed.");
  assert.equal(notices(session).length, 1);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(key(session.model), key(PRIMARY));
  assert.equal(session.thinkingLevel, "high");
  assert.equal(settingsManager.getDefaultModel(), undefined);
  assert.deepEqual(errors, []);
  const retryContext = calls[1].messages;
  assert.ok(retryContext.some((message) => message.role === "user" && JSON.stringify(message.content).includes(prompt)));
  assert.ok(!retryContext.some((message) => message.role === "assistant" && message.rawStopReason === "refusal"));
  assert.equal(retryContext.at(-1).role, "user");
  assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.rawStopReason === "refusal"));
});

test("normal success does not switch models or add notices", async (t) => {
  const { session, calls, errors } = await fixture(t, { responses: ["success"] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY)]);
  assert.equal(notices(session).length, 0);
  assert.deepEqual(errors, []);
});

test("unrelated provider errors do not trigger switching", async (t) => {
  const { session, calls } = await fixture(t, { responses: [{ stopReason: "error", errorMessage: "Invalid API credentials" }] });
  await session.prompt(prompt);
  assert.equal(calls.length, 1);
  assert.equal(notices(session).length, 0);
});

test("consecutive refusals advance through the configured chain", async (t) => {
  const { session, calls, errors } = await fixture(t, { responses: ["refusal", "refusal", "success"] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST), key(SECOND)]);
  assert.equal(notices(session).length, 2);
  assert.equal(key(session.model), key(PRIMARY));
  assert.deepEqual(errors, []);
});

test("chain exhaustion stops without looping", async (t) => {
  const { session, calls, errors } = await fixture(t, { responses: ["refusal", "refusal", "refusal"] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST), key(SECOND)]);
  assert.equal(notices(session).length, 2);
  assert.equal(key(session.model), key(PRIMARY));
  assert.deepEqual(errors, []);
});

test("skip the currently selected model", async (t) => {
  const { session, calls, errors } = await fixture(t, { initial: FIRST });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(FIRST), key(SECOND)]);
  assert.equal(key(session.model), key(FIRST));
  assert.deepEqual(errors, []);
});

test("skip missing catalog entries rather than silently stopping", async (t) => {
  const { session, calls, errors } = await fixture(t, { models: [PRIMARY, SECOND] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(SECOND)]);
  assert.deepEqual(errors, []);
});

test("skip unavailable authentication without false notices", async (t) => {
  const source = { provider: "test-source", id: "primary" };
  const { session, calls, errors } = await fixture(t, { initial: source, models: [source, FIRST, SECOND], noAuth: [FIRST.provider] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(source), key(SECOND)]);
  assert.equal(notices(session).length, 1);
  assert.ok(notices(session)[0].content.includes(SECOND.id));
  assert.deepEqual(errors, []);
});

test("abort never retries, even with stale refusal metadata", async (t) => {
  const { session, calls, errors } = await fixture(t, {
    responses: [{ stopReason: "aborted", rawStopReason: "refusal", errorMessage: "Request was aborted" }],
  });
  await session.prompt(prompt);
  assert.equal(calls.length, 1);
  assert.equal(notices(session).length, 0);
  assert.equal(key(session.model), key(PRIMARY));
  assert.deepEqual(errors, []);
});

test("abort during a later request restores the original model", async (t) => {
  const { session, calls, errors } = await fixture(t, { responses: ["refusal", "aborted"] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST)]);
  assert.equal(key(session.model), key(PRIMARY));
  assert.deepEqual(errors, []);
});

test("a new user run resets the per-run chain state", async (t) => {
  const { session, calls, errors } = await fixture(t, { responses: ["refusal", "success", "refusal", "success"] });
  await session.prompt(prompt);
  await session.prompt("A second harmless test prompt.");
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST), key(PRIMARY), key(FIRST)]);
  assert.equal(notices(session).length, 2);
  assert.deepEqual(errors, []);
});

test("preserve earlier boundary proposals from other extensions", async (t) => {
  const { session, calls, errors } = await fixture(t, { priorBoundaryEntry: true });
  await session.prompt(prompt);
  assert.equal(calls.length, 2);
  assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "prior-boundary"));
  assert.deepEqual(errors, []);
});

test("native Anthropic transport sends a follow-up POST to a local HTTP server", async (t) => {
  const { session, wireCalls, errors } = await fixture(t, { wire: true });
  await session.prompt(prompt);
  assert.deepEqual(wireCalls.map((call) => call.payload.model), [PRIMARY.id, FIRST.id]);
  assert.ok(wireCalls.every((call) => call.method === "POST" &&
    new URL(call.path, "http://127.0.0.1").pathname.endsWith("/v1/messages")));
  assert.equal(session.getLastAssistantText(), "Test response completed.");
  assert.equal(key(session.model), key(PRIMARY));
  assert.deepEqual(errors, []);
});

test("native HTTP transports complete a cross-provider handoff locally", async (t) => {
  const { session, wireCalls, errors } = await fixture(t, { wire: true, responses: ["refusal", "refusal", "success"] });
  await session.prompt(prompt);
  assert.deepEqual(wireCalls.map((call) => call.payload.model), [PRIMARY.id, FIRST.id, SECOND.id]);
  assert.ok(wireCalls[2].path.endsWith("/chat/completions"));
  assert.ok(JSON.stringify(wireCalls[2].payload.messages).includes(prompt));
  assert.equal(session.getLastAssistantText(), "Test response completed.");
  assert.equal(key(session.model), key(PRIMARY));
  assert.deepEqual(errors, []);
});

test("an empty user chain disables fallback; no models are hard-coded", async (t) => {
  const { session, calls, errors } = await fixture(t, { chain: [] });
  await session.prompt(prompt);
  assert.equal(calls.length, 1);
  assert.equal(notices(session).length, 0);
  assert.deepEqual(errors, []);
});

test("a user JSON configuration determines the exact model order", async (t) => {
  const { session, calls, errors } = await fixture(t, { chain: [SECOND, FIRST], fileConfig: true });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(SECOND)]);
  assert.deepEqual(errors, []);
});

test("invalid configuration disables fallback but does not break ordinary chat", async (t) => {
  const { session, calls, errors } = await fixture(t, { invalidConfig: true });
  await session.prompt(prompt);
  assert.equal(calls.length, 1);
  assert.equal(notices(session).length, 0);
  assert.deepEqual(errors, []);
});

test("duplicate entries and the original model cannot create a cycle", async (t) => {
  const { session, calls } = await fixture(t, { chain: [FIRST, FIRST, SECOND, PRIMARY], responses: ["refusal", "refusal", "refusal"] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST), key(SECOND)]);
  assert.equal(notices(session).length, 2);
});

test("nested model IDs are preserved by environment configuration", async (t) => {
  const nested = { provider: FIRST.provider, id: "organization/model-name:variant" };
  const { session, calls } = await fixture(t, { chain: [nested], models: [PRIMARY, nested] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(nested)]);
});

test("users can configure more than two fallback models", async (t) => {
  const third = { provider: "test-provider-c", id: "fallback-c" };
  const { session, calls } = await fixture(t, { chain: [FIRST, SECOND, third], models: [PRIMARY, FIRST, SECOND, third],
    responses: ["refusal", "refusal", "refusal", "success"] });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST), key(SECOND), key(third)]);
  assert.equal(notices(session).length, 3);
  assert.equal(key(session.model), key(PRIMARY));
});

test("the status command makes no model requests", async (t) => {
  const { session, calls } = await fixture(t);
  await session.prompt("/refusal-fallback status");
  assert.equal(calls.length, 0);
});

test("connection refused is a transport failure, not a model refusal", async (t) => {
  const { session, calls } = await fixture(t, {
    responses: [{ stopReason: "error", errorMessage: "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:12345" }],
  });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY)]);
  assert.equal(notices(session).length, 0);
});

test("a user's model selection during fallback is not overwritten or retried", async (t) => {
  const manual = { provider: "test-manual", id: "chosen-model" };
  const { session, calls, errors } = await fixture(t, {
    models: [PRIMARY, FIRST, SECOND, manual], responses: ["refusal", "refusal"],
    onRequest: async ({ number, session, runtime }) => {
      if (number === 2) await session.setModel(runtime.getModel(manual.provider, manual.id));
    },
  });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST)]);
  assert.equal(key(session.model), key(manual));
  assert.equal(lastReport(session).restoration, "user-choice");
  assert.deepEqual(errors, []);
});

test("a user's model change during the initial request prevents a stale fallback", async (t) => {
  const { session, calls } = await fixture(t, {
    onRequest: async ({ number, session, runtime }) => {
      if (number === 1) await session.setModel(runtime.getModel(SECOND.provider, SECOND.id));
    },
  });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY)]);
  assert.equal(key(session.model), key(SECOND));
});

test("a user's thinking change during fallback is respected on restoration", async (t) => {
  const { session } = await fixture(t, {
    onRequest: ({ number, session }) => { if (number === 2) session.setThinkingLevel("low"); },
  });
  await session.prompt(prompt);
  assert.equal(key(session.model), key(PRIMARY));
  assert.equal(session.thinkingLevel, "low");
});

test("quiet mode continues without injecting retry notices into model context", async (t) => {
  const { session, calls, errors, uiEvents } = await fixture(t, {
    fileConfig: true, retryMessages: false, ui: true, responses: ["refusal", "refusal", "success"],
  });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST), key(SECOND)]);
  assert.equal(notices(session).length, 0);
  assert.ok(calls.every((call) => !JSON.stringify(call.messages).includes("[refusal-fallback]")));
  const statuses = uiEvents.filter((event) => event.type === "status").map((event) => event.text);
  assert.ok(statuses.some((text) => text?.includes("fallback 1/2")));
  assert.ok(statuses.some((text) => text?.includes("fallback 2/2")));
  assert.ok(statuses.at(-1).includes("restored"));
  assert.ok(statuses.every((text, index) => index === 0 || text !== statuses[index - 1]));
  assert.deepEqual(errors, []);
});

test("status reports persisted last-run outcome and skip reasons without extra requests", async (t) => {
  const { session, calls, uiEvents } = await fixture(t, { ui: true, models: [PRIMARY, SECOND] });
  await session.prompt(prompt);
  const before = calls.length;
  await session.prompt("/refusal-fallback status");
  assert.equal(calls.length, before);
  const report = lastReport(session);
  assert.equal(report.outcome, "completed");
  assert.deepEqual(report.skipped, [{ entry: 1, reason: "missing-model" }]);
  assert.ok(uiEvents.some((event) => event.type === "notify" && event.message.includes("Last run: completed")));
});

test("restoration failure is visible and does not start another request", async (t) => {
  const { session, calls, errors, uiEvents } = await fixture(t, { ui: true, chain: [SECOND],
    onRequest: ({ number, runtime }) => { if (number === 2) runtime.unregisterProvider(PRIMARY.provider); },
  });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(SECOND)]);
  assert.equal(key(session.model), key(SECOND));
  assert.equal(lastReport(session).restoration, "failed");
  assert.ok(uiEvents.some((event) => event.type === "notify" && event.severity === "error" && event.message.includes("Could not restore")));
  assert.deepEqual(errors, []);
});

test("configuration is snapshotted per run and an explicit reload applies safe disabling", async (t) => {
  const { session, calls } = await fixture(t, { fileConfig: true, responses: ["refusal", "success", "refusal"],
    onRequest: async ({ number }) => {
      if (number === 1) await writeFile(process.env.PI_REFUSAL_FALLBACK_CONFIG, "invalid JSON");
    },
  });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST)]);
  await session.prompt("/refusal-fallback reload");
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST), key(PRIMARY)]);
});

test("user selection racing an awaited fallback switch is put back before settlement", async (t) => {
  const manual = { provider: "test-manual", id: "chosen-model" };
  const { session, calls, runtime } = await fixture(t, { models: [PRIMARY, FIRST, SECOND, manual] });
  const original = session.setModel.bind(session);
  let raced = false;
  session.setModel = async (model, options) => {
    if (!raced && key(model) === key(FIRST)) {
      raced = true;
      await original(runtime.getModel(manual.provider, manual.id));
    }
    return original(model, options);
  };
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY)]);
  assert.equal(key(session.model), key(manual));
});

test("user selection racing final restoration is not overwritten", async (t) => {
  const manual = { provider: "test-manual", id: "chosen-model" };
  const { session, calls, runtime } = await fixture(t, { models: [PRIMARY, FIRST, SECOND, manual] });
  const original = session.setModel.bind(session);
  let raced = false;
  session.setModel = async (model, options) => {
    if (!raced && key(model) === key(PRIMARY)) {
      raced = true;
      await original(runtime.getModel(manual.provider, manual.id));
    }
    return original(model, options);
  };
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(FIRST)]);
  assert.equal(key(session.model), key(manual));
  assert.equal(lastReport(session).restoration, "user-choice");
});

test("an earlier extension's continuation is honored rather than competing", async (t) => {
  const { session, calls, errors } = await fixture(t, { priorContinuation: true });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY), key(PRIMARY)]);
  assert.equal(notices(session).length, 0);
  assert.deepEqual(errors, []);
});

test("a missing runnable context leaves the refusal intact instead of fabricating input", async (t) => {
  const { session, calls, errors, uiEvents } = await fixture(t, { omitUserContext: true, ui: true });
  await session.prompt(prompt);
  assert.deepEqual(modelsCalled(calls), [key(PRIMARY)]);
  assert.equal(notices(session).length, 0);
  assert.equal(lastReport(session).outcome, "no-context");
  assert.ok(uiEvents.some((event) => event.type === "notify" && event.message.includes("Cannot retry")));
  assert.deepEqual(errors, []);
});
