import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForRemoteCount } from "./helpers";

test("M0.5 remote orientation changes and applied rotation follows it", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 Orientation ${Date.now()}`);
  const observer = await browser.newPage();
  const bot = await browser.newPage();

  try {
    await observer.goto(roomPath(roomId, "debug=1&name=Observer"));
    await bot.goto(roomPath(roomId, "debug=1&bot=turn&name=TurnBot&botSpeed=1"));
    await waitForRemoteCount(observer, 1);

    const initial = (await readM05Debug(observer))?.remoteParticipants?.[0];
    await expect.poll(async () => {
      const remote = (await readM05Debug(observer))?.remoteParticipants?.[0];
      return {
        headYawChanged: Math.abs((remote?.head.yaw ?? 0) - (initial?.head.yaw ?? 0)) > 0.25,
        appliedYawChanged: Math.abs((remote?.appliedHeadYaw ?? 0) - (initial?.appliedHeadYaw ?? 0)) > 0.1,
        visual: remote?.hasVisualEntity ?? false
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({ headYawChanged: true, appliedYawChanged: true, visual: true });
  } finally {
    await observer.close();
    await bot.close();
  }
});
