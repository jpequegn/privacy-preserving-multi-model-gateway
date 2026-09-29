import { createGatewayServer } from "./http.js";

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

createGatewayServer().listen(port, "127.0.0.1", () => {
  process.stdout.write(`Gateway listening on http://127.0.0.1:${port}\n`);
});
