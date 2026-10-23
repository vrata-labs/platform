import { createHash } from "node:crypto";
import { test, expect } from "playwright/test";

const maxTarballBytes = 1024 * 1024;

for (const mode of ["local", "@staging"]) {
  test.describe(`plugin SDK distribution ${mode}`, () => {
    test("public releases serve exact immutable SDK bytes and unknown digests return 404", async ({ request }) => {
      const manifestResponse = await request.get("/assets/plugin-sdk/releases.json", { maxRedirects: 0 });
      expect(manifestResponse.status()).toBe(200);
      expect(manifestResponse.headers()["content-type"]).toMatch(/^application\/json(?:;|$)/i);
      const manifest = await manifestResponse.json();
      expect(manifest.schemaVersion).toBe(1);
      expect(Array.isArray(manifest.releases)).toBe(true);
      expect(manifest.releases.length).toBeGreaterThan(0);
      const urls = new Set<string>();
      for (const release of manifest.releases) {
        expect(release.package).toBe("@vrata/room-plugin-sdk");
        expect(release.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
        expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(release.url).toBe(`/assets/plugin-sdk/${release.version}/${release.sha256}/vrata-room-plugin-sdk-${release.version}.tgz`);
        expect(urls.has(release.url)).toBe(false);
        urls.add(release.url);
      }

      for (const release of manifest.releases) {
        const response = await request.get(release.url, { maxRedirects: 0 });
        expect(response.status(), release.url).toBe(200);
        expect(response.headers()["content-type"]).toMatch(/^application\/octet-stream(?:;|$)/i);
        expect(response.headers()["x-content-type-options"]).toBe("nosniff");
        const bytes = await response.body();
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.length).toBeLessThanOrEqual(maxTarballBytes);
        expect(bytes.subarray(0, 2).toString("hex")).toBe("1f8b");
        expect(createHash("sha256").update(bytes).digest("hex"), release.url).toBe(release.sha256);
      }

      const release = manifest.releases[0];
      const unknownDigest = `${release.sha256[0] === "0" ? "1" : "0"}${release.sha256.slice(1)}`;
      const unknownUrl = `/assets/plugin-sdk/${release.version}/${unknownDigest}/vrata-room-plugin-sdk-${release.version}.tgz`;
      expect(urls.has(unknownUrl)).toBe(false);
      const missing = await request.get(unknownUrl, { maxRedirects: 0 });
      expect(missing.status(), "unknown digest must not resolve to a latest archive or application shell").toBe(404);
    });
  });
}
