# Three.js (`three`)

3D: solids of revolution, vectors, planes, surfaces z = f(x, y), molecules, orbits. Large (~600 KB); use only when 3D is the point.

```ts
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const host = document.querySelector<HTMLElement>("#scene")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
host.append(renderer.domElement);
renderer.domElement.dataset.part = "scene_3d";

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0E0E12");
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100);
camera.position.set(6, 5, 8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(5, 10, 7); scene.add(sun);
scene.add(new THREE.AxesHelper(3), new THREE.GridHelper(10, 10, 0x444444, 0x222222));

const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32),
  new THREE.MeshStandardMaterial({ color: "#58C4DD", roughness: 0.4 }));
scene.add(mesh);
scene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 1, 0).normalize(), new THREE.Vector3(), 2, 0xffe14d));

function resize() {
  const w = host.clientWidth, h = Math.round(w * 9 / 16);
  renderer.setSize(w, h, false); renderer.domElement.style.width = "100%";
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host); resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
```

- Surface z = f(x, y): `new THREE.PlaneGeometry(w, h, n, n)`, then set each vertex's z from f and call `geometry.computeVertexNormals()`.
- Labels in 3D: project a `Vector3` to the screen (`v.clone().project(camera)`) and position an absolutely positioned HTML element.
- Dispose geometries and materials you replace, to avoid leaks on slider changes.
