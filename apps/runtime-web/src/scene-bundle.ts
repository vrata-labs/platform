export interface SceneBundleSpawnPoint {
  id: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
}

export interface SceneBundleManifest {
  schemaVersion: 1;
  sceneId: string;
  label: string;
  source: string;
  glbPath: string;
  spawnPoints: SceneBundleSpawnPoint[];
  bounds?: {
    width: number;
    height: number;
    depth: number;
  };
  preview?: string;
  notes?: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertObject(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(errorCode);
  }
  return value;
}

function parseSpawnPoint(input: unknown, index: number): SceneBundleSpawnPoint {
  const payload = assertObject(input, `invalid_scene_bundle_spawn_point:${index}`);
  const position = assertObject(payload.position, `invalid_scene_bundle_spawn_position:${index}`);
  if (!isFiniteNumber(position.x) || !isFiniteNumber(position.y) || !isFiniteNumber(position.z)) {
    throw new Error(`invalid_scene_bundle_spawn_position:${index}`);
  }

  return {
    id: assertString(payload.id, `invalid_scene_bundle_spawn_id:${index}`),
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    }
  };
}

export function parseSceneBundleManifest(input: unknown): SceneBundleManifest {
  const payload = assertObject(input, "invalid_scene_bundle_manifest");
  if (payload.schemaVersion !== 1) {
    throw new Error(`unsupported_scene_bundle_schema:${String(payload.schemaVersion ?? "unknown")}`);
  }

  const spawnPointsRaw = payload.spawnPoints;
  if (!Array.isArray(spawnPointsRaw)) {
    throw new Error("invalid_scene_bundle_spawn_points");
  }

  const manifest: SceneBundleManifest = {
    schemaVersion: 1,
    sceneId: assertString(payload.sceneId, "invalid_scene_bundle_scene_id"),
    label: assertString(payload.label, "invalid_scene_bundle_label"),
    source: assertString(payload.source, "invalid_scene_bundle_source"),
    glbPath: assertString(payload.glbPath, "invalid_scene_bundle_glb_path"),
    spawnPoints: spawnPointsRaw.map((entry, index) => parseSpawnPoint(entry, index))
  };

  if (payload.bounds !== undefined) {
    const bounds = assertObject(payload.bounds, "invalid_scene_bundle_bounds");
    if (!isFiniteNumber(bounds.width) || !isFiniteNumber(bounds.height) || !isFiniteNumber(bounds.depth)) {
      throw new Error("invalid_scene_bundle_bounds");
    }
    manifest.bounds = {
      width: bounds.width,
      height: bounds.height,
      depth: bounds.depth
    };
  }

  if (payload.preview !== undefined) {
    manifest.preview = assertString(payload.preview, "invalid_scene_bundle_preview");
  }
  if (payload.notes !== undefined) {
    manifest.notes = assertString(payload.notes, "invalid_scene_bundle_notes");
  }

  return manifest;
}

export function resolveSceneAssetUrl(bundleUrl: string, assetPath: string): string {
  return new URL(assetPath, bundleUrl).toString();
}

export function pickSceneSpawnPoint(manifest: SceneBundleManifest): SceneBundleSpawnPoint | null {
  return manifest.spawnPoints[0] ?? null;
}
