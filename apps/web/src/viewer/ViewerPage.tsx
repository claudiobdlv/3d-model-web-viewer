import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft, Box, Download, Focus, MousePointer2, Move3D, RotateCw, ZoomIn } from "lucide-react";
import { getModel } from "../api";
import type { ModelRecord } from "../types";

type MetadataSource = { source: string; name: string; value: Record<string, unknown> };

export function ViewerPage() {
  const slug = useMemo(() => window.location.pathname.split("/").filter(Boolean).pop() ?? "", []);
  const [model, setModel] = useState<ModelRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState("none");
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const rotateXRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void getModel(slug)
      .then(setModel)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Model not found."));
  }, [slug]);

  useEffect(() => {
    if (!model?.has_display_glb || !canvasHost.current) return undefined;

    const host = canvasHost.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d10);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(scene.background, 1);
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN
    };

    scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(5, 8, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9dbdff, 0.8);
    fill.position.set(-5, 3, -4);
    scene.add(fill);

    let root: THREE.Group | null = null;
    let xQuarterTurns = 0;
    let selectable: THREE.Object3D[] = [];
    let pointerStart: { x: number; y: number } | null = null;
    let disposed = false;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      camera.aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
    };

    const frame = () => {
      if (!root) return;
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const distance = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(distance * 0.7, distance * 0.46, distance * 1.25));
      camera.near = Math.max(maxDim / 10000, 0.01);
      camera.far = Math.max(maxDim * 30, 1000);
      camera.updateProjectionMatrix();
      controls.update();
    };
    fitRef.current = frame;
    rotateXRef.current = () => {
      if (!root) return;
      xQuarterTurns = (xQuarterTurns + 1) % 4;
      root.rotation.x = -Math.PI / 2 + xQuarterTurns * Math.PI / 2;
      root.updateMatrixWorld(true);
      frame();
    };

    const onPointerDown = (event: PointerEvent) => {
      pointerStart = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event: PointerEvent) => {
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
      const hit = raycaster.intersectObjects(selectable, true)[0];
      setSelectedName(hit ? selectedDisplayName(hit.object) : "none");
    };

    const animate = () => {
      if (disposed) return;
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    resize();
    window.addEventListener("resize", resize);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    new GLTFLoader().load(
      `/model-files/${encodeURIComponent(slug)}/display.glb`,
      (gltf) => {
        if (disposed) return;
        // Three.js is Y-up. Keep source/GLB data untouched and rotate the
        // displayed CAD root so its native Z axis is visually up.
        root = new THREE.Group();
        root.rotation.x = -Math.PI / 2;
        root.add(gltf.scene);
        scene.add(root);
        selectable = [];
        root.traverse((object) => {
          if ((object as THREE.Mesh).isMesh) selectable.push(object);
        });
        frame();
      },
      undefined,
      (loadError) => setError(loadError instanceof Error ? loadError.message : "Could not load GLB.")
    );

    animate();

    return () => {
      disposed = true;
      fitRef.current = null;
      rotateXRef.current = null;
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        materials.forEach((material) => material.dispose());
      });
    };
  }, [model?.has_display_glb, slug]);

  return (
    <div className="h-screen overflow-hidden" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <header className="relative z-20 flex min-h-14 items-center justify-between gap-3 border-b px-3 md:px-4" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
        <div className="flex min-w-0 items-center gap-3">
          <a className="secondary-button" href="/admin"><ArrowLeft size={16} /> Admin</a>
          <div className="h-6 w-px" style={{ background: "var(--line)" }} />
          <div className="min-w-0">
            <h1 className="truncate font-display text-lg font-bold text-[var(--accent)]">{model?.name ?? "Model viewer"}</h1>
            <p className="truncate text-xs" style={{ color: "var(--subtle)" }}>{model ? `${model.source_filename} / ${model.status}` : slug}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {model ? (
            <>
              <a className="secondary-button hidden sm:inline-flex" href={`/downloads/${encodeURIComponent(slug)}/original`}>STEP</a>
              {model.has_display_glb ? <a className="secondary-button hidden sm:inline-flex" href={`/downloads/${encodeURIComponent(slug)}/display.glb`}><Download size={15} /> GLB</a> : null}
            </>
          ) : null}
        </div>
      </header>

      <main className="relative h-[calc(100vh-3.5rem)] overflow-hidden" style={{ background: "var(--panel-soft)" }}>
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="grid max-w-md place-items-center gap-3 rounded border p-8 text-center" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
              <Box className="text-[var(--accent)]" size={38} />
              <h2 className="font-display text-xl font-bold">Model unavailable</h2>
              <p className="text-sm" style={{ color: "var(--subtle)" }}>{error}</p>
            </div>
          </div>
        ) : !model?.has_display_glb ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="grid max-w-md place-items-center gap-3 rounded border p-8 text-center" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
              <Box className="text-[var(--accent)]" size={38} />
              <h2 className="font-display text-xl font-bold">Model not processed yet</h2>
              <p className="text-sm" style={{ color: "var(--subtle)" }}>The original file is uploaded, but there is no display.glb for this model yet.</p>
            </div>
          </div>
        ) : null}

        <div ref={canvasHost} className="h-full w-full" />

        <div className="absolute bottom-4 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-2 shadow-panel backdrop-blur" style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--panel) 88%, transparent)", color: "var(--muted)" }}>
          <MousePointer2 size={17} />
          <Move3D size={17} />
          <ZoomIn size={17} />
          <button className="grid h-8 w-8 place-items-center rounded-full hover:bg-[var(--panel-strong)] hover:text-[var(--accent)]" type="button" title="Fit model" aria-label="Fit model" onClick={() => fitRef.current?.()}>
            <Focus size={17} />
          </button>
          <button className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 hover:bg-[var(--panel-strong)] hover:text-[var(--accent)]" type="button" title="Rotate model 90 degrees around X" aria-label="Rotate X 90 degrees" onClick={() => rotateXRef.current?.()}>
            <RotateCw size={17} /><span className="hidden text-xs font-bold sm:inline">Rotate X 90°</span>
          </button>
          <div className="h-5 w-px shrink-0" style={{ background: "var(--line)" }} />
          <span className="min-w-0 max-w-[46vw] truncate text-xs" title={selectedName === "none" ? undefined : selectedName}>
            <strong className="text-[var(--text)]">Selected:</strong> {selectedName}
          </span>
        </div>
      </main>
    </div>
  );
}

