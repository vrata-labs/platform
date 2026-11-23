/** Optional, data-only bindings to animation clips inside the same scene GLB. */
export interface SceneClipEffect {
  id: string;
  kind: "clip-loop";
  root: string;
  clips: string[];
}

const name = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);

export function isSceneClipEffects(value: unknown): value is SceneClipEffect[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  const ids = new Set<string>(),
    roots = new Set<string>(),
    clips = new Set<string>();
  return value.every((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some((k) => !["id", "kind", "root", "clips"].includes(k)) ||
      !name(item.id) ||
      !name(item.root) ||
      item.kind !== "clip-loop" ||
      ids.has(item.id) ||
      roots.has(item.root) ||
      !Array.isArray(item.clips) ||
      item.clips.length < 1 ||
      item.clips.length > 4
    )
      return false;
    ids.add(item.id);
    roots.add(item.root);
    return item.clips.every((clip: unknown) => {
      if (!name(clip) || clips.has(clip)) return false;
      clips.add(clip);
      return true;
    });
  });
}
