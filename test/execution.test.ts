import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCatalog } from "../src/demo.js";
import type { GatewayRequest, ModelEndpoint } from "../src/domain.js";
import { executeRoute, type ModelStream } from "../src/execution.js";
import { planRoute } from "../src/routing.js";

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
