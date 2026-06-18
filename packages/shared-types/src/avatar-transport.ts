export interface CompactPoseFrame {
  seq: number;
  sentAtMs: number;
  flags: number;
  root: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    vx: number;
    vz: number;
  };
  head: {
    x: number;
    y: number;
    z: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
  };
  leftHand: {
    x: number;
    y: number;
    z: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
    gesture: number;
  };
  rightHand: {
    x: number;
    y: number;
    z: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
    gesture: number;
  };
  locomotion: {
    mode: number;
    speed: number;
    angularVelocity: number;
  };
}
