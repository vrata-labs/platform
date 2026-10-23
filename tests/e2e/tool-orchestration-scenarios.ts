import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import { installFunctionalFrameBudget } from "./functional-frame-budget";
import { chooseMeetingPanel, meetingRequest } from "./meeting-tools-acceptance";
import { createDocumentMeeting } from "./document-meeting-scenarios";

type Input = { browser: Browser; request: APIRequestContext; origin: string; adminToken: string; expectedProtocol?: 1 | 2 };

/** Replaces only OS screen selection, never publication/subscription/decoding.
 * Captures are tied to real clicks; this is not a physical Android/picker test. */
async function installCaptureSource(page: Page) {
  await page.addInitScript(() => {
    const state = { mode: "allow", calls: [] as boolean[], streams: [] as MediaStream[], color: "#e82020", release: () => {} };
    (window as any).__toolCapture = state;
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => {
      state.calls.push(navigator.userActivation.isActive);
      if (state.mode === "cancel") throw new DOMException("", "NotAllowedError");
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const paint = canvas.getContext("2d")!;
      const draw = () => { paint.fillStyle = state.color; paint.fillRect(0, 0, 160, 90); };
      draw(); const stream = canvas.captureStream(10), timer = setInterval(draw, 100); state.streams.push(stream);
      stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer));
      if (state.mode === "hold") await new Promise<void>(resolve => { state.release = resolve; });
      return stream;
    } });
  });
}

