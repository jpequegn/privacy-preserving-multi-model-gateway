import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../src/http.js";

const server = createGatewayServer();
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
