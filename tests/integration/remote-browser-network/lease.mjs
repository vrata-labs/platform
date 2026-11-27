import { createInterface } from "node:readline";
import { connectPublicHttpsGateway } from "/app/apps/remote-browser/dist/public-https-gateway-client.js";

const lease = connectPublicHttpsGateway();
lease.setDeadline(performance.now() + 9500);
await lease.ready;
console.log(JSON.stringify({ path: lease.socketPath }));
for await (const command of createInterface({ input: process.stdin })) {
  if (command === "revoke") {
    lease.revoke();
    console.log(JSON.stringify({ revoked: true }));
    continue;
  }
  try {
    lease.setDeadline(performance.now() + Number(command));
    console.log(JSON.stringify({ renewed: true }));
  } catch {
    console.log(JSON.stringify({ renewed: false }));
  }
}
lease.revoke();