export async function toolOrchestrationScenario(input: Input) {
  const contexts: BrowserContext[] = [], headers = { "x-vrata-admin-token": input.adminToken };
  const created = await meetingRequest(() => input.request.post(`${input.origin}/api/rooms`, { headers, data: {
    tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned tool orchestration", visibility: "private"
  } }));
  expect(created.status()).toBe(201); const roomId = (await created.json()).roomId as string, path = `/api/rooms/${roomId}`;
  async function enter(role: "host" | "member" | "guest") {
    phase = `onboarding-${role}`;
    const invitation = await meetingRequest(() => input.request.post(`${input.origin}${path}/invites`, { headers, data: { role, expiresInSeconds: 1200 } }));
    expect(invitation.status()).toBe(201);
    const context = await input.browser.newContext({ viewport: role === "guest" ? { width: 390, height: 844 } : { width: 800, height: 500 },
      deviceScaleFactor: .4, isMobile: role === "guest", hasTouch: role === "guest" });
    contexts.push(context); const page = await context.newPage(); await installFunctionalFrameBudget(page);
    if (role !== "guest") await installCaptureSource(page);
    else await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: undefined }));
    const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    void admission.catch(() => undefined);
    try { await page.goto((await invitation.json()).inviteLink); } catch { throw new Error("tool_meeting_navigation_failed"); }
    await expect(page.locator("#guest-onboarding")).toBeVisible({ timeout: 30_000 });
    await page.locator("#guest-name-input").fill(`Tools ${role}`); await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    const issued = await (await admission).json(); expect(issued.access.role).toBe(role);
    if (input.expectedProtocol) expect(issued.identityProtocolVersion ?? 1).toBe(input.expectedProtocol);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
    return { page, participantId: await page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId) as string, issued };
  }
  const active = (page: Page, surfaceId = "debug-main") => page.evaluate(surfaceId => {
    const debug = (window as any).__VRATA_DEBUG__, surface = debug?.mediaObjects?.surfaces?.find((item: any) => item.surfaceId === surfaceId);
    return debug?.mediaObjects?.objects?.find((item: any) => item.objectId === surface?.activeObjectId) ?? null;
  }, surfaceId);
  const pdfPage = (page: Page, number: number) => expect.poll(() => page.evaluate(() => {
    const pdf = (window as any).__VRATA_DEBUG__?.pdfPresentation; return pdf?.renderState === "ready" ? pdf.page : null;
  }), { timeout: 45_000 }).toBe(number);
  let phase = "onboarding";
  try {
    const host = await enter("host"), member = await enter("member"), guest = await enter("guest");
    phase = "own-pdf";
    await chooseMeetingPanel(host.page, "present", false);
    const pdf = await PDFDocument.create();
    for (const color of [rgb(.8, .1, .1), rgb(.1, .2, .8)]) {
      const page = pdf.addPage([640, 360]); page.drawRectangle({ x: 0, y: 0, width: 640, height: 360, color });
      page.drawText("Own orchestration slides", { x: 30, y: 180, color: rgb(1, 1, 1), size: 24 });
    }
    await host.page.locator("#document-upload-input").setInputFiles({ name: "orchestration.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
    const uploaded = host.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/documents`);
    void uploaded.catch(() => undefined); await host.page.locator("#document-upload-button").click();
    const upload = await uploaded; expect(upload.status()).toBe(201); const documentId = (await upload.json()).document.documentId as string;
    await host.page.locator("#document-surface-button").click(); await pdfPage(guest.page, 1);
    const originalPdf = (await active(host.page)).objectId;
    phase = "sticky-consent";
    await chooseMeetingPanel(host.page, "board", false); await host.page.locator("#meeting-use-board-surface").click();
    await host.page.locator("#start-markdown-board").click();
    await host.page.locator("#markdown-board-note-text").fill("Preserve this decision unless replacement is confirmed"); await host.page.locator("#add-sticky-note").click();
    await expect.poll(async () => (await active(guest.page, "whiteboard-wall"))?.state?.notes?.length).toBe(1);
    const stickyId = (await active(host.page, "whiteboard-wall")).objectId;
    await host.page.locator("#media-surface-select").selectOption("debug-main");
    await host.page.locator("#start-whiteboard").click();
    await expect(host.page.locator("#meeting-replace-dialog")).toBeVisible();
    await expect(host.page.locator("#meeting-replace-cancel")).toBeFocused();
    await expect(host.page.locator("#meeting-replace-explanation")).toContainText("notes or strokes will be removed");
    await host.page.keyboard.press("Escape"); await expect(host.page.locator("#meeting-replace-dialog")).toBeHidden();
    expect((await active(host.page, "whiteboard-wall")).objectId).toBe(stickyId); expect((await active(host.page)).objectId).toBe(originalPdf);
    await host.page.locator("#start-whiteboard").click();
    // A colleague edits this exact sticky object while consent is open.
    await chooseMeetingPanel(member.page, "board", false); await member.page.locator("#meeting-use-board-surface").click();
    await member.page.locator("#markdown-board-note-text").fill("Concurrent colleague decision"); await member.page.locator("#add-sticky-note").click();
    await expect.poll(async () => (await active(host.page, "whiteboard-wall"))?.state?.notes?.length).toBe(2);
    await host.page.locator("#meeting-replace-confirm").click();
    await expect(host.page.locator("#meeting-transition-status")).toContainText("surface content changed");
    expect((await active(guest.page, "whiteboard-wall")).objectId).toBe(stickyId);
    await host.page.locator("#start-whiteboard").click(); await host.page.locator("#meeting-replace-confirm").click();
    await expect.poll(async () => (await active(guest.page, "whiteboard-wall"))?.type).toBe("whiteboard");
    await expect(host.page.locator("#media-surface-select")).toHaveValue("whiteboard-wall");
    phase = "independent-strokes";
    for (const page of [host.page, member.page]) {
      // Coordinate injection exercises real input authorization, WS and canvas;
      // physical mouse/touch accuracy remains a separate device acceptance gate.
      expect(await page.evaluate(() => (window as any).__VRATA_TEST__.sendDebugSurfaceInput({ surfaceId: "whiteboard-wall", kind: "click", u: .3, v: .4 }))).toBe(true);
    }
    await expect.poll(async () => (await active(guest.page, "whiteboard-wall"))?.state?.strokes?.length).toBe(2);
    expect(await guest.page.evaluate(() => (window as any).__VRATA_TEST__.sendDebugSurfaceInput({ surfaceId: "whiteboard-wall", kind: "click", u: .5, v: .6 }))).toBe(false);
    expect((await active(guest.page)).objectId).toBe(originalPdf);
    phase = "capture-cancel";
    await chooseMeetingPanel(host.page, "present", false);
    await host.page.locator("#start-share").click(); await host.page.locator("#meeting-replace-cancel").click();
    expect(await host.page.evaluate(() => (window as any).__toolCapture.calls.length)).toBe(0);
    await host.page.evaluate(() => { (window as any).__toolCapture.mode = "cancel"; });
    await host.page.locator("#start-share").click(); await host.page.locator("#meeting-replace-confirm").click();
    await expect(host.page.locator("#meeting-transition-status")).toContainText("Existing content was kept");
    expect((await active(guest.page)).objectId).toBe(originalPdf);
    await host.page.evaluate(() => { (window as any).__toolCapture.mode = "hold"; });
    phase = "pdf-to-screen";
    await host.page.locator("#media-surface-select").selectOption("debug-main");
    await host.page.locator("#start-share").click(); await host.page.locator("#meeting-replace-confirm").click();
    await expect(host.page.locator("#meeting-transition-status")).toContainText("Choose a screen");
    await host.page.locator("#media-surface-select").selectOption("whiteboard-wall");
    await host.page.evaluate(() => { const capture = (window as any).__toolCapture; capture.mode = "allow"; capture.release(); });
    await expect.poll(() => guest.page.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount), { timeout: 90_000 }).toBe(1);
    await expect(host.page.locator("#media-surface-select")).toHaveValue("whiteboard-wall");
    expect((await meetingRequest(() => input.request.get(`${input.origin}${path}/documents/${documentId}/presentation`, {
      headers: { authorization: `Bearer ${guest.issued.token}` }
    }))).status()).toBe(404);
    const receivedColor = () => guest.page.evaluate(() => {
      const pixel = (window as any).__VRATA_TEST__.sampleMediaSurfaceTexture("debug-main", { u: .5, v: .5 }, { width: .01, height: .01 })?.samples?.[0];
      return pixel?.[0] > pixel?.[2] + 30 ? "red" : pixel?.[2] > pixel?.[0] + 30 ? "blue" : null;
    });
    await expect.poll(receivedColor, { timeout: 30_000 }).toBe("red");
    await host.page.evaluate(() => { (window as any).__toolCapture.color = "#2040e8"; }); await expect.poll(receivedColor, { timeout: 30_000 }).toBe("blue");
    phase = "screen-to-pdf";
    await host.page.locator("#document-surface-button").click(); await host.page.locator("#meeting-replace-confirm").click();
    await pdfPage(guest.page, 1); await host.page.locator("#presentation-next").click(); await pdfPage(guest.page, 2);
    expect(await host.page.evaluate(() => (window as any).__toolCapture.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    expect((await active(guest.page, "whiteboard-wall")).state.strokes.length).toBe(2);
    phase = "browser-stop";
    await host.page.locator("#start-share").click(); await host.page.locator("#meeting-replace-confirm").click();
    await expect.poll(() => host.page.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.localPublishing), { timeout: 60_000 }).toBe(true);
    await host.page.evaluate(() => { const track = (window as any).__toolCapture.streams.at(-1).getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event("ended")); });
    await expect.poll(async () => (await active(guest.page))?.type ?? null, { timeout: 30_000 }).toBeNull();
    phase = "presenter-revoke";
    await chooseMeetingPanel(host.page, "people", false); await host.page.locator("#host-participant-select").selectOption(member.participantId); await host.page.locator("#grant-presenter").click();
    await expect.poll(() => member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 20_000 }).toBe("presenter");
    await chooseMeetingPanel(member.page, "present", false); await member.page.locator("#start-share").click();
    await expect.poll(() => member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.localPublishing), { timeout: 60_000 }).toBe(true);
    await host.page.locator("#revoke-presenter").click();
    await expect.poll(() => member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 20_000 }).toBe("member");
    await expect.poll(async () => (await active(guest.page))?.type ?? null, { timeout: 30_000 }).toBeNull();
    await expect.poll(() => member.page.evaluate(() => (window as any).__toolCapture.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended"))), { timeout: 20_000 }).toBe(true);
    phase = "late-picker-after-regrant";
    await host.page.locator("#grant-presenter").click();
    await expect.poll(() => member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 20_000 }).toBe("presenter");
    await member.page.evaluate(() => { (window as any).__toolCapture.mode = "hold"; });
    const beforeCapture = await member.page.evaluate(() => (window as any).__toolCapture.calls.length);
    await member.page.locator("#start-share").click();
    await expect.poll(() => member.page.evaluate(() => (window as any).__toolCapture.calls.length)).toBe(beforeCapture + 1);
    await host.page.locator("#revoke-presenter").click();
    await expect.poll(() => member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 20_000 }).toBe("member");
    await host.page.locator("#grant-presenter").click();
    await expect.poll(() => member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 20_000 }).toBe("presenter");
    await member.page.evaluate(() => (window as any).__toolCapture.release());
    await expect(member.page.locator("#meeting-transition-status")).toContainText("pending action was cancelled");
    expect(await active(guest.page)).toBeNull();
    await expect.poll(() => member.page.evaluate(() => (window as any).__toolCapture.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended"))), { timeout: 20_000 }).toBe(true);
    for (const page of [host.page, member.page]) expect(await page.evaluate(() => (window as any).__toolCapture.calls.every(Boolean))).toBe(true);
    await chooseMeetingPanel(guest.page, "present", true); await expect(guest.page.locator("#start-share")).toBeDisabled();
    await expect(guest.page.locator("#meeting-present-status")).toContainText("Host or Presenter");
  } catch (error) {
    console.warn("tool_orchestration_failed", JSON.stringify({ phase })); throw error;
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    expect((await meetingRequest(() => input.request.delete(`${input.origin}${path}`, { headers }))).ok()).toBe(true);
  }
}

/** Calls the original browser getDisplayMedia, with Chromium selecting its test
 * monitor. No replacement API/canvas source, but no claim of a human OS picker. */
export async function nativeToolCaptureScenario(input: Input) {
  const meeting = await createDocumentMeeting({ ...input, mobile: false });
  const pages: Page[] = [];
  try {
    const host = await meeting.enter("host"), guest = await meeting.enter("guest");
    pages.push(host.page, guest.page);
    await host.page.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      (window as any).__nativeToolCapture = { calls: 0, active: false, stream: null };
      navigator.mediaDevices.getDisplayMedia = async options => {
        const state = (window as any).__nativeToolCapture; state.calls++; state.active = navigator.userActivation.isActive;
        state.stream = await original(options); return state.stream;
      };
    });
    await chooseMeetingPanel(host.page, "present", false); await host.page.locator("#start-share").click();
    await expect.poll(() => host.page.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.localPublishing), { timeout: 90_000 }).toBe(true);
    expect(await host.page.evaluate(() => {
      const state = (window as any).__nativeToolCapture, track = state.stream.getVideoTracks()[0];
      return { calls: state.calls, active: state.active, live: track.readyState, surface: track.getSettings().displaySurface };
    })).toEqual({ calls: 1, active: true, live: "live", surface: "monitor" });
    const frames = () => guest.page.evaluate(() => [...document.querySelectorAll("video")].reduce((sum, video) => sum + video.getVideoPlaybackQuality().totalVideoFrames, 0));
    await expect.poll(frames, { timeout: 45_000 }).toBeGreaterThan(2); const baseline = await frames();
    await expect.poll(frames, { timeout: 20_000 }).toBeGreaterThan(baseline + 2);
    await host.page.locator("#stop-share").click();
    await expect.poll(() => host.page.evaluate(() => (window as any).__nativeToolCapture.stream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended")), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => guest.page.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount), { timeout: 20_000 }).toBe(0);
  } catch (error) {
    const facts = await Promise.all(pages.map(page => page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return { scene: debug?.sceneBundleState, connected: debug?.roomStateConnected, state: debug?.screenShareState,
        share: debug?.screenShare, issue: debug?.issueCode,
        videos: [...document.querySelectorAll("video")].map(video => ({ width: video.videoWidth, height: video.videoHeight, ready: video.readyState,
          paused: video.paused, frames: video.getVideoPlaybackQuality().totalVideoFrames })) };
    }).catch(() => ({ unavailable: true }))));
    console.warn("native_tool_capture_failed", JSON.stringify(facts)); throw error;
  } finally { await meeting.close(); }
}

export async function unsupportedCaptureAttemptScenario(input: Input) {
  const meeting = await createDocumentMeeting({ ...input, mobile: false });
  try {
    const host = await meeting.enter("host"), page = host.page;
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded");
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.mediaCapabilities?.screenShare?.supported)).toBe(true);
    await page.evaluate(() => {
      (window as any).__unsupportedCapture = { calls: 0, activated: true, mode: "abort" };
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => {
        const capture = (window as any).__unsupportedCapture;
        capture.calls++; capture.activated = capture.activated && navigator.userActivation.isActive;
        if (capture.mode === "abort") throw new DOMException("Error starting screen capture", "AbortError");
        throw new DOMException("", "NotSupportedError");
      } });
    });
    await chooseMeetingPanel(page, "present", false); await page.locator("#start-share").click();
    await expect(page.locator("#meeting-transition-status")).toContainText("Screen capture was cancelled");
    await expect(page.locator("#start-share")).toBeEnabled(); await expect(page.locator("#start-share")).toHaveText("Start Share");
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__.mediaCapabilities.screenShare.supported)).toBe(true);
    await page.evaluate(() => { (window as any).__unsupportedCapture.mode = "unsupported"; });
    await page.locator("#start-share").click();
    await expect(page.locator("#start-share")).toHaveText("Share Unsupported"); await expect(page.locator("#start-share")).toBeDisabled();
    await expect(page.locator("#meeting-present-status")).toContainText("Screen sharing is unsupported on this device");
    await chooseMeetingPanel(page, "board", false); await page.locator("#start-whiteboard").click();
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.mediaObjects?.surfaces?.find((surface: any) => surface.surfaceId === "whiteboard-wall")?.activeObjectType)).toBe("whiteboard");
    await chooseMeetingPanel(page, "present", false);
    await expect(page.locator("#start-share")).toBeDisabled();
    await expect(page.locator("#start-share")).toHaveAttribute("title", /capture unavailable in this browser environment/);
    expect(await page.evaluate(() => {
      const capabilities = (window as any).__VRATA_DEBUG__.mediaCapabilities;
      const capture = (window as any).__unsupportedCapture;
      return { calls: capture.calls, activated: capture.activated, apiExists: typeof navigator.mediaDevices.getDisplayMedia === "function",
        supported: capabilities.screenShare.supported, reason: capabilities.screenShare.reason, microphoneSupported: capabilities.audioInput.supported };
    })).toEqual({ calls: 2, activated: true, apiExists: true, supported: false, reason: "display_capture_unsupported", microphoneSupported: true });
  } finally { await meeting.close(); }
}

export async function bootDiagnosticsPresenceScenario(input: Input) {
  let held = false, heldServerTimeMs = NaN, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const meeting = await createDocumentMeeting({ ...input, mobile: false,
    async preparePage(page, room) {
      await installFunctionalFrameBudget(page);
      await page.route(`**/api/rooms/${room.roomId}/diagnostics`, async route => {
        const request = route.request();
        if (request.method() !== "POST" || request.postDataJSON()?.note !== "runtime_booted") return route.continue();
        const response = await route.fetch(); heldServerTimeMs = Date.parse(response.headers()["date"] ?? ""); held = true; await pending;
        await route.fulfill({ response }).catch(() => undefined);
      });
    }
  });
  try {
    const invitation = await meeting.invite("host"), link = new URL(invitation.inviteLink);
    // Hold only the telemetry response, not native RTC connection work. Presence
    // must stay alive even when audio cannot connect and diagnostics is pending.
    link.searchParams.set("failaudio", "connection_failed");
    const host = await meeting.enter("host", { ...invitation, inviteLink: link.href });
    await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
    expect(Number.isFinite(heldServerTimeMs)).toBe(true);
    // API presence expires after 15 seconds; prove a real heartbeat beyond that
    // lease while the diagnostics request remains deliberately unresolved.
    await host.page.waitForTimeout(18_000);
    const response = await meetingRequest(() => input.request.get(`${input.origin}/api/rooms/${meeting.roomId}/presence`, { headers: meeting.headers }));
    expect(response.status()).toBe(200);
    const participant = (await response.json()).items.find((person: any) => person.participantId === host.participantId);
    expect(!!participant).toBe(true);
    expect(Date.parse(participant.updatedAt)).toBeGreaterThan(heldServerTimeMs + 15_000);
    expect(await host.page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
  } finally { release(); await meeting.close(); }
}
