export interface RoomTemplateAssetLockIssue {
  path: string;
  code: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("%") || value.includes("?") || value.includes("#")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return value.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
}

function isRepositorySlug(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 2
    && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..");
}

function validateFileLock(file: unknown, path: string, issues: RoomTemplateAssetLockIssue[]): Record<string, unknown> | null {
  if (!isRecord(file)) {
    issues.push({ path, code: "invalid_template_asset_file_lock" });
    return null;
  }
  if (typeof file.path !== "string" || !isSafeRelativePath(file.path)) issues.push({ path: `${path}.path`, code: "invalid_template_asset_path" });
  if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) issues.push({ path: `${path}.sha256`, code: "invalid_template_asset_sha256" });
  if (typeof file.sizeBytes !== "number" || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) issues.push({ path: `${path}.sizeBytes`, code: "invalid_template_asset_size" });
  return file;
}

export function validateRoomTemplateAssetLock(lock: unknown): RoomTemplateAssetLockIssue[] {
  const issues: RoomTemplateAssetLockIssue[] = [];
  if (!isRecord(lock)) {
    return [{ path: "assetLock", code: "invalid_template_asset_lock" }];
  }
  if (!isRepositorySlug(lock.repository)) {
    issues.push({ path: "repository", code: "invalid_template_asset_repository" });
  }
  if (typeof lock.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(lock.commitSha)) {
    issues.push({ path: "commitSha", code: "invalid_template_asset_commit_sha" });
  }

  const releaseMatch = typeof lock.sceneReleaseId === "string"
    ? lock.sceneReleaseId.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)@(\d+\.\d+\.\d+)$/)
    : null;
  if (!releaseMatch) {
    issues.push({ path: "sceneReleaseId", code: "invalid_template_scene_release_id" });
  }

  const files = [
    ["releaseManifest", lock.releaseManifest],
    ["sceneManifest", lock.sceneManifest],
    ["sceneAsset", lock.sceneAsset],
    ["preview", lock.preview]
  ] as const;
  const validatedFiles = new Map<string, Record<string, unknown>>();
  for (const [path, file] of files) {
    const validated = validateFileLock(file, path, issues);
    if (validated) validatedFiles.set(path, validated);
  }

  const paths = Array.from(validatedFiles.values(), (file) => file.path).filter((path): path is string => typeof path === "string");
  if (new Set(paths).size !== paths.length) {
    issues.push({ path: "files", code: "duplicate_template_asset_path" });
  }
  const releaseManifestPath = validatedFiles.get("releaseManifest")?.path;
  const sceneManifestPath = validatedFiles.get("sceneManifest")?.path;
  const sceneAssetPath = validatedFiles.get("sceneAsset")?.path;
  const previewPath = validatedFiles.get("preview")?.path;
  if (releaseManifestPath !== "manifest.json") {
    issues.push({ path: "releaseManifest.path", code: "invalid_template_release_manifest_path" });
  }

  if (releaseMatch) {
    const [, sceneId, version] = releaseMatch;
    const releaseRoot = `assets/scenes/${sceneId}/${version}`;
    if (sceneManifestPath !== `${releaseRoot}/scene.json`) {
      issues.push({ path: "sceneManifest.path", code: "template_scene_manifest_path_mismatch" });
    }
    if (sceneAssetPath !== `${releaseRoot}/scene.glb`) {
      issues.push({ path: "sceneAsset.path", code: "template_scene_asset_path_mismatch" });
    }
    if (typeof previewPath !== "string" || !new RegExp(`^${releaseRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/preview\\.(?:jpe?g|png|webp)$`).test(previewPath)) {
      issues.push({ path: "preview.path", code: "template_scene_preview_path_mismatch" });
    }
  }

  return issues;
}

export function resolveRoomTemplateAssetUrl(baseUrl: string, relativePath: string, options: { allowLoopbackHttp?: boolean } = {}): string {
  if (typeof relativePath !== "string" || !isSafeRelativePath(relativePath)) throw new Error("invalid_template_asset_path");
  if (typeof baseUrl !== "string") throw new Error("invalid_template_asset_base_url");
  if (/[\u0000-\u0020\u007f]/.test(baseUrl) || baseUrl.includes("\\") || baseUrl.includes("%")
    || /\/(?:\.{1,2})(?:\/|$|[?#])/.test(baseUrl)) {
    throw new Error("invalid_template_asset_base_url");
  }
  let base: URL;
  try {
    base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new Error("invalid_template_asset_base_url");
  }
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(options.allowLoopbackHttp && loopback && base.protocol === "http:")) {
    throw new Error("invalid_template_asset_base_url");
  }
  if (base.username || base.password || base.search || base.hash || base.pathname.includes("%")) throw new Error("invalid_template_asset_base_url");

  const resolved = new URL(relativePath, base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new Error("invalid_template_asset_path");
  }
  return resolved.toString();
}
