import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type Request as BrowserRequest, type Response as BrowserResponse } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import { chooseMeetingPanel, meetingRequest, installMeetingPerformanceObservation, readMeetingPerformance } from "./meeting-tools-acceptance";
import { installFunctionalFrameBudget } from "./functional-frame-budget";

export interface MeetingPresenter {
  page: Page;
  participantId: string;
  admittedAt: number;
  prematureAdmissions(): number;
  issued: { token: string; identityProtocolVersion?: 2; expiresInSeconds: number; access: { role: string } };
}
type Input = { browser: Browser; request: APIRequestContext; origin: string; adminToken: string };
type Hooks = {
  prepareActor?: (page: Page, origin: string) => Promise<void>;
  presenting?: (actor: MeetingPresenter, index: number, roomId: string, guest: MeetingPresenter) => Promise<void>;
  revoked?: (actor: MeetingPresenter, index: number, roomId: string, guest: MeetingPresenter) => Promise<void>;
  failed?: (phase: string, roomId: string) => Promise<void>;
};

/** Shared local/published check: real invitations, onboarding, host controls and
 * uploaded documents. Native RTC coverage adds hooks, never replaces the UI. */
export async function presenterMeetingScenario(input: Input, hooks: Hooks = {}) {
  const contexts: BrowserContext[] = [], headers = { "x-vrata-admin-token": input.adminToken };
  async function post(url: string, options: Parameters<APIRequestContext["post"]>[1]) {
    try { return await input.request.post(url, options); }
    catch { throw new Error("presenter_meeting_request_failed"); }
  }
  const created = await post(`${input.origin}/api/rooms`, { headers, data: {
    tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned presenter handoff", visibility: "private"
  } });
  expect(created.status()).toBe(201); const roomId = (await created.json()).roomId as string;
  const path = `/api/rooms/${roomId}`, names = ["Meeting Host", "Alpha <b>literal</b>", "Beta speaker", "Meeting Guest"];
  async function enter(role: "host" | "member" | "guest", index: number): Promise<MeetingPresenter> {
    const invitation = await post(`${input.origin}${path}/invites`, { headers, data: { role, expiresInSeconds: 1200 } });
    expect(invitation.status()).toBe(201); const link = (await invitation.json()).inviteLink;
    const context = await input.browser.newContext({ viewport: role === "guest" ? { width: 390, height: 844 } : { width: 800, height: 500 },
      deviceScaleFactor: 0.4, hasTouch: role === "guest", isMobile: role === "guest" });
    contexts.push(context); const page = await context.newPage();
    await installFunctionalFrameBudget(page);
    await installMeetingPerformanceObservation(page);
    await hooks.prepareActor?.(page, input.origin);
    let renewalAt = 0, prematureAdmissions = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/tokens/state" && renewalAt > 0 && Date.now() < renewalAt) prematureAdmissions++; });
    const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    void admission.catch(() => undefined);
    try { await page.goto(link); } catch { throw new Error("presenter_meeting_navigation_failed"); }
    await expect(page.locator("#guest-onboarding")).toBeVisible();
    await page.locator("#guest-name-input").fill(names[index]); await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    const issued = await (await admission).json(), admittedAt = Date.now(); expect(issued.access.role).toBe(role);
    renewalAt = admittedAt + Math.max(30_000, Math.min(420_000, (issued.expiresInSeconds - 120) * 1000)) - 5000;
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
    const participantId = await page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId) as string;
    return { page, participantId, admittedAt, issued, prematureAdmissions: () => prematureAdmissions };
  }
  const expectRole = async (actor: MeetingPresenter, role: string) => {
    await actor.page.waitForFunction(role => (window as any).__VRATA_DEBUG__?.access?.role === role, role, { timeout: 20_000, polling: 100 });
  };
  const nextSelfView = (actor: MeetingPresenter, role: string | "blocked") => {
    const observed = actor.page.waitForResponse(async response => {
      if (response.request().method() !== "GET" || new URL(response.url()).pathname !== `${path}/session-control`) return false;
      const view = await response.json().catch(() => null);
      if (role === "blocked" && view?.error === "identity_required" && view.reason === "identity_recovery_required") return true;
      return response.status() === 200 && view?.participant?.participantId === actor.participantId
        && (role === "blocked" ? view.participant.status === "blocked" : view.participant.role === role);
    }, { timeout: 60_000 });
    void observed.catch(() => undefined); return observed;
  };
  async function showPage(guest: MeetingPresenter, documentId: string, page: number) {
    try {
      await expect.poll(() => guest.page.evaluate(({ documentId, page }) => {
        const debug = (window as any).__VRATA_DEBUG__;
        return debug?.pdfPresentation?.documentId === documentId && debug.pdfPresentation.page === page && debug.pdfPresentation.renderState === "ready";
      }, { documentId, page }), { timeout: 45_000 }).toBe(true);
    } catch (error) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const client = guest.page.evaluate(expected => {
        const debug = (window as any).__VRATA_DEBUG__, pdf = debug?.pdfPresentation;
        const surface = debug?.mediaObjects?.surfaces?.find((surface: any) => surface.surfaceId === "debug-main");
        const object = debug?.mediaObjects?.objects?.find((object: any) => object.objectId === surface?.activeObjectId);
        const code = String(pdf?.errorCode ?? "");
        return { scene: debug?.sceneBundleState, connected: debug?.roomStateConnected, pdfActive: pdf?.active,
          documentMatches: pdf?.documentId === expected, page: pdf?.page, pageCount: pdf?.pageCount,
          renderState: ["idle","loading","ready","failed","error"].includes(pdf?.renderState) ? pdf.renderState : "other",
          hasError: Boolean(code), forbidden: /403|forbidden|denied/.test(code), notActive: /404|not_active|not_found/.test(code),
          surfaceExists: Boolean(surface), objectIsPdf: object?.type === "pdf-presentation", objectDocumentMatches: object?.state?.documentId === expected };
      }, documentId).catch(() => ({ unavailable: true }));
      const server = meetingRequest(() => input.request.get(`${input.origin}${path}/documents/${documentId}/presentation`, {
        headers: { authorization: `Bearer ${guest.issued.token}` }, timeout: 5000
      })).then(async response => {
        const result = { status: response.status(), bytes: Number(response.headers()["content-length"] ?? 0) }; await response.dispose(); return result;
      }, () => ({ unavailable: true }));
      try {
        const facts = await Promise.all([Promise.race([client, new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: true }), 5000); })]), server, readMeetingPerformance(guest.page)]);
        console.warn("presenter_pdf_not_ready", JSON.stringify({ requestedPage: page, client: facts[0], serverWithInitialProof: facts[1], performance: facts[2],
          initialProofExpired: Date.now() >= guest.admittedAt+guest.issued.expiresInSeconds*1000 }));
      } finally { if (timer) clearTimeout(timer); }
      throw error;
    }
  }
  let phase = "onboarding", failed = false;
  const rejoinedViews: Array<{ seconds: number; status: number; role?: string; access?: string; presenterSelf: boolean; reason?: string; ttl?: number }> = [];
  let rejoinedActor: MeetingPresenter | undefined, rejoinedToken: string | undefined;
  const startedAt = Date.now();
  const phases: Array<{ phase: string; seconds: number }> = [];
  const mark = (next: string) => { phase = next; phases.push({ phase, seconds: Math.round((Date.now() - startedAt) / 1000) }); };
  try {
    const host = await enter("host", 0), first = await enter("member", 1), second = await enter("member", 2), guest = await enter("guest", 3);
    await chooseMeetingPanel(host.page, "people", false);
    await expect(host.page.locator("#meeting-people-list li")).toHaveCount(4);
    await expect(host.page.locator("#meeting-people-list")).toContainText("Host — Meeting Host");
    await expect(host.page.locator("#meeting-people-list")).toContainText("Member — Alpha <b>literal</b>");
    await expect(host.page.locator("#meeting-people-list b")).toHaveCount(0);
    await expect(host.page.locator("#remote-mic-status")).toContainText(names[1]);
    for (const actor of [first, second, guest]) {
      await chooseMeetingPanel(actor.page, "present", actor === guest);
      await expect(actor.page.locator("#document-upload-button")).toBeDisabled();
      await expect(actor.page.locator("#start-share")).toBeDisabled();
    }
    for (const [index, actor] of [first, second].entries()) {
      mark(`grant-${index + 1}`);
      await host.page.locator("#host-participant-select").selectOption(actor.participantId);
      await expect(host.page.locator("#grant-presenter")).toBeEnabled({ timeout: 10_000 });
      const granted = host.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/presenters/${encodeURIComponent(actor.participantId)}/grant`);
      void granted.catch(() => undefined); await host.page.locator("#grant-presenter").click(); expect((await granted).status()).toBe(200);
      await expectRole(actor, "presenter");
      await expect(host.page.locator("#meeting-people-list")).toContainText(`Presenter — ${names[index + 1]}`);
      await expect(host.page.locator("#presenter-line")).toContainText(names[index + 1]);
      await expect(actor.page.locator("#document-upload-button")).toBeEnabled();
      mark(`own-pdf-${index + 1}`);
      const pdf = await PDFDocument.create();
      for (let number = 1; number <= 3; number++) {
        const page = pdf.addPage([640, 360]);
        page.drawRectangle({ x: 0, y: 0, width: 640, height: 360, color: index ? rgb(.1, .5, .2) : rgb(.15, .2, .7) });
        page.drawText(`Presenter ${index + 1}, own page ${number}`, { x: 40, y: 180, color: rgb(1, 1, 1), size: 24 });
      }
      const bytes = Buffer.from(await pdf.save());
      const oldProofUpload = { file: { name: "old-token-owned.pdf", mimeType: "application/pdf", buffer: bytes } };
      const positive = await post(`${input.origin}${path}/documents`, { headers: { authorization: `Bearer ${actor.issued.token}` }, multipart: oldProofUpload });
      expect(positive.status()).toBe(201); expect((await positive.json()).document.uploadedBy).toBe(actor.participantId);
      await actor.page.locator("#document-upload-input").setInputFiles({ name: `presenter-${index + 1}.pdf`, mimeType: "application/pdf", buffer: bytes });
      const uploaded = actor.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/documents`);
      void uploaded.catch(() => undefined); await actor.page.locator("#document-upload-button").click();
      const upload = await uploaded; expect(upload.status()).toBe(201); const document = (await upload.json()).document;
      expect(document.uploadedBy).toBe(actor.participantId);
      await expect(actor.page.locator("#document-select")).toHaveValue(document.documentId);
      await actor.page.locator("#document-surface-button").click(); await showPage(guest, document.documentId, 1);
      await actor.page.locator("#presentation-next").click(); await showPage(guest, document.documentId, 2);
      if (hooks.presenting) {
        // The RTC variant explicitly stops the PDF before starting capture.
        // The ordinary local/staging variant leaves it visible across revoke.
        await actor.page.locator("#presentation-stop").click();
        await expect.poll(() => guest.page.evaluate(() => (window as any).__VRATA_DEBUG__?.pdfPresentation?.documentId), { timeout: 20_000 }).toBeNull();
      }
      mark(`presenting-hook-${index + 1}`); await hooks.presenting?.(actor, index, roomId, guest);
      mark(`revoke-${index + 1}`);
      await host.page.locator("#host-participant-select").selectOption(actor.participantId);
      await expect(host.page.locator("#revoke-presenter")).toBeEnabled({ timeout: 10_000 });
      const revoked = host.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/presenters/${encodeURIComponent(actor.participantId)}/revoke`);
      void revoked.catch(() => undefined); await host.page.locator("#revoke-presenter").click(); expect((await revoked).status()).toBe(200);
      await expectRole(actor, "member"); await expect(actor.page.locator("#document-upload-button")).toBeDisabled();
      await expect(actor.page.locator("#start-share")).toBeDisabled();
      await expect(host.page.locator("#meeting-people-list")).not.toContainText(`Presenter — ${names[index + 1]}`);
      const denied = await post(`${input.origin}${path}/documents`, { headers: { authorization: `Bearer ${actor.issued.token}` },
        multipart: oldProofUpload });
      expect(denied.status()).toBe(403); expect((await denied.json()).reason).toBe("permission_denied");
      const deniedControl = await post(`${input.origin}${path}/documents/${document.documentId}/surface`, {
        headers: { authorization: `Bearer ${actor.issued.token}` }, data: { surfaceId: "debug-main" }
      });
      expect(deniedControl.status()).toBe(403); expect((await deniedControl.json()).permission).toBe("document.present");
      if (!hooks.presenting) {
        await showPage(guest, document.documentId, 2);
        await expect(actor.page.locator("#presentation-next")).toBeDisabled();
        await expect(actor.page.locator("#presentation-prev")).toBeDisabled();
        await chooseMeetingPanel(host.page, "present", false);
        await host.page.locator("#presentation-stop").click();
        await expect.poll(() => guest.page.evaluate(() => (window as any).__VRATA_DEBUG__?.pdfPresentation?.documentId), { timeout: 20_000 }).toBeNull();
        await chooseMeetingPanel(host.page, "people", false);
      }
      mark(`revoked-hook-${index + 1}`); await hooks.revoked?.(actor, index, roomId, guest);
    }
    mark("final-access");
    await expectRole(host, "host"); await expectRole(first, "member"); await expectRole(second, "member"); await expectRole(guest, "guest");
    for (const actor of [host, first, second, guest]) {
      expect(new URL(actor.page.url()).pathname).toBe(`/rooms/${roomId}`);
      await expect(actor.page.locator("#guest-onboarding")).toBeHidden();
      if (actor.issued.identityProtocolVersion === 2) expect(actor.prematureAdmissions()).toBe(0);
    }
    await expect(host.page.locator("#presenter-line")).toHaveText("Presenter: none");
    const visible = await host.page.locator("#meeting-people-list, #host-controls-status, #presenter-line, #remote-mic-status").allTextContents();
    expect(visible.some(text => [host, first, second, guest].some(actor => text.includes(actor.participantId) || text.includes(actor.participantId.slice(0, 8))))).toBe(false);
    mark("reconnect-member");
    rejoinedActor = first;
    first.page.on("response", async response => {
      if (new URL(response.url()).pathname !== `${path}/session-control`) return;
      const view = await response.json().catch(() => ({}));
      const role = (value: unknown) => ["guest", "member", "presenter", "host", "admin"].includes(String(value)) ? String(value) : undefined;
      rejoinedViews.push({ seconds: Math.round((Date.now() - startedAt) / 1000), status: response.status(), role: role(view.participant?.role), access: role(view.access?.role), presenterSelf: view.state?.presenterParticipantId === first.participantId,
        reason: ["expired_token", "participant_removed", "identity_recovery_required"].includes(view.reason ?? view.participant?.reason) ? view.reason ?? view.participant.reason : undefined,
        ttl: Number.isSafeInteger(view.expiresInSeconds) ? view.expiresInSeconds : undefined });
      if (rejoinedViews.length > 12) rejoinedViews.shift();
    });
    const readmission = first.page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    void readmission.catch(() => undefined);
    try { await first.page.reload(); } catch { throw new Error("presenter_meeting_reload_failed"); }
    await expect(first.page.locator("#guest-onboarding")).toBeVisible();
    await first.page.locator("#guest-name-input").fill(names[1]); await first.page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    const rejoined = await (await readmission).json(); rejoinedToken = rejoined.token; expect(rejoined.access.role).toBe("member");
    await expect.poll(() => first.page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
    expect(await first.page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId)).toBe(first.participantId);
    // WS can connect before the reloaded scene finishes synchronous material
    // setup. Do not spend a role-delivery deadline on that independent boot work.
    mark("reloaded-scene-ready");
    await first.page.waitForFunction(() => (window as any).__VRATA_DEBUG__?.sceneBundleState === "loaded", null, { timeout: 90_000, polling: 100 });
    await first.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    mark("reloaded-api-presence-ready");
    await expect.poll(async () => {
      const response = await meetingRequest(() => input.request.get(`${input.origin}${path}/presence`, { headers, timeout: 5000 }));
      expect(response.status()).toBe(200);
      return (await response.json()).items.some((person: { participantId: string }) => person.participantId === first.participantId);
    }, { timeout: 45_000 }).toBe(true);
    mark("regrant-after-reconnect");
    await host.page.locator("#host-participant-select").selectOption(first.participantId);
    await expect(host.page.locator("#grant-presenter")).toBeEnabled({ timeout: 10_000 });
    const regrantPath = `${path}/presenters/${encodeURIComponent(first.participantId)}/grant`;
    const regrantEvents: Array<{ event: string; seconds: number; status?: number }> = [];
    const observeRegrant = (event: string, status?: number) => regrantEvents.push({ event, seconds: Math.round((Date.now() - startedAt) / 1000), ...(status === undefined ? {} : { status }) });
    const onRegrantRequest = (request: BrowserRequest) => {
      const requestedPath = new URL(request.url()).pathname;
      if (request.method() === "POST" && requestedPath.startsWith(`${path}/presenters/`) && requestedPath.endsWith("/grant")) {
        observeRegrant(requestedPath === regrantPath ? "request-target" : "request-other-target");
      }
    };
    host.page.on("request", onRegrantRequest);
    const regranted = host.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === regrantPath, { timeout: 30_000 });
    void regranted.catch(() => undefined);
    const promotedView = nextSelfView(first, "presenter");
    let regrantResponse: BrowserResponse;
    try {
      observeRegrant("click-start"); await host.page.locator("#grant-presenter").click({ timeout: 15_000 }); observeRegrant("click-finished");
      regrantResponse = await regranted; observeRegrant("response", regrantResponse.status());
      console.info("presenter_regrant_transport", JSON.stringify({ events: regrantEvents }));
    } catch (error) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const facts = host.page.evaluate(expectedParticipant => {
        const debug = (window as any).__VRATA_DEBUG__, button = document.querySelector<HTMLButtonElement>("#grant-presenter");
        return { visibility: document.visibilityState, focused: document.hasFocus(), role: debug?.access?.role, connected: debug?.roomStateConnected,
          scene: debug?.sceneBundleState, issue: debug?.issueCode,
          grantDisabled: button?.disabled, grantVisible: Boolean(button?.getClientRects().length),
          selectedMatches: (document.querySelector<HTMLSelectElement>("#host-participant-select")?.value ?? "") === expectedParticipant,
          hostVisible: debug?.hostControls?.visible, ended: debug?.hostControls?.ended,
          dialogs: [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].map(dialog => dialog.id) };
      }, first.participantId).catch(() => ({ unavailable: true }));
      try {
        const hostFacts = await Promise.race([facts, new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: true }), 5000); })]);
        console.warn("presenter_regrant_transport_failed", JSON.stringify({ events: regrantEvents, host: hostFacts }));
      } finally { if (timer) clearTimeout(timer); }
      throw error;
    } finally { host.page.off("request", onRegrantRequest); }
    if (regrantResponse.status() !== 200) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const body = await Promise.race([regrantResponse.json().then(reply => ({ state: "ok", reply }), () => ({ state: "failed", reply: {} })),
          new Promise<{ state: string; reply: Record<string, unknown> }>(resolve => { timer = setTimeout(() => resolve({ state: "timeout", reply: {} }), 5000); })]);
        const reason = body.reply.reason ?? body.reply.error;
        console.warn("presenter_regrant_denied", JSON.stringify({ seconds: Math.round((Date.now() - startedAt) / 1000),
          status: regrantResponse.status(), bodyRead: body.state,
          reason: ["participant_not_found", "room_not_found", "host_controls_disabled", "permission_denied", "authority_conflict", "room_state_changed", "identity_required", "identity_session_expired", "identity_recovery_required"].includes(reason) ? reason : "other" }));
      } finally { if (timer) clearTimeout(timer); }
    }
    expect(regrantResponse.status()).toBe(200);
    try { await promotedView; await expectRole(first, "presenter"); }
    catch (error) {
      let server: unknown = { unavailable: true };
      try {
        const response = await input.request.get(`${input.origin}${path}/session-control`, { headers: { authorization: `Bearer ${rejoined.token}` } });
        const view = await response.json();
        server = { status: response.status(), role: ["guest", "member", "presenter", "host", "admin"].includes(view.participant?.role) ? view.participant.role : "other",
          presenterSelf: view.state?.presenterParticipantId === first.participantId, accessPresent: Boolean(view.access) };
      } catch { /* No transport error with credentials enters the diagnostic. */ }
      console.warn("presenter_rejoined_view_failed", JSON.stringify({ history: rejoinedViews, server }));
      throw error;
    }
    mark("remove-active-presenter");
    await host.page.locator("#host-participant-select").selectOption(first.participantId);
    await expect(host.page.locator("#remove-participant")).toBeEnabled({ timeout: 10_000 });
    const removed = host.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/participants/${encodeURIComponent(first.participantId)}/remove`);
    const blockedView = nextSelfView(first, "blocked");
    const terminalState = first.page.waitForFunction(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return ["participant_removed", "identity_recovery_required"].includes(debug?.hostControls?.lastReason) && debug.roomStateConnected === false;
    }, null, { timeout: 60_000, polling: 100 });
    void terminalState.catch(() => undefined);
    void removed.catch(() => undefined); await host.page.locator("#remove-participant").click(); expect((await removed).status()).toBe(200);
    // WS recovery can legitimately terminate polling before another self GET.
    await Promise.race([blockedView, terminalState]);
    const removedReason = first.issued.identityProtocolVersion === 2 ? "identity_recovery_required" : "participant_removed";
    await expect.poll(() => first.page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return { reason: debug?.hostControls?.lastReason, connected: debug?.roomStateConnected,
        shareDisabled: document.querySelector<HTMLButtonElement>("#start-share")?.disabled };
    }), { timeout: 20_000 }).toEqual({ reason: removedReason, connected: false, shareDisabled: true });
    await expect(host.page.locator("#presenter-line")).toHaveText("Presenter: none");
    const deniedAfterRemove = await post(`${input.origin}/api/tokens/media`, { headers: { authorization: `Bearer ${first.issued.token}` },
      data: { roomId, participantId: first.participantId, canPublishAudio: true, canPublishVideo: true } });
    expect(deniedAfterRemove.status()).toBe(first.issued.identityProtocolVersion === 2 ? 409 : 403);
    expect((await deniedAfterRemove.json()).reason).toBe(removedReason);
  } catch (error) {
    failed = true;
    await hooks.failed?.(phase, roomId).catch(() => undefined);
    let rejoinedState: unknown;
    if (rejoinedActor && rejoinedToken) {
      try {
        const response = await input.request.get(`${input.origin}${path}/session-control`, { headers: { authorization: `Bearer ${rejoinedToken}` } });
        const view = await response.json();
        rejoinedState = { server: { status: response.status(), role: view.participant?.role, blocked: view.participant?.status === "blocked",
          presenterSelf: view.state?.presenterParticipantId === rejoinedActor.participantId },
          browser: await rejoinedActor.page.evaluate(() => ({ visibility: document.visibilityState, role: (window as any).__VRATA_DEBUG__?.access?.role,
            polling: (window as any).__VRATA_DEBUG__?.hostControls?.polling })) };
      } catch { rejoinedState = { unavailable: true }; }
    }
    console.warn("presenter_meeting_failed", JSON.stringify({ phase, seconds: Math.round((Date.now() - startedAt) / 1000), phases,
      rejoinedViews, rejoinedState }));
    throw error;
  }
  finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    try {
      let removed;
      try { removed = await input.request.delete(`${input.origin}${path}`, { headers }); } catch { throw new Error("presenter_meeting_cleanup_failed"); }
      expect(removed.ok()).toBe(true);
    }
    catch (error) { if (!failed) throw error; console.warn("presenter_meeting_cleanup_unconfirmed"); }
  }
}
