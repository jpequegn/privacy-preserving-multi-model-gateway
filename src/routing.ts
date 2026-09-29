import type { GatewayRequest, ModelEndpoint, Policy } from "./domain.js";

export type ExclusionReason = "unknown_locality" | "privacy" | "capability" | "budget" | "invalid_model";

export type RoutePlan =
  | { kind: "ready"; candidates: readonly ModelEndpoint[]; reasons: Readonly<Record<string, readonly ExclusionReason[]>>; decisionMs: number }
  | { kind: "refused"; reason: "no_eligible_model"; reasons: Readonly<Record<string, readonly ExclusionReason[]>>; decisionMs: number };

export function estimatedCostUsd(model: ModelEndpoint, prompt: string, outputTokens = 512): number {
  const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
  return (inputTokens * model.inputUsdPerMillion + outputTokens * model.outputUsdPerMillion) / 1_000_000;
}

function validModel(model: ModelEndpoint): boolean {
  return model.id.length > 0 && [model.inputUsdPerMillion, model.outputUsdPerMillion, model.qualityScore, model.latencyMs]
    .every((value) => Number.isFinite(value) && value >= 0) && model.qualityScore <= 1;
}

function rank(model: ModelEndpoint, policy: Policy, prompt: string): number {
  const cost = estimatedCostUsd(model, prompt);
  switch (policy) {
    case "cost": return cost;
    case "quality": return -model.qualityScore;
    case "latency": return model.latencyMs;
    case "balanced": return cost * 1000 + model.latencyMs / 1000 - model.qualityScore;
  }
}

export function planRoute(request: GatewayRequest, catalog: readonly ModelEndpoint[]): RoutePlan {
  const started = performance.now();
  const reasons: Record<string, ExclusionReason[]> = {};
  const eligible = catalog.filter((model) => {
    const excluded: ExclusionReason[] = [];
    if (!validModel(model)) excluded.push("invalid_model");
    if (model.locality === "unknown") excluded.push("unknown_locality");
    if (request.privacy === "local_only" && model.locality !== "local") excluded.push("privacy");
    if (request.requiredCapabilities?.some((capability) => !model.capabilities.includes(capability))) excluded.push("capability");
    if (request.maxCostUsd !== undefined && estimatedCostUsd(model, request.prompt) > request.maxCostUsd) excluded.push("budget");
    if (excluded.length > 0) reasons[model.id] = excluded;
    return excluded.length === 0;
  });

  eligible.sort((left, right) => rank(left, request.policy, request.prompt) - rank(right, request.policy, request.prompt) || left.id.localeCompare(right.id));
  const decisionMs = performance.now() - started;
  return eligible.length > 0
    ? { kind: "ready", candidates: eligible, reasons, decisionMs }
    : { kind: "refused", reason: "no_eligible_model", reasons, decisionMs };
}
