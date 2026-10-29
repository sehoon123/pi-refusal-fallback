import { readFileSync, statSync } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { modelKey } from "./refusal.ts";

export interface ChainEntry { provider: string; id: string }
/** What to hand the next model when a response was cut off by a refusal. */
export const CARRY_MODES = ["off", "cross-provider", "always"] as const;
export type CarryMode = (typeof CARRY_MODES)[number];
export interface Configuration {
  chain: ChainEntry[];
  source: "environment" | "file" | "none";
  retryMessages?: boolean;
  showStatus?: boolean;
  notifications?: boolean;
  carryPartial?: CarryMode;
}
export interface ConfigOptions { agentDir: string; env?: NodeJS.ProcessEnv; cwd?: string }
export const MAX_CONFIG_BYTES = 65_536;
export const MAX_CHAIN_ENTRIES = 128;
const optionNames = ["retryMessages", "showStatus", "notifications"] as const;

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value.trim());
}
function parseChain(value: unknown): ChainEntry[] {
  if (!Array.isArray(value) || value.length > MAX_CHAIN_ENTRIES) {
    throw new Error(`The chain must be an array with at most ${MAX_CHAIN_ENTRIES} entries.`);
  }
  const seen = new Set<string>();
  const result: ChainEntry[] = [];
  value.forEach((entry: unknown, index: number) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Chain entry ${index + 1} must be an object with provider and id strings.`);
    }
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== "provider" && key !== "id") ||
        !identifier(item.provider) || !identifier(item.id)) {
      throw new Error(`Chain entry ${index + 1} must contain only nonempty provider and id strings.`);
    }
    const model = { provider: item.provider.trim(), id: item.id.trim() };
    const key = modelKey(model);
    if (!seen.has(key)) { seen.add(key); result.push(model); }
  });
  return result;
}
function document(value: unknown): Omit<Configuration, "source"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The configuration must be an object with a chain array.");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => key !== "chain" && key !== "carryPartial" && !optionNames.includes(key as typeof optionNames[number]))) {
    throw new Error("Unknown configuration field; use chain, retryMessages, showStatus, notifications and carryPartial only.");
  }
  const result: Omit<Configuration, "source"> = { chain: parseChain(item.chain) };
  if (item.carryPartial !== undefined) {
    if (typeof item.carryPartial !== "string" || !(CARRY_MODES as readonly string[]).includes(item.carryPartial)) {
      throw new Error("The carryPartial option must be off, cross-provider or always.");
    }
    result.carryPartial = item.carryPartial as CarryMode;
  }
  for (const key of optionNames) {
    if (item[key] !== undefined) {
      if (typeof item[key] !== "boolean") throw new Error(`The ${key} option must be a boolean.`);
      result[key] = item[key];
    }
  }
  return result;
}
export function configurationPath(options: ConfigOptions): string {
  const requested = (options.env ?? process.env).PI_REFUSAL_FALLBACK_CONFIG ?? join(options.agentDir, "refusal-fallback.json");
  const expanded = requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested;
  return resolve(options.cwd ?? process.cwd(), expanded);
}
function boundedRead(path: string): Buffer {
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error("Configuration must be a regular file no larger than 64 KiB.");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error("Configuration must be no larger than 64 KiB.");
  return bytes;
}
/** No provider/model presets. Reads once at load or explicit reload, never per token/turn. */
export function readConfiguration(options: ConfigOptions): Configuration {
  const env = options.env ?? process.env;
  if (env.PI_REFUSAL_FALLBACK_CHAIN !== undefined) {
    const raw = env.PI_REFUSAL_FALLBACK_CHAIN.trim();
    if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error("Environment chain must be no larger than 64 KiB.");
    if (!raw) return { chain: [], source: "environment" };
    const entries = raw.split(",").map((part, index) => {
      const separator = part.indexOf("/");
      if (separator < 1) throw new Error(`Environment chain entry ${index + 1} must use provider/model-id.`);
      return { provider: part.slice(0, separator), id: part.slice(separator + 1) };
    });
    return { chain: parseChain(entries), source: "environment" };
  }
  let bytes: Buffer;
  try {
    bytes = boundedRead(configurationPath(options));
  } catch (error) {
    if (env.PI_REFUSAL_FALLBACK_CONFIG === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { chain: [], source: "none" };
    }
    // File contents, paths and arbitrary system errors must not leak through diagnostics.
    throw new Error("Cannot read configuration: use an accessible regular file no larger than 64 KiB.");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("The refusal-fallback configuration file is not valid JSON/UTF-8."); }
  return { ...document(value), source: "file" };
}
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const temporary = join(dirname(path), `.refusal-fallback-${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporary, path);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
/** Explicit setup command only: validated, private, atomic and cancellation-safe. Returns whether an earlier file was kept as .bak. */
export async function saveConfiguration(options: ConfigOptions, value: unknown): Promise<{ backedUp: boolean }> {
  if ((options.env ?? process.env).PI_REFUSAL_FALLBACK_CHAIN !== undefined) {
    throw new Error("The environment chain overrides files. Unset it before using setup.");
  }
  const parsed = document(value);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new Error("Configuration must be no larger than 64 KiB.");
  const path = configurationPath(options);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error("Cannot inspect the configuration file.");
  });
  if (existing) {
    if (!existing.isFile()) throw new Error("Setup does not replace symlinks or special files; edit them manually.");
    await atomicWrite(`${path}.bak`, boundedRead(path));
  }
  await atomicWrite(path, serialized);
  return { backedUp: existing !== undefined };
}
