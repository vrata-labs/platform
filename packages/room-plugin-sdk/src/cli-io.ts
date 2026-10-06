import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

export class RoomPluginCliError extends Error {
  constructor(readonly code: string, readonly exitCode: 2 | 3 | 4 | 5) {
    super(code);
    this.name = "RoomPluginCliError";
  }
}

export function checkLocalPath(path: string): void {
  if (!path || path.includes("\0") || (!isAbsolute(path) && /^[a-z][a-z0-9+.-]*:/i.test(path))) {
    throw new RoomPluginCliError("local_path_required", 2);
  }
}

/** Regular local files only; size is bounded both before allocation and while reading. */
export async function readRoomPluginFile(path: string, maximum: number, sizeCode: string): Promise<Uint8Array> {
  checkLocalPath(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RoomPluginCliError("input_not_regular", 4);
    if (stat.size > maximum) throw new RoomPluginCliError(sizeCode, 3);
    const parts: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(parts, total);
      total += bytesRead;
      if (total > maximum) throw new RoomPluginCliError(sizeCode, 3);
      parts.push(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    if (error instanceof RoomPluginCliError) throw error;
    throw new RoomPluginCliError("io_error", 4);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function decodeRoomPluginFile(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new RoomPluginCliError("invalid_utf8", 3); }
}

/** Explicit output only. Validation finishes first; failures never truncate an existing file. */
export async function writeRoomPluginFile(path: string, bytes: Uint8Array): Promise<void> {
  checkLocalPath(path);
  const temporary = join(dirname(path), `.vrata-plugin-${randomUUID()}.tmp`);
  let handle;
  let temporaryOwned = false;
  try {
    let target;
    try { target = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (target && !target.isFile()) throw new RoomPluginCliError("output_not_regular", 4);
    handle = await open(temporary, "wx", 0o600);
    temporaryOwned = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    temporaryOwned = false;
  } catch (error) {
    if (error instanceof RoomPluginCliError) throw error;
    throw new RoomPluginCliError("io_error", 4);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryOwned) await unlink(temporary).catch(() => {});
  }
}
