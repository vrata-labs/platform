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

export interface SceneBundleMediaSurface {
  surfaceId: string;
  label?: string;
  kind?: "wall" | "table" | "laptop" | "floating" | "custom";
  widthM: number;
  heightM: number;
  widthPx?: number;
  heightPx?: number;
  transform: {
    x: number;
    y: number;
    z: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
  };
  visible?: boolean;
  allowedObjectTypes?: string[];
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
  mediaSurfaces?: SceneBundleMediaSurface[];
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

function parseOptionalBoolean(value: unknown, errorCode: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(errorCode);
  }
  return value;
}

function parsePositiveNumber(value: unknown, errorCode: string): number {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new Error(errorCode);
  }
  return value;
}

function parseMediaSurface(input: unknown, index: number): SceneBundleMediaSurface {
  const payload = assertObject(input, `invalid_scene_bundle_media_surface:${index}`);
  const transform = assertObject(payload.transform, `invalid_scene_bundle_media_surface_transform:${index}`);
  if (!isFiniteNumber(transform.x) || !isFiniteNumber(transform.y) || !isFiniteNumber(transform.z)) {
    throw new Error(`invalid_scene_bundle_media_surface_transform:${index}`);
  }
  const parsed: SceneBundleMediaSurface = {
    surfaceId: assertString(payload.surfaceId, `invalid_scene_bundle_media_surface_id:${index}`),
    widthM: parsePositiveNumber(payload.widthM, `invalid_scene_bundle_media_surface_width_m:${index}`),
    heightM: parsePositiveNumber(payload.heightM, `invalid_scene_bundle_media_surface_height_m:${index}`),
    transform: {
      x: transform.x,
      y: transform.y,
      z: transform.z
    }
  };

  if (payload.label !== undefined) {
    parsed.label = assertString(payload.label, `invalid_scene_bundle_media_surface_label:${index}`);
  }
  if (payload.kind !== undefined) {
    if (payload.kind !== "wall" && payload.kind !== "table" && payload.kind !== "laptop" && payload.kind !== "floating" && payload.kind !== "custom") {
      throw new Error(`invalid_scene_bundle_media_surface_kind:${index}`);
    }
    parsed.kind = payload.kind;
  }
  if (payload.widthPx !== undefined) {
    parsed.widthPx = parsePositiveNumber(payload.widthPx, `invalid_scene_bundle_media_surface_width_px:${index}`);
  }
  if (payload.heightPx !== undefined) {
    parsed.heightPx = parsePositiveNumber(payload.heightPx, `invalid_scene_bundle_media_surface_height_px:${index}`);
  }
  if (transform.yaw !== undefined) {
    if (!isFiniteNumber(transform.yaw)) throw new Error(`invalid_scene_bundle_media_surface_yaw:${index}`);
    parsed.transform.yaw = transform.yaw;
  }
  if (transform.pitch !== undefined) {
    if (!isFiniteNumber(transform.pitch)) throw new Error(`invalid_scene_bundle_media_surface_pitch:${index}`);
    parsed.transform.pitch = transform.pitch;
  }
  if (transform.roll !== undefined) {
    if (!isFiniteNumber(transform.roll)) throw new Error(`invalid_scene_bundle_media_surface_roll:${index}`);
    parsed.transform.roll = transform.roll;
  }

  parsed.visible = parseOptionalBoolean(payload.visible, `invalid_scene_bundle_media_surface_visible:${index}`);

  if (payload.allowedObjectTypes !== undefined) {
    if (!Array.isArray(payload.allowedObjectTypes)) {
      throw new Error(`invalid_scene_bundle_media_surface_allowed_object_types:${index}`);
    }
    parsed.allowedObjectTypes = payload.allowedObjectTypes.map((entry, typeIndex) => assertString(entry, `invalid_scene_bundle_media_surface_allowed_object_type:${index}:${typeIndex}`));
  }

  return parsed;
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

  if (payload.mediaSurfaces !== undefined) {
    if (!Array.isArray(payload.mediaSurfaces)) {
      throw new Error("invalid_scene_bundle_media_surfaces");
    }
    if (payload.mediaSurfaces.length === 0) {
      throw new Error("invalid_scene_bundle_media_surfaces_empty");
    }
    manifest.mediaSurfaces = payload.mediaSurfaces.map((entry, index) => parseMediaSurface(entry, index));
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
