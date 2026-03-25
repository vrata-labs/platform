import { createControlPlanePageState } from "./index.js";

const state = createControlPlanePageState();

console.log("control_plane_ready", state.publishStatus);
