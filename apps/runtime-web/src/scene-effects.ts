import { AnimationClip, AnimationMixer, Object3D } from "three";
import type { SceneClipEffect } from "@vrata/shared-types";

interface ClipBinding {
  node: Object3D;
  mixer: AnimationMixer;
  clips: AnimationClip[];
  owners: Map<string, () => boolean>;
  playing: boolean;
}

/** Only the scene author selects clips and nodes. The plugin receives neither.
 * Validate all bindings before changing visibility. */
export class SceneEffects {
  private readonly bindings = new Map<string, ClipBinding>();
  constructor(scene: Object3D, animations: AnimationClip[], specs: SceneClipEffect[]) {
    const nodes: Object3D[] = [];
    scene.traverse((node) => nodes.push(node));
    const roots = new Set(specs.map((spec) => spec.root));
    for (const spec of specs) {
      const found = nodes.filter((node) => node.name === spec.root);
      if (found.length !== 1 || found[0] === scene) throw new Error("invalid_scene_effect_root");
      const root = found[0],
        members = new Set<string>(),
        duplicate = new Set<string>();
      root.traverse((node) => {
        if (node !== root && roots.has(node.name)) throw new Error("overlapping_scene_effect_roots");
        if (members.has(node.name)) duplicate.add(node.name);
        members.add(node.name);
      });
      const clips = spec.clips.map((name) => {
        const matches = animations.filter((clip) => clip.name === name);
        if (matches.length !== 1) throw new Error("missing_scene_effect_clip");
        const clip = matches[0];
        if (
          !Number.isFinite(clip.duration) ||
          clip.duration <= 0 ||
          !clip.tracks.length ||
          clip.tracks.length > 64 ||
          !clip.tracks.every((track) => {
            const match = /^([a-zA-Z][a-zA-Z0-9_-]*)\.(position|quaternion|scale)$/.exec(track.name);
            return match && members.has(match[1]) && !duplicate.has(match[1]);
          })
        )
          throw new Error("invalid_scene_effect_track");
        return clip;
      });
      this.bindings.set(spec.id, {
        node: root,
        mixer: new AnimationMixer(root),
        clips,
        owners: new Map(),
        playing: false,
      });
    }
    for (const { node } of this.bindings.values()) node.visible = false;
  }
  set(owner: string, id: string, enabled: boolean, live: () => boolean): boolean {
    const effect = this.bindings.get(id);
    if (!effect) return false;
    if (enabled) effect.owners.set(owner, live);
    else effect.owners.delete(owner);
    return true;
  }
  retire(owner: string): void {
    for (const effect of this.bindings.values()) effect.owners.delete(owner);
  }
  tick(seconds: number): void {
    for (const e of this.bindings.values()) {
      let on = false;
      for (const live of e.owners.values())
        if (live()) {
          on = true;
          break;
        }
      if (on !== e.playing) {
        if (on) for (const clip of e.clips) e.mixer.clipAction(clip).play();
        else e.mixer.stopAllAction();
        e.playing = e.node.visible = on;
      }
      if (on && Number.isFinite(seconds) && seconds > 0) e.mixer.update(seconds);
    }
  }
  diagnostics() {
    return Array.from(this.bindings, ([id, e]) => ({
      id,
      playing: e.playing,
      position: e.node.position.toArray(),
      clips: e.clips.map((c) => ({ name: c.name, time: e.mixer.existingAction(c)?.time ?? 0 })),
    }));
  }
  dispose(): void {
    for (const e of this.bindings.values()) {
      e.mixer.stopAllAction();
      e.mixer.uncacheRoot(e.node);
      e.node.visible = false;
      e.owners.clear();
    }
    this.bindings.clear();
  }
}
