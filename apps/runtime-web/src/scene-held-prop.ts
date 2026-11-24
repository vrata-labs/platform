import {
  Box3, BufferGeometry, Mesh, MeshStandardMaterial, QuadraticBezierCurve3, Quaternion,
  Sprite, SpriteMaterial, TubeGeometry, Vector3, type Object3D, type Texture
} from "three";
import type { SceneHeldPropEffect } from "@vrata/shared-types";
import type { AvatarHandPose } from "./avatar/avatar-xr-hands.js";
import type { XrViewerPose } from "./input/xr-viewer.js";
import { createHeldPropContact, createHeldPropState, type PropHand } from "./interaction/held-prop-state.js";
import { SceneEffectSound, type LoadSceneEffectSound } from "./scene-effect-audio.js";

export interface HeldPropFrame {
  nowMs: number;
  enabled: boolean;
  head: XrViewerPose | null;
  hands: Readonly<Record<PropHand, { pressed: boolean; pose: AvatarHandPose | null }>>;
}

interface HeldNodes {
  root: Object3D;
  fixture: Object3D;
  handle: Object3D;
  tip: Object3D;
  connector: Object3D;
  tether: Object3D;
  restHose: Object3D;
  soundSource: Object3D;
}

const contains = (root: Object3D, node: Object3D) => {
  for (let current: Object3D | null = node.parent; current; current = current.parent) {
    if (current === root) return true;
  }
  return false;
};

export function bindHeldSceneProp(scene: Object3D, spec: SceneHeldPropEffect, lookup: (name: string) => Object3D,
  loadSound?: LoadSceneEffectSound) {
  const nodes: HeldNodes = {
    root: lookup(spec.root), fixture: lookup(spec.fixture), handle: lookup(spec.handle),
    tip: lookup(spec.tip), connector: lookup(spec.connector), tether: lookup(spec.tether),
    restHose: lookup(spec.restHose), soundSource: lookup(spec.soundSource)
  };
  const { fixture, handle, tip, tether, connector, restHose, root, soundSource } = nodes;
  if ([handle, connector, restHose, soundSource].some(node => !contains(fixture, node)) ||
      !contains(handle, tip) || !contains(handle, tether) || contains(handle, restHose) ||
      contains(handle, connector) || contains(handle, soundSource) ||
      contains(fixture, root) || contains(root, fixture) || contains(restHose, handle) ||
      contains(restHose, connector) || contains(restHose, soundSource)) {
    throw new Error("invalid_scene_held_prop_hierarchy");
  }
  if (!(root instanceof Mesh) || !(root.material instanceof MeshStandardMaterial) || !root.material.map) {
    throw new Error("invalid_scene_held_prop_atlas");
  }
  let hoseMaterial: MeshStandardMaterial | undefined;
  restHose.traverse(node => {
    if (!hoseMaterial && node instanceof Mesh && node.material instanceof MeshStandardMaterial) hoseMaterial = node.material;
  });
  if (!hoseMaterial) throw new Error("invalid_scene_held_prop_hose");
  const map = root.material.map;
  const material = hoseMaterial;
  return () => new HeldSceneProp(scene, spec, nodes, map, material, loadSound);
}

export class HeldSceneProp {
  private readonly hold;
  private readonly contact;
  private readonly originalPosition;
  private readonly originalRotation;
  private readonly sound?: SceneEffectSound;
  private readonly relativeRotation = new Quaternion();
  private readonly gripRotation = new Quaternion();
  private readonly handleRotation = new Quaternion();
  private readonly parentRotation = new Quaternion();
  private readonly target = new Vector3();
  private readonly mouth = new Vector3();
  private readonly tip = new Vector3();
  private readonly origin = new Vector3();
  private readonly endpoint = new Vector3();
  private readonly sag = new Vector3();
  private readonly restCenter = new Vector3();
  private readonly hoseBox = new Box3();
  private readonly previousEnd = new Vector3(Infinity, Infinity, Infinity);
  private readonly texture: Texture;
  private readonly smoke: Sprite;
  private readonly cable: Mesh;
  private readonly smokePoint = new Vector3();
  private readonly viewerScale = new Vector3();
  private heldBy: PropHand | null = null;
  private burstAt = -Infinity;
  private touching = false;
  private bursts = 0;

