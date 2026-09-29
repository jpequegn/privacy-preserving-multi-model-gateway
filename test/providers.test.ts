import assert from "node:assert/strict";
import { test } from "node:test";
import { executeRoute } from "../src/execution.js";
import { parseProviderConfig } from "../src/providers.js";
import { planRoute } from "../src/routing.js";

const base = { capabilities: ["text"], inputUsdPerMillion: 1, outputUsdPerMillion: 2, qualityScore: 0.7, latencyMs: 10 };
const ollama = { ...base, id: "local-ollama", adapter: "ollama", baseUrl: "http://127.0.0.1:11434", modelName: "test-model" };
const hosted = { ...base, id: "hosted", adapter: "openai_compatible", baseUrl: "https://api.openai.com/v1", modelName: "test-model", apiKeyEnv: "TEST_API_KEY" };

test("configuration rejects unallowlisted remote and non-loopback Ollama URLs", () => {
  assert.throws(() => parseProviderConfig({ models: [hosted] }, { TEST_API_KEY: "secret" }), /remote_host_not_allowed/);
  assert.throws(() => parseProviderConfig({ models: [{ ...ollama, baseUrl: "http://evil.example" }] }), /ollama_must_be_loopback/);
});

test("local-only route never sends a hosted request", async () => {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (url) => { calls.push(String(url)); return new Response("offline", { status: 503 }); };
  const registry = parseProviderConfig({ models: [ollama, hosted] }, { TEST_API_KEY: "secret", GATEWAY_REMOTE_ALLOWLIST: "api.openai.com" }, fetchFn);
  const request = { prompt: "private", privacy: "local_only" as const, policy: "quality" as const };
  const plan = planRoute(request, registry.catalog);
  assert.equal(plan.kind, "ready");
  if (plan.kind !== "ready") return;
  assert.deepEqual(plan.candidates.map((model) => model.id), ["local-ollama"]);
  const result = await executeRoute(request, plan, registry.stream, () => undefined);
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^http:\/\/127\.0\.0\.1/);
});

test("hosted model without a server-side key is omitted", () => {
  const registry = parseProviderConfig({ models: [ollama, hosted] }, { GATEWAY_REMOTE_ALLOWLIST: "api.openai.com" });
  assert.deepEqual(registry.catalog.map((model) => model.id), ["local-ollama"]);
});

test("Ollama NDJSON content and reported usage are normalized", async () => {
  const fetchFn: typeof fetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:11434/api/chat");
    assert.match(String(options?.body), /"stream":true/);
    return new Response('{"message":{"content":"hello "},"done":false}\n{"message":{"content":"world"},"done":false}\n{"done":true,"prompt_eval_count":3,"eval_count":2}\n');
  };
  const registry = parseProviderConfig({ models: [ollama] }, {}, fetchFn);
  const request = { prompt: "say hello", privacy: "local_only" as const, policy: "cost" as const };
  const plan = planRoute(request, registry.catalog);
  if (plan.kind !== "ready") throw new Error("no route");
  const result = await executeRoute(request, plan, registry.stream, () => undefined);
  assert.equal(result.answer, "hello world");
  assert.equal(result.receipt.inputTokens, 3);
  assert.equal(result.receipt.outputTokens, 2);
  assert.equal(result.receipt.costKind, "reported");
});

test("hosted SSE requires opt-in and never exposes its key in receipts", async () => {
  const fetchFn: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal((options?.headers as Record<string, string>).authorization, "Bearer secret");
    return new Response('data: {"choices":[{"delta":{"content":"hosted"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  };
  const registry = parseProviderConfig({ models: [hosted] }, { TEST_API_KEY: "secret", GATEWAY_REMOTE_ALLOWLIST: "api.openai.com" }, fetchFn);
  const request = { prompt: "hello", privacy: "remote_allowed" as const, policy: "quality" as const };
  const plan = planRoute(request, registry.catalog);
  if (plan.kind !== "ready") throw new Error("no route");
  const result = await executeRoute(request, plan, registry.stream, () => undefined);
  assert.equal(result.answer, "hosted");
  assert.equal(result.receipt.costKind, "reported");
  assert.doesNotMatch(JSON.stringify(result.receipt), /secret|hello/);
});

test("a truncated provider stream is an interruption, not success", async () => {
  const fetchFn: typeof fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  const registry = parseProviderConfig({ models: [hosted] }, { TEST_API_KEY: "secret", GATEWAY_REMOTE_ALLOWLIST: "api.openai.com" }, fetchFn);
  const request = { prompt: "x", privacy: "remote_allowed" as const, policy: "cost" as const };
  const plan = planRoute(request, registry.catalog);
  if (plan.kind !== "ready") throw new Error("no route");
  const result = await executeRoute(request, plan, registry.stream, () => undefined);
  assert.equal(result.receipt.outcome, "interrupted");
  assert.equal(result.answer, "partial");
});
