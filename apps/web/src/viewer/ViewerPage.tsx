import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { ArrowLeft, Box, Download, RotateCw, Home, Sun, Moon } from "lucide-react";
import { getModel, getPublicModel } from "../api";
import type { ModelRecord, PublicModel } from "../types";

type MetadataSource = { source: string; name: string; value: Record<string, unknown> };

// --- SVG Gimbal Component ---
// Renders a small interactive XYZ orientation indicator in the top-right of the viewer.
// The gimbal state is updated from inside the render loop via a React ref callback.

type GimbalAxis = { label: string; color: string; x: number; y: number; z: number; dot: number };

function OrientationGimbal({
  gimbalRef,
  onAxisClick,
}: {
  gimbalRef: React.RefObject<((camQ: THREE.Quaternion, rootQ: THREE.Quaternion) => void) | null>;
  onAxisClick: (axis: string) => void;
}) {
  // We store the computed 2-D axis endpoints in state and update them from the render loop.
  const [axes, setAxes] = useState<GimbalAxis[]>([]);
  const localRef = useRef<(camQ: THREE.Quaternion, rootQ: THREE.Quaternion) => void>(() => {});

  useEffect(() => {
    // World-space axis directions after the Z-up correction (root rotates -90° around X so that
    // the CAD Z axis points up in Three.js/screen space).
    const WORLD_AXES = [
      { label: "+X", color: "#ef4444", dir: new THREE.Vector3(1, 0, 0) },
      { label: "-X", color: "#f87171", dir: new THREE.Vector3(-1, 0, 0) },
      { label: "+Y", color: "#22c55e", dir: new THREE.Vector3(0, 1, 0) },
      { label: "-Y", color: "#4ade80", dir: new THREE.Vector3(0, -1, 0) },
      // +Z is visually "up" (was the CAD Z axis before -90° root rotation)
      { label: "+Z", color: "#3b82f6", dir: new THREE.Vector3(0, 0, 1) },
      { label: "-Z", color: "#93c5fd", dir: new THREE.Vector3(0, 0, -1) },
    ];

    localRef.current = (camQ: THREE.Quaternion, rootQ: THREE.Quaternion) => {
      // Camera view matrix: to map world → camera space we use the camera quaternion inverse.
      const camQInv = camQ.clone().invert();
      const result: GimbalAxis[] = WORLD_AXES.map(({ label, color, dir }) => {
        // 1. Apply root model rotation to the axis (accounts for Rotate X/Y transforms).
        const rotated = dir.clone().applyQuaternion(rootQ);
        // 2. Transform into camera space so it appears relative to the current view.
        const inCam = rotated.clone().applyQuaternion(camQInv);
        // 3. Simple orthographic projection: x → right, y → up, z → depth
        //    SVG Y grows downward so negate y.
        const SIZE = 44; // half-width of gimbal SVG canvas in px
        return {
          label,
          color,
          x: inCam.x * SIZE * 0.7,
          y: -inCam.y * SIZE * 0.7,
          z: inCam.z,       // depth: positive = towards viewer
          dot: inCam.z,
        };
      });
      // Sort so axes pointing towards the viewer render on top.
      result.sort((a, b) => a.z - b.z);
      setAxes(result);
    };

    // Expose to parent via ref.
    (gimbalRef as React.MutableRefObject<typeof localRef.current>).current = localRef.current;
    return () => {
      (gimbalRef as React.MutableRefObject<typeof localRef.current | null>).current = null;
    };
  }, [gimbalRef]);

  const SIZE = 88; // total SVG size in px
  const CENTER = SIZE / 2;
  const STICK = 30; // length of each axis line

  return (
    <div
      className="absolute right-3 z-10 select-none"
      style={{ top: "calc(3.5rem + 12px)", pointerEvents: "auto" }}
      aria-label="XYZ orientation gimbal"
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ overflow: "visible", filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.5))" }}
      >
        {/* Subtle background circle */}
        <circle cx={CENTER} cy={CENTER} r={CENTER - 4} fill="rgba(0,0,0,0.18)" />
        {axes.map((axis) => {
          const ex = CENTER + axis.x;
          const ey = CENTER + axis.y;
          const opacity = axis.dot >= 0 ? 1 : 0.35;
          const isPositive = axis.label.startsWith("+");
          return (
            <g
              key={axis.label}
              style={{ cursor: "pointer", opacity }}
              onClick={() => onAxisClick(axis.label)}
              aria-label={`Snap camera to ${axis.label} axis`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onAxisClick(axis.label)}
            >
              {isPositive && (
                <line
                  x1={CENTER}
                  y1={CENTER}
                  x2={ex}
                  y2={ey}
                  stroke={axis.color}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                />
              )}
              {isPositive ? (
                <circle cx={ex} cy={ey} r={8} fill={axis.color} />
              ) : (
                <circle cx={ex} cy={ey} r={5} fill="none" stroke={axis.color} strokeWidth={2} />
              )}
              {isPositive && (
                <text
                  x={ex}
                  y={ey}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={7}
                  fontWeight="bold"
                  fill="white"
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {axis.label[1]}
                </text>
              )}
            </g>
          );
        })}
        {/* Central dot */}
        <circle cx={CENTER} cy={CENTER} r={4} fill="white" opacity={0.9} />
      </svg>
    </div>
  );
}

