import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCatalog } from "../src/demo.js";
import type { GatewayRequest, ModelEndpoint } from "../src/domain.js";
import { executeRoute, type ModelStream } from "../src/execution.js";
import { planRoute } from "../src/routing.js";
import { estimatedCostUsd } from "../src/routing.js";

const request: GatewayRequest = { prompt: "hello", privacy: "local_only", policy: "cost" };
const catalog = [demoCatalog[2]!, demoCatalog[0]!];
const plan = planRoute(request, catalog);
if (plan.kind !== "ready") throw new Error("bad test catalog");

test("fails over before first chunk", async () => {
  const seen: string[] = [];
  const stream: ModelStream = async function* (model) {
    if (model.id === "local-flaky") throw new Error("offline");
    yield "backup answer";
  };
  const result = await executeRoute(request, plan, stream, (chunk) => seen.push(chunk));
  assert.equal(result.receipt.outcome, "completed");
  assert.equal(result.receipt.modelId, "local-fast");
  assert.deepEqual(result.receipt.attempts.map((attempt) => attempt.status), ["failed", "completed"]);
  assert.deepEqual(seen, ["backup answer"]);
});

test("partial stream does not splice another model", async () => {
  const seen: string[] = [];
  const stream: ModelStream = async function* (model) {
    if (model.id === "local-flaky") { yield "partial"; throw new Error("offline"); }
    yield "backup";
  };
  const result = await executeRoute(request, plan, stream, (chunk) => seen.push(chunk));
  assert.equal(result.receipt.outcome, "interrupted");
  assert.equal(result.receipt.attempts.length, 1);
  assert.deepEqual(seen, ["partial"]);
});

test("fallback cannot use a remote model under local-only privacy", async () => {
  const remote: ModelEndpoint = { ...demoCatalog[0]!, id: "remote", locality: "remote" };
  const localPlan = planRoute(request, [demoCatalog[2]!, remote]);
  assert.equal(localPlan.kind, "ready");
  if (localPlan.kind !== "ready") return;
  const stream: ModelStream = async function* () { throw new Error("offline"); };
  const result = await executeRoute(request, localPlan, stream, () => undefined);
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.attempts.length, 1);
});

test("a timed-out primary fails over within the configured deadline", async () => {
  const stream: ModelStream = async function* (model) {
    if (model.id === "local-flaky") await new Promise((resolve) => setTimeout(resolve, 100));
    yield model.id;
  };
  const result = await executeRoute(request, plan, stream, () => undefined, undefined, { attemptMs: 10, overallMs: 200, maxAttempts: 2 });
  assert.equal(result.receipt.outcome, "completed");
  assert.deepEqual(result.receipt.attempts.map((attempt) => attempt.status), ["timed_out", "completed"]);
});

test("failed-attempt cost consumes the shared retry ceiling", async () => {
  const priced = [
    { ...demoCatalog[2]!, id: "first", inputUsdPerMillion: 100, outputUsdPerMillion: 100 },
    { ...demoCatalog[0]!, id: "second", inputUsdPerMillion: 100, outputUsdPerMillion: 100 },
  ];
  const ceiling = estimatedCostUsd(priced[0]!, request.prompt) + 0.00001;
  const budgetRequest = { ...request, maxCostUsd: ceiling };
  const budgetPlan = planRoute(budgetRequest, priced);
  if (budgetPlan.kind !== "ready") throw new Error("no route");
  let calls = 0;
  const stream: ModelStream = async function* () { calls += 1; throw new Error("offline"); };
  const result = await executeRoute(budgetRequest, budgetPlan, stream, () => undefined);
  assert.equal(calls, 1);
  assert.equal(result.receipt.attempts.length, 1);
  assert.ok(result.receipt.costUsd > 0);
});

test("reported usage above the estimate cannot be marked completed", async () => {
  const budgetRequest = { ...request, maxCostUsd: 0.001 };
  const single = planRoute(budgetRequest, [demoCatalog[0]!]);
  if (single.kind !== "ready") throw new Error("no route");
  const stream: ModelStream = async function* () {
    yield "answer";
    yield { usage: { inputTokens: 100_000, outputTokens: 1 } };
  };
  const result = await executeRoute(budgetRequest, single, stream, () => undefined);
  assert.equal(result.receipt.outcome, "interrupted");
  assert.equal(result.receipt.attempts[0]?.reason, "budget_exceeded");
  assert.ok(result.receipt.costUsd > budgetRequest.maxCostUsd);
});
