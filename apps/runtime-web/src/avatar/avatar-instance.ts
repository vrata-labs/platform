import * as THREE from "three";

import type { LoadedAvatarPreset } from "./avatar-types.js";

export interface ProceduralAvatarHeadVisual {
  head: THREE.Mesh;
  mouth: THREE.Mesh;
  hair: THREE.Mesh;
}

export interface AvatarVisualInstance {
  avatarId: string;
  label: string;
  group: THREE.Group;
  setHighlighted(highlighted: boolean): void;
}

function createMaterial(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.86, metalness: 0.04 });
}

export function createProceduralAvatarHead(input: {
  skinColor: THREE.ColorRepresentation;
  accentColor: THREE.ColorRepresentation;
  mouthColor?: THREE.ColorRepresentation;
}): ProceduralAvatarHeadVisual {
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 20), createMaterial(input.skinColor));

  const mouth = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.028, 0.024),
    createMaterial(input.mouthColor ?? 0x5a1f24)
  );
  mouth.position.set(0, -0.055, -0.165);
  head.add(mouth);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), createMaterial(input.accentColor));
  hair.scale.set(1.1, 0.72, 1.1);
  hair.position.set(0, 0.14, -0.01);
  head.add(hair);

  return { head, mouth, hair };
}

export function applyProceduralMouthState(mouth: THREE.Mesh, mouthAmount: number): void {
  const clampedAmount = THREE.MathUtils.clamp(mouthAmount, 0, 1);
  mouth.scale.y = 1 + clampedAmount * 4.6;
  mouth.position.y = -0.055 - clampedAmount * 0.02;
}

export function createProceduralAvatarInstance(preset: LoadedAvatarPreset): AvatarVisualInstance {
  const group = new THREE.Group();
  group.name = `avatar:${preset.preset.avatarId}`;

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.72, 6, 12), createMaterial(preset.recipe.palette.primary));
  body.position.y = 0.9;
  group.add(body);

  const { head } = createProceduralAvatarHead({
    skinColor: preset.recipe.palette.skin,
    accentColor: preset.recipe.palette.accent
  });
  head.position.y = 1.56;
  group.add(head);

  const shoulderLeft = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 14), createMaterial(preset.recipe.palette.accent));
  shoulderLeft.position.set(-0.24, 1.22, 0);
  group.add(shoulderLeft);

  const shoulderRight = shoulderLeft.clone();
  shoulderRight.position.x = 0.24;
  group.add(shoulderRight);

  const outline = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.39, 28),
    new THREE.MeshBasicMaterial({ color: 0xf7f2e8, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  outline.rotation.x = -Math.PI / 2;
  outline.position.y = 0.02;
  group.add(outline);

  return {
    avatarId: preset.preset.avatarId,
    label: preset.preset.label,
    group,
    setHighlighted(highlighted: boolean) {
      outline.material = new THREE.MeshBasicMaterial({
        color: highlighted ? 0xffe7a1 : 0xf7f2e8,
        transparent: true,
        opacity: highlighted ? 0.55 : 0.18,
        side: THREE.DoubleSide
      });
      group.scale.setScalar(highlighted ? 1.06 : 1);
    }
  };
}

export function positionAvatarRing(instances: AvatarVisualInstance[], radius = 3.8): void {
  instances.forEach((instance, index) => {
    const angle = (index / instances.length) * Math.PI * 2;
    instance.group.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    instance.group.lookAt(0, 1.2, 0);
  });
}
