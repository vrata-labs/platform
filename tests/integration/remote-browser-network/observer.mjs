import { createSocket } from "node:dgram";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
import { once } from "node:events";

const observations = "/tmp/observations.jsonl";
const record = (event, fields = {}) => appendFileSync(observations, `${JSON.stringify({ event, time: Date.now(), ...fields })}\n`);
function serve(request, response) {
  const path = new URL(request.url, "https://fixture.test").pathname;
  record("http", { path });
  switch (path) {
    case "/redirect":
      response.writeHead(302, { location: "https://allowed.test/document" }).end();
      break;
    case "/redirect-denied":
      response.writeHead(302, { location: "https://denied.test/hidden" }).end();
      break;
    case "/redirect-http":
      response.writeHead(302, { location: "http://channel.test/plaintext" }).end();
      break;
    case "/resource.svg":
      response.writeHead(200, { "content-type": "image/svg+xml" })
        .end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
      break;
    case "/document":
      response.writeHead(200, { "content-type": "text/html" }).end(`
        <title>Controlled document</title>
        <img id="resource" src="/resource.svg">
        <iframe src="https://denied.test/frame"></iframe>
        <a id="popup" href="https://denied.test/popup" target="_blank">New window</a>
      `);
      break;
    case "/hold": {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.write("controlled stream\n");
      const heartbeat = setInterval(() => response.write("controlled stream\n"), 100);
      response.once("close", () => {
        clearInterval(heartbeat);
        record("stream-closed");
      });
      break;
    }
    default:
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("controlled response");
  }
}

const tcp = https({ key: readFileSync("/fixture-ca/site.key"), cert: readFileSync("/fixture-ca/site.pem") }, serve);
tcp.on("connection", socket => record("tcp", { from: socket.remoteAddress }));
tcp.on("upgrade", (_request, socket) => {
  record("upgrade");
  socket.end();
});
const plaintext = http(serve);
plaintext.on("connection", () => record("plaintext"));
const udp = createSocket("udp4");
udp.on("message", () => record("udp"));
tcp.listen(443, "0.0.0.0");
plaintext.listen(80, "0.0.0.0");
udp.bind(3478, "0.0.0.0");
await Promise.all([once(tcp, "listening"), once(plaintext, "listening"), once(udp, "listening")]);
writeFileSync(observations, "");
