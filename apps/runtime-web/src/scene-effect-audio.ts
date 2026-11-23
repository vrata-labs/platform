import { Vector3, Quaternion, type Object3D } from "three";
import type { SceneEffectAudio } from "@vrata/shared-types";

export type LoadSceneEffectSound = (spec: SceneEffectAudio, signal: AbortSignal) => Promise<ArrayBuffer>;

export function sceneEffectGain(spec: Pick<SceneEffectAudio, "gain" | "nearM" | "farM">, distance: number): number {
  const remaining = Math.max(0, Math.min(1, (spec.farM - distance) / (spec.farM - spec.nearM)));
  return Number.isFinite(remaining) ? spec.gain * remaining ** 2 : 0;
}

export class SceneEffectSound {
  private request?: AbortController;
  private buffer?: AudioBuffer;
  private source?: AudioBufferSourceNode;
  private volume?: GainNode;
  private stereo?: StereoPannerNode;
  private failed = false;
  private readonly delta = new Vector3();
  private readonly eye = new Vector3();
  private readonly right = new Vector3();
  private readonly orientation = new Quaternion();
  private level = 0;

  constructor(private readonly spec: SceneEffectAudio, private readonly node: Object3D, private readonly load: LoadSceneEffectSound) {}

  tick(target: { context: AudioContext; camera: Object3D } | undefined, active: boolean, motionTime: number): void {
    if (!target || target.context.state !== "running" || !active) { this.stop(); return; }
    const { context, camera } = target;
    if (!this.buffer) {
      if (!this.failed && !this.request) {
        const request = this.request = new AbortController();
        void this.load(this.spec, request.signal).then(bytes => {
          request.signal.throwIfAborted();
          return context.decodeAudioData(bytes);
        }).then(buffer => {
          if (this.request === request) this.buffer = buffer;
        }).catch(() => {
          if (this.request === request) this.failed = true;
        }).finally(() => {
          if (this.request === request) this.request = undefined;
        });
      }
      return;
    }
    camera.getWorldPosition(this.eye);
    this.node.getWorldPosition(this.delta).sub(this.eye);
    const distance = this.delta.length();
    const level = sceneEffectGain(this.spec, distance);
    if (!level) { this.stopVoice(); return; }
    if (!this.source) {
      const volume = this.volume = context.createGain();
      const stereo = this.stereo = context.createStereoPanner();
      const source = this.source = context.createBufferSource();
      volume.gain.value = 0;
      source.buffer = this.buffer;
      source.loop = true;
      source.connect(stereo).connect(volume).connect(context.destination);
      source.start(0, motionTime % this.buffer.duration);
    }
    const now = context.currentTime;
    const side = this.right.set(1, 0, 0).applyQuaternion(camera.getWorldQuaternion(this.orientation));
    this.stereo!.pan.setTargetAtTime(distance ? this.delta.dot(side) / distance : 0, now, 0.04);
    // Never keep playing indefinitely if frames are suspended or a room loses authority while the UI is busy.
    const gain = this.volume!.gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(level, now, 0.04);
    gain.setTargetAtTime(0, now + 0.4, 0.06);
    this.level = level;
  }

  private stopVoice(): void {
    this.source?.stop();
    this.source?.disconnect();
    this.stereo?.disconnect();
    this.volume?.disconnect();
    this.source = this.stereo = this.volume = undefined;
    this.level = 0;
  }

  stop(): void {
    this.stopVoice();
    this.request?.abort();
    this.request = undefined;
  }

  allowRetry(): void { this.failed = false; }
  dispose(): void { this.stop(); this.buffer = undefined; }
  diagnostics() { return { playing: Boolean(this.source), gain: this.level, failed: this.failed }; }
}
