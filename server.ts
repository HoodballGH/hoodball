import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { createServer } from "node:http";
import next from "next";
async function main() {
  const port = Number(process.env.PORT || 3000);
  const app = next({ dev: process.env.NODE_ENV !== "production", hostname: "0.0.0.0", port });
  const handle = app.getRequestHandler();
  await app.prepare();
  const { startWorker } = await import("./lib/indexer");
  const stopWorker = startWorker();
  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      console.error("Request handler failed:", error instanceof Error ? error.message : "unknown");
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(port, "0.0.0.0", () => console.log(`Hoodball listening on :${port}`));
  const shutdown = () => { stopWorker(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
