import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCatalog } from "../src/demo.js";
import type { RouteReceipt } from "../src/domain.js";
import { catalogWithFeedback, leaderboard } from "../src/feedback.js";
import { MemoryLedger } from "../src/ledger.js";
import { planRoute } from "../src/routing.js";

function receipt(id: string): RouteReceipt {
  return { id, createdAt: new Date().toISOString(), policy: "quality", privacy: "local_only", modelId: "local-fast", attempts: [],
    inputTokens: 1, outputTokens: 1, costUsd: 0, costKind: "synthetic", elapsedMs: 1, decisionMs: 1, outcome: "completed" };
}

test("feedback is idempotent metadata and sparse votes do not alter ranking", () => {
  const ledger = new MemoryLedger();
  ledger.record(receipt("one"));
  assert.equal(ledger.setFeedback("one", "up", false), true);
  assert.equal(ledger.setFeedback("one", "up", false), true);
  assert.equal(ledger.setFeedback("missing", "up", false), false);
  assert.equal(leaderboard(demoCatalog, ledger.list()).find((item) => item.modelId === "local-fast")?.positiveRate, null);
  assert.deepEqual(catalogWithFeedback(demoCatalog, ledger.list()), demoCatalog);
});

test("adequate feedback adjusts soft quality but not privacy eligibility", () => {
  const ledger = new MemoryLedger();
  for (let index = 0; index < 5; index++) {
    ledger.record(receipt(String(index)));
    ledger.setFeedback(String(index), "up", false);
  }
  const adjusted = catalogWithFeedback(demoCatalog, ledger.list());
  assert.ok(adjusted.find((model) => model.id === "local-fast")!.qualityScore > demoCatalog[0]!.qualityScore);
  const remote = { ...demoCatalog[0]!, id: "remote", locality: "remote" as const };
  const plan = planRoute({ prompt: "x", privacy: "local_only", policy: "quality" }, [...adjusted, remote]);
  assert.equal(plan.kind, "ready");
  if (plan.kind === "ready") assert.equal(plan.candidates.some((model) => model.id === "remote"), false);
});