export function ViewerPage({ publicToken, theme, toggleTheme }: { publicToken?: string; theme?: "dark" | "light"; toggleTheme?: () => void }) {
  const slug = useMemo(() => window.location.pathname.split("/").filter(Boolean).pop() ?? "", []);
  const [model, setModel] = useState<ModelRecord | PublicModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState("none");
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const rotateXRef = useRef<(() => void) | null>(null);
  const rotateYRef = useRef<(() => void) | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const updateThemeRef = useRef<((theme: "dark" | "light") => void) | null>(null);
  const snapAxisRef = useRef<((axis: string) => void) | null>(null);
  const gimbalUpdateRef = useRef<((camQ: THREE.Quaternion, rootQ: THREE.Quaternion) => void) | null>(null);

  // Propagate theme changes into the live Three.js scene without reloading the GLB.
  useEffect(() => {
    if (updateThemeRef.current && theme) {
      updateThemeRef.current(theme);
    }
  }, [theme]);

  useEffect(() => {
    void (publicToken ? getPublicModel(publicToken) : getModel(slug))
      .then(setModel)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Model not found."));
  }, [publicToken, slug]);

  const hasDisplayGlb = model ? ("glb_url" in model || Boolean(model.has_display_glb)) : false;
  const glbUrl = model
    ? ("glb_url" in model ? model.glb_url : `/model-files/${encodeURIComponent(slug)}/display.glb`)
    : "";

  useEffect(() => {
    if (!hasDisplayGlb || !glbUrl || !canvasHost.current) return undefined;

    const host = canvasHost.current;
    const scene = new THREE.Scene();
    const initialBgColor = theme === "light" ? 0xf4f7fb : 0x0b0d10;
    scene.background = new THREE.Color(initialBgColor);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Keep high-density mobile displays crisp while avoiding the 3x-4x fill
    // cost common on phones. The previous 1.5 cap visibly undersampled DPR 2.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(scene.background, 1);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.touchAction = "none";
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.enablePan = true;
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
    let yQuarterTurns = 0;
    let modelRadius = 1;
    let modelCenter = new THREE.Vector3();
    let defaultCamOffset = new THREE.Vector3(); // camera offset from target at default view
    let rotationAnimation: { from: THREE.Quaternion; to: THREE.Quaternion; startedAt: number } | null = null;
    // Reset animation interpolates camera position, OrbitControls target, and root quaternion.
    // Controls are disabled for the duration to prevent damping from fighting the lerp.
    let resetAnimation: {
      fromCamPos: THREE.Vector3; toCamPos: THREE.Vector3;
      fromTarget: THREE.Vector3; toTarget: THREE.Vector3;
      fromRootQ: THREE.Quaternion; toRootQ: THREE.Quaternion;
      startedAt: number;
      controlsWereEnabled: boolean;
    } | null = null;
    let selectable: THREE.Object3D[] = [];
    let pointerStart: { x: number; y: number } | null = null;
    let disposed = false;
    let animationFrame: number | null = null;
    let intro: { startedAt: number; baseOffset: THREE.Vector3 } | null = null;
    let restorePixelRatioTimer: number | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const displayNameCache = new WeakMap<THREE.Object3D, string>();

    // Pre-allocated temporaries for per-frame animation (avoid GC pressure).
    const _tmpVec = new THREE.Vector3();
    const _tmpQuat = new THREE.Quaternion();

    // Throttle gimbal React state updates to ~30 fps to avoid per-frame re-renders.
    let lastGimbalUpdate = 0;
    const GIMBAL_INTERVAL = 33; // ms (~30 fps)

    // Smooth easing: easeInOutCubic
    function easeInOutCubic(t: number): number {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    const requestRender = () => {
      if (!disposed && animationFrame === null) {
        animationFrame = requestAnimationFrame(render);
      }
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      camera.aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
      requestRender();
    };

    // Default camera direction for the higher starting angle (≈60° elevation).
    // Vector components (x, y, z) in Three.js world space (Y-up). After the
    // -90° root rotation the model's native Z appears as Three.js +Y, so this
    // positions the camera slightly in front and high up, looking down.
    const DEFAULT_CAM_DIR = new THREE.Vector3(0.4, 1.1, 0.9).normalize();

    const frame = () => {
      if (!root) return;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const radius = sphere.radius || 1;

      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
      const fitFov = Math.min(verticalFov, horizontalFov);

      // Calculate distance to fit the bounding sphere.
      // Use sin(fitFov / 2) to ensure the sphere fits inside both vertical and horizontal bounds.
      // 1.1x scaling adds a 10% safety margin/padding so the model is framed nicely without clipping.
      const distance = (radius / Math.sin(fitFov / 2)) * 1.1;

      modelRadius = radius;
      modelCenter = center.clone();

      controls.target.copy(center);
      const camOffset = DEFAULT_CAM_DIR.clone().multiplyScalar(distance);
      camera.position.copy(center).add(camOffset);
      defaultCamOffset = camOffset.clone();

      controls.minDistance = Math.max(radius * 0.04, 0.01);
      controls.maxDistance = radius * 100;

      // Conservative initial near/far — will be refined per-frame in render().
      camera.near = Math.max(radius * 0.001, 0.001);
      camera.far = distance + radius * 4;
      camera.updateProjectionMatrix();
      controls.update();
    };

    const rotationTarget = () => new THREE.Quaternion().setFromEuler(new THREE.Euler(
      -Math.PI / 2 + xQuarterTurns * Math.PI / 2,
      yQuarterTurns * Math.PI / 2,
      0,
      "XYZ"
    ));

    const defaultRotationTarget = () => new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ")
    );

    const animateToQuarterTurns = () => {
      if (!root) return;
      rotationAnimation = {
        from: root.quaternion.clone(),
        to: rotationTarget(),
        startedAt: performance.now()
      };
      requestRender();
    };

    rotateXRef.current = () => {
      if (!root) return;
      stopIntro();
      xQuarterTurns = (xQuarterTurns + 1) % 4;
      animateToQuarterTurns();
    };
    rotateYRef.current = () => {
      if (!root) return;
      stopIntro();
      yQuarterTurns = (yQuarterTurns + 1) % 4;
      animateToQuarterTurns();
    };

    resetViewRef.current = () => {
      if (!root) return;
      stopIntro();
      // Cancel any ongoing model rotation animation.
      rotationAnimation = null;
      // Cancel any previous reset/snap in-flight.
      cancelResetAnimation();
      xQuarterTurns = 0;
      yQuarterTurns = 0;
      startResetAnimation(
        camera.position.clone(),
        modelCenter.clone().add(defaultCamOffset),
        controls.target.clone(),
        modelCenter.clone(),
        root.quaternion.clone(),
        defaultRotationTarget(),
      );
    };

    // --- Shared reset/snap animation helpers ---
    function startResetAnimation(
      fromCamPos: THREE.Vector3, toCamPos: THREE.Vector3,
      fromTarget: THREE.Vector3, toTarget: THREE.Vector3,
      fromRootQ: THREE.Quaternion, toRootQ: THREE.Quaternion,
    ) {
      resetAnimation = {
        fromCamPos, toCamPos,
        fromTarget, toTarget,
        fromRootQ, toRootQ,
        startedAt: performance.now(),
        controlsWereEnabled: controls.enabled,
      };
      // Disable controls entirely so damping / internal spherical state
      // cannot fight the animation each frame.
      controls.enabled = false;
      requestRender();
    }

    /** Cancel any in-flight reset/snap animation and restore controls. */
    function cancelResetAnimation() {
      if (!resetAnimation) return;
      const wasEnabled = resetAnimation.controlsWereEnabled;
      resetAnimation = null;
      controls.enabled = wasEnabled;
      // Sync controls to current camera state so there is no snap.
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
    }

    // Snap camera to look along a world axis.
    snapAxisRef.current = (axis: string) => {
      if (!root) return;
      stopIntro();
      // Cancel any previous reset/snap in-flight.
      cancelResetAnimation();
      // We keep Rotate X/Y state unchanged — snapping is a camera move only.
      const dist = camera.position.distanceTo(controls.target);
      const dirs: Record<string, THREE.Vector3> = {
        "+X": new THREE.Vector3(1, 0, 0),
        "-X": new THREE.Vector3(-1, 0, 0),
        "+Y": new THREE.Vector3(0, 1, 0),
        "-Y": new THREE.Vector3(0, -1, 0),
        "+Z": new THREE.Vector3(0, 1, 0.001), // near-top view
        "-Z": new THREE.Vector3(0, -1, 0.001),
      };
      const dir = dirs[axis];
      if (!dir) return;
      startResetAnimation(
        camera.position.clone(),
        controls.target.clone().add(dir.clone().normalize().multiplyScalar(dist)),
        controls.target.clone(),
        controls.target.clone(),
        root.quaternion.clone(),
        root.quaternion.clone(), // keep current model rotation
      );
    };

    const onPointerDown = (event: PointerEvent) => {
      stopIntro();
      cancelResetAnimation(); // user interaction cancels any in-flight reset/snap
      pointerStart = { x: event.clientX, y: event.clientY };
    };

    const onTouchStart = () => {
      stopIntro();
      cancelResetAnimation();
    };

    const onWheel = () => {
      stopIntro();
      cancelResetAnimation();
    };

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    function stopIntro() {
      if (!intro) return;
      intro = null;
      // Sync controls state to the camera's current wiggled position before OrbitControls takes over.
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
    }

    const onControlsStart = () => {
      stopIntro();
      if ((window.devicePixelRatio || 1) > 1.5) {
        if (restorePixelRatioTimer !== null) window.clearTimeout(restorePixelRatioTimer);
        renderer.setPixelRatio(1.5);
        resize();
      }
    };

    const onControlsEnd = () => {
      if ((window.devicePixelRatio || 1) <= 1.5) return;
      if (restorePixelRatioTimer !== null) window.clearTimeout(restorePixelRatioTimer);
      restorePixelRatioTimer = window.setTimeout(() => {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        resize();
      }, 180);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!pointerStart) return;
      const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
      pointerStart = null;
      if (moved > 6) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(pointer, camera);
      // `selectable` already contains every mesh, so recursive intersection
      // only repeats work for nested mesh hierarchies.
      const hit = raycaster.intersectObjects(selectable, false)[0];
      if (!hit) {
        setSelectedName("none");
        return;
      }
      let displayName = displayNameCache.get(hit.object);
      if (!displayName) {
        displayName = selectedDisplayName(hit.object);
        displayNameCache.set(hit.object, displayName);
      }
      setSelectedName(displayName);
    };

    // Animation constants
    const RESET_DURATION = 500;   // ms for Home/snap animations
    const ROT_DURATION = 240;     // ms for Rotate X/Y

    function render() {
      animationFrame = null;
      if (disposed) return;

      const now = performance.now();
      let needsMore = false;

      // --- Model rotation animation (Rotate X/Y buttons) ---
      if (root && rotationAnimation) {
        const progress = Math.min((now - rotationAnimation.startedAt) / ROT_DURATION, 1);
        const eased = easeInOutCubic(progress);
        root.quaternion.slerpQuaternions(rotationAnimation.from, rotationAnimation.to, eased);
        root.updateMatrixWorld(true);
        if (progress >= 1) rotationAnimation = null;
        else needsMore = true;
      }

      // --- Reset / axis-snap animation ---
      // Controls are disabled for the duration (see startResetAnimation).
      // We directly drive camera position, target, and root quaternion.
      if (resetAnimation) {
        const progress = Math.min((now - resetAnimation.startedAt) / RESET_DURATION, 1);
        const eased = easeInOutCubic(progress);

        camera.position.lerpVectors(resetAnimation.fromCamPos, resetAnimation.toCamPos, eased);
        // Lerp the target into a temp first, then copy — avoids controls.target
        // being read in a half-updated state by any listener.
        _tmpVec.lerpVectors(resetAnimation.fromTarget, resetAnimation.toTarget, eased);
        controls.target.copy(_tmpVec);

        if (root) {
          _tmpQuat.slerpQuaternions(resetAnimation.fromRootQ, resetAnimation.toRootQ, eased);
          root.quaternion.copy(_tmpQuat);
          root.updateMatrixWorld(true);
        }

        // Maintain correct camera orientation toward the moving target.
        camera.lookAt(controls.target);
        camera.updateMatrixWorld(true);

        // Update near/far every frame during animation to prevent clipping.
        // (Bypasses the threshold gate below to ensure smoothness.)
        {
          const dist = camera.position.distanceTo(controls.target);
          const minNear = modelRadius * 0.001;
          const rawNear = dist - modelRadius * 2.5;
          camera.near = Math.max(minNear, rawNear > 0 ? rawNear : minNear);
          camera.far = Math.max(dist + modelRadius * 2.5, camera.near * 10);
          camera.updateProjectionMatrix();
        }

        if (progress >= 1) {
          // Snap to exact end values to avoid floating-point drift.
          camera.position.copy(resetAnimation.toCamPos);
          controls.target.copy(resetAnimation.toTarget);
          if (root) {
            root.quaternion.copy(resetAnimation.toRootQ);
            root.updateMatrixWorld(true);
          }
          camera.lookAt(controls.target);
          camera.updateMatrixWorld(true);

          // Restore controls and sync internal spherical coordinates.
          const wasEnabled = resetAnimation.controlsWereEnabled;
          resetAnimation = null;
          controls.enabled = wasEnabled;
          // Temporarily disable damping so controls.update() instantly
          // adopts the new camera/target without any residual velocity.
          const damping = controls.enableDamping;
          controls.enableDamping = false;
          controls.update();
          controls.enableDamping = damping;
        } else {
          needsMore = true;
        }
      }

      // --- Intro wiggle ---
      if (intro) {
        const progress = Math.max(0, Math.min((now - intro.startedAt) / 1800, 1));
        const easedEnvelope = Math.sin(Math.PI * progress);
        const angle = Math.sin(progress * Math.PI * 2) * THREE.MathUtils.degToRad(6) * easedEnvelope;
        camera.position.copy(controls.target).add(intro.baseOffset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle));
        camera.lookAt(controls.target);
        if (progress >= 1) {
          intro = null;
          // Sync controls state to the camera's final wiggled position before OrbitControls takes over.
          const damping = controls.enableDamping;
          controls.enableDamping = false;
          controls.update();
          controls.enableDamping = damping;
        } else {
          needsMore = true;
        }
      }

      // Only update controls if we are NOT in intro or reset animation phase.
      const controlsChanged = (intro || resetAnimation) ? false : controls.update();
      if (controlsChanged) needsMore = true;

      // --- Dynamic near/far to maintain depth precision without clipping ---
      // Skip if we already updated near/far inside the reset animation block above.
      if (root && !resetAnimation) {
        const dist = camera.position.distanceTo(controls.target);
        const minNear = modelRadius * 0.001;
        const rawNear = dist - modelRadius * 2.5;
        const near = Math.max(minNear, rawNear > 0 ? rawNear : minNear);
        const far = Math.max(dist + modelRadius * 2.5, near * 10);
        if (Math.abs(camera.near - near) / near > 0.05 || Math.abs(camera.far - far) / far > 0.05) {
          camera.near = near;
          camera.far = far;
          camera.updateProjectionMatrix();
        }
      }

      // --- Update gimbal (throttled to ~30 fps to avoid React re-render jank) ---
      if (root && gimbalUpdateRef.current && now - lastGimbalUpdate >= GIMBAL_INTERVAL) {
        lastGimbalUpdate = now;
        gimbalUpdateRef.current(camera.quaternion, root.quaternion);
      }

      renderer.render(scene, camera);
      if (needsMore) requestRender();
    }

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    controls.addEventListener("change", requestRender);
    controls.addEventListener("start", onControlsStart);
    controls.addEventListener("end", onControlsEnd);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: true });
    renderer.domElement.addEventListener("wheel", onWheel, { passive: true });
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    setLoadProgress(0);
    loader.load(
      glbUrl,
      (gltf) => {
        if (disposed) return;
        // Three.js is Y-up. Keep source/GLB data untouched and rotate the
        // displayed CAD root so its native Z axis is visually up. Position
        // the root at the model centre so user rotations stay visually fixed
        // around the model instead of orbiting around the GLB origin.
        const content = new THREE.Group();
        content.add(gltf.scene);
        content.updateMatrixWorld(true);
        const pivot = new THREE.Box3().setFromObject(content).getCenter(new THREE.Vector3());
        root = new THREE.Group();
        root.position.copy(pivot);
        root.rotation.x = -Math.PI / 2;
        content.position.sub(pivot);
        root.add(content);
        scene.add(root);
        root.updateMatrixWorld(true);

        // Fix effectively opaque materials to prevent depth-sorting/z-fighting artefacts.
        // Only touch materials where transparent=true but opacity≥0.99 and no alpha map
        // (i.e. they are effectively solid and ended up in the transparent draw pass by mistake).
        root.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((mat) => {
            const m = mat as THREE.MeshStandardMaterial;
            if (
              m.transparent === true &&
              m.opacity >= 0.99 &&
              !m.alphaMap
            ) {
              m.transparent = false;
              m.depthWrite = true;
              m.depthTest = true;
            }
          });
        });

        selectable = [];
        root.traverse((object) => {
          if ((object as THREE.Mesh).isMesh) selectable.push(object);
        });
        frame();
        intro = { startedAt: performance.now() + 250, baseOffset: camera.position.clone().sub(controls.target) };
        setLoadProgress(null);
        requestRender();
      },
      (event) => setLoadProgress(event.total > 0 ? Math.min(event.loaded / event.total, 1) : 0),
      (loadError) => {
        setLoadProgress(null);
        setError(loadError instanceof Error ? loadError.message : "Could not load GLB.");
      }
    );

    // Live theme update without reloading GLB.
    updateThemeRef.current = (newTheme) => {
      const bgColor = newTheme === "light" ? 0xf4f7fb : 0x0b0d10;
      scene.background = new THREE.Color(bgColor);
      renderer.setClearColor(scene.background, 1);
      requestRender();
    };

    requestRender();

    return () => {
      disposed = true;
      updateThemeRef.current = null;
      rotateXRef.current = null;
      rotateYRef.current = null;
      resetViewRef.current = null;
      snapAxisRef.current = null;
      resizeObserver.disconnect();
      controls.removeEventListener("change", requestRender);
      controls.removeEventListener("start", onControlsStart);
      controls.removeEventListener("end", onControlsEnd);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      controls.dispose();
      if (restorePixelRatioTimer !== null) window.clearTimeout(restorePixelRatioTimer);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        materials.forEach((material) => material.dispose());
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glbUrl, hasDisplayGlb]);

  return (
    <div className="w-screen overflow-hidden" style={{ height: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
      <header className="relative z-20 flex min-h-14 items-center justify-between gap-3 border-b px-3 md:px-4" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
        <div className="flex min-w-0 items-center gap-3">
          {!publicToken ? <><a className="secondary-button" href="/admin"><ArrowLeft size={16} /> Admin</a><div className="h-6 w-px" style={{ background: "var(--line)" }} /></> : null}
          <div className="min-w-0">
            <h1 className="truncate font-display text-lg font-bold text-[var(--accent)]">{model?.name ?? "Model viewer"}</h1>
            <p className="truncate text-xs" style={{ color: "var(--subtle)" }}>{model ? ("source_filename" in model ? `${model.source_filename} / ${model.status}` : "Public read-only viewer") : (publicToken ? "Public read-only viewer" : slug)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {theme !== undefined && toggleTheme !== undefined ? (
            <button
              className="secondary-button"
              type="button"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          ) : null}
          {model && !publicToken && "source_filename" in model ? (
            <>
              <a className="secondary-button hidden sm:inline-flex" href={`/downloads/${encodeURIComponent(slug)}/original`}>STEP</a>
              {model.has_display_glb ? <a className="secondary-button hidden sm:inline-flex" href={`/downloads/${encodeURIComponent(slug)}/display.glb`}><Download size={15} /> GLB</a> : null}
            </>
          ) : null}
        </div>
      </header>

      {/* Main 3-D viewport */}
      <main className="relative h-[calc(100dvh-3.5rem)] overflow-hidden" style={{ background: "var(--panel-soft)" }}>
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="grid max-w-md place-items-center gap-3 rounded border p-8 text-center" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
              <Box className="text-[var(--accent)]" size={38} />
              <h2 className="font-display text-xl font-bold">Model unavailable</h2>
              <p className="text-sm" style={{ color: "var(--subtle)" }}>{error}</p>
            </div>
          </div>
        ) : !hasDisplayGlb ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="grid max-w-md place-items-center gap-3 rounded border p-8 text-center" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
              <Box className="text-[var(--accent)]" size={38} />
              <h2 className="font-display text-xl font-bold">Model not processed yet</h2>
              <p className="text-sm" style={{ color: "var(--subtle)" }}>The original file is uploaded, but there is no display.glb for this model yet.</p>
            </div>
          </div>
        ) : null}

        {/* Three.js canvas host */}
        <div ref={canvasHost} className="h-full w-full overflow-hidden touch-none" />

        {/* Loading progress bar */}
        {loadProgress !== null ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-1 overflow-hidden bg-black/20" aria-label="Loading model">
            <div className="h-full bg-[var(--accent-strong)] transition-[width] duration-150" style={{ width: `${Math.max(loadProgress * 100, 3)}%` }} />
          </div>
        ) : null}

        {/* XYZ Orientation Gimbal – top-right, above toolbar */}
        <OrientationGimbal
          gimbalRef={gimbalUpdateRef}
          onAxisClick={(axis) => snapAxisRef.current?.(axis)}
        />

        {/*
          Bottom toolbar: Home | Rotate X | Rotate Y | separator | Selected object
          ─────────────────────────────────────────────────────────────────────────
          Layout strategy for mobile:
          - Positioned with env(safe-area-inset-bottom) to clear the home indicator / nav bar.
          - flex-wrap allows the selected-name row to move below controls on very narrow screens.
          - Buttons use h-10 (40 px) for comfortable touch targets.
          - Selected text is truncated with min-w-0/overflow-hidden so it never pushes buttons away.
          - max-w uses dvw units (supported alongside dvh) to respect real viewport width.
        */}
        <div
          className="absolute left-1/2 z-10 flex w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-2xl border px-2 py-1.5 shadow-panel backdrop-blur"
          style={{
            bottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
            borderColor: "var(--line)",
            background: "color-mix(in srgb, var(--panel) 88%, transparent)",
            color: "var(--muted)",
          }}
        >
          {/* Home / Reset view — always first on left */}
          <button
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2.5 transition hover:bg-[var(--panel-strong)] hover:text-[var(--accent)]"
            type="button"
            title="Reset to default view"
            aria-label="Reset view"
            onClick={() => resetViewRef.current?.()}
          >
            <Home size={16} />
            <span className="hidden text-xs font-bold sm:inline">Reset</span>
          </button>

          <div className="h-5 w-px shrink-0" style={{ background: "var(--line)" }} />

          {/* Rotate X */}
          <button
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2.5 transition hover:bg-[var(--panel-strong)] hover:text-[var(--accent)]"
            type="button"
            title="Rotate model 90 degrees around X"
            aria-label="Rotate X 90 degrees"
            onClick={() => rotateXRef.current?.()}
          >
            <RotateCw size={16} />
            <span className="text-xs font-bold">
              <span className="sm:hidden">X</span>
              <span className="hidden sm:inline">Rotate X 90°</span>
            </span>
          </button>

          {/* Rotate Y */}
          <button
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2.5 transition hover:bg-[var(--panel-strong)] hover:text-[var(--accent)]"
            type="button"
            title="Rotate model 90 degrees around Y"
            aria-label="Rotate Y 90 degrees"
            onClick={() => rotateYRef.current?.()}
          >
            <RotateCw size={16} />
            <span className="text-xs font-bold">
              <span className="sm:hidden">Y</span>
              <span className="hidden sm:inline">Rotate Y 90°</span>
            </span>
          </button>

          <div className="h-5 w-px shrink-0" style={{ background: "var(--line)" }} />

          {/* Selected object name – never pushes buttons; truncates cleanly */}
          <span
            className="min-w-0 max-w-[40vw] overflow-hidden whitespace-nowrap text-xs"
            style={{ textOverflow: "ellipsis", display: "inline-block" }}
            title={selectedName === "none" ? undefined : selectedName}
          >
            <strong className="text-[var(--text)]">Selected:</strong>{" "}
            {selectedName}
          </span>
        </div>
      </main>
    </div>
  );
}

function selectedDisplayName(object: THREE.Object3D): string {
  const sources = metadataSources(object);
  for (const key of ["resolvedObjectName", "blockName", "componentName", "productName", "objectName", "displayName"]) {
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
  if (["document", "compound", "compsolid", "solid", "shell", "shape"].includes(name.toLowerCase())) return undefined;
  return name;
}
