import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { demoCatalog, streamDemo } from "./demo.js";
import type { ModelEndpoint } from "./domain.js";
import { executeRoute, type ModelStream } from "./execution.js";
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

async function handleGenerate(request: IncomingMessage, response: ServerResponse, catalog: readonly ModelEndpoint[], stream: ModelStream, sse: boolean): Promise<void> {
  let input;
  try { input = parseGatewayRequest(await readJson(request)); }
  catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "invalid_request" }); return; }
  const plan = planRoute(input, catalog);
  if (plan.kind === "refused") {
    json(response, 422, { error: plan.reason, reasons: plan.reasons });
    return;
  }
  const disconnected = new AbortController();
  response.on("close", () => disconnected.abort(new Error("client_disconnected")));
  if (sse) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const result = await executeRoute(input, plan, stream, (chunk) => {
    if (sse) response.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
  }, disconnected.signal);
  if (sse) {
    response.write(`event: done\ndata: ${JSON.stringify({ receipt: result.receipt })}\n\n`);
    response.end();
  } else {
    json(response, result.receipt.outcome === "completed" ? 200 : 502, { answer: result.answer, receipt: result.receipt, synthetic: result.receipt.costKind === "synthetic" });
  }
}

export function createGatewayServer(catalog: readonly ModelEndpoint[] = demoCatalog, stream: ModelStream = streamDemo): Server {
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
    if (request.method === "GET" && request.url === "/api/models") { json(response, 200, { models: catalog, synthetic: true }); return; }
    if (request.method === "POST" && (request.url === "/api/generate" || request.url === "/api/generate/stream")) {
      const sse = request.url.endsWith("/stream");
      void handleGenerate(request, response, catalog, stream, sse).catch(() => {
        if (!response.headersSent) json(response, 502, { error: "provider_failed" });
        else response.end();
      });
      return;
    }
    json(response, 404, { error: "not_found" });
  });
}
