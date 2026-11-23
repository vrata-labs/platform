import { AnimationClip, AnimationMixer, Mesh, Object3D, Quaternion, Raycaster, type Ray } from "three";
import type { SceneEffect, SceneEffectSwitchState } from "@vrata/shared-types";
import { SceneEffectSound, type LoadSceneEffectSound } from "./scene-effect-audio.js";
import { bindHeldSceneProp, type HeldPropFrame, type HeldSceneProp } from "./scene-held-prop.js";
import { collectSpriteMeshes, createSceneSpriteAnimator } from "./scene-sprite-effect.js";

interface ClipBinding {
  node: Object3D;
  mixer: AnimationMixer;
  clips: AnimationClip[];
  owners: Map<string, () => boolean>;
  playing: boolean;
  sound?: SceneEffectSound;
  sprite?: ReturnType<typeof createSceneSpriteAnimator>;
  phase: number;
  control?: {
    mount: Object3D; handle: Object3D; on: Quaternion; off: Quaternion;
    enabled: boolean; synchronized: boolean;
  };
}

/** Only the scene author selects clips and nodes. The plugin receives neither.
 * Validate all bindings before changing visibility. */
export class SceneEffects {
  private readonly bindings = new Map<string, ClipBinding>();
  private readonly heldProps: HeldSceneProp[] = [];
  private readonly raycaster = new Raycaster();
  private readonly occluders: Mesh[];
  private audio?: { context: AudioContext; camera: Object3D };
  constructor(scene: Object3D, animations: AnimationClip[], specs: SceneEffect[], loadSound?: LoadSceneEffectSound) {
    const nodes: Object3D[] = [];
    scene.traverse((node) => nodes.push(node));
    const roots = new Set(specs.map((spec) => spec.root));
    const namedNode = (name: string) => {
      const found = nodes.filter(node => node.name === name);
      if (found.length !== 1 || found[0] === scene) throw new Error("invalid_scene_effect_root");
      return found[0]!;
    };
    const contains = (root: Object3D, child: Object3D) => {
      for (let current: Object3D | null = child; current; current = current.parent) if (current === root) return true;
      return false;
    };
    const effectRoots = [...roots].map(namedNode);
    const staticMounts: Object3D[] = [];
    const installSprites: Array<() => void> = [];
    const installHeldProps: Array<() => HeldSceneProp> = [];
    for (const spec of specs) {
      if (spec.kind === "held-prop") {
        installHeldProps.push(bindHeldSceneProp(scene, spec, namedNode, loadSound));
        continue;
      }
      const root = namedNode(spec.root),
        members = new Set<string>(),
        duplicate = new Set<string>();
      root.traverse((node) => {
        if (node !== root && roots.has(node.name)) throw new Error("overlapping_scene_effect_roots");
        if (members.has(node.name)) duplicate.add(node.name);
        members.add(node.name);
      });
      const clips = spec.kind === "sprite-loop" ? [] : spec.clips.map((name) => {
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
      const binding: ClipBinding = {
        node: root,
        mixer: new AnimationMixer(root),
        clips,
        owners: new Map(),
        playing: false,
        phase: 0,
        sound: spec.audio && loadSound ? new SceneEffectSound(spec.audio, root, loadSound) : undefined,
      };
      if (spec.kind === "sprite-loop") {
        const mount = namedNode(spec.switch.mount), handle = namedNode(spec.switch.handle);
        if (mount === handle || !contains(mount, handle) ||
            [...effectRoots, ...staticMounts].some(other => contains(other, mount) || contains(mount, other))) {
          throw new Error("invalid_scene_effect_switch");
        }
        staticMounts.push(mount);
        const sprites = collectSpriteMeshes(root);
        binding.control = {
          mount, handle, on: handle.quaternion.clone(), off: new Quaternion(...spec.switch.offQuaternion).normalize(),
          enabled: spec.switch.initiallyOn, synchronized: false
        };
        installSprites.push(() => { binding.sprite = createSceneSpriteAnimator(sprites, spec.atlas); });
      }
      this.bindings.set(spec.id, binding);
    }
    this.occluders = staticMounts.length ? nodes.filter((node): node is Mesh =>
      node instanceof Mesh && ![...effectRoots, ...staticMounts].some(root => contains(root, node)) &&
      (Array.isArray(node.material) ? node.material.every(m => !m.transparent) : !node.material.transparent)) : [];
    for (const install of installSprites) install();
    for (const install of installHeldProps) this.heldProps.push(install());
    for (const { node } of this.bindings.values()) node.visible = false;
  }
  set(owner: string, id: string, enabled: boolean, live: () => boolean): boolean {
    const effect = this.bindings.get(id);
    if (!effect || effect.control) return false;
    if (enabled) effect.owners.set(owner, live);
    else effect.owners.delete(owner);
    return true;
  }
  retire(owner: string): void {
    for (const effect of this.bindings.values()) {
      effect.owners.delete(owner);
      if (!effect.control && ![...effect.owners.values()].some(live => live())) effect.sound?.stop();
    }
  }
  applySwitchState(state?: SceneEffectSwitchState): void {
    for (const [id, e] of this.bindings) {
      if (!e.control) continue;
      const current = state?.switches.find(item => item.id === id);
      e.control.synchronized = current !== undefined;
      if (current) e.control.enabled = current.enabled;
    }
  }
  pickSwitch(ray: Ray, maxDistance: number) {
    const picker = this.raycaster;
    picker.ray.copy(ray);
    picker.far = Math.min(maxDistance, 3);
    let nearest: { kind: "effect-switch"; effectId: string; point: ReturnType<Ray["at"]> } | undefined;
    for (const [id, e] of this.bindings) {
      if (!e.control?.synchronized) continue;
      const hit = picker.intersectObject(e.control.mount, true)[0];
      if (hit) {
        nearest = { kind: "effect-switch", effectId: id, point: hit.point };
        picker.far = hit.distance;
      }
    }
    return nearest && picker.intersectObjects(this.occluders, false)[0] ? undefined : nearest;
  }
  hasAudio(): boolean { return [...this.bindings.values()].some(b => b.sound) || this.heldProps.some(prop => prop.hasAudio); }
  hasHeldProps(): boolean { return this.heldProps.length > 0; }
  updateHeldProps(frame: HeldPropFrame): void {
    for (const prop of this.heldProps) {
      prop.update(frame);
      prop.tick(frame.nowMs, this.audio);
    }
  }
  setAudio(input?: { context: AudioContext; camera: Object3D }): void {
    this.audio = input;
    for (const prop of this.heldProps) prop.audioChanged(!!input);
    for (const e of this.bindings.values()) {
      if (input) e.sound?.allowRetry();
      else e.sound?.stop();
    }
  }
  tick(seconds: number): void {
    for (const e of this.bindings.values()) {
      let on = e.control ? e.control.synchronized && e.control.enabled : false;
      for (const live of e.owners.values())
        if (live()) {
          on = true;
          break;
        }
      if (on !== e.playing) {
        if (on) for (const clip of e.clips) e.mixer.clipAction(clip).play();
        else e.mixer.stopAllAction();
        e.playing = e.node.visible = on;
        e.phase = 0;
        if (on) e.sound?.allowRetry();
      }
      if (e.control && e.control.synchronized) {
        const { handle, on: up, off } = e.control;
        handle.quaternion.slerp(on ? up : off, Math.min(1, Math.max(0, seconds) * 12));
      }
      if (on && Number.isFinite(seconds) && seconds > 0) {
        e.mixer.update(seconds);
        e.phase += seconds;
        e.sprite?.update(e.phase);
      }
      e.sound?.tick(this.audio, on, e.clips.length ? e.mixer.existingAction(e.clips[0]!)?.time ?? 0 : e.phase);
    }
  }
  diagnostics() {
    const loops = Array.from(this.bindings, ([id, e]) => ({
      id,
      playing: e.playing,
      position: e.node.position.toArray(),
      clips: e.clips.map((c) => ({ name: c.name, time: e.mixer.existingAction(c)?.time ?? 0 })),
      ...(e.control ? { switch: { synchronized: e.control.synchronized, enabled: e.control.enabled,
        handle: e.control.handle.quaternion.toArray() } } : {}),
      audio: e.sound?.diagnostics(),
    }));
    return [...loops, ...this.heldProps.map(prop => prop.diagnostics())];
  }
  dispose(): void {
    this.audio = undefined;
    for (const prop of this.heldProps.splice(0)) prop.dispose();
    for (const e of this.bindings.values()) {
      e.sound?.dispose();
      e.sprite?.dispose();
      e.mixer.stopAllAction();
      e.mixer.uncacheRoot(e.node);
      e.node.visible = false;
      e.owners.clear();
    }
    this.bindings.clear();
  }
}
