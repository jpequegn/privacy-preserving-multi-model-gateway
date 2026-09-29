import { demoCatalog } from "../src/demo.js";
import type { GatewayRequest } from "../src/domain.js";
import { executeRoute, type ModelStream } from "../src/execution.js";
import { estimatedCostUsd, planRoute } from "../src/routing.js";

const request: GatewayRequest = { prompt: "Summarize a short project note", privacy: "local_only", policy: "balanced" };
const decisions: number[] = [];
for (let index = 0; index < 1000; index++) decisions.push(planRoute(request, demoCatalog).decisionMs);
decisions.sort((a, b) => a - b);
const p50 = decisions[Math.floor(decisions.length / 2)] ?? 0;

const flaky = demoCatalog.find((model) => model.id === "local-flaky")!;
const fast = demoCatalog.find((model) => model.id === "local-fast")!;
const failoverPlan = planRoute({ ...request, policy: "cost" }, [flaky, fast]);
if (failoverPlan.kind !== "ready") throw new Error("invalid benchmark catalog");
const faultStream: ModelStream = async function* (model) {
  if (model.id === "local-flaky") throw new Error("synthetic_outage");
  yield "recovered";
};
let recovered = 0;
for (let index = 0; index < 100; index++) {
  const result = await executeRoute(request, failoverPlan, faultStream, () => undefined);
  if (result.receipt.outcome === "completed") recovered += 1;
}

const costPlan = planRoute({ ...request, policy: "cost" }, demoCatalog);
const qualityPlan = planRoute({ ...request, policy: "quality" }, demoCatalog);
if (costPlan.kind !== "ready" || qualityPlan.kind !== "ready") throw new Error("invalid benchmark plans");
const costFirst = estimatedCostUsd(costPlan.candidates[0]!, request.prompt);
const qualityFirst = estimatedCostUsd(qualityPlan.candidates[0]!, request.prompt);
const savings = qualityFirst > 0 ? (1 - costFirst / qualityFirst) * 100 : 0;
process.stdout.write(JSON.stringify({ routingDecisionP50Ms: p50, failoverSuccess: `${recovered}/100`,
  syntheticCostSavingsVsQualityFirstPercent: savings, benchmark: "deterministic demo; excludes provider latency" }, null, 2) + "\n");
