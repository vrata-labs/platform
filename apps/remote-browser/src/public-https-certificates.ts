import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rename, writeFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import { promisify } from "node:util";

const exec = promisify(execFile);
const openssl = (...args: string[]) => exec("openssl", args, { timeout: 4000 });

export async function createBrowserCertificateAuthority(publicCertificate: string) {
  const directory = await mkdtemp(join(tmpdir(), "vrata-ca-"));
  const caKey = join(directory, "ca.key");
  const ca = join(directory, "ca.pem");
  const leafKey = join(directory, "leaf.key");
  const request = join(directory, "leaf.csr");
  const publish = `${publicCertificate}.new`;
  try {
    await openssl("req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-days", "3650", "-subj", "/CN=Vrata isolated browser", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign", "-keyout", caKey, "-out", ca);
    await openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-subj", "/CN=Vrata isolated site", "-keyout", leafKey, "-out", request);
    await writeFile(publish, await readFile(ca), { mode: 0o644 });
    await rename(publish, publicCertificate);
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("public_https_certificate_setup_failed");
  }

  const key = await readFile(leafKey);
  const cache = new Map<string, { validUntil: number; certificate: Promise<SecureContext> }>();
  let issuing = 0;

  async function sign(hostname: string): Promise<SecureContext> {
    const serial = randomBytes(16).toString("hex");
    const extensions = join(directory, `${serial}.ext`);
    try {
      await writeFile(extensions, [
        "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=serverAuth", `subjectAltName=${isIP(hostname) ? "IP" : "DNS"}:${hostname}`
      ].join("\n"));
      const { stdout: cert } = await openssl("x509", "-req", "-in", request, "-CA", ca, "-CAkey", caKey,
        "-set_serial", `0x${serial}`, "-days", "1", "-extfile", extensions);
      return createSecureContext({ key, cert, minVersion: "TLSv1.2" });
    } finally {
      await rm(extensions, { force: true });
    }
  }

  return {
    forHost(hostname: string): Promise<SecureContext> {
      const cached = cache.get(hostname);
      if (cached && Date.now() < cached.validUntil) return cached.certificate;
      cache.delete(hostname);
      if (issuing >= 32) return Promise.reject(new Error("public_https_certificate_capacity"));
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      issuing++;
      const certificate = sign(hostname).catch(() => {
        if (cache.get(hostname)?.certificate === certificate) cache.delete(hostname);
        throw new Error("public_https_certificate_failed");
      }).finally(() => { issuing--; });
      cache.set(hostname, { certificate, validUntil: Date.now() + 20 * 60 * 60 * 1000 });
      return certificate;
    },
    close: () => rm(directory, { recursive: true, force: true })
  };
}
