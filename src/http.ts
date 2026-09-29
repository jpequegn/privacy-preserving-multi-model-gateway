import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { demoCatalog, generateDemo } from "./demo.js";
import type { RouteReceipt } from "./domain.js";
import { estimatedCostUsd, planRoute } from "./routing.js";
import { parseGatewayRequest } from "./validation.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("content_type_must_be_json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16_384) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("invalid_json"); }
}

async function handleGenerate(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let input;
  try { input = parseGatewayRequest(await readJson(request)); }
  catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "invalid_request" }); return; }
  const started = performance.now();
  const plan = planRoute(input, demoCatalog);
  if (plan.kind === "refused") {
    json(response, 422, { error: plan.reason, reasons: plan.reasons });
    return;
  }
  const model = plan.candidates[0]!;
  const attemptStart = performance.now();
  const result = await generateDemo(model, input, AbortSignal.timeout(5000));
  const receipt: RouteReceipt = {
    id: randomUUID(), createdAt: new Date().toISOString(), policy: input.policy, privacy: input.privacy,
    modelId: model.id, attempts: [{ modelId: model.id, elapsedMs: performance.now() - attemptStart, status: "completed" }],
    inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    costUsd: estimatedCostUsd(model, input.prompt, result.outputTokens), costKind: result.costKind,
    elapsedMs: performance.now() - started, decisionMs: plan.decisionMs, outcome: "completed",
  };
  json(response, 200, { answer: result.text, receipt, synthetic: true });
}

export function createGatewayServer(): Server {
  return createServer((request, response) => {
    const host = request.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") { json(response, 403, { error: "loopback_only" }); return; }
    const origin = request.headers.origin;
    if (origin) {
      let permitted = false;
      try { const parsed = new URL(origin); permitted = parsed.protocol === "http:" && parsed.host === request.headers.host; } catch {}
      if (!permitted) { json(response, 403, { error: "cross_origin_denied" }); return; }
    }
    if (request.method === "GET" && request.url === "/api/health") {
      json(response, 200, { status: "ok", version: 1 });
      return;
    }
    if (request.method === "GET" && request.url === "/api/models") { json(response, 200, { models: demoCatalog, synthetic: true }); return; }
    if (request.method === "POST" && request.url === "/api/generate") {
      void handleGenerate(request, response).catch(() => json(response, 502, { error: "provider_failed" }));
      return;
    }
    json(response, 404, { error: "not_found" });
  });
}
