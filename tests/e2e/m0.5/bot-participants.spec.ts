import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForM05Debug } from "./helpers";

test.describe.configure({ mode: "serial" });

test("M0.5 bot modes drive deterministic local presence", async ({ page, request }) => {
  const roomId = await createM05Room(request, `M05 Bots ${Date.now()}`);

  await page.goto(roomPath(roomId, "debug=1&bot=idle&botStart=1,2"));
  await waitForM05Debug(page);
  let debug = await readM05Debug(page);
  expect(debug?.botMode).toBe("idle");
  expect(debug?.localPose?.root.x).toBeCloseTo(1, 1);
  expect(debug?.localPose?.root.z).toBeCloseTo(2, 1);

  await page.goto(roomPath(roomId, "debug=1&bot=line&botStart=0,0&botSpeed=1"));
  await waitForM05Debug(page);
  const lineStart = (await readM05Debug(page))?.localPose?.root.z ?? 0;
  await expect.poll(async () => {
    const next = await readM05Debug(page);
    return Math.abs((next?.localPose?.root.z ?? lineStart) - lineStart);
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBeGreaterThan(0.3);

  await page.goto(roomPath(roomId, "debug=1&bot=turn&botStart=0,0&botSpeed=1"));
  await waitForM05Debug(page);
  const turnStart = (await readM05Debug(page))?.localPose?.root.yaw ?? 0;
  await expect.poll(async () => {
    const next = await readM05Debug(page);
    return Math.abs((next?.localPose?.root.yaw ?? turnStart) - turnStart);
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBeGreaterThan(0.3);

  await page.goto(roomPath(roomId, "debug=1&bot=square&botStart=0,0&botSpeed=1"));
  await waitForM05Debug(page);
  const squareStart = await readM05Debug(page);
  await expect.poll(async () => {
    const next = await readM05Debug(page);
    return {
      moved: Math.hypot((next?.localPose?.root.x ?? 0) - (squareStart?.localPose?.root.x ?? 0), (next?.localPose?.root.z ?? 0) - (squareStart?.localPose?.root.z ?? 0)) > 0.3,
      turned: Math.abs((next?.localPose?.root.yaw ?? 0) - (squareStart?.localPose?.root.yaw ?? 0)) > 0.1
    };
  }, {
    timeout: 12000,
    intervals: [500, 1000, 2000]
  }).toEqual({ moved: true, turned: true });
});
