import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForM05Debug } from "./helpers";

test("M0.5 debug contract exposes stable presence fields", async ({ page, request }) => {
  const roomId = await createM05Room(request, `M05 Debug Contract ${Date.now()}`);
  await page.goto(roomPath(roomId, "debug=1"));
  await waitForM05Debug(page);

  const debug = await readM05Debug(page);
  expect(typeof debug?.participantId).toBe("string");
  expect(["desktop", "mobile", "vr"]).toContain(debug?.mode);
  expect(typeof debug?.roomStateConnected).toBe("boolean");
  expect(["colyseus", "api_fallback", "disconnected"]).toContain(debug?.roomStateMode);
  expect(typeof debug?.remoteAvatarCount).toBe("number");
  expect(Array.isArray(debug?.remoteParticipants)).toBeTruthy();
  expect(typeof debug?.localPose?.root.x).toBe("number");
  expect(typeof debug?.localPose?.root.yaw).toBe("number");
  expect(typeof debug?.localPose?.head.pitch).toBe("number");
  expect(debug?.media).toBeTruthy();
  expect(["not_joined", "joining", "joined", "muted", "degraded", "failed"]).toContain(debug?.media?.audioState);
  expect(typeof debug?.media?.publishedAudio).toBe("boolean");
  expect(debug?.spatialAudio).toBeTruthy();
  expect(Array.isArray(debug?.spatialAudio?.remoteSources)).toBeTruthy();
});
