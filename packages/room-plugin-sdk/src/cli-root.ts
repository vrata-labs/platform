import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { checkLocalPath, RoomPluginCliError } from "./cli-io.js";

function assertInside(root: string, path: string): void {
  const value = relative(root, path);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new RoomPluginCliError("source_outside_root", 3);
  }
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (error instanceof RoomPluginCliError) throw error;
    throw new RoomPluginCliError("io_error", 4);
  }
}

export async function roomPluginProjectRoot(explicit?: string): Promise<string> {
  if (explicit !== undefined) checkLocalPath(explicit);
  const root = await canonical(resolve(explicit ?? process.cwd()));
  try {
    if (!(await stat(root)).isDirectory()) throw new RoomPluginCliError("root_not_directory", 4);
  } catch (error) {
    if (error instanceof RoomPluginCliError) throw error;
    throw new RoomPluginCliError("io_error", 4);
  }
  // A filesystem-wide root must be an explicit CLI choice, never an accidental cwd.
  if (explicit === undefined && root === parse(root).root) throw new RoomPluginCliError("explicit_root_required", 2);
  return root;
}

/** Canonicalization occurs before any source bytes are read, including the entry. */
export async function roomPluginSourcePath(root: string, path: string): Promise<string> {
  checkLocalPath(path);
  const source = await canonical(resolve(path));
  assertInside(root, source);
  return source;
}

/** Reject lexical traversal and escaping symlink ancestors before default resolver/glob work. */
async function checkImportTarget(root: string, path: string): Promise<void> {
  let candidate = resolve(path);
  assertInside(root, candidate);
  while (true) {
    try {
      assertInside(root, await realpath(candidate));
      return;
    } catch (error) {
      if (error instanceof RoomPluginCliError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new RoomPluginCliError("io_error", 4);
      const parent = dirname(candidate);
      if (parent === candidate) throw new RoomPluginCliError("io_error", 4);
      candidate = parent;
      assertInside(root, candidate);
    }
  }
}

/** Only named candidate directories on the importer-to-root chain; no directory traversal/search. */
export async function checkRoomPluginImport(root: string, importerDirectory: string, specifier: string): Promise<{ packageName: string; directory: string } | undefined> {
  const directory = resolve(importerDirectory);
  assertInside(root, directory);
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    await checkImportTarget(root, resolve(directory, specifier));
    return;
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name || name === ".." || name === "." || name.startsWith("@") && parts.length < 2) {
    throw new RoomPluginCliError("dependency_not_local", 3);
  }
  let current = directory;
  while (true) {
    const candidate = join(current, "node_modules", name);
    try {
      const directory = await realpath(candidate);
      assertInside(root, directory);
      return { packageName: name, directory };
    } catch (error) {
      if (error instanceof RoomPluginCliError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new RoomPluginCliError("io_error", 4);
    }
    if (current === root) throw new RoomPluginCliError("dependency_not_local", 3);
    current = dirname(current);
    assertInside(root, current);
  }
}
