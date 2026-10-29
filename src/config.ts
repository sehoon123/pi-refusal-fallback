import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ChainEntry {
  provider: string;
  id: string;
}

export interface Configuration {
  chain: ChainEntry[];
  source: "environment" | "file" | "none";
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value.trim());
}

function parseChain(value: unknown): ChainEntry[] {
  if (!Array.isArray(value)) throw new Error("The configuration must contain a chain array.");
  return value.map((entry: unknown, index: number) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Chain entry ${index + 1} must be an object with provider and id strings.`);
    }
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== "provider" && key !== "id") ||
        !identifier(item.provider) || !identifier(item.id)) {
      throw new Error(`Chain entry ${index + 1} must contain only nonempty provider and id strings.`);
    }
    return { provider: item.provider.trim(), id: item.id.trim() };
  });
}

/** No built-in providers or models. An empty environment value explicitly disables fallback. */
export function readConfiguration(options: {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Configuration {
  const env = options.env ?? process.env;
  if (env.PI_REFUSAL_FALLBACK_CHAIN !== undefined) {
    const raw = env.PI_REFUSAL_FALLBACK_CHAIN.trim();
    if (!raw) return { chain: [], source: "environment" };
    const entries = raw.split(",").map((part, index) => {
      const separator = part.indexOf("/");
      if (separator < 1) throw new Error(`Environment chain entry ${index + 1} must use provider/model-id.`);
      // Model IDs can contain additional slashes; split only at the first one.
      return { provider: part.slice(0, separator), id: part.slice(separator + 1) };
    });
    return { chain: parseChain(entries), source: "environment" };
  }

  const override = env.PI_REFUSAL_FALLBACK_CONFIG;
  const requestedPath = override ?? join(options.agentDir, "refusal-fallback.json");
  const expandedPath = requestedPath.startsWith("~/") ? join(homedir(), requestedPath.slice(2)) : requestedPath;
  const configPath = resolve(options.cwd ?? process.cwd(), expandedPath);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (override === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { chain: [], source: "none" };
    }
    throw new Error("Cannot read the refusal-fallback configuration file.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Do not echo input: a mistaken configuration can contain secrets.
    throw new Error("The refusal-fallback configuration file is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "chain")) {
    throw new Error("The configuration must be an object containing only a chain array.");
  }
  return { chain: parseChain((value as Record<string, unknown>).chain), source: "file" };
}
