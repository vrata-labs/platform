import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForRemoteCount } from "./helpers";

test.setTimeout(60000);

test("M0.5 four browser participants see each other", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 Four Participants ${Date.now()}`);
  const pages = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage(), browser.newPage()]);
  const paths = [
    roomPath(roomId, "debug=1&bot=idle&name=BotA"),
    roomPath(roomId, "debug=1&bot=line&name=BotB&botStart=2,0"),
    roomPath(roomId, "debug=1&bot=turn&name=BotC&botStart=-2,0"),
    roomPath(roomId, "debug=1&bot=square&name=BotD&botStart=0,2")
  ];

  try {
    await Promise.all(pages.map((page, index) => page.goto(paths[index]!)));
    await Promise.all(pages.map((page) => waitForRemoteCount(page, 3, 30000)));

    const ids = await Promise.all(pages.map(async (page) => (await readM05Debug(page))?.participantId));
    expect(new Set(ids).size).toBe(4);
    for (const page of pages) {
      const debug = await readM05Debug(page);
      expect(debug?.remoteParticipants?.length).toBe(3);
      expect(debug?.remoteParticipants?.every((participant) => participant.hasVisualEntity)).toBeTruthy();
    }

    await expect.poll(async () => {
      const counts = await Promise.all(pages.map(async (page) => (await readM05Debug(page))?.remoteAvatarCount ?? 0));
      return counts.every((count) => count === 3);
    }, {
      timeout: 12000,
      intervals: [1000, 2000, 3000]
    }).toBeTruthy();

    const presenceResponse = await request.get(`/api/rooms/${roomId}/presence`);
    const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
    expect(presence.items.length).toBeGreaterThanOrEqual(4);
  } finally {
    await Promise.all(pages.map((page) => page.close()));
  }
});
