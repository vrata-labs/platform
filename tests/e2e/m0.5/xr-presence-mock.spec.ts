import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForRemoteCount } from "./helpers";

test("M0.5 XR mock publishes VR mode and changing head pose", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 XR Mock ${Date.now()}`);
  const observer = await browser.newPage();
  const xrMock = await browser.newPage();

  try {
    await observer.goto(roomPath(roomId, "debug=1&name=Observer"));
    await xrMock.goto(roomPath(roomId, "debug=1&xrmock=1&bot=turn&name=XrMock&botSpeed=1"));
    await waitForRemoteCount(observer, 1);
    const initial = (await readM05Debug(observer))?.remoteParticipants?.[0];
    expect(initial?.mode).toBe("vr");
    expect(typeof initial?.head.pitch).toBe("number");

    await expect.poll(async () => {
      const remote = (await readM05Debug(observer))?.remoteParticipants?.[0];
      return {
        mode: remote?.mode,
        yawChanged: Math.abs((remote?.head.yaw ?? 0) - (initial?.head.yaw ?? 0)) > 0.25,
        pitchNumber: typeof remote?.head.pitch === "number"
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({ mode: "vr", yawChanged: true, pitchNumber: true });
  } finally {
    await observer.close();
    await xrMock.close();
  }
});
