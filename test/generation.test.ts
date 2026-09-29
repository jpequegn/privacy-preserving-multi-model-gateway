import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../src/http.js";
import { MemoryLedger } from "../src/ledger.js";
import { demoCatalog, streamDemo } from "../src/demo.js";

const ledger = new MemoryLedger();
const server = createGatewayServer(undefined, undefined, ledger);
let baseUrl: string;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

async function generate(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("key-free generation returns a synthetic answer and receipt", async () => {
  const response = await generate({ prompt: "Summarize this note", policy: "cost" });
  assert.equal(response.status, 200);
  const result = await response.json() as { answer: string; receipt: { modelId: string; privacy: string; outcome: string; attempts: unknown[] }; synthetic: boolean };
  assert.match(result.answer, /^\[Synthetic local-flaky\]/);
  assert.equal(result.receipt.modelId, "local-flaky");
  assert.equal(result.receipt.privacy, "local_only");
  assert.equal(result.receipt.outcome, "completed");
  assert.equal(result.receipt.attempts.length, 1);
  assert.equal(result.synthetic, true);
});

test("invalid input is rejected without echoing the prompt", async () => {
  const response = await generate({ prompt: "SECRET", policy: "invalid" });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /SECRET/);
});

test("a zero budget refuses all demo models", async () => {
  const response = await generate({ prompt: "hello", maxCostUsd: 0 });
  assert.equal(response.status, 422);
});

test("SSE emits chunks followed by a final receipt", async () => {
  const response = await fetch(`${baseUrl}/api/generate/stream`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello world" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /event: chunk/);
  assert.match(body, /event: done/);
  assert.match(body, /"outcome":"completed"/);
});

test("metrics reconcile with metadata receipts and can be cleared", async () => {
  const receipts = await fetch(`${baseUrl}/api/receipts`).then((response) => response.json()) as { receipts: { costUsd: number }[] };
  const metrics = await fetch(`${baseUrl}/api/metrics`).then((response) => response.json()) as { requests: number; totalCostUsd: number };
  assert.equal(metrics.requests, receipts.receipts.length);
  assert.equal(metrics.totalCostUsd, receipts.receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0));
  const cleared = await fetch(`${baseUrl}/api/receipts`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.equal(ledger.list().length, 0);
});

test("feedback updates leaderboard without accepting correction text", async () => {
  const generated = await generate({ prompt: "Private note" }).then((response) => response.json()) as { receipt: { id: string } };
  const response = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: generated.receipt.id, rating: "up", corrected: true, correctionText: "SECRET_CORRECTION" }),
  });
  assert.equal(response.status, 200);
  const receipts = await fetch(`${baseUrl}/api/receipts`).then((item) => item.text());
  assert.doesNotMatch(receipts, /Private note|SECRET_CORRECTION/);
  const leaderboard = await fetch(`${baseUrl}/api/leaderboard`).then((item) => item.json()) as { models: { ratings: number }[] };
  assert.ok(leaderboard.models.some((model) => model.ratings > 0));
});

test("opt-in comparison returns two gated answers and a shared identity", async () => {
  const response = await fetch(`${baseUrl}/api/compare`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Compare this", privacy: "local_only", policy: "quality" }) });
  assert.equal(response.status, 200);
  const result = await response.json() as { comparisonId: string; primary: { answer: string; receipt: { modelId: string; comparisonId: string } }; alternative: { answer: string; receipt: { modelId: string; comparisonId: string } }; disagreement: string };
  assert.notEqual(result.primary.receipt.modelId, result.alternative.receipt.modelId);
  assert.equal(result.primary.receipt.comparisonId, result.comparisonId);
  assert.equal(result.alternative.receipt.comparisonId, result.comparisonId);
  assert.equal(result.disagreement, "different");
  assert.match(result.primary.answer, /^\[Synthetic/);
});

test("comparison rejects a ceiling that cannot cover both planned models", async () => {
  const response = await fetch(`${baseUrl}/api/compare`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", privacy: "local_only", policy: "cost", maxCostUsd: 0.0003 }) });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "comparison_budget_too_low" });
});

test("comparison refuses a remote second model under local-only privacy", async () => {
  const remote = { ...demoCatalog[0]!, id: "remote", locality: "remote" as const };
  let remoteCalls = 0;
  const comparisonServer = createGatewayServer([demoCatalog[0]!, remote], (model, input, signal) => {
    if (model.id === "remote") remoteCalls += 1;
    return streamDemo(model, input, signal);
  }, new MemoryLedger());
  await new Promise<void>((resolve) => comparisonServer.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(comparisonServer.address() as AddressInfo).port}/api/compare`;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "private", privacy: "local_only" }) });
    assert.equal(response.status, 422);
    assert.equal(remoteCalls, 0);
  } finally { await new Promise<void>((resolve) => comparisonServer.close(() => resolve())); }
});

test("comparison does not launch a second call after the client disconnects", async () => {
  const calls: string[] = [];
  let startedFirst!: () => void;
  const started = new Promise<void>((resolve) => { startedFirst = resolve; });
  const comparisonServer = createGatewayServer([demoCatalog[2]!, demoCatalog[0]!], async function* (model) {
    calls.push(model.id);
    startedFirst();
    await new Promise((resolve) => setTimeout(resolve, 100));
    yield "late answer";
  }, new MemoryLedger());
  await new Promise<void>((resolve) => comparisonServer.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    const url = `http://127.0.0.1:${(comparisonServer.address() as AddressInfo).port}/api/compare`;
    const pending = fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello", policy: "cost" }), signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(calls, ["local-flaky"]);
  } finally { await new Promise<void>((resolve) => comparisonServer.close(() => resolve())); }
});
