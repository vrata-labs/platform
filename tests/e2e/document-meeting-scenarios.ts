import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import { createHash, randomUUID } from "node:crypto";
import { chooseMeetingPanel } from "./meeting-tools-acceptance";

type Admission = { token: string; participantId?: string; access: { role: string } };
type DocumentRecord = { documentId: string; filename: string; downloadUrl: string; uploadedBy: string; checksum: string; metadata: { pageCount: number } };
type Input = { browser: Browser; request: APIRequestContext; origin: string; adminToken: string; mobile: boolean; storageFault?: (action: () => Promise<void>) => Promise<void> };

export async function createDocumentMeeting(input: Input) {
  const contexts: BrowserContext[] = [];
  const headers = { "x-vrata-admin-token": input.adminToken };
  const response = await input.request.post(`${input.origin}/api/rooms`, { headers, data: {
    tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned document acceptance", visibility: "private"
  } });
  expect(response.status()).toBe(201); const room = await response.json();
  const path = `/api/rooms/${room.roomId}/documents`;
  async function invite(role: "host" | "guest" | "member") {
    const response = await input.request.post(`${input.origin}/api/rooms/${room.roomId}/invites`, { headers, data: { role, expiresInSeconds: 1200 } });
    expect(response.status()).toBe(201);
    const result = await response.json() as { inviteLink: string };
    const inviteToken = new URL(result.inviteLink).searchParams.get("invite"); expect(!!inviteToken).toBe(true);
    return { inviteLink: result.inviteLink, inviteToken: inviteToken! };
  }
  async function enter(role: "host" | "guest" | "member", invitation?: Awaited<ReturnType<typeof invite>>) {
    const issuedInvite = invitation ?? await invite(role);
    // Functional drawing buffers, not a product quality override: desktop uses
    // 800×500@0.4 = 320×200; mobile keeps its real 390×844 CSS layout.
    const context = await input.browser.newContext({ viewport: input.mobile ? { width: 390, height: 844 } : { width: 800, height: 500 },
      deviceScaleFactor: 0.4, hasTouch: input.mobile, isMobile: input.mobile });
    contexts.push(context); const page = await context.newPage();
    await page.addInitScript(() => {
      const original = URL.createObjectURL.bind(URL); (window as any).__documentTextObjectUrls = 0;
      URL.createObjectURL = value => {
        if (value instanceof Blob && value.type === "text/plain") (window as any).__documentTextObjectUrls++;
        return original(value);
      };
    });
    const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    void admission.catch(() => undefined);
    const initialLibrary = role === "guest" ? null : page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === path);
    void initialLibrary?.catch(() => undefined);
    try { await page.goto(issuedInvite.inviteLink); } catch { throw new Error("document_meeting_navigation_failed"); }
    await expect(page.locator("#guest-onboarding")).toBeVisible();
    await page.locator("#guest-name-input").fill(`Document ${role}`);
    await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    const issued = await (await admission).json() as Admission;
    expect(issued.access.role).toBe(role);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
    const participantId = await page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId) as string;
    return { page, context, issued, participantId, invitation: issuedInvite, initialLibrary };
  }
  async function close() {
    await Promise.all(contexts.map(context => context.close()));
    expect((await input.request.delete(`${input.origin}/api/rooms/${room.roomId}`, { headers })).ok()).toBe(true);
  }
  return { ...input, roomId: room.roomId as string, path, headers, invite, enter, close };
}

type Meeting = Awaited<ReturnType<typeof createDocumentMeeting>>;
async function ownPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (const [index, color] of [rgb(.85, .12, .12), rgb(.12, .65, .2), rgb(.12, .2, .85)].entries()) {
    const page = pdf.addPage([640, 360]); page.drawRectangle({ x: 0, y: 0, width: 640, height: 360, color });
    page.drawText(`Own document: page ${index + 1}`, { x: 40, y: 180, size: 24, color: rgb(1, 1, 1) });
  }
  return Buffer.from(await pdf.save());
}
async function upload(page: Page, path: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.locator("#document-upload-input").setInputFiles(file);
  const response = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path);
  void response.catch(() => undefined); await page.locator("#document-upload-button").click(); return response;
}

