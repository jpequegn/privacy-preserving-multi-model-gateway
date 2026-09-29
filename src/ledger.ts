import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RouteReceipt } from "./domain.js";

export interface Ledger {
  record(receipt: RouteReceipt): void;
  list(): readonly RouteReceipt[];
  clear(): void;
}

export class MemoryLedger implements Ledger {
  private receipts: RouteReceipt[] = [];
  record(receipt: RouteReceipt): void { this.receipts.push(metadataOnly(receipt)); }
  list(): readonly RouteReceipt[] { return [...this.receipts]; }
  clear(): void { this.receipts = []; }
}

function metadataOnly(receipt: RouteReceipt): RouteReceipt {
  return {
    id: receipt.id,
    createdAt: receipt.createdAt,
    policy: receipt.policy,
    privacy: receipt.privacy,
    ...(receipt.modelId === undefined ? {} : { modelId: receipt.modelId }),
    attempts: receipt.attempts.map((attempt) => ({ modelId: attempt.modelId, elapsedMs: attempt.elapsedMs, status: attempt.status, ...(attempt.reason === undefined ? {} : { reason: attempt.reason }) })),
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
    costUsd: receipt.costUsd,
    costKind: receipt.costKind,
    elapsedMs: receipt.elapsedMs,
    decisionMs: receipt.decisionMs,
    outcome: receipt.outcome,
  };
}

export class FileLedger implements Ledger {
  private receipts: RouteReceipt[] = [];

  constructor(private readonly path: string, private readonly retentionDays = 30) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        try { this.receipts.push(metadataOnly(JSON.parse(line) as RouteReceipt)); } catch {}
      }
    }
    this.purgeExpired();
  }

  record(receipt: RouteReceipt): void {
    const safe = metadataOnly(receipt);
    appendFileSync(this.path, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    this.receipts.push(safe);
    this.purgeExpired();
  }

  list(): readonly RouteReceipt[] { return [...this.receipts]; }

  clear(): void {
    this.receipts = [];
    this.rewrite();
  }

  private purgeExpired(): void {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    const kept = this.receipts.filter((receipt) => Date.parse(receipt.createdAt) >= cutoff);
    if (kept.length !== this.receipts.length) { this.receipts = kept; this.rewrite(); }
  }

  private rewrite(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, this.receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + (this.receipts.length ? "\n" : ""), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(fraction * ordered.length) - 1] ?? 0;
}

export function summarize(receipts: readonly RouteReceipt[]) {
  const perModel: Record<string, { requests: number; costUsd: number }> = {};
  const frequency: Record<string, number> = {};
  for (const receipt of receipts) {
    const model = receipt.modelId ?? "unserved";
    perModel[model] ??= { requests: 0, costUsd: 0 };
    perModel[model].requests += 1;
    perModel[model].costUsd += receipt.costUsd;
    const hour = receipt.createdAt.slice(0, 13) + ":00Z";
    frequency[hour] = (frequency[hour] ?? 0) + 1;
  }
  return {
    requests: receipts.length,
    totalCostUsd: receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0),
    perModel,
    latencyMs: { p50: percentile(receipts.map((receipt) => receipt.elapsedMs), 0.5), p95: percentile(receipts.map((receipt) => receipt.elapsedMs), 0.95) },
    decisionMs: { p50: percentile(receipts.map((receipt) => receipt.decisionMs), 0.5) },
    frequency,
  };
}
