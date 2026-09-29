import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayRequest, ModelEndpoint } from "../src/domain.js";
import { planRoute } from "../src/routing.js";

const request: GatewayRequest = { prompt: "hello", privacy: "local_only", policy: "cost" };
const models: ModelEndpoint[] = [
  { id: "local-cheap", provider: "demo", locality: "local", capabilities: ["text"], inputUsdPerMillion: 0, outputUsdPerMillion: 0, qualityScore: 0.5, latencyMs: 10 },
  { id: "local-good", provider: "demo", locality: "local", capabilities: ["text", "reasoning"], inputUsdPerMillion: 2, outputUsdPerMillion: 4, qualityScore: 0.9, latencyMs: 30 },
  { id: "remote", provider: "hosted", locality: "remote", capabilities: ["text"], inputUsdPerMillion: 1, outputUsdPerMillion: 1, qualityScore: 1, latencyMs: 5 },
];

test("local-only excludes remote before ranking", () => {
  const plan = planRoute(request, models);
  assert.equal(plan.kind, "ready");
  if (plan.kind !== "ready") return;
  assert.deepEqual(plan.candidates.map((model) => model.id), ["local-cheap", "local-good"]);
  assert.deepEqual(plan.reasons.remote, ["privacy"]);
});

test("quality policy changes order without changing eligibility", () => {
  const plan = planRoute({ ...request, policy: "quality" }, models);
  assert.equal(plan.kind, "ready");
  if (plan.kind !== "ready") return;
  assert.deepEqual(plan.candidates.map((model) => model.id), ["local-good", "local-cheap"]);
});

test("capability and budget are hard gates", () => {
  const plan = planRoute({ ...request, requiredCapabilities: ["reasoning"], maxCostUsd: 0 }, models);
  assert.equal(plan.kind, "refused");
  assert.deepEqual(plan.reasons["local-cheap"], ["capability"]);
  assert.deepEqual(plan.reasons["local-good"], ["budget"]);
});

test("unknown locality is never eligible", () => {
  const plan = planRoute({ ...request, privacy: "remote_allowed" }, [{ ...models[0]!, id: "unknown", locality: "unknown" }]);
  assert.equal(plan.kind, "refused");
  assert.deepEqual(plan.reasons.unknown, ["unknown_locality"]);
});