export async function documentPolicyScenario(meeting: Meeting) {
  const host = await meeting.enter("host"), page = host.page;
  await chooseMeetingPanel(page, "present", meeting.mobile);
  await expect(page.locator("#document-upload-button")).toBeEnabled();
  const library = await meeting.request.get(`${meeting.origin}${meeting.path}`, { headers: { authorization: `Bearer ${host.issued.token}` } });
  expect(library.status()).toBe(200);
  const policy = (await library.json()).uploadPolicy;
  expect(Number.isSafeInteger(policy.maxFileBytes) && policy.maxFileBytes > 0 && policy.maxFileBytes <= 128 * 1024 * 1024).toBe(true);
  await expect(page.locator("#document-upload-policy")).toContainText(`${policy.maxFileBytes.toLocaleString("en-US")} bytes`);
  await expect(page.locator("#document-upload-policy")).toContainText(`up to ${policy.maxPdfPages} pages`);
  await expect(page.locator("#document-upload-input")).toHaveAttribute("aria-describedby", "document-upload-policy");
  let postRequests = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === meeting.path) postRequests++; });
  for (const [file, code] of [
    [{ name: "unsupported.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("unsupported") }, "unsupported_document_mime"],
    [{ name: "too-large.txt", mimeType: "text/plain", buffer: Buffer.alloc(policy.maxFileBytes + 1, 120) }, "document_too_large"]
  ] as const) {
    const before = postRequests; await page.locator("#document-upload-input").setInputFiles(file); await page.locator("#document-upload-button").click();
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.documents?.errorCode)).toBe(code);
    expect(postRequests).toBe(before); await expect(page.locator("#document-operation-progress")).toBeHidden();
  }
  const corrupt = await upload(page, meeting.path, { name: "corrupt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nbroken") });
  expect(corrupt.status()).toBe(422); expect((await corrupt.json()).error).toBe("corrupt_pdf");
  await expect(page.locator("#document-status")).toContainText("This PDF cannot be read");
  const bytes = await ownPdf(); expect(bytes.length).toBeLessThanOrEqual(policy.maxFileBytes);
  let release!: () => void, seen!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { seen = resolve; });
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); seen(); await hold; await route.fulfill({ response });
  };
  await page.route(`**${meeting.path}`, handler);
  let document: DocumentRecord;
  try {
    await page.locator("#document-upload-input").setInputFiles({ name: "own-document.pdf", mimeType: "application/pdf", buffer: bytes });
    const response = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === meeting.path);
    void response.catch(() => undefined);
    await page.locator("#document-upload-button").click(); await received;
    await expect(page.locator("#document-operation-progress")).toBeVisible();
    await expect(page.locator("#documents-panel")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#document-upload-button")).toBeDisabled();
    release(); const uploaded = await response; expect(uploaded.status()).toBe(201); document = (await uploaded.json()).document;
  } finally { release(); await page.unroute(`**${meeting.path}`, handler); }
  expect(document!).toMatchObject({ uploadedBy: host.participantId, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, metadata: { pageCount: 3 } });
  await expect(page.locator("#document-select")).toHaveValue(document!.documentId);
  await expect(page.locator("#document-operation-progress")).toBeHidden();
  const download = page.waitForEvent("download"); await page.locator("#document-download-button").click();
  const saved = await download; const stream = await saved.createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  await expect(page.locator("#document-status")).toContainText("Document downloaded");
  if (meeting.storageFault) await meeting.storageFault(async () => {
    const failure = await upload(page, meeting.path, { name: "storage-failure.txt", mimeType: "text/plain", buffer: Buffer.from("owned storage fault") });
    expect(failure.status()).toBe(503); expect((await failure.json()).error).toBe("document_storage_unavailable");
    await expect(page.locator("#document-status")).toContainText("Document storage is unavailable");
  });
  await page.locator("#document-refresh-button").click();
  await expect(page.locator("#document-select option")).toHaveCount(1);
  await expect(page.locator("#document-select")).toHaveValue(document!.documentId);
}

async function expectPage(page: Page, documentId: string, number: number) {
  await expect.poll(() => page.evaluate(({ documentId, number }) => {
    const debug = (window as any).__VRATA_DEBUG__, pdf = debug?.pdfPresentation;
    return pdf?.documentId === documentId && pdf?.page === number && pdf?.pageCount === 3 && pdf?.renderState === "ready"
      && debug?.mediaObjects?.surfaces?.some((surface: any) => surface.surfaceId === "debug-main" && typeof surface.textureId === "number");
  }, { documentId, number }), { timeout: 45_000 }).toBe(true);
}

