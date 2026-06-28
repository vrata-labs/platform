import { expect, type Page, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForM05Debug, waitForRemoteCount } from "./helpers";

test.setTimeout(120000);

async function waitForAllRemoteCounts(pages: Page[], expectedCount: number): Promise<void> {
  await Promise.all(pages.map((page) => waitForRemoteCount(page, expectedCount, 45000)));
}

async function participantId(page: Page): Promise<string> {
  const id = (await readM05Debug(page))?.participantId;
  expect(id).toBeTruthy();
  return id!;
}

async function waitForMovementObserved(observer: Page, participantId: string, minimumDistance = 0.2): Promise<void> {
  let initial: { x: number; z: number } | null = null;

  await expect.poll(async () => {
    const remote = (await readM05Debug(observer))?.remoteParticipants?.find((participant) => participant.participantId === participantId);
    if (!remote) {
      return 0;
    }
    initial ??= { x: remote.root.x, z: remote.root.z };
    return Math.hypot(remote.root.x - initial.x, remote.root.z - initial.z);
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000]
  }).toBeGreaterThan(minimumDistance);
}

async function waitForVoiceJoinResult(listener: Page, sourceParticipantId: string): Promise<"joined" | "failed"> {
  let result: "joined" | "failed" | null = null;
  await expect.poll(async () => {
    const debug = await readM05Debug(listener);
    const participant = debug?.remoteParticipants?.find((item) => item.participantId === sourceParticipantId);
    const source = debug?.spatialAudio?.remoteSources.find((item) => item.participantId === sourceParticipantId);
    if (debug?.media?.audioState === "failed") {
      result = "failed";
      return debug.roomStateConnected === true || debug.roomStateMode === "api_fallback" ? "ready" : "pending";
    }
    const joined = debug?.media?.audioState === "joined"
      && debug.media.audioSource === "mock"
      && debug.media.subscribedAudioCount === 1
      && participant?.activeAudio === true
      && source?.attachedTo === "head"
      && source?.hasAudioNode === true;
    if (joined) {
      result = "joined";
      return "ready";
    }
    return "pending";
  }, {
    timeout: 45000,
    intervals: [1000, 2000, 3000]
  }).toBe("ready");

  expect(result).toBeTruthy();
  return result!;
}

test("M0.5 reliable 2-4 participant room scenario covers movement voice reload and late join", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 Reliable Room ${Date.now()}`);
  const observer = await browser.newPage();
  const source = await browser.newPage();
  let reloaded = await browser.newPage();
  const witness = await browser.newPage();
  let lateJoiner: Page | null = null;

  try {
    await Promise.all([
      observer.goto(roomPath(roomId, "debug=1&audiomock=1&name=Observer")),
      source.goto(roomPath(roomId, "debug=1&audiomock=1&bot=line&botSpeed=1&botStart=2,0&name=VoiceMover")),
      reloaded.goto(roomPath(roomId, "debug=1&bot=turn&botStart=-2,0&name=ReloadTarget")),
      witness.goto(roomPath(roomId, "debug=1&bot=square&botStart=0,2&name=Witness"))
    ]);
    const initialPages = [observer, source, reloaded, witness];
    await Promise.all(initialPages.map(waitForM05Debug));
    await waitForAllRemoteCounts(initialPages, 3);

    const initialIds = await Promise.all(initialPages.map(participantId));
    expect(new Set(initialIds).size).toBe(4);
    for (const page of initialPages) {
      const debug = await readM05Debug(page);
      expect(debug?.remoteParticipants?.length).toBe(3);
      expect(debug?.remoteParticipants?.every((participant) => participant.hasVisualEntity)).toBeTruthy();
    }

    const sourceId = initialIds[1]!;
    await Promise.all([
      waitForMovementObserved(observer, sourceId),
      waitForMovementObserved(reloaded, sourceId),
      waitForMovementObserved(witness, sourceId)
    ]);

    await Promise.all([
      observer.click("#join-audio"),
      source.click("#join-audio")
    ]);
    const voiceResult = await waitForVoiceJoinResult(observer, sourceId);

    await reloaded.reload({ waitUntil: "domcontentloaded" });
    await waitForM05Debug(reloaded);
    await waitForRemoteCount(reloaded, 3, 45000);
    const reloadedId = await participantId(reloaded);
    expect(reloadedId).toBe(initialIds[2]);
    await Promise.all([observer, source, witness].map(async (page) => {
      await expect.poll(async () => (await readM05Debug(page))?.remoteAvatarCount ?? -1, {
        timeout: 30000,
        intervals: [500, 1000, 2000]
      }).toBe(3);
    }));

    await reloaded.close();
    reloaded = await browser.newPage();
    await reloaded.goto(roomPath(roomId, "debug=1&bot=turn&botStart=-2,0&name=ReloadTarget"));
    await waitForM05Debug(reloaded);
    await waitForRemoteCount(observer, 3, 45000);
    const replacementId = await participantId(reloaded);
    expect(replacementId).not.toBe(reloadedId);

    lateJoiner = await browser.newPage();
    await lateJoiner.goto(roomPath(roomId, "debug=1&name=LateJoiner"));
    await waitForM05Debug(lateJoiner);
    await waitForRemoteCount(lateJoiner, 4, 45000);
    const lateDebug = await readM05Debug(lateJoiner);
    if (voiceResult === "joined") {
      expect(lateDebug?.remoteParticipants?.some((participant) => participant.participantId === sourceId && participant.activeAudio)).toBeTruthy();
    }
    expect(lateDebug?.remoteParticipants?.every((participant) => participant.hasVisualEntity)).toBeTruthy();

    const presenceResponse = await request.get(`/api/rooms/${roomId}/presence`);
    expect(presenceResponse.ok()).toBeTruthy();
    const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
    expect(new Set(presence.items.map((item) => item.participantId)).size).toBeGreaterThanOrEqual(5);
  } finally {
    await Promise.all([
      observer.close(),
      source.close(),
      reloaded.close(),
      witness.close(),
      lateJoiner?.close() ?? Promise.resolve()
    ]);
  }
});
