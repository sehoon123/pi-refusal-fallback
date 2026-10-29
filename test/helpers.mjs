import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = process.env.PI_REFUSAL_TEST_PACKAGE_DIR ??
  fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(join(packageDir, "dist", "index.js")).href);
const { AssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } =
  await import(pathToFileURL(join(packageDir, "..", "pi-ai", "dist", "index.js")).href);

export const PRIMARY = { provider: "test-provider-a", id: "primary" };
export const FIRST = { provider: "test-provider-a", id: "fallback-a" };
export const SECOND = { provider: "test-provider-b", id: "fallback-b" };
export const key = (model) => `${model.provider}/${model.id}`;
export const notices = (session) => session.sessionManager.getBranch().filter(
  (entry) => entry.type === "custom_message" && entry.customType === "refusal-fallback",
);

function wireReply(res, payload, kind, isOpenAI) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`${isOpenAI ? "" : `event: ${event.type}\n`}data: ${JSON.stringify(event)}\n\n`);
  if (isOpenAI) {
    const chunk = (delta, finish_reason) => ({ id: "test-chat", object: "chat.completion.chunk", created: 0,
      model: payload.model, choices: [{ index: 0, delta, finish_reason }] });
    send(chunk({ role: "assistant", content: "Test response completed." }, null));
    send(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
    return;
  }
  send({ type: "message_start", message: { id: "test-message", type: "message", role: "assistant",
    model: payload.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 } } });
  if (kind === "success") {
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Test response completed." } });
    send({ type: "content_block_stop", index: 0 });
  }
  send({ type: "message_delta", delta: { stop_reason: kind === "success" ? "end_turn" : "refusal", stop_sequence: null },
    usage: { output_tokens: 1 } });
  send({ type: "message_stop" });
  res.end();
}

/** Isolated credentials, model catalog and session. HTTP tests bind loopback only. */
export async function fixture(t, {
  responses = ["refusal", "success"], initial = PRIMARY, chain = [FIRST, SECOND],
  models = [PRIMARY, FIRST, SECOND], noAuth = [], priorBoundaryEntry = false,
  wire = false, fileConfig = false, invalidConfig = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-refusal-fallback-test-"));
  const envKeys = ["PI_REFUSAL_FALLBACK_CHAIN", "PI_REFUSAL_FALLBACK_CONFIG", "PI_REFUSAL_FALLBACK_DEBUG"];
  const previousEnv = Object.fromEntries(envKeys.map((name) => [name, process.env[name]]));
  let session;
  let server;
  t.after(async () => {
    try {
      session?.dispose();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      for (const name of envKeys) {
        if (previousEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnv[name];
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
  process.env.PI_REFUSAL_FALLBACK_DEBUG = "0";
  process.env.PI_REFUSAL_FALLBACK_CONFIG = join(dir, "fallback.json");
  if (fileConfig || invalidConfig) {
    delete process.env.PI_REFUSAL_FALLBACK_CHAIN;
    await writeFile(process.env.PI_REFUSAL_FALLBACK_CONFIG,
      invalidConfig ? "not valid JSON" : JSON.stringify({ chain }));
  } else {
    process.env.PI_REFUSAL_FALLBACK_CHAIN = chain.map(key).join(",");
  }
  const calls = [];
  const wireCalls = [];
  const errors = [];
  const events = [];
  if (wire) {
    server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const kind = responses[wireCalls.length];
        wireCalls.push({ method: req.method, path: req.url, payload });
        wireReply(res, payload, kind, req.url.startsWith(`/${SECOND.provider}/`));
      } catch {
        res.writeHead(500).end("Test server error");
      }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  }
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const streamSimple = (model, context, options) => {
    const response = responses[calls.length] ?? { stopReason: "error", errorMessage: "Unexpected extra test request" };
    calls.push({ model: key(model), messages: structuredClone(context.messages), reasoning: options?.reasoning });
    const overrides = typeof response === "object" ? response : response === "success" ? {
      stopReason: "stop", content: [{ type: "text", text: "Test response completed." }],
    } : {
      stopReason: response === "aborted" ? "aborted" : "error",
      ...(response === "refusal" ? { rawStopReason: "refusal" } : {}),
      errorMessage: response === "refusal" ? "The model refused to complete the request" : "Request was aborted",
    };
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), content: [], stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...overrides };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  for (const provider of new Set(models.map((model) => model.provider))) {
    runtime.registerProvider(provider, {
      api: wire ? (provider === SECOND.provider ? "openai-completions" : "anthropic-messages") : "offline-refusal-test",
      baseUrl: wire ? `http://127.0.0.1:${server.address().port}/${provider}` : "https://unused.invalid",
      ...(wire ? {} : { streamSimple }), ...(noAuth.includes(provider) ? {} : { apiKey: "offline-test-credential" }),
      models: models.filter((model) => model.provider === provider).map((model) => ({ id: model.id, name: model.id,
        reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    });
  }
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false },
    cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false });
  const paths = [];
  if (priorBoundaryEntry) {
    const priorPath = join(dir, "prior-boundary.ts");
    await writeFile(priorPath, `export default function (pi) {
      pi.on("agent_before_settle", (event) => {
        if (event.outcome === "error") return {
          entries: [...event.entries, { type: "custom", customType: "prior-boundary", data: { preserved: true } }],
        };
      });
    }`);
    paths.push(priorPath);
  }
  paths.push(extensionPath);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: paths, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: "You are an offline test assistant." });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], "extension must load without errors");
  const result = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
    model: runtime.getModel(initial.provider, initial.id), thinkingLevel: "high", resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(dir), tools: [] });
  session = result.session;
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  session.subscribe((event) => events.push(event));
  return { session, calls, wireCalls, errors, events, runtime, settingsManager };
}
