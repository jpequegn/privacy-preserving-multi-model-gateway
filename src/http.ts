import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { demoCatalog, streamDemo } from "./demo.js";
import type { ModelEndpoint } from "./domain.js";
import { executeRoute, type ModelStream } from "./execution.js";
import { catalogWithFeedback, leaderboard } from "./feedback.js";
import { FileLedger, summarize, type Ledger } from "./ledger.js";
import { planRoute } from "./routing.js";
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

async function handleGenerate(request: IncomingMessage, response: ServerResponse, catalog: readonly ModelEndpoint[], stream: ModelStream, ledger: Ledger, sse: boolean): Promise<void> {
  let input;
  try { input = parseGatewayRequest(await readJson(request)); }
  catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "invalid_request" }); return; }
  const plan = planRoute(input, catalogWithFeedback(catalog, ledger.list()));
  if (plan.kind === "refused") {
    ledger.record({ id: randomUUID(), createdAt: new Date().toISOString(), policy: input.policy, privacy: input.privacy,
      attempts: [], inputTokens: 0, outputTokens: 0, costUsd: 0, costKind: "estimated", elapsedMs: plan.decisionMs,
      decisionMs: plan.decisionMs, outcome: "refused" });
    json(response, 422, { error: plan.reason, reasons: plan.reasons });
    return;
  }
  const disconnected = new AbortController();
  response.on("close", () => disconnected.abort(new Error("client_disconnected")));
  if (sse) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const result = await executeRoute(input, plan, stream, (chunk) => {
    if (sse) response.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
  }, disconnected.signal);
  ledger.record(result.receipt);
  if (sse) {
    response.write(`event: done\ndata: ${JSON.stringify({ receipt: result.receipt })}\n\n`);
    response.end();
  } else {
    json(response, result.receipt.outcome === "completed" ? 200 : 502, { answer: result.answer, receipt: result.receipt, synthetic: result.receipt.costKind === "synthetic" });
  }
}

export function createGatewayServer(catalog: readonly ModelEndpoint[] = demoCatalog, stream: ModelStream = streamDemo, ledger: Ledger = new FileLedger(process.env.GATEWAY_DATA_FILE ?? "data/receipts.jsonl")): Server {
  return createServer((request, response) => {
    const host = request.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") { json(response, 403, { error: "loopback_only" }); return; }
    const origin = request.headers.origin;
    if (origin) {
      let permitted = false;
      try { const parsed = new URL(origin); permitted = parsed.protocol === "http:" && parsed.host === request.headers.host; } catch {}
      if (!permitted) { json(response, 403, { error: "cross_origin_denied" }); return; }
    }
    const assets: Record<string, { file: string; type: string }> = {
      "/": { file: "index.html", type: "text/html; charset=utf-8" },
      "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
      "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    };
    const asset = request.method === "GET" ? assets[request.url ?? ""] : undefined;
    if (asset) {
      response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'" });
      response.end(readFileSync(fileURLToPath(new URL(`../public/${asset.file}`, import.meta.url))));
      return;
    }
    if (request.method === "GET" && request.url === "/api/health") {
      json(response, 200, { status: "ok", version: 1 });
      return;
    }
    if (request.method === "GET" && request.url === "/api/models") { json(response, 200, { models: catalog, synthetic: catalog.every((model) => model.provider === "demo") }); return; }
    if (request.method === "GET" && request.url === "/api/metrics") { json(response, 200, summarize(ledger.list())); return; }
    if (request.method === "GET" && request.url === "/api/leaderboard") { json(response, 200, { models: leaderboard(catalog, ledger.list()) }); return; }
    if (request.method === "GET" && request.url === "/api/receipts") { json(response, 200, { receipts: ledger.list().slice(-100).reverse() }); return; }
    if (request.method === "DELETE" && request.url === "/api/receipts") { ledger.clear(); json(response, 200, { deleted: true }); return; }
    if (request.method === "POST" && request.url === "/api/feedback") {
      void readJson(request).then((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) { json(response, 400, { error: "invalid_feedback" }); return; }
        const input = value as Record<string, unknown>;
        if (typeof input.requestId !== "string" || (input.rating !== "up" && input.rating !== "down") || (input.corrected !== undefined && typeof input.corrected !== "boolean")) {
          json(response, 400, { error: "invalid_feedback" }); return;
        }
        if (!ledger.setFeedback(input.requestId, input.rating, input.corrected === true)) { json(response, 404, { error: "request_not_found" }); return; }
        json(response, 200, { saved: true });
      }).catch(() => json(response, 400, { error: "invalid_feedback" }));
      return;
    }
    if (request.method === "POST" && (request.url === "/api/generate" || request.url === "/api/generate/stream")) {
      const sse = request.url.endsWith("/stream");
      void handleGenerate(request, response, catalog, stream, ledger, sse).catch(() => {
        if (!response.headersSent) json(response, 502, { error: "provider_failed" });
        else response.end();
      });
      return;
    }
    json(response, 404, { error: "not_found" });
  });
}