  constructor(private readonly scene: Object3D, private readonly spec: SceneHeldPropEffect,
    private readonly nodes: HeldNodes, map: Texture, hoseMaterial: MeshStandardMaterial, loadSound?: LoadSceneEffectSound) {
    this.hold = createHeldPropState(spec.pickupM, spec.reachM);
    this.contact = createHeldPropContact(spec.contactM, spec.burst.intervalSeconds * 1000);
    this.originalPosition = nodes.handle.position.clone();
    this.originalRotation = nodes.handle.quaternion.clone();
    // Keep the baked rest hose unchanged; the movable copy retains its rubber colour, not baked lighting UVs.
    this.cable = new Mesh(new BufferGeometry(), new MeshStandardMaterial({
      color: hoseMaterial.color, roughness: hoseMaterial.roughness, metalness: 0
    }));
    this.cable.visible = false;
    this.texture = map.clone();
    this.texture.repeat.set(1 / spec.burst.columns, 1 / spec.burst.rows);
    this.texture.needsUpdate = true;
    this.smoke = new Sprite(new SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false }));
    this.smoke.visible = nodes.root.visible = false;
    scene.add(this.cable, this.smoke);
    if (spec.audio && loadSound) this.sound = new SceneEffectSound(spec.audio, nodes.soundSource, loadSound, false);
  }

  private restore() {
    this.nodes.handle.position.copy(this.originalPosition);
    this.nodes.handle.quaternion.copy(this.originalRotation);
    this.nodes.restHose.visible = true;
    this.cable.visible = false;
    this.previousEnd.set(Infinity, Infinity, Infinity);
  }

  private trackCable() {
    this.nodes.tether.getWorldPosition(this.endpoint);
    if (this.previousEnd.distanceToSquared(this.endpoint) < .003 ** 2) return;
    this.previousEnd.copy(this.endpoint);
    const sag = Math.min(.35, Math.sqrt(Math.max(0, this.spec.reachM ** 2 - this.endpoint.distanceToSquared(this.origin))) * .2);
    this.sag.copy(this.origin).lerp(this.endpoint, .5);
    this.sag.y = Math.max(Math.min(this.origin.y, this.endpoint.y, this.hoseBox.min.y), this.sag.y - sag);
    this.scene.getWorldScale(this.viewerScale);
    const curve = new QuadraticBezierCurve3(this.scene.worldToLocal(this.origin.clone()),
      this.scene.worldToLocal(this.sag.clone()), this.scene.worldToLocal(this.endpoint.clone()));
    this.cable.geometry.dispose();
    this.cable.geometry = new TubeGeometry(curve, 16, this.spec.hoseRadiusM / this.viewerScale.y, 6, false);
    this.cable.visible = true;
  }

  update(frame: HeldPropFrame) {
    const { handle, connector, tip, restHose } = this.nodes;
    const previous = this.heldBy;
    connector.getWorldPosition(this.origin);
    if (!previous) handle.getWorldPosition(this.restCenter);
    this.heldBy = this.hold.update({
      enabled: frame.enabled, restHandle: this.restCenter, tetherAnchor: this.origin,
      grips: {
        left: { pressed: frame.hands.left.pressed, position: frame.hands.left.pose?.position ?? null },
        right: { pressed: frame.hands.right.pressed, position: frame.hands.right.pose?.position ?? null }
      }
    });
    const pose = this.heldBy ? frame.hands[this.heldBy].pose : null;
    if (pose && handle.parent) {
      this.gripRotation.copy(pose.orientation).normalize();
      if (!previous) {
        this.relativeRotation.copy(this.gripRotation).invert().multiply(handle.getWorldQuaternion(this.handleRotation));
        this.hoseBox.setFromObject(restHose);
      }
      handle.position.copy(handle.parent.worldToLocal(this.target.copy(pose.position)));
      handle.parent.getWorldQuaternion(this.parentRotation).invert();
      handle.quaternion.copy(this.parentRotation).multiply(this.gripRotation).multiply(this.relativeRotation);
      restHose.visible = false;
      this.trackCable();
    } else if (previous) {
      this.restore();
    }

    const { head } = frame;
    const mouth = head ? this.mouth.set(0, -.085, -.085).applyQuaternion(head.orientation).add(head.position) : null;
    const event = this.contact.update(frame.nowMs, pose ? tip.getWorldPosition(this.tip) : null, mouth);
    this.touching = event.touching;
    if (event.stop) this.sound?.stop();
    if (head && event.pulse) {
      this.burstAt = frame.nowMs;
      this.bursts++;
      this.smokePoint.set(0, .025, -.44).applyQuaternion(head.orientation).add(head.position);
      this.sound?.allowRetry();
    }
    if (!frame.enabled) this.burstAt = -Infinity;
  }

  tick(nowMs: number, audio?: { context: AudioContext; camera: Object3D }) {
    const elapsed = (nowMs - this.burstAt) / 1000;
    const { columns, rows, durationSeconds } = this.spec.burst;
    const phase = elapsed / durationSeconds;
    this.smoke.visible = phase >= 0 && phase < 1;
    if (this.smoke.visible) {
      const tile = Math.min(columns * rows - 1, Math.floor(phase * columns * rows));
      this.texture.offset.set((tile % columns) / columns, Math.floor(tile / columns) / rows);
      this.smoke.material.opacity = Math.min(phase * 12, (1 - phase) * 3, .66);
      this.smoke.position.copy(this.smokePoint);
      this.smoke.position.y += phase * .24;
      this.scene.worldToLocal(this.smoke.position);
      this.scene.getWorldScale(this.viewerScale);
      this.smoke.scale.setScalar((.22 + phase * .34) / this.viewerScale.y);
    }
    this.sound?.tick(audio, this.touching && elapsed >= 0 && elapsed < this.spec.burst.intervalSeconds, elapsed);
  }

  get hasAudio() { return !!this.sound; }
  audioChanged(enabled: boolean) { if (!enabled) this.sound?.stop(); else this.sound?.allowRetry(); }
  diagnostics() {
    return {
      id: this.spec.id, playing: this.smoke.visible, clips: [], position: this.nodes.handle.getWorldPosition(this.target).toArray(),
      holding: this.heldBy, touching: this.touching, bursts: this.bursts,
      tip: this.nodes.tip.getWorldPosition(this.tip).toArray(), audio: this.sound?.diagnostics()
    };
  }
  dispose() {
    this.restore();
    this.nodes.root.visible = false;
    this.sound?.dispose();
    this.texture.dispose();
    this.smoke.material.dispose();
    this.cable.geometry.dispose();
    (this.cable.material as MeshStandardMaterial).dispose();
    this.smoke.removeFromParent();
    this.cable.removeFromParent();
  }
}
