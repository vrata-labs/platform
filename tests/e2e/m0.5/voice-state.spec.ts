import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForConnectedOrFallback, waitForM05Debug } from "./helpers";

test("M0.5 microphone is explicit and denial degrades without breaking presence", async ({ page, request }) => {
  const roomId = await createM05Room(request, `M05 Voice ${Date.now()}`);
  await page.goto(roomPath(roomId, "debug=1&failaudio=mic_denied"));
  await waitForM05Debug(page);
  await waitForConnectedOrFallback(page);

  let debug = await readM05Debug(page);
  expect(debug?.media?.audioState).toBe("not_joined");
  expect(debug?.media?.publishedAudio).toBe(false);

  await page.click("#join-audio");
  await expect.poll(async () => {
    const next = await readM05Debug(page);
    return {
      issueCode: next?.issueCode ?? null,
      audioState: next?.media?.audioState ?? null,
      roomUsable: next?.roomStateConnected === true || next?.roomStateMode === "api_fallback"
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({ issueCode: "mic_denied", audioState: "degraded", roomUsable: true });

  debug = await readM05Debug(page);
  expect(debug?.media?.muted).toBe(true);
});

test("M0.5 join-muted preference survives reload without auto-publishing", async ({ page, request }) => {
  const roomId = await createM05Room(request, `M05 Mute ${Date.now()}`);
  await page.goto(roomPath(roomId, "debug=1&audiomock=1"));
  await waitForM05Debug(page);
  await waitForConnectedOrFallback(page);

  await page.check("#join-muted");
  await expect(page.locator("#join-muted")).toBeChecked();

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForM05Debug(page);
  await waitForConnectedOrFallback(page);
  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return {
      audioState: debug?.media?.audioState ?? null,
      audioJoined: debug?.media?.audioJoined ?? true,
      publishedAudio: debug?.media?.publishedAudio ?? true
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    audioState: "not_joined",
    audioJoined: false,
    publishedAudio: false
  });
});
