import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalLiveKitFixture } from "./local-livekit-fixture";

test("an installed native LiveKit fixture rejects a binary outside the pinned checksum before starting", async () => {
  const previous = process.env.VRATA_TEST_LIVEKIT_BINARIES_DIR;
  const directory = await mkdtemp(join(tmpdir(), "vrata-invalid-native-"));
  try {
    await writeFile(join(directory, "livekit-server-1.13.9"), "not the pinned native server");
    process.env.VRATA_TEST_LIVEKIT_BINARIES_DIR = directory;
    await expect(startLocalLiveKitFixture("1.13.9")).rejects.toThrow("local_livekit_fixture_failed:checksum");
  } finally {
    if (previous === undefined) delete process.env.VRATA_TEST_LIVEKIT_BINARIES_DIR;
    else process.env.VRATA_TEST_LIVEKIT_BINARIES_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
