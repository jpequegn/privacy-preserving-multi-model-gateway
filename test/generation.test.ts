import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../src/http.js";
import { MemoryLedger } from "../src/ledger.js";

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
