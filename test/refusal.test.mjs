import assert from "node:assert/strict";
import test from "node:test";
import { isRefusal, modelKey } from "../src/refusal.ts";

const error = (errorMessage, extra = {}) => ({ role: "assistant", stopReason: "error", errorMessage, ...extra });

test("explicit provider refusals and canonical legacy errors are recognized", () => {
  assert.equal(isRefusal(error("wrapped error", { rawStopReason: "refusal" })), true);
  assert.equal(isRefusal(error("wrapped error", { rawStopReason: "refusal", stopReason: "stop" })), true);
  for (const text of ["The model refused to complete the request", "Model refused to process request", "Refusal: provider declined", "This request triggered restrictions on violative cyber content", "Blocked under the provider's Usage Policy"]) {
    assert.equal(isRefusal(error(text)), true, text);
  }
});

test("network/auth/proxy refusals and generic policy prose are not model refusals", () => {
  for (const text of ["ECONNREFUSED", "Connection refused", "Proxy refused connection", "Permission refused", "403 Access refused", "Quota exhausted under usage policy", "refused to connect", "DNS lookup failed", "Request was aborted"]) {
    assert.equal(isRefusal(error(text)), false, text);
  }
});

test("stale refusal metadata never restarts pending, aborted or tool-executing turns", () => {
  for (const stopReason of ["pending", "aborted", "toolUse", "length", "deferred"]) {
    assert.equal(isRefusal(error("The model refused to complete the request", { rawStopReason: "refusal", stopReason })), false);
  }
  assert.equal(isRefusal({ role: "user", rawStopReason: "refusal" }), false);
  const oversized = "x".repeat(8192) + " The model refused to complete the request";
  assert.equal(isRefusal(error(oversized)), false, "legacy text scanning is bounded");
  assert.equal(isRefusal(error(oversized, { rawStopReason: "refusal" })), true, "explicit provider reason remains authoritative");
});

test("model keys cannot collide across provider/model slash boundaries", () => {
  assert.notEqual(modelKey({ provider: "a/b", id: "c" }), modelKey({ provider: "a", id: "b/c" }));
});
