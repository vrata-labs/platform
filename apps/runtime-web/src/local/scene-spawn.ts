import type { SceneBundleSpawnPoint } from "../scene-bundle.js";
import type { LocalPose, LocalPoseController } from "./local-pose.js";

export function applySceneSpawnPoint(
  localPoseController: LocalPoseController,
  spawnPoint: SceneBundleSpawnPoint
): LocalPose {
  const currentPose = localPoseController.getPose();
  return localPoseController.setPose({
    ...currentPose,
    position: spawnPoint.position,
    yaw: spawnPoint.yaw ?? currentPose.yaw
  }, "spawn");
}
