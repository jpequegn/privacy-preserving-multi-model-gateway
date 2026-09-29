import type { ModelEndpoint, RouteReceipt } from "./domain.js";

export interface LeaderboardEntry {
  modelId: string;
  requests: number;
  ratings: number;
  positiveRate: number | null;
  qualityEvidence: "insufficient" | "user_feedback";
}

export function leaderboard(catalog: readonly ModelEndpoint[], receipts: readonly RouteReceipt[]): LeaderboardEntry[] {
  return catalog.map((model) => {
    const own = receipts.filter((receipt) => receipt.modelId === model.id && receipt.outcome === "completed");
    const rated = own.filter((receipt) => receipt.feedback !== undefined);
    const positiveRate = rated.length >= 5 ? rated.filter((receipt) => receipt.feedback?.rating === "up").length / rated.length : null;
    return { modelId: model.id, requests: own.length, ratings: rated.length, positiveRate, qualityEvidence: positiveRate === null ? "insufficient" : "user_feedback" };
  });
}

export function catalogWithFeedback(catalog: readonly ModelEndpoint[], receipts: readonly RouteReceipt[]): ModelEndpoint[] {
  const evidence = new Map(leaderboard(catalog, receipts).map((entry) => [entry.modelId, entry]));
  return catalog.map((model) => {
    const rate = evidence.get(model.id)?.positiveRate;
    return rate === null || rate === undefined ? model : { ...model, qualityScore: (model.qualityScore + rate) / 2 };
  });
}
