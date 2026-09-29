export type Privacy = "local_only" | "remote_allowed";
export type Policy = "cost" | "quality" | "latency" | "balanced";
export type Locality = "local" | "remote";

export interface GatewayRequest {
  prompt: string;
  privacy: Privacy;
  policy: Policy;
  maxCostUsd?: number;
}

export interface ModelEndpoint {
  id: string;
  provider: string;
  locality: Locality;
  capabilities: readonly string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  qualityScore: number;
  latencyMs: number;
}

export interface AttemptReceipt {
  modelId: string;
  elapsedMs: number;
  status: "completed" | "failed" | "timed_out" | "interrupted";
  reason?: string;
}

export interface RouteReceipt {
  id: string;
  createdAt: string;
  policy: Policy;
  privacy: Privacy;
  modelId?: string;
  attempts: AttemptReceipt[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costKind: "synthetic" | "estimated" | "reported";
  elapsedMs: number;
  decisionMs: number;
  outcome: "completed" | "refused" | "failed" | "interrupted";
}
