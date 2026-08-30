import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface PbrRoomEnvironment {
  texture: THREE.Texture;
  dispose(): void;
}

export function createPbrRoomEnvironment(renderer: THREE.WebGLRenderer): PbrRoomEnvironment {
  const source = new RoomEnvironment();
  const generator = new THREE.PMREMGenerator(renderer);
  try {
    const target = generator.fromScene(source, 0.04);
    return {
      texture: target.texture,
      dispose: () => target.dispose()
    };
  } finally {
    source.dispose();
    generator.dispose();
  }
}
