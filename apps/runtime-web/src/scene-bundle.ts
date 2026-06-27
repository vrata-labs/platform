export interface SceneBundleSpawnPoint {
  id: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
}

export interface SceneBundleSeatAnchor {
  id: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
  yaw: number;
  seatHeight: number;
  radius: number;
  label?: string;
}

export interface SceneBundleAttribution {
  title: string;
  author: string;
  source: string;
  license: string;
  authorUrl?: string;
  licenseUrl?: string;
  changes?: string;
}

export interface SceneBundleManifest {
  schemaVersion: 1;
  sceneId: string;
  label: string;
  source: string;
  glbPath: string;
  renderMode?: "default" | "clean";
  spawnPoints: SceneBundleSpawnPoint[];
  anchors?: {
    teleportFloorY?: number;
    seatAnchors: SceneBundleSeatAnchor[];
  };
  materialOverrides?: Array<{
    match: string;
    mapPath?: string;
    color?: {
      r: number;
      g: number;
      b: number;
    };
  }>;
  bounds?: {
    width: number;
    height: number;
    depth: number;
  };
  preview?: string;
  attributions?: SceneBundleAttribution[];
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

function assertHttpUrl(value: unknown, errorCode: string): string {
  const url = assertString(value, errorCode);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(errorCode);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(errorCode);
  }
  return url;
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

function parseSeatAnchor(input: unknown, index: number): SceneBundleSeatAnchor {
  const payload = assertObject(input, `invalid_scene_bundle_seat_anchor:${index}`);
  const position = assertObject(payload.position, `invalid_scene_bundle_seat_anchor_position:${index}`);
  if (!isFiniteNumber(position.x) || !isFiniteNumber(position.y) || !isFiniteNumber(position.z)) {
    throw new Error(`invalid_scene_bundle_seat_anchor_position:${index}`);
  }
  if (!isFiniteNumber(payload.yaw)) {
    throw new Error(`invalid_scene_bundle_seat_anchor_yaw:${index}`);
  }
  if (!isFiniteNumber(payload.seatHeight)) {
    throw new Error(`invalid_scene_bundle_seat_anchor_height:${index}`);
  }
  const radius = payload.radius === undefined
    ? 0.4
    : isFiniteNumber(payload.radius)
      ? payload.radius
      : Number.NaN;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`invalid_scene_bundle_seat_anchor_radius:${index}`);
  }

  return {
    id: assertString(payload.id, `invalid_scene_bundle_seat_anchor_id:${index}`),
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    },
    yaw: payload.yaw,
    seatHeight: payload.seatHeight,
    radius,
    label: payload.label === undefined ? undefined : assertString(payload.label, `invalid_scene_bundle_seat_anchor_label:${index}`)
  };
}

function parseAttribution(input: unknown, index: number): SceneBundleAttribution {
  const payload = assertObject(input, `invalid_scene_bundle_attribution:${index}`);
  const parsed: SceneBundleAttribution = {
    title: assertString(payload.title, `invalid_scene_bundle_attribution_title:${index}`),
    author: assertString(payload.author, `invalid_scene_bundle_attribution_author:${index}`),
    source: assertHttpUrl(payload.source, `invalid_scene_bundle_attribution_source:${index}`),
    license: assertString(payload.license, `invalid_scene_bundle_attribution_license:${index}`)
  };

  if (payload.authorUrl !== undefined) {
    parsed.authorUrl = assertHttpUrl(payload.authorUrl, `invalid_scene_bundle_attribution_author_url:${index}`);
  }
  if (payload.licenseUrl !== undefined) {
    parsed.licenseUrl = assertHttpUrl(payload.licenseUrl, `invalid_scene_bundle_attribution_license_url:${index}`);
  }
  if (payload.changes !== undefined) {
    parsed.changes = assertString(payload.changes, `invalid_scene_bundle_attribution_changes:${index}`);
  }

  return parsed;
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

  if (payload.renderMode !== undefined) {
    if (payload.renderMode !== "default" && payload.renderMode !== "clean") {
      throw new Error("invalid_scene_bundle_render_mode");
    }
    manifest.renderMode = payload.renderMode;
  }

  if (payload.anchors !== undefined) {
    const anchors = assertObject(payload.anchors, "invalid_scene_bundle_anchors");
    const seatAnchorsRaw = anchors.seatAnchors;
    if (seatAnchorsRaw !== undefined && !Array.isArray(seatAnchorsRaw)) {
      throw new Error("invalid_scene_bundle_seat_anchors");
    }
    const parsedAnchors: NonNullable<SceneBundleManifest["anchors"]> = {
      seatAnchors: Array.isArray(seatAnchorsRaw) ? seatAnchorsRaw.map((entry, index) => parseSeatAnchor(entry, index)) : []
    };
    if (anchors.teleportFloorY !== undefined) {
      if (!isFiniteNumber(anchors.teleportFloorY)) {
        throw new Error("invalid_scene_bundle_teleport_floor_y");
      }
      parsedAnchors.teleportFloorY = anchors.teleportFloorY;
    }
    manifest.anchors = parsedAnchors;
  }

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

  if (payload.materialOverrides !== undefined) {
    if (!Array.isArray(payload.materialOverrides)) {
      throw new Error("invalid_scene_bundle_material_overrides");
    }
    manifest.materialOverrides = payload.materialOverrides.map((entry, index) => {
      const override = assertObject(entry, `invalid_scene_bundle_material_override:${index}`);
      const parsed: NonNullable<SceneBundleManifest["materialOverrides"]>[number] = {
        match: assertString(override.match, `invalid_scene_bundle_material_override_match:${index}`)
      };
      if (override.mapPath !== undefined) {
        parsed.mapPath = assertString(override.mapPath, `invalid_scene_bundle_material_override_map:${index}`);
      }
      if (override.color !== undefined) {
        const color = assertObject(override.color, `invalid_scene_bundle_material_override_color:${index}`);
        if (!isFiniteNumber(color.r) || !isFiniteNumber(color.g) || !isFiniteNumber(color.b)) {
          throw new Error(`invalid_scene_bundle_material_override_color:${index}`);
        }
        parsed.color = {
          r: color.r,
          g: color.g,
          b: color.b
        };
      }
      return parsed;
    });
  }

  if (payload.preview !== undefined) {
    manifest.preview = assertString(payload.preview, "invalid_scene_bundle_preview");
  }
  if (payload.attributions !== undefined) {
    if (!Array.isArray(payload.attributions)) {
      throw new Error("invalid_scene_bundle_attributions");
    }
    manifest.attributions = payload.attributions.map((entry, index) => parseAttribution(entry, index));
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
