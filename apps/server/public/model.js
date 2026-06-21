import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const slug = window.location.pathname.split("/").filter(Boolean).pop();
const title = document.querySelector("#modelTitle");
const meta = document.querySelector("#modelMeta");
const viewerShell = document.querySelector("#viewerShell");
const viewerCanvas = document.querySelector("#viewerCanvas");
const notReady = document.querySelector("#notReady");
const downloadLinks = document.querySelector("#downloadLinks");
const objectInfo = document.querySelector("#objectInfo");
const objectInfoTitle = document.querySelector("#objectInfoTitle");
const objectInfoSubtitle = document.querySelector("#objectInfoSubtitle");
const objectInfoBody = document.querySelector("#objectInfoBody");
const closeInfo = document.querySelector("#closeInfo");
const themeToggle = document.querySelector("#themeToggle");
const fitViewButton = document.querySelector("#fitViewButton");

let renderer;
let camera;
let controls;
let scene;
let loadedRoot;
let selectableMeshes = [];
let pointerStart = null;

initTheme();
loadModel();

function initTheme() {
  const stored = localStorage.getItem("viewer-theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(stored || preferred);
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("viewer-theme", next);
    setTheme(next);
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${theme === "dark" ? "light_mode" : "dark_mode"}</span>`;
  themeToggle.setAttribute("aria-label", theme === "dark" ? "Use light mode" : "Use dark mode");
  if (renderer && scene) {
    scene.background = new THREE.Color(theme === "dark" ? 0x0e0e0e : 0xf3f6fb);
    renderer.setClearColor(scene.background, 1);
  }
}

async function loadModel() {
  const modelResponse = await fetch(`/api/models/${encodeURIComponent(slug)}`);
  if (!modelResponse.ok) {
    title.textContent = "Model not found";
    notReady.classList.remove("hidden");
    return;
  }

  const model = await modelResponse.json();
  title.textContent = model.name;
  meta.textContent = `${model.source_filename} / ${model.status}`;
  downloadLinks.innerHTML = `<a class="download-pill" href="/downloads/${encodeURIComponent(slug)}/original"><span class="material-symbols-outlined" aria-hidden="true">source</span>Original</a>`;

  const displayResponse = await fetch(`/model-files/${encodeURIComponent(slug)}/display.glb`, { method: "HEAD" });
  if (!displayResponse.ok) {
    notReady.classList.remove("hidden");
    return;
  }

  downloadLinks.innerHTML += `<a class="download-pill" href="/downloads/${encodeURIComponent(slug)}/display.glb"><span class="material-symbols-outlined" aria-hidden="true">download</span>GLB</a>`;
  viewerShell.classList.remove("hidden");
  await initThree(`/model-files/${encodeURIComponent(slug)}/display.glb`);
}

async function initThree(url) {
  scene = new THREE.Scene();
  const dark = document.documentElement.dataset.theme === "dark";
  scene.background = new THREE.Color(dark ? 0x0e0e0e : 0xf3f6fb);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
  camera.position.set(2.5, 2.2, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(scene.background, 1);
  viewerCanvas.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
  };

  scene.add(new THREE.HemisphereLight(0xffffff, 0x667085, 2.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(5, 8, 6);
  scene.add(keyLight);

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  loadedRoot = gltf.scene;
  scene.add(loadedRoot);
  selectableMeshes = [];
  loadedRoot.traverse((object) => {
    if (object.isMesh) selectableMeshes.push(object);
  });

  frameModel(loadedRoot);
  resize();
  window.addEventListener("resize", resize);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  closeInfo.addEventListener("click", () => objectInfo.classList.add("hidden"));
  fitViewButton.addEventListener("click", () => loadedRoot && frameModel(loadedRoot));
  animate();
}

function frameModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));

  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(distance * 0.65, distance * 0.45, distance * 1.25));
  camera.near = Math.max(maxDim / 10000, 0.01);
  camera.far = Math.max(maxDim * 20, 1000);
  camera.updateProjectionMatrix();
  controls.update();
}

function resize() {
  const rect = viewerCanvas.getBoundingClientRect();
  camera.aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(rect.width, rect.height, false);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function onPointerDown(event) {
  pointerStart = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event) {
  if (!pointerStart) return;
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  pointerStart = null;
  if (moved > 6) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(selectableMeshes, true)[0];
  if (hit) showObjectInfo(hit.object);
}

function isUsefulDisplayName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  const genericNames = [
    "unnamed",
    "unnamed part",
    "object",
    "mesh",
    "node",
    "scene",
    "document",
    "compound",
    "compsolid",
    "solid",
    "shell",
    "shape",
    "primitive"
  ];
  if (genericNames.includes(lower)) return false;

  if (/^(mesh|node|object|primitive)[ _-]?\d+$/i.test(trimmed)) return false;
  if (/^=>\s*\[[\d:]+\]$/.test(trimmed)) return false;
  if (/^\d+(?::\d+)+$/.test(trimmed)) return false;
  if (/^#\d+$/.test(trimmed)) return false;
  if (trimmed.includes(">") || trimmed.includes("/material/")) return false;

  return true;
}

function readableName(value) {
  if (Array.isArray(value)) value = value.find((item) => readableName(item));
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!isUsefulDisplayName(name)) return undefined;
  return name;
}

function stableIdentifier(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value).trim();
  return id || undefined;
}

function selectedDisplayName(object, sources) {
  // 1. resolvedObjectName / displayName if present and readable (leaf-to-root)
  for (const source of sources) {
    const name = readableName(firstValue(source.value, ["resolvedObjectName", "displayName"]));
    if (name) return name;
  }

  // 2. Block/component/instance name (leaf-to-root)
  for (const source of sources) {
    const blockName = readableName(firstValue(source.value, ["blockName", "instanceName", "componentInstance", "blockInstance"]));
    if (blockName) return blockName;
  }

  // 3. Part/object/product/representation name (leaf-to-root)
  for (const source of sources) {
    const partName = readableName(firstValue(source.value, ["partName", "objectName", "componentName", "productName", "representationName"]));
    if (partName) return partName;
  }

  // 4. Useful direct object.name or metadata name (leaf-to-root)
  for (const source of sources) {
    const name = readableName(source.value["name"]);
    if (name) return name;
  }
  const directObjName = readableName(object.name);
  if (directObjName) return directObjName;

  // 5. Layer name (leaf-to-root)
  for (const source of sources) {
    const layer = readableName(firstValue(source.value, ["layerNames", "layerName", "layer", "layers"]));
    if (layer) return layer;
  }

  // 6. stableObjectId
  for (const source of sources) {
    const id = stableIdentifier(source.value["stableObjectId"]);
    if (id) return id;
  }

  // 7. selectableId
  for (const source of sources) {
    const id = stableIdentifier(source.value["selectableId"]);
    if (id) return id;
  }

  // 8. "Unnamed part"
  return "Unnamed part";
}

function showObjectInfo(object) {
  const sources = metadataSources(object);
  const merged = Object.assign({}, ...sources.map((source) => source.value));
  const displayName = selectedDisplayName(object, sources);

  objectInfoTitle.textContent = displayName;
  objectInfoSubtitle.textContent = object.name || object.type || "";

  if (Object.keys(merged).length === 0) {
    objectInfoBody.innerHTML = '<p class="empty">No object metadata found.</p>';
    objectInfo.classList.remove("hidden");
    return;
  }

  const fields = [
    ["Layer", firstValue(merged, ["layerNames", "layers", "layerName", "layer"])],
    ["Colour source", firstValue(merged, ["colourSource", "colorSource", "materialSource"])],
    ["Geometry source", firstValue(merged, ["geometrySource"])],
    ["STEP IDs", firstValue(merged, ["stepEntityIds", "stepEntityId", "stepStyledItemId"])],
    ["XCAF label path", firstValue(merged, ["xcafLabelPath", "labelPath"])],
    ["Referred label path", firstValue(merged, ["referredLabelPath"])],
    ["Selectable ID", firstValue(merged, ["selectableId", "selectable_id"])],
    ["Parent object", firstValue(merged, ["parentObjectId", "parent_object_id"])]
  ];

  objectInfoBody.innerHTML = `
    <dl class="metadata-list">
      ${fields.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${formatValue(value)}</dd>
        </div>
      `).join("")}
    </dl>
    <details class="metadata-details">
      <summary>Advanced raw metadata</summary>
      <pre>${escapeHtml(JSON.stringify({ merged, sources }, null, 2))}</pre>
    </details>
  `;
  objectInfo.classList.remove("hidden");
}

function metadataSources(object) {
  const sources = [];
  let current = object;
  while (current) {
    if (hasMetadata(current.userData)) {
      sources.push({ source: current === object ? "node" : "ancestor-node", name: current.name, value: current.userData });
    }
    current = current.parent;
  }

  if (hasMetadata(object.geometry?.userData)) {
    sources.push({ source: "geometry", name: object.geometry.name || "", value: object.geometry.userData });
  }

  const materials = Array.isArray(object.material) ? object.material : [object.material];
  materials.filter(Boolean).forEach((material) => {
    if (hasMetadata(material.userData)) {
      sources.push({ source: "material", name: material.name || "", value: material.userData });
    }
  });

  return sources;
}

function hasMetadata(value) {
  if (!value || typeof value !== "object") return false;
  const ignored = new Set(["gltfExtensions"]);
  return Object.keys(value).some((key) => !ignored.has(key));
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return undefined;
}

function formatValue(value) {
  if (value === undefined || value === null || value === "") return '<span class="muted">Not available</span>';
  if (Array.isArray(value)) return escapeHtml(value.join(", "));
  if (typeof value === "object") return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