export async function documentMobilePresentationScenario(meeting: Meeting) {
  const host = await meeting.enter("host"), guest = await meeting.enter("guest");
  await chooseMeetingPanel(host.page, "present", true);
  const bytes = await ownPdf(), response = await upload(host.page, meeting.path, { name: "mobile-own-slides.pdf", mimeType: "application/pdf", buffer: bytes });
  expect(response.status()).toBe(201); const document = (await response.json()).document as DocumentRecord;
  expect(document.uploadedBy).toBe(host.participantId);
  await expect(host.page.locator("#document-surface-button")).toBeEnabled(); await host.page.locator("#document-surface-button").click();
  await expectPage(host.page, document.documentId, 1); await expectPage(guest.page, document.documentId, 1);
  for (const number of [2, 3]) {
    await host.page.locator("#presentation-next").click();
    await expectPage(host.page, document.documentId, number); await expectPage(guest.page, document.documentId, number);
  }
  const readmission = guest.page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
  void readmission.catch(() => undefined);
  await guest.page.reload();
  await expect(guest.page.locator("#guest-onboarding")).toBeVisible();
  await guest.page.locator("#guest-name-input").fill("Document guest");
  await guest.page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  expect((await (await readmission).json()).access.role).toBe("guest");
  await expectPage(guest.page, document.documentId, 3);
  expect(await guest.page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId)).toBe(guest.participantId);
  await guest.context.close();
  const late = await meeting.enter("guest"); expect(late.participantId).not.toBe(guest.participantId);
  await expectPage(late.page, document.documentId, 3);
  await chooseMeetingPanel(late.page, "present", true);
  await expect(late.page.locator("#document-upload-button")).toBeDisabled();
  const denied = await meeting.request.get(`${meeting.origin}${document.downloadUrl}`, { headers: { authorization: `Bearer ${late.issued.token}` } });
  expect(denied.status()).toBe(403);
}

export async function documentDelayedResponseScenario(meeting: Meeting) {
  const diagnostic: { phase: string; page?: Page } = { phase: "admission" };
  try { await runDelayedResponseScenario(meeting, diagnostic); }
  catch (error) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let state: unknown = { observationUnavailable: true };
    try {
      if (diagnostic.page && !diagnostic.page.isClosed()) state = await Promise.race([
        diagnostic.page.evaluate(() => {
          const debug = (window as any).__VRATA_DEBUG__, permissions = debug?.access?.permissions;
          return { role: ["guest", "member", "presenter", "host", "admin"].includes(debug?.access?.role) ? debug.access.role : "unknown",
            canUpload: Array.isArray(permissions) && permissions.includes("document.upload"), canDelete: Array.isArray(permissions) && permissions.includes("document.delete"),
            libraryCount: document.querySelector("#document-select")?.children.length,
            selectHasDocument: Boolean(document.querySelector<HTMLSelectElement>("#document-select")?.value),
            busy: document.querySelector("#documents-panel")?.getAttribute("aria-busy") === "true",
            progressHidden: document.querySelector<HTMLProgressElement>("#document-operation-progress")?.hidden,
            textObjectUrls: (window as any).__documentTextObjectUrls };
        }).catch(() => ({ observationUnavailable: true })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ observationUnavailable: true }), 2000); })
      ]);
    } finally { clearTimeout(timer); }
    // Fixed phase names and bounded state only: no tokens, URLs or request bodies.
    console.warn("document_authority_scenario_failed", JSON.stringify({ phase: diagnostic.phase, state }));
    throw error;
  }
}

