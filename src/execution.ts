import { randomUUID } from "node:crypto";
import type { AttemptReceipt, GatewayRequest, ModelEndpoint, RouteReceipt } from "./domain.js";
import { costFromUsage, estimatedCostUsd, type RoutePlan } from "./routing.js";

export type StreamItem = string | { usage: { inputTokens: number; outputTokens: number } };
export type ModelStream = (model: ModelEndpoint, request: GatewayRequest, signal: AbortSignal) => AsyncIterable<StreamItem>;
export type ChunkSink = (chunk: string) => void;

export interface ExecutionResult {
  answer: string;
  receipt: RouteReceipt;
}

export interface ExecutionLimits {
  attemptMs: number;
  overallMs: number;
  maxAttempts: number;
}

const defaultLimits: ExecutionLimits = { attemptMs: 20_000, overallMs: 60_000, maxAttempts: 3 };

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([iterator.next(), aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

export async function executeRoute(
  request: GatewayRequest,
  plan: Extract<RoutePlan, { kind: "ready" }>,
  stream: ModelStream,
  onChunk: ChunkSink,
  disconnectSignal?: AbortSignal,
  limits: ExecutionLimits = defaultLimits,
): Promise<ExecutionResult> {
  const started = performance.now();
  const attempts: AttemptReceipt[] = [];
  let answer = "";
  let chosen: ModelEndpoint | undefined;
  let reportedUsage: { inputTokens: number; outputTokens: number } | undefined;
  let outcome: RouteReceipt["outcome"] = "failed";
  const overall = AbortSignal.timeout(limits.overallMs);
  for (const model of plan.candidates.slice(0, limits.maxAttempts)) {
    if (overall.aborted || disconnectSignal?.aborted) break;
    reportedUsage = undefined;
    const attemptStart = performance.now();
    const attempt = AbortSignal.timeout(limits.attemptMs);
    const signal = AbortSignal.any(disconnectSignal ? [overall, attempt, disconnectSignal] : [overall, attempt]);
    const iterator = stream(model, request, signal)[Symbol.asyncIterator]();
    let emitted = false;
    try {
      while (true) {
        const item = await nextWithAbort(iterator, signal);
        if (item.done) break;
        if (signal.aborted) throw signal.reason;
        if (typeof item.value !== "string") {
          reportedUsage = item.value.usage;
          continue;
        }
        if (request.maxCostUsd !== undefined && estimatedCostUsd(model, request.prompt, Math.ceil((answer.length + item.value.length) / 4)) > request.maxCostUsd) {
          throw new Error("budget_exceeded");
        }
        emitted = true;
        chosen = model;
        answer += item.value;
        onChunk(item.value);
      }
      chosen = model;
      outcome = "completed";
      attempts.push({ modelId: model.id, elapsedMs: performance.now() - attemptStart, status: "completed" });
      break;
    } catch (error) {
      const timedOut = attempt.aborted || overall.aborted;
      const reason = timedOut ? "timeout" : error instanceof Error && error.message === "budget_exceeded" ? "budget_exceeded" : "provider_error";
      attempts.push({ modelId: model.id, elapsedMs: performance.now() - attemptStart, status: emitted ? "interrupted" : timedOut ? "timed_out" : "failed", reason });
      if (emitted) { outcome = "interrupted"; break; }
    } finally {
      if (iterator.return) void iterator.return().catch(() => undefined);
    }
  }
  const inputTokens = reportedUsage?.inputTokens ?? Math.max(1, Math.ceil(request.prompt.length / 4));
  const outputTokens = reportedUsage?.outputTokens ?? Math.ceil(answer.length / 4);
  const receipt: RouteReceipt = {
    id: randomUUID(), createdAt: new Date().toISOString(), policy: request.policy, privacy: request.privacy,
    modelId: chosen?.id, attempts, inputTokens, outputTokens,
    costUsd: chosen ? costFromUsage(chosen, inputTokens, outputTokens) : 0,
    costKind: chosen?.provider === "demo" ? "synthetic" : reportedUsage ? "reported" : "estimated",
    elapsedMs: performance.now() - started, decisionMs: plan.decisionMs, outcome,
  };
  return { answer, receipt };
}
