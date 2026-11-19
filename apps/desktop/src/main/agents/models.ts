import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProviderId, AgentSettings, ModelOption, ProviderModels } from "@studio/shared";
import { paths } from "../paths";
import { listCodexModels } from "./codex";
import { executableFor } from "./detect";

/**
 * Model lists come from the installed CLIs themselves, so new models appear without an app update.
 * They're cached on disk (the CLI calls take a few seconds) and refreshed in the background.
 */
const CACHE_HOURS = 12;
const cacheFile = () => join(paths.dataDir, "models-cache.json");

function readCache(): Partial<Record<AgentProviderId, ProviderModels>> {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeCache(entry: ProviderModels): void {
  const all = readCache();
  all[entry.provider] = entry;
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(all, null, 1));
}

async function claudeModels(): Promise<ModelOption[]> {
  const exe = await executableFor("claude");
  // A session that never receives a prompt: enough to ask the CLI what it supports.
  const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }) };
  const abort = new AbortController();
  const q = query({ prompt: idle, options: { pathToClaudeCodeExecutable: exe, settingSources: [], cwd: os.homedir(), abortController: abort } });
  try {
    const list = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claude Code took too long to list its models.")), 30000)),
    ]);
    return list.map((m) => ({
      id: m.value,
      label: m.displayName,
      description: m.description,
      efforts: m.supportedEffortLevels ?? [],
      fast: m.supportsFastMode ? { label: "Fast mode", description: "Faster responses; uses more of your plan" } : undefined,
    }));
  } finally {
    abort.abort();
  }
}

const inflight = new Map<AgentProviderId, Promise<ProviderModels>>();

export async function providerModels(provider: AgentProviderId, refresh = false): Promise<ProviderModels> {
  const cached = readCache()[provider];
  const fresh = cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_HOURS * 3600_000;
  if (cached?.models.length && !refresh) {
    if (!fresh) void load(provider).catch(() => {}); // refresh quietly for next time
    return cached;
  }
  return load(provider);
}

function load(provider: AgentProviderId): Promise<ProviderModels> {
  let p = inflight.get(provider);
  if (!p) {
    p = (async () => {
      try {
        const models = provider === "claude" ? await claudeModels() : await listCodexModels();
        const entry: ProviderModels = { provider, models, fetchedAt: new Date().toISOString() };
        writeCache(entry);
        return entry;
      } catch (e) {
        const cached = readCache()[provider];
        return { provider, models: cached?.models ?? [], fetchedAt: cached?.fetchedAt, error: e instanceof Error ? e.message : String(e) };
      } finally {
        inflight.delete(provider);
      }
    })();
    inflight.set(provider, p);
  }
  return p;
}

// ---------------------------------------------------------------- defaults for new projects

const settingsFile = () => join(paths.dataDir, "settings.json");

export function agentDefaults(): AgentSettings {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { agent?: AgentSettings };
    if (s.agent?.provider) return s.agent;
  } catch {
    /* first run */
  }
  return { provider: "claude" };
}

export function setAgentDefaults(agent: AgentSettings): void {
  let s: Record<string, unknown> = {};
  try {
    s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    /* first write */
  }
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...s, agent }, null, 1));
}
