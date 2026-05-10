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

test("M0.5 desktop head pitch tilts without horizontal head drift", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 Head Pitch ${Date.now()}`);
  const observer = await browser.newPage();
  const actor = await browser.newPage();

  try {
    await observer.goto(roomPath(roomId, "debug=1&name=Observer"));
    await actor.goto(roomPath(roomId, "debug=1&name=PitchActor"));
    await waitForRemoteCount(observer, 1);

    await expect.poll(async () => {
      const localRoot = (await readM05Debug(actor))?.localPose?.root;
      const remote = (await readM05Debug(observer))?.remoteParticipants?.[0];
      const headRootDrift = Math.hypot(
        (remote?.head.x ?? 0) - (localRoot?.x ?? 0),
        (remote?.head.z ?? 0) - (localRoot?.z ?? 0)
      );
      return {
        localReady: Boolean(localRoot),
        headAtRoot: headRootDrift < 0.08,
        visual: remote?.hasVisualEntity ?? false
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({ localReady: true, headAtRoot: true, visual: true });

    const initialPitch = (await readM05Debug(observer))?.remoteParticipants?.[0]?.head.pitch ?? 0;

    await actor.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) {
        throw new Error("canvas missing");
      }
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
        clientX: 200,
        clientY: 220
      }));
      const move = new PointerEvent("pointermove", {
        bubbles: true,
        pointerType: "mouse",
        clientX: 200,
        clientY: 80
      });
      Object.defineProperty(move, "movementX", { value: 0 });
      Object.defineProperty(move, "movementY", { value: -140 });
      window.dispatchEvent(move);
      window.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        pointerType: "mouse",
        clientX: 200,
        clientY: 80
      }));
    });

    await expect.poll(async () => {
      const local = (await readM05Debug(actor))?.localPose?.head;
      return Math.abs(local?.pitch ?? 0) > 0.15;
    }, {
      timeout: 5000,
      intervals: [100, 250, 500]
    }).toBe(true);

    await expect.poll(async () => {
      const localRoot = (await readM05Debug(actor))?.localPose?.root;
      const remote = (await readM05Debug(observer))?.remoteParticipants?.[0];
      const headRootDrift = Math.hypot(
        (remote?.head.x ?? 0) - (localRoot?.x ?? 0),
        (remote?.head.z ?? 0) - (localRoot?.z ?? 0)
      );
      return {
        pitchChanged: Math.abs((remote?.head.pitch ?? 0) - initialPitch) > 0.15,
        headXzStable: headRootDrift < 0.08,
        visual: remote?.hasVisualEntity ?? false
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({ pitchChanged: true, headXzStable: true, visual: true });
  } finally {
    await observer.close();
    await actor.close();
  }
});
