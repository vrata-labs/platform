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
  if (/^\/media-(red|blue|purple)$/.test(path)) {
    const color = path.slice(7);
    const frequency = { red: 440, blue: 880, purple: 660 }[color];
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(`<!doctype html>
      <style>body{background:${color}} #indicator{position:fixed;left:35%;top:35%;width:30%;height:30%;}</style>
      <div id="indicator"></div><script>
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = ${frequency}; gain.gain.value = 0.2;
      oscillator.connect(gain).connect(context.destination); oscillator.start();
      setInterval(() => indicator.style.background = indicator.style.background === "lime" ? "yellow" : "lime", 180);
      fetch("/hold/${color}").catch(() => {});
      navigator.permissions.query({name:"microphone"}).then(permission => {
        const exposed = "LivekitClient" in window || "__VRATA_REMOTE_BROWSER_LIVEKIT__" in window
          || "__VRATA_REMOTE_BROWSER_PUBLISH_RESULT__" in window || permission.state === "granted";
        return fetch(exposed ? "/page-has-authority" : "/page-without-authority");
      }).catch(() => {});
      document.onclick = event => {
        if (event.clientX < innerWidth / 3) location.href = "https://denied.test/hidden";
        else if (event.clientX < 2 * innerWidth / 3) location.href = "/media-blue";
        else fetch("https://denied.test/resource.png",{mode:"no-cors"}).catch(() => {});
      };
      </script>`);
    return;
  }
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
    case "/hold":
    case "/hold/red":
    case "/hold/blue":
    case "/hold/purple": {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.write("controlled stream\n");
      const heartbeat = setInterval(() => response.write("controlled stream\n"), 100);
      response.once("close", () => {
        clearInterval(heartbeat);
        record("stream-closed", { path });
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
