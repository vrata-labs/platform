import { test as base, type Page, type TestInfo } from "@playwright/test";
import { captureSceneNetwork } from "../../tools/scene-network-diagnostics.mjs";

export { expect, type APIRequestContext, type Page } from "@playwright/test";

type Capture = Awaited<ReturnType<typeof captureSceneNetwork>>;
type Report = ReturnType<Capture["snapshot"]> & { pageIndex: number };
type Registry = { pages: Map<Page, Promise<Capture>>; snapshots(): Promise<Report[]> };
const registries = new WeakMap<TestInfo, Registry>();

// Explicitly wrap manually created pages; do not patch browser/context methods or intercept traffic.
export async function observeScenePage(pageOrPromise: Page | Promise<Page>): Promise<Page> {
  const page = await pageOrPromise;
  const registry = registries.get(base.info());
  if (!registry) throw new Error("scene_network_fixture_missing");
  if (!registry.pages.has(page)) registry.pages.set(page, captureSceneNetwork(page));
  await registry.pages.get(page);
  return page;
}

export const test = base.extend<{ sceneNetwork: Registry }>({
  sceneNetwork: [async ({}, use, testInfo) => {
    const pages = new Map<Page, Promise<Capture>>();
    const registry: Registry = {
      pages,
      async snapshots() {
        return Promise.all(Array.from(pages.values(), async (pending, pageIndex) => ({
          pageIndex, ...(await pending).snapshot()
        })));
      }
    };
    registries.set(testInfo, registry);
    try {
      await use(registry);
    } finally {
      for (const pending of pages.values()) (await pending).stop();
      // Keep one small, redacted report per attempt, including failed attempts and retries.
      await testInfo.attach("scene-network", {
        body: Buffer.from(JSON.stringify({ retry: testInfo.retry, pages: await registry.snapshots() })),
        contentType: "application/json"
      });
      registries.delete(testInfo);
    }
  }, { auto: true, box: true }],
  page: async ({ page, sceneNetwork }, use) => {
    await observeScenePage(page);
    try { await use(page); }
    finally { (await sceneNetwork.pages.get(page))?.stop(); }
  }
});
