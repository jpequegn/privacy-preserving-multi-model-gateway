import type { GatewayRequest, Policy, Privacy } from "./domain.js";

const policies: readonly Policy[] = ["cost", "quality", "latency", "balanced"];
const privacies: readonly Privacy[] = ["local_only", "remote_allowed"];

export function parseGatewayRequest(value: unknown): GatewayRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request_must_be_object");
  const input = value as Record<string, unknown>;
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0 || input.prompt.length > 8000) throw new Error("invalid_prompt");
  const policy = input.policy ?? "balanced";
  const privacy = input.privacy ?? "local_only";
  if (!policies.includes(policy as Policy)) throw new Error("invalid_policy");
  if (!privacies.includes(privacy as Privacy)) throw new Error("invalid_privacy");
  const maxCostUsd = input.maxCostUsd;
  if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)) throw new Error("invalid_budget");
  const requiredCapabilities = input.requiredCapabilities;
  if (requiredCapabilities !== undefined && (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((item) => typeof item !== "string" || item.length === 0))) throw new Error("invalid_capabilities");
  return {
    prompt: input.prompt,
    policy: policy as Policy,
    privacy: privacy as Privacy,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd: maxCostUsd as number }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities: requiredCapabilities as string[] }),
  };
}