async function runDelayedResponseScenario(meeting: Meeting, diagnostic: { phase: string; page?: Page }) {
  const host = await meeting.enter("host"), page = host.page;
  diagnostic.page = page; diagnostic.phase = "initial-library";
  const initialLibrary = await host.initialLibrary!; expect(initialLibrary.status()).toBe(200); await initialLibrary.finished();
  await chooseMeetingPanel(page, "present", false);
  await expect(page.locator("#documents-panel")).toHaveAttribute("aria-busy", "false");
  diagnostic.phase = "own-uploads";
  const documents: DocumentRecord[] = [];
  for (const name of ["first.txt", "second.txt"]) {
    const response = await upload(page, meeting.path, { name, mimeType: "text/plain", buffer: Buffer.from(name) });
    expect(response.status()).toBe(201); const uploaded = (await response.json()).document as DocumentRecord;
    documents.push(uploaded);
    await expect(page.locator("#document-select")).toHaveValue(uploaded.documentId);
  }
  await expect(page.locator("#document-select")).toHaveValue(documents[1].documentId);
  await expect(page.locator("#document-operation-progress")).toBeHidden();
  diagnostic.phase = "peer-admission";
  const peerInvite = await meeting.invite("member"), peerId = randomUUID();
  const admitPeer = async () => {
    const response = await meeting.request.post(`${meeting.origin}/api/tokens/state`, { data: { roomId: meeting.roomId, participantId: peerId,
      displayName: "Document peer", inviteToken: peerInvite.inviteToken } }); expect(response.status()).toBe(200);
    const admission = await response.json() as Admission;
    expect((await meeting.request.put(`${meeting.origin}/api/rooms/${meeting.roomId}/presence/${peerId}`, {
      headers: { authorization: `Bearer ${admission.token}` }, data: { participantId: peerId, displayName: "Document peer", mode: "desktop",
        rootTransform: { x: 2, y: 0, z: 2, yaw: 0 }, bodyTransform: { x: 2, y: .92, z: 2, yaw: 0 },
        headTransform: { x: 2, y: 1.6, z: 2, yaw: 0, pitch: 0 }, audioJoined: false, muted: true, speaking: false,
        activeMedia: { audio: false, screenShare: false }, seq: 1, clientTimeMs: Date.now() }
    })).status()).toBe(200);
    return admission;
  };
  await admitPeer();
  const actor = { authorization: `Bearer ${host.issued.token}` };
  let release!: () => void, seen!: () => void, settle!: () => void, heldStatus = 0;
  let hold = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { seen = resolve; });
  let settled = new Promise<void>(resolve => { settle = resolve; });
  const handler = async (route: Route) => {
    try {
      const response = await route.fetch(); heldStatus = response.status(); seen(); await hold;
      try { await route.fulfill({ response }); } catch { /* The operation's abort can retire this already accepted response. */ }
    } catch { heldStatus = -1; seen(); }
    finally { settle(); }
  };
  await page.locator("#document-select").selectOption(documents[0].documentId);
  const deleteUrl = `${meeting.path}/${documents[0].documentId}`;
  await page.route(`**${deleteUrl}`, handler);
  try {
    diagnostic.phase = "hold-successful-delete";
    await page.locator("#document-delete-button").click(); await received; expect(heldStatus).toBe(200);
    await page.locator("#document-select").selectOption(documents[1].documentId);
    const libraryRefresh = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === meeting.path);
    void libraryRefresh.catch(() => undefined);
    diagnostic.phase = "transfer-host-retain-presenter";
    expect((await meeting.request.post(`${meeting.origin}/api/rooms/${meeting.roomId}/presenters/${host.participantId}/grant`, { headers: actor })).status()).toBe(200);
    expect((await meeting.request.post(`${meeting.origin}/api/rooms/${meeting.roomId}/host/transfer`, { headers: actor, data: { participantId: peerId } })).status()).toBe(200);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 20_000 }).toBe("presenter");
    diagnostic.phase = "authoritative-library-refresh";
    const refreshed = await libraryRefresh; expect(refreshed.status()).toBe(200);
    expect((await refreshed.json()).items).toHaveLength(1); await refreshed.finished();
    await expect(page.locator("#document-select option")).toHaveCount(1);
    await expect(page.locator("#document-delete-button")).toBeDisabled(); await expect(page.locator("#document-upload-button")).toBeEnabled();
    await expect(page.locator("#document-select")).toHaveValue(documents[1].documentId);
    release(); await settled;
    await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    await expect(page.locator("#document-status")).not.toContainText("Document deleted:");
  } finally { release(); await page.unroute(`**${deleteUrl}`, handler); }
  diagnostic.phase = "restore-host";
  const peer = await admitPeer(); expect(peer.access.role).toBe("host");
  expect((await meeting.request.post(`${meeting.origin}/api/rooms/${meeting.roomId}/host/transfer`, {
    headers: { authorization: `Bearer ${peer.token}` }, data: { participantId: host.participantId }
  })).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 20_000 }).toBe("host");
  diagnostic.phase = "positive-text-download";
  const positiveDownload = page.waitForEvent("download");
  await page.locator("#document-download-button").click();
  const positiveStream = await (await positiveDownload).createReadStream();
  const positiveChunks: Buffer[] = []; for await (const chunk of positiveStream!) positiveChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(positiveChunks).toString("utf8")).toBe("second.txt");
  await expect(page.locator("#document-download-button")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__documentTextObjectUrls)).toBeGreaterThan(0);
  let downloads = 0; page.on("download", () => { downloads++; });
  const objectUrlsBefore = await page.evaluate(() => (window as any).__documentTextObjectUrls);
  hold = new Promise<void>(resolve => { release = resolve; }); received = new Promise<void>(resolve => { seen = resolve; });
  settled = new Promise<void>(resolve => { settle = resolve; }); heldStatus = 0;
  const downloadUrl = `${meeting.path}/${documents[1].documentId}/download`;
  await page.route(`**${downloadUrl}`, handler);
  try {
    diagnostic.phase = "hold-successful-download";
    await page.locator("#document-download-button").click(); await received; expect(heldStatus).toBe(200);
    await expect(page.locator("#document-operation-progress")).toBeVisible();
    diagnostic.phase = "end-session";
    await chooseMeetingPanel(page, "people", false); await page.locator("#end-session").click();
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.issueCode), { timeout: 20_000 }).toBe("room_access_denied");
    release(); await settled;
    await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    diagnostic.phase = "retired-response-effects";
    await expect(page.locator("#documents-panel")).toBeHidden(); expect(downloads).toBe(0);
    expect(await page.evaluate(() => (window as any).__documentTextObjectUrls)).toBe(objectUrlsBefore);
  } finally { release(); await page.unroute(`**${downloadUrl}`, handler); }
}
