import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForRemoteCount } from "./helpers";

test.setTimeout(60000);

test("M0.5 motion diagnostics stay within smoothing thresholds", async ({ browser, request }) => {
  for (const mode of ["line", "square"] as const) {
    const roomId = await createM05Room(request, `M05 Motion ${mode} ${Date.now()}`);
    const observer = await browser.newPage();
    const bot = await browser.newPage();
    try {
      await observer.goto(roomPath(roomId, "debug=1&name=Observer"));
      await bot.goto(roomPath(roomId, `debug=1&bot=${mode}&name=MotionBot&botSpeed=1`));
      await waitForRemoteCount(observer, 1);

      await expect.poll(async () => {
        const remote = (await readM05Debug(observer))?.remoteParticipants?.[0];
        return {
          hz: (remote?.updateHz ?? 0) >= 3,
          fresh: (remote?.staleMs ?? Number.POSITIVE_INFINITY) <= 1500,
          jump: (remote?.maxObservedJumpM ?? Number.POSITIVE_INFINITY) <= 1.25
        };
      }, {
        timeout: 20000,
        intervals: [1000, 2000, 3000]
      }).toEqual({ hz: true, fresh: true, jump: true });
    } finally {
      await observer.close();
      await bot.close();
    }
  }
});
