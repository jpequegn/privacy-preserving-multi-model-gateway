import type { GatewayRequest, ModelEndpoint } from "./domain.js";

export const demoCatalog: readonly ModelEndpoint[] = [
  { id: "local-fast", provider: "demo", locality: "local", capabilities: ["text"], inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.5, qualityScore: 0.55, latencyMs: 10 },
  { id: "local-careful", provider: "demo", locality: "local", capabilities: ["text", "reasoning"], inputUsdPerMillion: 1, outputUsdPerMillion: 2, qualityScore: 0.82, latencyMs: 35 },
  { id: "local-flaky", provider: "demo", locality: "local", capabilities: ["text"], inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3, qualityScore: 0.45, latencyMs: 8 },
];

export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costKind: "synthetic" | "estimated" | "reported";
}

export async function generateDemo(model: ModelEndpoint, request: GatewayRequest, signal: AbortSignal): Promise<ProviderResult> {
  if (signal.aborted) throw signal.reason;
  const words = request.prompt.trim().split(/\s+/);
  const excerpt = words.slice(0, 12).join(" ");
  const text = `[Synthetic ${model.id}] ${excerpt}${words.length > 12 ? "..." : ""}`;
  return {
    text,
    inputTokens: Math.max(1, Math.ceil(request.prompt.length / 4)),
    outputTokens: Math.max(1, Math.ceil(text.length / 4)),
    costKind: "synthetic",
  };
}
