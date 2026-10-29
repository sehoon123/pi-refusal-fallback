import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Prefer the provider's explicit terminal reason; never confuse ECONNREFUSED with a refusal. */
export function isRefusal(message: AgentMessage): boolean {
  if (message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "stop")) return false;
  if (message.rawStopReason === "refusal") return true;
  if (message.stopReason !== "error") return false;
  const text = (message.errorMessage ?? "").slice(0, 4096);
  return /\bmodel refused to (?:complete|process|answer)(?: the)? request\b/i.test(text) ||
    /^refusal(?:\s*:|\s*$)/i.test(text.trim()) ||
    /\bviolative cyber content\b/i.test(text) ||
    /\bblocked under [^\r\n.]{0,100}usage policy\b/i.test(text);
}

export const modelKey = (model: { provider: string; id: string }): string => JSON.stringify([model.provider, model.id]);
export const modelLabel = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;
