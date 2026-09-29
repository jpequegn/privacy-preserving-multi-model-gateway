import { readFileSync } from "node:fs";
import type { GatewayRequest, ModelEndpoint } from "./domain.js";
import { streamDemo } from "./demo.js";
import type { ModelStream, StreamItem } from "./execution.js";

interface ProviderTarget {
  adapter: "demo" | "ollama" | "openai_compatible";
  baseUrl?: string;
  modelName?: string;
  apiKeyEnv?: string;
}

export interface ProviderRegistry {
  catalog: ModelEndpoint[];
  stream: ModelStream;
}

function parseUsage(inputTokens: unknown, outputTokens: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0) return undefined;
  return { inputTokens, outputTokens };
}

async function* lines(response: Response): AsyncIterable<string> {
  if (!response.body) throw new Error("provider_empty_body");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1_048_576) throw new Error("provider_line_too_large");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer.trim();
}

async function* streamOllama(target: ProviderTarget, prompt: string, signal: AbortSignal, fetchFn: typeof fetch): AsyncIterable<StreamItem> {
  const response = await fetchFn(`${target.baseUrl}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: target.modelName, messages: [{ role: "user", content: prompt }], stream: true, options: { num_predict: 512 } }),
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  let complete = false;
  for await (const line of lines(response)) {
    if (!line) continue;
    const event = JSON.parse(line) as { message?: { content?: unknown }; error?: unknown; done?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
    if (event.error) throw new Error("provider_error");
    if (typeof event.message?.content === "string" && event.message.content) yield event.message.content;
    const usage = parseUsage(event.prompt_eval_count, event.eval_count);
    if (usage) yield { usage };
    if (event.done === true) complete = true;
  }
  if (!complete) throw new Error("provider_incomplete_stream");
}

async function* streamOpenAI(target: ProviderTarget, prompt: string, signal: AbortSignal, fetchFn: typeof fetch, env: NodeJS.ProcessEnv): AsyncIterable<StreamItem> {
  const key = target.apiKeyEnv ? env[target.apiKeyEnv] : undefined;
  if (!key) throw new Error("provider_not_configured");
  const response = await fetchFn(`${target.baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, signal,
    body: JSON.stringify({ model: target.modelName, messages: [{ role: "user", content: prompt }], stream: true, max_tokens: 512, stream_options: { include_usage: true } }),
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  let complete = false;
  for await (const line of lines(response)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { complete = true; break; }
    const event = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[]; error?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    if (event.error) throw new Error("provider_error");
    const content = event.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content) yield content;
    const usage = parseUsage(event.usage?.prompt_tokens, event.usage?.completion_tokens);
    if (usage) yield { usage };
  }
  if (!complete) throw new Error("provider_incomplete_stream");
}

export function parseProviderConfig(value: unknown, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): ProviderRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_provider_config");
  const entries = (value as Record<string, unknown>).models;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20) throw new Error("invalid_provider_models");
  const allowedHosts = new Set((env.GATEWAY_REMOTE_ALLOWLIST ?? "").split(",").map((host) => host.trim()).filter(Boolean));
  const targets = new Map<string, ProviderTarget>();
  const catalog: ModelEndpoint[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("invalid_provider_model");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || targets.has(item.id)) throw new Error("invalid_model_id");
    if (item.adapter !== "demo" && item.adapter !== "ollama" && item.adapter !== "openai_compatible") throw new Error("invalid_adapter");
    const adapter = item.adapter;
    const locality = adapter === "openai_compatible" ? "remote" : "local";
    const numeric = [item.inputUsdPerMillion, item.outputUsdPerMillion, item.qualityScore, item.latencyMs];
    if (numeric.some((field) => typeof field !== "number" || !Number.isFinite(field) || field < 0) || (item.qualityScore as number) > 1) throw new Error("invalid_model_metrics");
    if (!Array.isArray(item.capabilities) || item.capabilities.some((field) => typeof field !== "string")) throw new Error("invalid_capabilities");
    const target: ProviderTarget = { adapter };
    if (adapter !== "demo") {
      if (typeof item.baseUrl !== "string" || typeof item.modelName !== "string" || !item.modelName) throw new Error("invalid_provider_target");
      const url = new URL(item.baseUrl);
      if (url.username || url.password || url.search || url.hash) throw new Error("invalid_provider_url");
      if (adapter === "ollama" && (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("ollama_must_be_loopback");
      if (adapter === "openai_compatible" && (url.protocol !== "https:" || !allowedHosts.has(url.hostname))) throw new Error("remote_host_not_allowed");
      target.baseUrl = url.toString().replace(/\/$/, "");
      target.modelName = item.modelName;
    }
    if (adapter === "openai_compatible") {
      if (typeof item.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(item.apiKeyEnv)) throw new Error("invalid_api_key_env");
      target.apiKeyEnv = item.apiKeyEnv;
      if (!env[item.apiKeyEnv]) continue;
    }
    targets.set(item.id, target);
    catalog.push({ id: item.id, provider: adapter, locality, capabilities: item.capabilities as string[],
      inputUsdPerMillion: item.inputUsdPerMillion as number, outputUsdPerMillion: item.outputUsdPerMillion as number,
      qualityScore: item.qualityScore as number, latencyMs: item.latencyMs as number });
  }
  if (catalog.length === 0) throw new Error("no_configured_models");
  const stream: ModelStream = (model: ModelEndpoint, request: GatewayRequest, signal: AbortSignal) => {
    const target = targets.get(model.id);
    if (!target) throw new Error("model_not_configured");
    if (target.adapter === "demo") return streamDemo(model, request, signal);
    if (target.adapter === "ollama") return streamOllama(target, request.prompt, signal, fetchFn);
    return streamOpenAI(target, request.prompt, signal, fetchFn, env);
  };
  return { catalog, stream };
}

export function loadProviderConfig(path: string, env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  return parseProviderConfig(JSON.parse(readFileSync(path, "utf8")) as unknown, env);
}
