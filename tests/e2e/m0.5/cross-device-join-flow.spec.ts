import { expect, test } from "@playwright/test";

import { createM05Room, readM05Debug, roomPath, waitForM05Debug, waitForRemoteCount } from "./helpers";

test("M0.5 cross-device join flow resolves desktop, mobile, and VR mock clients", async ({ browser, request }) => {
  const roomId = await createM05Room(request, `M05 Cross Device ${Date.now()}`);
  const desktop = await browser.newPage();
  const mobileContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  const mobile = await mobileContext.newPage();
  const xrMock = await browser.newPage();

  try {
    await desktop.goto(roomPath(roomId, "debug=1&failxr=1&name=Desktop"));
    await mobile.goto(roomPath(roomId, "debug=1&name=Mobile"));
    await xrMock.goto(roomPath(roomId, "debug=1&xrmock=1&name=VrMock&bot=turn&botSpeed=1"));

    await Promise.all([
      waitForM05Debug(desktop),
      waitForM05Debug(mobile),
      waitForM05Debug(xrMock)
    ]);
    await Promise.all([
      waitForRemoteCount(desktop, 2),
      waitForRemoteCount(mobile, 2),
      waitForRemoteCount(xrMock, 2)
    ]);

    await expect.poll(async () => {
      const debug = await readM05Debug(desktop);
      return debug?.remoteParticipants?.map((participant) => participant.mode).sort() ?? [];
    }, {
      timeout: 20000,
      intervals: [500, 1000, 2000]
    }).toEqual(["mobile", "vr"]);

    const desktopDebug = await readM05Debug(desktop);
    const mobileDebug = await readM05Debug(mobile);
    const xrDebug = await readM05Debug(xrMock);

    expect(desktopDebug?.mode).toBe("desktop");
    expect(desktopDebug?.clientCompatibility?.resolvedJoinMode).toBe("desktop");
    expect(desktopDebug?.clientCompatibility?.entryBlocked).toBe(false);
    expect(desktopDebug?.clientCompatibility?.warnings).toContain("xr_unavailable");
    await expect(desktop.locator("#compatibility-status")).toContainText("Compatibility: desktop mode");
    await expect(desktop.locator(".vr-button")).toBeDisabled();
    await expect(desktop.locator(".vr-button")).toContainText(/VR (unavailable|NOT SUPPORTED)/);

    expect(mobileDebug?.mode).toBe("mobile");
    expect(mobileDebug?.clientCompatibility?.resolvedJoinMode).toBe("mobile");
    expect(mobileDebug?.clientCompatibility?.touchControls).toEqual({ supported: true, required: true });
    expect(mobileDebug?.clientCompatibility?.entryBlocked).toBe(false);

    expect(xrDebug?.mode).toBe("vr");
    expect(xrDebug?.clientCompatibility?.resolvedJoinMode).toBe("vr");
    expect(xrDebug?.clientCompatibility?.modeSource).toBe("xr_mock");
    expect(xrDebug?.clientCompatibility?.xr.mocked).toBe(true);
    expect(xrDebug?.clientCompatibility?.entryBlocked).toBe(false);
  } finally {
    await desktop.close();
    await mobileContext.close();
    await xrMock.close();
  }
});
