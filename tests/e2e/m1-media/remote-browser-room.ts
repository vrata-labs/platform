import { expect, type Page } from "@playwright/test";

type BrowserRoomDebug = {
  roomStateConnected?: boolean;
  participantId?: string;
  access?: { role?: string };
  remoteBrowser?: {
    status?: string;
    currentUrl?: string;
    mediaTrackSid?: string;
    audioTrackSid?: string;
    externalVideoTrackSid?: string;
  };
  mediaObjects?: {
    surfaces?: Array<{ surfaceId: string; activeObjectId?: string; activeObjectType?: string }>;
  };
};

export function readBrowserRoom(page: Page): Promise<BrowserRoomDebug | undefined> {
  return page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: BrowserRoomDebug }).__VRATA_DEBUG__);
}

export async function enterBrowserRoom(page: Page, entryUrl: string, name: string) {
  // A grant or invite in the URL is a credential.
  try {
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
  } catch {
    throw new Error("remote_browser_room_entry_navigation_failed");
  }
  await page.locator("#guest-name-input").fill(name);
  await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  await expect.poll(async () => (await readBrowserRoom(page))?.roomStateConnected, { timeout: 45_000 }).toBe(true);
}

export async function openBrowserAddress(page: Page, url: string) {
  await expect(page.locator("#open-remote-browser")).toBeEnabled({ timeout: 20_000 });
  await page.locator("#remote-browser-url").fill(url);
  await page.locator("#open-remote-browser").click();
}

export async function waitForBrowserObject(page: Page, url: string, videoTrackPrefix?: string) {
  await expect.poll(async () => {
    const object = (await readBrowserRoom(page))?.remoteBrowser;
    return {
      status: object?.status,
      url: object?.currentUrl,
      video: !!object?.mediaTrackSid && (!videoTrackPrefix || object.mediaTrackSid.startsWith(videoTrackPrefix)),
      audio: !!object?.audioTrackSid
    };
  }, { timeout: 30_000 }).toEqual({ status: "active", url, video: true, audio: true });
}
