#!/usr/bin/env node

import { createServer } from "node:http";

const port = Number(process.argv[2]);
const exitAfterMs = Number(process.argv[3] ?? 0);
const ignoreTerm = process.argv.includes("--ignore-term");

if (!Number.isInteger(port) || port <= 0) {
  console.error("fixture_invalid_port");
  process.exit(2);
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}');
});

server.listen(port, "127.0.0.1");

const shutdown = () => {
  if (ignoreTerm) return;
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (exitAfterMs > 0) {
  setTimeout(() => process.exit(7), exitAfterMs).unref();
}
