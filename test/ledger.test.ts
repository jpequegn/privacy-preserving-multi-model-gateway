import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RouteReceipt } from "../src/domain.js";
import { FileLedger, summarize } from "../src/ledger.js";

const receipt: RouteReceipt = {
  id: "test", createdAt: new Date().toISOString(), policy: "cost", privacy: "local_only", modelId: "demo",
  attempts: [{ modelId: "demo", elapsedMs: 10, status: "completed" }], inputTokens: 2, outputTokens: 3,
  costUsd: 0.1, costKind: "synthetic", elapsedMs: 12, decisionMs: 2, outcome: "completed",
};

test("file ledger persists only metadata across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-ledger-"));
  try {
    const path = join(directory, "receipts.jsonl");
    const ledger = new FileLedger(path);
    ledger.record({ ...receipt, prompt: "CANARY_PROMPT", answer: "CANARY_ANSWER" } as RouteReceipt);
    assert.doesNotMatch(readFileSync(path, "utf8"), /CANARY_PROMPT|CANARY_ANSWER/);
    assert.deepEqual(new FileLedger(path).list(), [receipt]);
    assert.equal(summarize(ledger.list()).totalCostUsd, 0.1);
    ledger.clear();
    assert.deepEqual(new FileLedger(path).list(), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("expired receipts are removed on load", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-ledger-"));
  try {
    const path = join(directory, "receipts.jsonl");
    const ledger = new FileLedger(path, 1);
    ledger.record({ ...receipt, createdAt: "2020-01-01T00:00:00.000Z" });
    assert.equal(new FileLedger(path, 1).list().length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
