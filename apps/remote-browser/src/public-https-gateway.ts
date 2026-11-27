import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity, connect, TLSSocket, type SecureContext } from "node:tls";
import { REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS } from "@vrata/shared-types";
import { parsePublicHttpsTarget, type PublicHttpsTarget } from "./url-policy.js";

const maxLeaseNs = BigInt(REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS) * 1_000_000n;
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const diagnosticHeader = "x-vrata-browser-error";
const hopHeaders = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "alt-svc"
];

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionHeaders = headers.connection?.toLowerCase().split(",").map(value => value.trim()) ?? [];
  for (const name of [...hopHeaders, ...connectionHeaders, diagnosticHeader]) delete result[name];
  return result;
}

function rejectRequest(response: ServerResponse, status: 403 | 502, code: string): void {
  response.writeHead(status, { [diagnosticHeader]: code, "content-type": "text/plain", "cache-control": "no-store" })
    .end(status === 403 ? "Forbidden" : "Bad Gateway");
}

export interface PublicHttpsGatewayOptions {
  certificate(hostname: string): Promise<SecureContext>;
  resolve(hostname: string, signal: AbortSignal): Promise<string[]>;
}

/** Owns the real ingress and egress sockets of a single lease. */
export class PublicHttpsGateway {
  private readonly lifetime = new AbortController();
  private readonly sockets = new Set<Socket>();
  private readonly targets = new WeakMap<Socket, PublicHttpsTarget>();
  private deadline?: bigint;
  private expiry?: NodeJS.Timeout;
  private readonly https = createServer({ headersTimeout: 5000 }, (incoming, outgoing) => {
    void this.forward(incoming, outgoing).catch(() => {
      if (!outgoing.headersSent && this.active()) rejectRequest(outgoing, 502, "target_unavailable");
      else outgoing.destroy();
    });
  }).on("upgrade", (_request, socket) => socket.destroy())
    .on("connect", (_request, socket) => socket.destroy())
    .on("checkContinue", (_request, response) => response.writeHead(417).end())
    .on("checkExpectation", (_request, response) => response.writeHead(417).end());

  readonly proxy = createServer({ headersTimeout: 5000 }, (_request, response) => {
    response.writeHead(403).end();
  }).on("connect", (incoming, socket: Socket, head) => {
    void this.acceptTunnel(incoming, socket, head).catch(() => socket.destroy());
  }).on("upgrade", (_request, socket) => socket.destroy())
    .on("connection", (socket: Socket) => {
      if (!this.active() || this.sockets.size >= 128) socket.destroy();
      else this.track(socket);
    });

  constructor(private readonly options: PublicHttpsGatewayOptions) {}

  get signal(): AbortSignal { return this.lifetime.signal; }

  setDeadline(deadline: bigint): boolean {
    const now = process.hrtime.bigint();
    if (this.lifetime.signal.aborted || (this.deadline !== undefined && this.deadline <= now)
      || deadline <= now || deadline - now > maxLeaseNs) {
      this.revoke();
      return false;
    }
    this.deadline = deadline;
    this.scheduleExpiry();
    return true;
  }

  revoke(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    clearTimeout(this.expiry);
    for (const socket of this.sockets) socket.destroy();
    this.proxy.close();
  }

  private active(): boolean {
    if (this.lifetime.signal.aborted || this.deadline === undefined) return false;
    if (process.hrtime.bigint() < this.deadline) return true;
    this.revoke();
    return false;
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      if (this.active()) this.scheduleExpiry();
    }, Math.max(1, Number(this.deadline! - process.hrtime.bigint()) / 1_000_000));
    this.expiry.unref();
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
  }

  private async acceptTunnel(incoming: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const authority = incoming.url ?? "";
    const target = parsePublicHttpsTarget(`https://${authority}`);
    if (!this.active() || !target || authority.toLowerCase() !== `${target.authority}:443`) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    const certificate = await this.options.certificate(target.hostname);
    if (!this.active() || socket.destroyed) return;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    const wrapped = new TLSSocket(socket, {
      isServer: true, secureContext: certificate, ALPNProtocols: ["http/1.1"]
    });
    this.track(wrapped);
    const handshake = setTimeout(() => wrapped.destroy(), 5000);
    wrapped.once("close", () => clearTimeout(handshake));
    wrapped.once("secure", () => {
      clearTimeout(handshake);
      if (!this.active()) return wrapped.destroy();
      this.targets.set(wrapped, target);
      this.https.emit("connection", wrapped);
    });
  }

  private async forward(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const target = this.targets.get(incoming.socket);
    const host = incoming.headers.host?.toLowerCase();
    const path = incoming.url ?? "";
    if (!this.active() || !target || !methods.has(incoming.method ?? "") || incoming.httpVersion !== "1.1"
      || !path.startsWith("/") || incoming.headers.upgrade !== undefined
      || (host !== target.authority && host !== `${target.authority}:443`)) {
      rejectRequest(outgoing, 403, "scheme_not_allowed");
      return;
    }

    const clientClosed = new AbortController();
    outgoing.once("close", () => clientClosed.abort());
    const signal = AbortSignal.any([clientClosed.signal, this.lifetime.signal]);
    const addresses = await this.options.resolve(target.hostname, signal).catch(() => undefined);
    if (signal.aborted || !this.active()) return;
    if (!addresses) {
      rejectRequest(outgoing, 502, "dns_failed");
      return;
    }
    if (!addresses.length) {
      rejectRequest(outgoing, 403, "private_address");
      return;
    }
    let upstream: TLSSocket | undefined;
    for (const address of addresses) {
      if (signal.aborted || !this.active()) return;
      upstream = await this.verifiedConnection(address, target.hostname, signal).catch(() => undefined);
      if (upstream) break;
    }
    if (!upstream) throw new Error("public_https_connection_failed");
    if (signal.aborted || !this.active()) {
      upstream.destroy();
      return;
    }

    // This socket has completed TLS verification. Do not pass the hostname to
    // a second dialer, use pooled connections, or write before secureConnect.
    const headers = forwardHeaders(incoming.headers);
    headers.host = target.authority;
    headers.connection = "close";
    const upstreamRequest = request({
      method: incoming.method, path, headers, signal, createConnection: () => upstream!
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers));
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstreamRequest.once("upgrade", (_response, socket) => {
      socket.destroy();
      rejectRequest(outgoing, 502, "target_unavailable");
    });
    upstreamRequest.once("error", () => {
      upstream.destroy();
      if (!outgoing.headersSent && this.active()) rejectRequest(outgoing, 502, "target_unavailable");
      else outgoing.destroy();
    });
    incoming.pipe(upstreamRequest);
  }

  private verifiedConnection(address: string, hostname: string, signal: AbortSignal): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      if (!isIP(address)) return reject(new Error("public_https_invalid_address"));
      const socket = connect({
        host: address, port: 443, servername: isIP(hostname) ? undefined : hostname,
        checkServerIdentity: (_host, cert) => checkServerIdentity(hostname, cert),
        rejectUnauthorized: true, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"],
        timeout: 2500
      });
      this.track(socket);
      const abort = () => socket.destroy();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      socket.once("close", () => signal.removeEventListener("abort", abort));
      socket.once("timeout", () => socket.destroy(new Error("public_https_connection_timeout")));
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("public_https_connection_closed")));
      socket.once("secureConnect", () => {
        socket.setTimeout(0);
        resolve(socket);
      });
    });
  }
}
