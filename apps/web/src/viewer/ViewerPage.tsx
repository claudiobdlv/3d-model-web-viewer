import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft, Box, Download, Focus, Moon, MousePointer2, Move3D, Sun, X, ZoomIn } from "lucide-react";
import { getModel } from "../api";
import type { ModelRecord, ThemeMode } from "../types";

type SelectedInfo = {
  title: string;
  subtitle: string;
  merged: Record<string, unknown>;
  sources: Array<{ source: string; name: string; value: Record<string, unknown> }>;
};

export function ViewerPage({ theme, onToggleTheme }: { theme: ThemeMode; onToggleTheme: () => void }) {
  const slug = useMemo(() => window.location.pathname.split("/").filter(Boolean).pop() ?? "", []);
  const [model, setModel] = useState<ModelRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedInfo | null>(null);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void getModel(slug)
      .then(setModel)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Model not found."));
  }, [slug]);

  useEffect(() => {
    if (!model?.has_display_glb || !canvasHost.current) return undefined;

    const host = canvasHost.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme === "dark" ? 0x0b0d10 : 0xf4f7fb);

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

    let root: THREE.Object3D | null = null;
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
      if (hit) setSelected(toSelectedInfo(hit.object));
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
        root = gltf.scene;
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

  useEffect(() => {
    const canvas = canvasHost.current?.querySelector("canvas");
    if (!canvas) return;
    const color = theme === "dark" ? "#0b0d10" : "#f4f7fb";
    canvas.style.background = color;
  }, [theme]);

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
          <button className="icon-button" type="button" onClick={onToggleTheme} aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
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

        <div className="pointer-events-none absolute bottom-5 left-5 hidden h-28 w-28 md:block">
          <svg viewBox="0 0 100 100" className="h-full w-full">
            <line x1="50" x2="86" y1="50" y2="50" stroke="#ff6464" strokeWidth="2" />
            <text x="88" y="54" fill="#ff6464" fontSize="10" fontWeight="800">X</text>
            <line x1="50" x2="50" y1="50" y2="14" stroke="#4ade80" strokeWidth="2" />
            <text x="47" y="12" fill="#4ade80" fontSize="10" fontWeight="800">Y</text>
            <line x1="50" x2="29" y1="50" y2="71" stroke="#6d8dff" strokeWidth="2" />
            <text x="19" y="79" fill="#6d8dff" fontSize="10" fontWeight="800">Z</text>
            <circle cx="50" cy="50" r="3" fill="var(--text)" />
          </svg>
        </div>

        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-2 shadow-panel backdrop-blur" style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--panel) 88%, transparent)", color: "var(--muted)" }}>
          <MousePointer2 size={17} />
          <Move3D size={17} />
          <ZoomIn size={17} />
          <button className="grid h-8 w-8 place-items-center rounded-full hover:bg-[var(--panel-strong)] hover:text-[var(--accent)]" type="button" title="Fit model" aria-label="Fit model" onClick={() => fitRef.current?.()}>
            <Focus size={17} />
          </button>
        </div>

        {selected ? <ObjectInfo info={selected} onClose={() => setSelected(null)} /> : null}
      </main>
    </div>
  );
}

function ObjectInfo({ info, onClose }: { info: SelectedInfo; onClose: () => void }) {
  const fields: Array<[string, unknown]> = [
    ["Object/block/component name", firstValue(info.merged, ["displayName", "name", "blockName", "componentName"]) ?? info.title],
    ["Layer", firstValue(info.merged, ["layerNames", "layers", "layerName", "layer"])],
    ["Colour source", firstValue(info.merged, ["colourSource", "colorSource", "materialSource"])],
    ["Geometry source", firstValue(info.merged, ["geometrySource"])],
    ["STEP IDs", firstValue(info.merged, ["stepEntityIds", "stepEntityId", "stepStyledItemId"])],
    ["XCAF label path", firstValue(info.merged, ["xcafLabelPath", "labelPath"])],
    ["Referred label path", firstValue(info.merged, ["referredLabelPath"])]
  ];

  return (
    <aside className="absolute right-3 top-3 max-h-[calc(100%-1.5rem)] w-[min(390px,calc(100%-1.5rem))] overflow-auto rounded border shadow-panel backdrop-blur md:right-5 md:top-5" style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--panel) 92%, transparent)" }}>
      <div className="flex items-start justify-between gap-3 border-b p-4" style={{ borderColor: "var(--line)", background: "var(--panel-strong)" }}>
        <div className="min-w-0">
          <span className="eyebrow">Object info</span>
          <h2 className="mt-1 truncate font-display text-lg font-bold text-[var(--accent)]">{info.title}</h2>
          <p className="truncate text-xs" style={{ color: "var(--subtle)" }}>{info.subtitle}</p>
        </div>
        <button className="icon-button" type="button" aria-label="Close object info" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="grid gap-3 p-4">
        {fields.map(([label, value]) => (
          <div key={label} className="grid grid-cols-1 gap-1 border-b pb-3" style={{ borderColor: "var(--line-soft)" }}>
            <dt className="font-display text-[10px] font-extrabold uppercase tracking-[0.06em]" style={{ color: "var(--subtle)" }}>{label}</dt>
            <dd className="min-w-0 break-words text-xs">{formatValue(value)}</dd>
          </div>
        ))}
        <details>
          <summary className="cursor-pointer font-display text-xs font-extrabold uppercase tracking-[0.06em] text-[var(--accent)]">Advanced raw metadata</summary>
          <pre className="mt-3 max-h-72 overflow-auto rounded border p-3 font-mono text-[11px]" style={{ borderColor: "var(--line)", background: "var(--bg)", color: "var(--muted)" }}>
            {JSON.stringify({ merged: info.merged, sources: info.sources }, null, 2)}
          </pre>
        </details>
      </div>
    </aside>
  );
}

function toSelectedInfo(object: THREE.Object3D): SelectedInfo {
  const sources = metadataSources(object);
  const merged = Object.assign({}, ...sources.map((source) => source.value)) as Record<string, unknown>;
  const title = String(firstValue(merged, ["displayName", "name", "blockName", "componentName"]) ?? object.name ?? "Selected object");
  return {
    title,
    subtitle: object.name || object.type || "",
    merged,
    sources
  };
}

function metadataSources(object: THREE.Object3D): SelectedInfo["sources"] {
  const sources: SelectedInfo["sources"] = [];
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

function formatValue(value: unknown): React.ReactNode {
  if (value === undefined || value === null || value === "") return <span style={{ color: "var(--subtle)" }}>Not available</span>;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return <code className="break-words font-mono text-[11px]" style={{ color: "var(--muted)" }}>{JSON.stringify(value)}</code>;
  return String(value);
}