function selectedDisplayName(object: THREE.Object3D): string {
  const sources = metadataSources(object);
  for (const key of ["displayName", "objectName", "blockName", "componentName"]) {
    for (const source of sources) {
      const name = readableName(source.value[key]);
      if (name) return name;
    }
  }
  for (const source of sources) {
    const layer = readableName(firstValue(source.value, ["layerNames", "layerName", "layer"]));
    if (layer) return layer;
  }
  return readableName(object.name) ?? "Unnamed object";
}

function metadataSources(object: THREE.Object3D): MetadataSource[] {
  const sources: MetadataSource[] = [];
  let current: THREE.Object3D | null = object;
  while (current) {
    if (hasMetadata(current.userData)) {
      sources.push({ source: current === object ? "node" : "ancestor-node", name: current.name, value: current.userData });
    }
    current = current.parent;
  }

  const mesh = object as THREE.Mesh;
  if (hasMetadata(mesh.geometry?.userData)) {
    sources.push({ source: "geometry", name: mesh.geometry.name || "", value: mesh.geometry.userData });
  }

  const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
  materials.forEach((material) => {
    if (hasMetadata(material.userData)) {
      sources.push({ source: "material", name: material.name || "", value: material.userData });
    }
  });

  return sources;
}

function hasMetadata(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) => key !== "gltfExtensions");
}

function firstValue(object: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function readableName(value: unknown): string | undefined {
  if (Array.isArray(value)) value = value.find((item) => readableName(item));
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || /^=>\s*\[[\d:]+\]$/.test(name) || /^\d+(?::\d+)+$/.test(name)) return undefined;
  return name;
}
