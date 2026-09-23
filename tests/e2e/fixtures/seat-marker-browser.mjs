// Component renderer: imports the built production marker, not a visual approximation.
import * as THREE from "three";
import { createSeatMarkerViewController } from "/runtime/interaction/seat-marker-view.js";

const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(640, 480);
renderer.setPixelRatio(1);
document.body.style.margin = "0";
document.body.append(renderer.domElement);
const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ color: 0x605952 }));
plane.rotation.x = -Math.PI / 2;
scene.add(plane);
const controller = createSeatMarkerViewController();
controller.rebuild([{ id: "seat", position: { x: 0, y: 0, z: 0 }, yaw: 0, seatHeight: 0, radius: 0.4 }]);
scene.add(controller.root);
const camera = new THREE.OrthographicCamera(-0.42, 0.42, 0.315, -0.315, 0.01, 10);
let light = false;
const render = () => { scene.background = new THREE.Color(light ? 0xe1e3e4 : 0x18222a); renderer.render(scene, camera); };
const setView = (name) => {
  camera.up.set(0, 1, 0);
  if (name === "top") { camera.up.set(0, 0, 1); camera.position.set(0, 2, 0); }
  else if (name === "side") camera.position.set(0, 0.22, -1.5);
  else camera.position.set(0.7, 0.7, -1.2);
  camera.lookAt(0, 0.08, 0);
  camera.updateMatrixWorld(true);
  render();
};
window.markerHarness = {
  setView,
  setLight(value) { light = value; plane.material.color.setHex(light ? 0xbab3a7 : 0x605952); render(); },
  setState(name, timeSeconds) {
    controller.update({
      hoveredSeatId: name === "hovered" ? "seat" : null,
      pendingSeatId: name === "pending" ? "seat" : null,
      currentSeatId: name === "current" ? "seat" : null,
      occupancy: name === "occupied" ? { seat: "other" } : {}, timeSeconds
    });
    render();
  },
  snapshot() {
    const marker = controller.getMarker("seat");
    return { visible: marker.group.visible, blocked: marker.hit.userData.seatMarkerBlocked,
      calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      opacity: marker.top.material.opacity, color: marker.top.material.color.getHex(),
      camera: camera.position.toArray(), forward: camera.getWorldDirection(new THREE.Vector3()).toArray() };
  }
};
setView("perspective");
