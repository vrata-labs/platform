import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export type SceneBundleValidationSeverity = "error" | "warning";
export type SceneBundleInputType = "directory" | "manifest-file" | "zip";

export interface SceneBundleValidationIssue {
  severity: SceneBundleValidationSeverity;
  path: string;
  code: string;
  message: string;
}

export interface SceneBundleValidationOptions {
  maxMainAssetBytes?: number;
  maxBundleBytes?: number;
}

export interface SceneBundleValidationStats {
  fileCount: number;
  bundleBytes: number;
  mainAssetBytes?: number;
}

export interface SceneBundleValidationResult {
  ok: boolean;
  inputPath: string;
  inputType: SceneBundleInputType | "unknown";
  manifestPath: string | null;
  issues: SceneBundleValidationIssue[];
  stats: SceneBundleValidationStats;
}

export interface SceneBundleReferenceValidationInput {
  storageKey?: string;
  publicUrl?: string;
  provider?: string;
}

const defaultMaxMainAssetBytes = 40 * 1024 * 1024;
const defaultMaxBundleBytes = 50 * 1024 * 1024;
const supportedSceneAssetExtensions = new Set([".glb", ".gltf", ".fbx"]);
const supportedPreviewExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function issue(severity: SceneBundleValidationSeverity, path: string, code: string, message: string): SceneBundleValidationIssue {
  return { severity, path, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeSceneBundleRelativePath(value: string): string | null {
  if (!isNonEmptyString(value)) return null;
  if (value.includes("\\")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.startsWith("/")) return null;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function validateSceneBundleReference(input: SceneBundleReferenceValidationInput): SceneBundleValidationIssue[] {
  const issues: SceneBundleValidationIssue[] = [];
  const storageKey = input.storageKey ?? "";
  const normalizedStorageKey = normalizeSceneBundleRelativePath(storageKey);
  if (!normalizedStorageKey) {
    issues.push(issue("error", "storageKey", "invalid_scene_bundle_storage_key", "storageKey must be a non-empty relative path without URL schemes, absolute roots, backslashes, or '..' segments."));
  } else if (basename(normalizedStorageKey) !== "scene.json") {
    issues.push(issue("error", "storageKey", "invalid_scene_bundle_manifest_key", "storageKey must point to a scene.json manifest."));
  }

  if (input.provider && input.provider !== "minio-default" && input.provider !== "s3-compatible") {
    issues.push(issue("error", "provider", "invalid_scene_bundle_provider", "provider must be minio-default or s3-compatible."));
  }

  if (input.publicUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(input.publicUrl);
    } catch {
      issues.push(issue("error", "publicUrl", "invalid_scene_bundle_public_url", "publicUrl must be a valid HTTP(S) URL."));
    }
    if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push(issue("error", "publicUrl", "invalid_scene_bundle_public_url", "publicUrl must use http or https."));
    }
    if (parsed && basename(parsed.pathname) !== "scene.json") {
      issues.push(issue("error", "publicUrl", "invalid_scene_bundle_manifest_url", "publicUrl must point to a scene.json manifest."));
    }
  }

  return issues;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, current = root): Promise<Array<{ path: string; sizeBytes: number }>> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: Array<{ path: string; sizeBytes: number }> = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(absolutePath);
    files.push({ path: relative(root, absolutePath).split(sep).join("/"), sizeBytes: info.size });
  }
  return files;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const signature = 0x06054b50;
  const earliestOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= earliestOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  return -1;
}

function parseZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error("invalid_zip_archive");
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralDirectoryOffset) !== 0x02014b50) {
      throw new Error("invalid_zip_central_directory");
    }
    const compressionMethod = buffer.readUInt16LE(centralDirectoryOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralDirectoryOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(centralDirectoryOffset + 24);
    const fileNameLength = buffer.readUInt16LE(centralDirectoryOffset + 28);
    const extraLength = buffer.readUInt16LE(centralDirectoryOffset + 30);
    const commentLength = buffer.readUInt16LE(centralDirectoryOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralDirectoryOffset + 42);
    const name = buffer.subarray(centralDirectoryOffset + 46, centralDirectoryOffset + 46 + fileNameLength).toString("utf8");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("unsupported_zip64_archive");
    }
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    centralDirectoryOffset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    throw new Error("invalid_zip_local_header");
  }
  const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) {
    return compressedData;
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressedData);
  }
  throw new Error(`unsupported_zip_compression:${entry.compressionMethod}`);
}

