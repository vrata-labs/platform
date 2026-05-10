import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForM05Debug } from "./helpers";

test("M0.5 degraded room-state and audio modes remain explicit", async ({ page, request }) => {
  const roomId = await createM05Room(request, `M05 Degraded ${Date.now()}`);
  await page.goto(roomPath(roomId, "debug=1&failroomstate=temporary&failaudio=connection_failed"));
  await waitForM05Debug(page);

  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return {
      roomStateMode: debug?.roomStateMode,
      degradedMode: debug?.degradedMode
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({ roomStateMode: "api_fallback", degradedMode: "api_fallback" });

  await page.click("#join-audio");
  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return {
      issueCode: debug?.issueCode ?? null,
      audioState: debug?.media?.audioState ?? null,
      hasLocalPose: typeof debug?.localPose?.root.x === "number"
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({ issueCode: "media_network_blocked", audioState: "failed", hasLocalPose: true });
});
