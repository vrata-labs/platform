import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForRemoteCount } from "./helpers";

test("M0.5 spatial audio diagnostics follow remote participant pose and expose fallback", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 Spatial ${Date.now()}`);
  const observer = await browser.newPage();
  const bot = await browser.newPage();

  try {
    await observer.goto(roomPath(roomId, "debug=1&name=Observer"));
    await bot.goto(roomPath(roomId, "debug=1&bot=line&name=AudioSource&botSpeed=1"));
    await waitForRemoteCount(observer, 1);
    const initial = (await readM05Debug(observer))?.spatialAudio?.remoteSources?.[0];
    expect(initial?.attachedTo).toBe("head");

    await expect.poll(async () => {
      const source = (await readM05Debug(observer))?.spatialAudio?.remoteSources?.[0];
      return Math.hypot((source?.x ?? 0) - (initial?.x ?? 0), (source?.z ?? 0) - (initial?.z ?? 0));
    }, {
      timeout: 12000,
      intervals: [500, 1000, 2000]
    }).toBeGreaterThan(0.2);

    const fallback = await browser.newPage();
    try {
      await fallback.goto(roomPath(roomId, "debug=1&spatial=0&name=Fallback"));
      await expect.poll(async () => (await readM05Debug(fallback))?.spatialAudio?.fallback ?? false, {
        timeout: 10000,
        intervals: [500, 1000, 2000]
      }).toBe(true);
    } finally {
      await fallback.close();
    }
  } finally {
    await observer.close();
    await bot.close();
  }
});