export async function extractSceneBundleZipToTemp(zipPath: string): Promise<{ root: string; files: string[] }> {
  const buffer = await readFile(zipPath);
  const entries = parseZipEntries(buffer);
  const root = await mkdtemp(join(tmpdir(), "vrata-scene-bundle-zip-"));
  const files: string[] = [];
  try {
    for (const entry of entries) {
      if (entry.name.endsWith("/")) continue;
      const normalizedPath = normalizeSceneBundleRelativePath(entry.name);
      if (!normalizedPath) {
        throw new Error(`unsafe_zip_entry:${entry.name}`);
      }
      const content = readZipEntry(buffer, entry);
      if (content.byteLength !== entry.uncompressedSize) {
        throw new Error(`invalid_zip_entry_size:${entry.name}`);
      }
      const absolutePath = join(root, normalizedPath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
      files.push(normalizedPath);
    }
    return { root, files };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function pushRequiredStringIssue(issues: SceneBundleValidationIssue[], manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key];
  if (!isNonEmptyString(value)) {
    issues.push(issue("error", `scene.json#/${key}`, `invalid_scene_bundle_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${key} must be a non-empty string.`));
    return null;
  }
  return value;
}

function validatePosition(issues: SceneBundleValidationIssue[], value: unknown, path: string): boolean {
  if (!isRecord(value)) {
    issues.push(issue("error", path, "invalid_scene_bundle_position", "position must be an object with finite x, y, and z numbers."));
    return false;
  }
  const invalidAxes = ["x", "y", "z"].filter((axis) => !isFiniteNumber(value[axis]));
  for (const axis of invalidAxes) {
    issues.push(issue("error", `${path}/${axis}`, "invalid_scene_bundle_position", `${axis} must be a finite number.`));
  }
  return invalidAxes.length === 0;
}

function validateManifestShape(input: unknown, issues: SceneBundleValidationIssue[]): { glbPath: string | null; preview: string | null; materialMapPaths: string[] } {
  if (!isRecord(input)) {
    issues.push(issue("error", "scene.json", "invalid_scene_bundle_manifest", "scene.json must contain a JSON object."));
    return { glbPath: null, preview: null, materialMapPaths: [] };
  }

  if (input.schemaVersion !== 1) {
    issues.push(issue("error", "scene.json#/schemaVersion", "unsupported_scene_bundle_schema", "schemaVersion must equal 1."));
  }

  const sceneId = pushRequiredStringIssue(issues, input, "sceneId");
  if (sceneId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sceneId)) {
    issues.push(issue("error", "scene.json#/sceneId", "invalid_scene_bundle_scene_id", "sceneId must be a lower-kebab identifier."));
  }
  pushRequiredStringIssue(issues, input, "label");
  const source = pushRequiredStringIssue(issues, input, "source");
  if (source && (/^[/\\]/.test(source) || /^[a-z]:[\\/]/i.test(source))) {
    issues.push(issue("error", "scene.json#/source", "unsafe_scene_bundle_source", "source must not be a local absolute path."));
  }

  const glbPath = pushRequiredStringIssue(issues, input, "glbPath");
  const normalizedGlbPath = glbPath ? normalizeSceneBundleRelativePath(glbPath) : null;
  if (glbPath && !normalizedGlbPath) {
    issues.push(issue("error", "scene.json#/glbPath", "unsafe_scene_bundle_asset_path", "glbPath must be a relative bundle path without URL schemes, absolute roots, backslashes, or '..' segments."));
  } else if (normalizedGlbPath && !supportedSceneAssetExtensions.has(extname(normalizedGlbPath).toLowerCase())) {
    issues.push(issue("error", "scene.json#/glbPath", "unsupported_scene_bundle_asset_extension", "glbPath must point to .glb, .gltf, or legacy .fbx."));
  } else if (normalizedGlbPath && extname(normalizedGlbPath).toLowerCase() !== ".glb") {
    issues.push(issue("warning", "scene.json#/glbPath", "non_glb_scene_asset", "Production scene bundles should use .glb; .gltf/.fbx remain runtime-compatible legacy formats."));
  }

  if (!Array.isArray(input.spawnPoints) || input.spawnPoints.length === 0) {
    issues.push(issue("error", "scene.json#/spawnPoints", "invalid_scene_bundle_spawn_points", "spawnPoints must be a non-empty array."));
  } else {
    input.spawnPoints.forEach((spawnPoint, index) => {
      const path = `scene.json#/spawnPoints/${index}`;
      if (!isRecord(spawnPoint)) {
        issues.push(issue("error", path, "invalid_scene_bundle_spawn_point", "spawn point must be an object."));
        return;
      }
      if (!isNonEmptyString(spawnPoint.id)) {
        issues.push(issue("error", `${path}/id`, "invalid_scene_bundle_spawn_id", "spawn point id must be a non-empty string."));
      }
      validatePosition(issues, spawnPoint.position, `${path}/position`);
    });
    const firstSpawn = input.spawnPoints[0];
    if (isRecord(firstSpawn) && firstSpawn.id !== "main") {
      issues.push(issue("warning", "scene.json#/spawnPoints/0/id", "non_main_first_spawn_point", "The first spawn point should be id=main for product scenes."));
    }
  }

  if (input.renderMode !== undefined && input.renderMode !== "default" && input.renderMode !== "clean") {
    issues.push(issue("error", "scene.json#/renderMode", "invalid_scene_bundle_render_mode", "renderMode must be default or clean."));
  }

  if (input.bounds !== undefined) {
    if (!isRecord(input.bounds)) {
      issues.push(issue("error", "scene.json#/bounds", "invalid_scene_bundle_bounds", "bounds must be an object with positive width, height, and depth numbers."));
    } else {
      for (const axis of ["width", "height", "depth"]) {
        if (!isFiniteNumber(input.bounds[axis]) || input.bounds[axis] <= 0) {
          issues.push(issue("error", `scene.json#/bounds/${axis}`, "invalid_scene_bundle_bounds", `${axis} must be a positive finite number.`));
        }
      }
    }
  }

  let preview: string | null = null;
  if (input.preview !== undefined) {
    if (!isNonEmptyString(input.preview)) {
      issues.push(issue("error", "scene.json#/preview", "invalid_scene_bundle_preview", "preview must be a non-empty relative path when provided."));
    } else {
      preview = normalizeSceneBundleRelativePath(input.preview);
      if (!preview) {
        issues.push(issue("error", "scene.json#/preview", "unsafe_scene_bundle_preview_path", "preview must be a relative bundle path without URL schemes, absolute roots, backslashes, or '..' segments."));
      } else if (!supportedPreviewExtensions.has(extname(preview).toLowerCase())) {
        issues.push(issue("error", "scene.json#/preview", "unsupported_scene_bundle_preview_extension", "preview must point to .jpg, .jpeg, .png, or .webp."));
      }
    }
  }

  const materialMapPaths: string[] = [];
  if (input.materialOverrides !== undefined) {
    if (!Array.isArray(input.materialOverrides)) {
      issues.push(issue("error", "scene.json#/materialOverrides", "invalid_scene_bundle_material_overrides", "materialOverrides must be an array when provided."));
    } else {
      input.materialOverrides.forEach((entry, index) => {
        const path = `scene.json#/materialOverrides/${index}`;
        if (!isRecord(entry)) {
          issues.push(issue("error", path, "invalid_scene_bundle_material_override", "material override must be an object."));
          return;
        }
        if (!isNonEmptyString(entry.match)) {
          issues.push(issue("error", `${path}/match`, "invalid_scene_bundle_material_override_match", "material override match must be a non-empty string."));
        }
        if (entry.mapPath !== undefined) {
          if (!isNonEmptyString(entry.mapPath)) {
            issues.push(issue("error", `${path}/mapPath`, "invalid_scene_bundle_material_override_map", "mapPath must be a non-empty relative path when provided."));
          } else {
            const normalizedMapPath = normalizeSceneBundleRelativePath(entry.mapPath);
            if (!normalizedMapPath) {
              issues.push(issue("error", `${path}/mapPath`, "unsafe_scene_bundle_material_map_path", "mapPath must be a relative bundle path without URL schemes, absolute roots, backslashes, or '..' segments."));
            } else {
              materialMapPaths.push(normalizedMapPath);
            }
          }
        }
      });
    }
  }

  if (input.anchors !== undefined) {
    if (!isRecord(input.anchors)) {
      issues.push(issue("error", "scene.json#/anchors", "invalid_scene_bundle_anchors", "anchors must be an object when provided."));
    } else {
      if (input.anchors.teleportFloorY !== undefined && !isFiniteNumber(input.anchors.teleportFloorY)) {
        issues.push(issue("error", "scene.json#/anchors/teleportFloorY", "invalid_scene_bundle_teleport_floor_y", "teleportFloorY must be a finite number."));
      }
      if (input.anchors.seatAnchors !== undefined) {
        if (!Array.isArray(input.anchors.seatAnchors)) {
          issues.push(issue("error", "scene.json#/anchors/seatAnchors", "invalid_scene_bundle_seat_anchors", "seatAnchors must be an array when provided."));
        } else {
          input.anchors.seatAnchors.forEach((seatAnchor, index) => {
            const path = `scene.json#/anchors/seatAnchors/${index}`;
            if (!isRecord(seatAnchor)) {
              issues.push(issue("error", path, "invalid_scene_bundle_seat_anchor", "seat anchor must be an object."));
              return;
            }
            if (!isNonEmptyString(seatAnchor.id)) {
              issues.push(issue("error", `${path}/id`, "invalid_scene_bundle_seat_anchor_id", "seat anchor id must be a non-empty string."));
            }
            validatePosition(issues, seatAnchor.position, `${path}/position`);
            if (!isFiniteNumber(seatAnchor.yaw)) {
              issues.push(issue("error", `${path}/yaw`, "invalid_scene_bundle_seat_anchor_yaw", "yaw must be a finite number."));
            }
            if (!isFiniteNumber(seatAnchor.seatHeight)) {
              issues.push(issue("error", `${path}/seatHeight`, "invalid_scene_bundle_seat_anchor_height", "seatHeight must be a finite number."));
            }
            if (seatAnchor.radius !== undefined && (!isFiniteNumber(seatAnchor.radius) || seatAnchor.radius <= 0)) {
              issues.push(issue("error", `${path}/radius`, "invalid_scene_bundle_seat_anchor_radius", "radius must be a positive finite number."));
            }
          });
        }
      }
    }
  }

  return { glbPath: normalizedGlbPath, preview, materialMapPaths };
}

export async function validateSceneBundlePath(inputPath: string, options: SceneBundleValidationOptions = {}): Promise<SceneBundleValidationResult> {
  const issues: SceneBundleValidationIssue[] = [];
  const resolvedInputPath = resolve(inputPath);
  let inputType: SceneBundleInputType | "unknown" = "unknown";
  let bundleRoot = resolvedInputPath;
  let manifestPath = join(resolvedInputPath, "scene.json");

  try {
    const inputInfo = await stat(resolvedInputPath);
    if (inputInfo.isDirectory()) {
      inputType = "directory";
    } else if (inputInfo.isFile() && basename(resolvedInputPath) === "scene.json") {
      inputType = "manifest-file";
      bundleRoot = dirname(resolvedInputPath);
      manifestPath = resolvedInputPath;
    } else if (inputInfo.isFile() && extname(resolvedInputPath).toLowerCase() === ".zip") {
      inputType = "zip";
    } else {
      issues.push(issue("error", inputPath, "unsupported_scene_bundle_input", "Input must be a scene bundle directory, a scene.json file, or a .zip archive."));
    }
  } catch {
    issues.push(issue("error", inputPath, "scene_bundle_input_not_found", "Input path does not exist."));
  }

  if (issues.some((entry) => entry.severity === "error")) {
    return {
      ok: false,
      inputPath,
      inputType,
      manifestPath: null,
      issues,
      stats: { fileCount: 0, bundleBytes: 0 }
    };
  }

  if (inputType === "zip") {
    let extracted: { root: string; files: string[] } | null = null;
    try {
      extracted = await extractSceneBundleZipToTemp(resolvedInputPath);
      const rootManifestExists = extracted.files.includes("scene.json");
      const sceneJsonFiles = extracted.files.filter((filePath) => basename(filePath) === "scene.json");
      if (!rootManifestExists && sceneJsonFiles.length > 1) {
        return {
          ok: false,
          inputPath,
          inputType: "zip",
          manifestPath: null,
          issues: [issue("error", inputPath, "multiple_scene_json_files", "Zip archives must contain scene.json at the archive root or exactly one scene.json file.")],
          stats: { fileCount: extracted.files.length, bundleBytes: extracted.files.reduce((total) => total, 0) }
        };
      }
      const nestedManifestPath = rootManifestExists ? extracted.root : join(extracted.root, sceneJsonFiles[0] ?? "scene.json");
      const result = await validateSceneBundlePath(nestedManifestPath, options);
      const relativeManifestPath = result.manifestPath ? relative(extracted.root, result.manifestPath).split(sep).join("/") : null;
      return {
        ...result,
        inputPath,
        inputType: "zip",
        manifestPath: relativeManifestPath ? `${inputPath}!/${relativeManifestPath}` : null
      };
    } catch (error) {
      return {
        ok: false,
        inputPath,
        inputType: "zip",
        manifestPath: null,
        issues: [issue("error", inputPath, "invalid_scene_bundle_zip", error instanceof Error ? error.message : "Zip archive could not be read.")],
        stats: { fileCount: 0, bundleBytes: 0 }
      };
    } finally {
      if (extracted) {
        await rm(extracted.root, { recursive: true, force: true });
      }
    }
  }

  const files = await listFiles(bundleRoot);
  const stats: SceneBundleValidationStats = {
    fileCount: files.length,
    bundleBytes: files.reduce((total, file) => total + file.sizeBytes, 0)
  };
  if (stats.bundleBytes > (options.maxBundleBytes ?? defaultMaxBundleBytes)) {
    issues.push(issue("error", bundleRoot, "scene_bundle_too_large", `Bundle is ${stats.bundleBytes} bytes, over the ${options.maxBundleBytes ?? defaultMaxBundleBytes} byte limit.`));
  }

  if (!await exists(manifestPath)) {
    issues.push(issue("error", "scene.json", "missing_scene_json", "Bundle must contain scene.json at its root."));
    return { ok: false, inputPath, inputType, manifestPath, issues, stats };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    issues.push(issue("error", "scene.json", "invalid_scene_json", `scene.json must be valid JSON: ${message}`));
    return { ok: false, inputPath, inputType, manifestPath, issues, stats };
  }

  const references = validateManifestShape(manifest, issues);
  const pathsToCheck = [
    references.glbPath ? { path: references.glbPath, code: "missing_scene_asset", message: "glbPath points to a missing scene asset." } : null,
    references.preview ? { path: references.preview, code: "missing_scene_preview", message: "preview points to a missing file." } : null,
    ...references.materialMapPaths.map((mapPath) => ({ path: mapPath, code: "missing_scene_material_map", message: "material override mapPath points to a missing file." }))
  ].filter((entry): entry is { path: string; code: string; message: string } => Boolean(entry));

  for (const reference of pathsToCheck) {
    const absolutePath = join(bundleRoot, reference.path);
    if (!absolutePath.startsWith(`${bundleRoot}${sep}`) && absolutePath !== bundleRoot) {
      issues.push(issue("error", reference.path, "unsafe_scene_bundle_asset_path", "Referenced asset path escapes the bundle root."));
      continue;
    }
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        issues.push(issue("error", reference.path, reference.code, reference.message));
        continue;
      }
      if (reference.path === references.glbPath) {
        stats.mainAssetBytes = info.size;
        if (info.size > (options.maxMainAssetBytes ?? defaultMaxMainAssetBytes)) {
          issues.push(issue("error", reference.path, "scene_asset_too_large", `Scene asset is ${info.size} bytes, over the ${options.maxMainAssetBytes ?? defaultMaxMainAssetBytes} byte limit.`));
        }
      }
    } catch {
      issues.push(issue("error", reference.path, reference.code, reference.message));
    }
  }

  return {
    ok: issues.every((entry) => entry.severity !== "error"),
    inputPath,
    inputType,
    manifestPath,
    issues,
    stats
  };
}
