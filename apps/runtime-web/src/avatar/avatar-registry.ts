import * as THREE from "three";

import type { AvatarVisualInstance } from "./avatar-instance.js";

export interface AvatarRegistry {
  root: THREE.Group;
  instances: AvatarVisualInstance[];
  selectAvatar(avatarId: string): void;
}

export function createAvatarRegistry(instances: AvatarVisualInstance[]): AvatarRegistry {
  const root = new THREE.Group();
  root.name = "avatar-registry";
  for (const instance of instances) {
    root.add(instance.group);
  }
  return {
    root,
    instances,
    selectAvatar(avatarId: string) {
      for (const instance of instances) {
        instance.setHighlighted(instance.avatarId === avatarId);
      }
    }
  };
}
