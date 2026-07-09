import { expect, test, type Page } from "@playwright/test";

type MarkdownBoardDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string };
  markdownBoard?: {
    active?: boolean;
    noteCount?: number;
    revision?: number;
    localCanEdit?: boolean;
    notes?: Array<{ noteId?: string; text?: string; x?: number; y?: number }>;
  };
  mediaObjects?: {
    surfaces?: Array<{
      surfaceId?: string;
      activeObjectId?: string | null;
      activeObjectType?: string | null;
    }>;
  };
};

function roomUrl(roomId: string, role: "guest" | "member" | "host") {
  const params = new URLSearchParams("debug=1");
  if (role !== "guest") {
    params.set("role", role);
  }
  return `/rooms/${roomId}?${params.toString()}`;
}

async function readDebug(page: Page): Promise<MarkdownBoardDebug | undefined> {
  return page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: MarkdownBoardDebug }).__VRATA_DEBUG__);
}

async function waitForKernel(page: Page, role: "guest" | "member" | "host") {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null,
      hasSurface: debug?.mediaObjects?.surfaces?.some((surface) => surface.surfaceId === "debug-main") ?? false
    };
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    connected: true,
    role,
    hasSurface: true
  });
}

async function waitForMarkdownBoard(page: Page, noteCount: number) {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
    return {
      activeObjectType: surface?.activeObjectType ?? null,
      active: debug?.markdownBoard?.active ?? false,
      noteCount: debug?.markdownBoard?.noteCount ?? null
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    activeObjectType: "markdown-board",
    active: true,
    noteCount
  });
}

async function createStickyNote(page: Page, text: string, x = 0.18, y = 0.22) {
  const sent = await page.evaluate((input) => (window as Window & {
    __VRATA_TEST__?: { createStickyNote: (value?: { text?: string; x?: number; y?: number }) => boolean };
  }).__VRATA_TEST__?.createStickyNote(input) ?? false, { text, x, y });
  expect(sent).toBe(true);
}

async function updateStickyNote(page: Page, noteId: string, text: string) {
  const sent = await page.evaluate((input) => (window as Window & {
    __VRATA_TEST__?: { updateStickyNote: (noteId?: string, text?: string) => boolean };
  }).__VRATA_TEST__?.updateStickyNote(input.noteId, input.text) ?? false, { noteId, text });
  expect(sent).toBe(true);
}

async function moveStickyNote(page: Page, noteId: string, x: number, y: number) {
  const sent = await page.evaluate((input) => (window as Window & {
    __VRATA_TEST__?: { moveStickyNote: (noteId?: string, x?: number, y?: number) => boolean };
  }).__VRATA_TEST__?.moveStickyNote(input.noteId, input.x, input.y) ?? false, { noteId, x, y });
  expect(sent).toBe(true);
}

async function deleteStickyNote(page: Page, noteId: string) {
  const sent = await page.evaluate((input) => (window as Window & {
    __VRATA_TEST__?: { deleteStickyNote: (noteId?: string) => boolean };
  }).__VRATA_TEST__?.deleteStickyNote(input.noteId) ?? false, { noteId });
  expect(sent).toBe(true);
}

test("M1.6 markdown sticky board syncs notes, movement, reload and safe rendering", async ({ browser }) => {
  test.setTimeout(90000);
  const roomId = `m1-markdown-board-${Date.now()}`;
  const host = await browser.newPage();
  const member = await browser.newPage();
  const guest = await browser.newPage();
  try {
    await host.goto(roomUrl(roomId, "host"));
    await member.goto(roomUrl(roomId, "member"));
    await guest.goto(roomUrl(roomId, "guest"));
    await waitForKernel(host, "host");
    await waitForKernel(member, "member");
    await waitForKernel(guest, "guest");

    await expect(host.locator("#start-markdown-board")).toBeVisible();
    await expect(host.locator("#start-markdown-board")).toBeEnabled();
    await host.click("#start-markdown-board");
    await waitForMarkdownBoard(guest, 0);
    await expect(member.locator("#add-sticky-note")).toBeEnabled();
    await expect(guest.locator("#add-sticky-note")).toBeDisabled();

    const unsafeMarkdown = "# Launch plan\n- synced card\n<script>window.__markdownBoardXss = true</script>";
    await createStickyNote(member, unsafeMarkdown);
    await waitForMarkdownBoard(host, 1);
    await waitForMarkdownBoard(guest, 1);

    const noteId = await host.evaluate(() => {
      const debug = (window as Window & { __VRATA_DEBUG__?: MarkdownBoardDebug }).__VRATA_DEBUG__;
      return debug?.markdownBoard?.notes?.[0]?.noteId ?? null;
    });
    expect(noteId).toBeTruthy();
    const stickyNoteId = noteId as string;

    await moveStickyNote(member, stickyNoteId, 0.62, 0.44);
    await expect.poll(async () => {
      const note = (await readDebug(host))?.markdownBoard?.notes?.[0];
      return { x: note?.x ?? null, y: note?.y ?? null };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({ x: 0.62, y: 0.44 });

    await updateStickyNote(member, stickyNoteId, "## Updated\n- safe markdown");
    await expect.poll(async () => (await readDebug(guest))?.markdownBoard?.notes?.[0]?.text ?? null, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe("## Updated\n- safe markdown");

    await guest.reload();
    await waitForKernel(guest, "guest");
    await waitForMarkdownBoard(guest, 1);
    await expect.poll(async () => guest.evaluate(() => (window as Window & { __markdownBoardXss?: boolean }).__markdownBoardXss ?? false)).toBe(false);

    const guestEditSent = await guest.evaluate(() => (window as Window & {
      __VRATA_TEST__?: { createStickyNote: (value?: { text?: string }) => boolean };
    }).__VRATA_TEST__?.createStickyNote({ text: "guest edit" }) ?? false);
    expect(guestEditSent).toBe(false);

    await deleteStickyNote(member, stickyNoteId);
    await waitForMarkdownBoard(host, 0);
    await waitForMarkdownBoard(guest, 0);
  } finally {
    await host.close();
    await member.close();
    await guest.close();
  }
});
