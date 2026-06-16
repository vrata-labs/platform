import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForM05Debug, waitForRemoteCount } from "./helpers";

test("M0.5 leave and rejoin remove stale participants", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 Rejoin ${Date.now()}`);
  const pageA = await browser.newPage();
  let pageB = await browser.newPage();

  try {
    await pageA.goto(roomPath(roomId, "debug=1&name=Watcher"));
    await pageB.goto(roomPath(roomId, "debug=1&bot=idle&name=SameName"));
    await waitForM05Debug(pageB);
    await waitForRemoteCount(pageA, 1);
    const participantB = (await readM05Debug(pageB))?.participantId;
    expect(participantB).toBeTruthy();

    await pageB.close();
    await waitForRemoteCount(pageA, 0, 20000);
    expect((await readM05Debug(pageA))?.remoteParticipants?.some((item) => item.participantId === participantB)).toBeFalsy();

    pageB = await browser.newPage();
    await pageB.goto(roomPath(roomId, "debug=1&bot=idle&name=SameName"));
    await waitForM05Debug(pageB);
    await waitForRemoteCount(pageA, 1);
    const participantC = (await readM05Debug(pageB))?.participantId;
    expect(participantC).toBeTruthy();
    expect(participantC).not.toBe(participantB);
    const debugA = await readM05Debug(pageA);
    expect(debugA?.remoteParticipants?.length).toBe(1);
    expect(debugA?.remoteParticipants?.[0]?.participantId).toBe(participantC);
  } finally {
    await pageA.close();
    if (!pageB.isClosed()) {
      await pageB.close();
    }
  }
});
