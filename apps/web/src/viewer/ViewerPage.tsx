import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { ArrowLeft, Box, Download, Home, Sun, Moon } from "lucide-react";
import { getModel, getPublicModel, saveModelDefaultView } from "../api";
import type { ModelRecord, ModelRevisionRecord, PublicModel, PublicRevisionSummary } from "../types";

type MetadataSource = { source: string; name: string; value: Record<string, unknown> };

// --- Marquee Auto-Scroll Text Component ---
// Automatically scrolls text horizontally if it overflows its container.
// Includes pauses at the start and end, and respects reduced-motion preferences.
function MarqueeText({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    setScrollDistance(0);

    const measure = () => {
      const container = containerRef.current;
      const textEl = textRef.current;
      if (!container || !textEl) return;

      const containerWidth = container.getBoundingClientRect().width;
      const textWidth = textEl.scrollWidth;

      if (textWidth > containerWidth) {
        setScrollDistance(textWidth - containerWidth);
      } else {
        setScrollDistance(0);
      }
    };

    const timer = setTimeout(measure, 50);

    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  const scrollTime = scrollDistance / 50; // 50 px/sec
  const pauseTime = 0.6; // 0.6s pause
  const totalDuration = 2 * pauseTime + 2 * scrollTime;

  const p1 = totalDuration > 0 ? (pauseTime / totalDuration) * 100 : 0;
  const p2 = totalDuration > 0 ? ((pauseTime + scrollTime) / totalDuration) * 100 : 0;
  const p3 = totalDuration > 0 ? ((2 * pauseTime + scrollTime) / totalDuration) * 100 : 0;

  const animationName = `marquee-${Math.round(scrollDistance)}-${Math.round(totalDuration * 10)}`;

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden whitespace-nowrap w-full flex items-center"
      style={{ display: "flex", minHeight: "1rem" }}
    >
      {scrollDistance > 0 && !prefersReducedMotion ? (
        <>
          <style>{`
            @keyframes ${animationName} {
              0%, ${p1}% { transform: translate3d(0, 0, 0); }
              ${p2}%, ${p3}% { transform: translate3d(-${scrollDistance}px, 0, 0); }
              100% { transform: translate3d(0, 0, 0); }
            }
          `}</style>
          <span
            ref={textRef}
            className="inline-block text-xs leading-none"
            style={{
              animation: `${animationName} ${totalDuration}s linear infinite`,
            }}
          >
            {text}
          </span>
        </>
      ) : (
        <span
          ref={textRef}
          className="inline-block max-w-full truncate text-xs leading-none"
          style={{ textOverflow: "ellipsis" }}
        >
          {text}
        </span>
      )}
    </div>
  );
}

export function ViewerPage({ publicToken, theme, toggleTheme }: { publicToken?: string; theme?: "dark" | "light"; toggleTheme?: () => void }) {
  const isPublic = !!publicToken;
  const slug = useMemo(() => window.location.pathname.split("/").filter(Boolean).pop() ?? "", []);
  const initialRevisionId = useMemo(() => {
    const value = Number(new URLSearchParams(window.location.search).get("revisionId"));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }, []);
  const adminReturnPath = useMemo(() => { const candidate=new URLSearchParams(window.location.search).get("returnTo"); return candidate?.startsWith("/admin") ? candidate : "/admin"; }, []);
  const [model, setModel] = useState<ModelRecord | PublicModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState("none");
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const updateThemeRef = useRef<((theme: "dark" | "light") => void) | null>(null);
  const saveViewRef = useRef<(() => Promise<void>) | null>(null);
  const clearViewRef = useRef<(() => Promise<void>) | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [requestedRevisionId, setRequestedRevisionId] = useState<number | undefined>(initialRevisionId);

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const savedViewRef = useRef<{
    version: number;
    cameraPosition: [number, number, number];
    target: [number, number, number];
    rootQuaternion?: [number, number, number, number];
    fov?: number;
  } | null>(null);

  useEffect(() => {
    if (model && model.default_view_json) {
      try {
        savedViewRef.current = JSON.parse(model.default_view_json);
      } catch (e) {
        console.error("Failed to parse default view JSON", e);
        savedViewRef.current = null;
      }
    } else {
      savedViewRef.current = null;
    }
  }, [model]);

  // Propagate theme changes into the live Three.js scene without reloading the GLB.
  useEffect(() => {
    if (updateThemeRef.current && theme) {
      updateThemeRef.current(theme);
    }
  }, [theme]);

  useEffect(() => {
    setError(null);
    void (publicToken ? getPublicModel(publicToken, requestedRevisionId) : getModel(slug, requestedRevisionId))
      .then((loadedModel) => {
        setModel(loadedModel);
        const activeRevision = loadedModel.activeRevision;
        if (loadedModel.invalidRevisionRequested && activeRevision) {
          setRequestedRevisionId(activeRevision.id);
          updateRevisionUrl(activeRevision.id);
        }
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Model not found."));
  }, [publicToken, requestedRevisionId, slug]);

  const activeRevision = model?.activeRevision ?? null;
  const hasDisplayGlb = model
    ? Boolean(model.glb_url) && (!activeRevision || activeRevision.status === undefined || activeRevision.status === "ready")
    : false;
  const glbUrl = model
    ? model.glb_url
    : "";
  const availableRevisions = model?.revisions ?? [];
  const activeRevisionIsSelectable = Boolean(
    activeRevision && availableRevisions.some((revision) => revision.id === activeRevision.id)
  );
  const showRevisionDropdown = isPublic
    ? Boolean(
        model
        && "allowRevisionSwitching" in model
        && model.allowRevisionSwitching
        && (availableRevisions.length > 1 || (!activeRevisionIsSelectable && availableRevisions.length > 0))
      )
    : availableRevisions.length > 1;

  const selectRevision = (revisionId: number) => {
    if (revisionId === activeRevision?.id) return;
    setRequestedRevisionId(revisionId);
    updateRevisionUrl(revisionId);
  };

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
    let modelRadius = 1;
    let modelCenter = new THREE.Vector3();
    let defaultCamOffset = new THREE.Vector3(); // camera offset from target at default view
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
    const DEFAULT_CAM_DIR = new THREE.Vector3(-0.4, 1.1, 0.9).normalize();

    // --- Responsive saved-view helper ---
    // On mobile / narrow screens the saved desktop composition may be too
    // zoomed-in.  This helper preserves the saved camera *direction* and
    // orientation but zooms out just enough so the full model bounding
    // sphere fits inside the viewport with a small margin (1.12×).
    // On desktop the saved offset is returned unchanged.
    const MOBILE_BREAKPOINT = 768;
    const FIT_MARGIN = 1.12;
    function getResponsiveCameraOffset(
      savedCameraOffset: THREE.Vector3,
      fov: number,
      aspect: number,
      radius: number,
    ): THREE.Vector3 {
      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      if (!isMobile) return savedCameraOffset.clone();

      const savedDistance = savedCameraOffset.length();
      const direction = savedCameraOffset.clone().normalize();

      // Required distance so the bounding sphere fits both the vertical
      // and horizontal field-of-view, whichever is tighter.
      const vFov = THREE.MathUtils.degToRad(fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const fitFov = Math.min(vFov, hFov);
      const fitDistance = (radius / Math.sin(fitFov / 2)) * FIT_MARGIN;

      // Never zoom in closer than the saved desktop composition.
      const finalDistance = Math.max(savedDistance, fitDistance);
      return direction.multiplyScalar(finalDistance);
    }

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
      const distance = (radius / Math.sin(fitFov / 2)) * 1.1;

      modelRadius = radius;
      modelCenter = center.clone();

      controls.target.copy(center);
      const camOffset = DEFAULT_CAM_DIR.clone().multiplyScalar(distance);
      camera.position.copy(center).add(camOffset);
      defaultCamOffset = camOffset.clone();

      controls.minDistance = Math.max(radius * 0.04, 0.01);
      controls.maxDistance = radius * 100;

      camera.near = Math.max(radius * 0.001, 0.001);
      camera.far = distance + radius * 4;
      camera.updateProjectionMatrix();
      controls.update();
    };

    resetViewRef.current = () => {
      if (!root) return;
      stopIntro();
      cancelResetAnimation();

      const savedView = savedViewRef.current;
      let targetCamPos: THREE.Vector3;
      let targetTarget: THREE.Vector3;
      let targetRootQ: THREE.Quaternion;

      if (savedView) {
        const targetOffset = new THREE.Vector3().fromArray(savedView.target);
        const rawCameraOffset = new THREE.Vector3().fromArray(savedView.cameraPosition);
        const responsiveCameraOffset = getResponsiveCameraOffset(
          rawCameraOffset, camera.fov, camera.aspect, modelRadius,
        );
        targetTarget = modelCenter.clone().add(targetOffset);
        targetCamPos = targetTarget.clone().add(responsiveCameraOffset);
        targetRootQ = savedView.rootQuaternion
          ? new THREE.Quaternion().fromArray(savedView.rootQuaternion)
          : new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ"));
      } else {
        targetTarget = modelCenter.clone();
        targetCamPos = modelCenter.clone().add(defaultCamOffset);
        targetRootQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ"));
      }

      startResetAnimation(
        camera.position.clone(),
        targetCamPos,
        controls.target.clone(),
        targetTarget,
        root.quaternion.clone(),
        targetRootQ
      );
    };

    saveViewRef.current = async () => {
      if (!camera || !controls || !root) return;

      const cameraOffset = camera.position.clone().sub(controls.target);
      const targetOffset = controls.target.clone().sub(modelCenter);

      const viewState = {
        version: 1,
        cameraPosition: [cameraOffset.x, cameraOffset.y, cameraOffset.z],
        target: [targetOffset.x, targetOffset.y, targetOffset.z],
        rootQuaternion: [root.quaternion.x, root.quaternion.y, root.quaternion.z, root.quaternion.w],
        fov: camera.fov
      };

      try {
        const updatedModel = await saveModelDefaultView(slug, viewState);
        setModel(updatedModel);
        showToast("success", "Start view saved successfully!");
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : "Failed to save start view.");
      }
    };

    clearViewRef.current = async () => {
      try {
        const updatedModel = await saveModelDefaultView(slug, null);
        setModel(updatedModel);
        showToast("success", "Saved start view cleared!");
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : "Failed to clear start view.");
      }
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

    function render() {
      animationFrame = null;
      if (disposed) return;

      const now = performance.now();
      let needsMore = false;

      // --- Reset / axis-snap animation ---
      // Controls are disabled for the duration (see startResetAnimation).
      // We directly drive camera position, target, and root quaternion.
      if (resetAnimation) {
        const progress = Math.min((now - resetAnimation.startedAt) / RESET_DURATION, 1);
        const eased = easeInOutCubic(progress);

        camera.position.lerpVectors(resetAnimation.fromCamPos, resetAnimation.toCamPos, eased);
        // Lerp the target into a temp first, then copy — avoids controls.target
        // being read in a half-updated state by any listener.
        const _tmpVec = new THREE.Vector3();
        _tmpVec.lerpVectors(resetAnimation.fromTarget, resetAnimation.toTarget, eased);
        controls.target.copy(_tmpVec);

        if (root) {
          const _tmpQuat = new THREE.Quaternion();
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
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        modelRadius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
        modelCenter = box.getCenter(new THREE.Vector3());

        const savedView = savedViewRef.current;
        if (savedView) {
          const targetOffset = new THREE.Vector3().fromArray(savedView.target);
          const rawCameraOffset = new THREE.Vector3().fromArray(savedView.cameraPosition);
          const targetPos = modelCenter.clone().add(targetOffset);

          // Apply saved FOV first so the responsive helper uses the correct value.
          if (savedView.fov !== undefined) {
            camera.fov = savedView.fov;
            camera.updateProjectionMatrix();
          }

          const responsiveCameraOffset = getResponsiveCameraOffset(
            rawCameraOffset, camera.fov, camera.aspect, modelRadius,
          );
          const cameraPos = targetPos.clone().add(responsiveCameraOffset);

          camera.position.copy(cameraPos);
          controls.target.copy(targetPos);

          if (savedView.rootQuaternion && root) {
            root.quaternion.set(
              savedView.rootQuaternion[0],
              savedView.rootQuaternion[1],
              savedView.rootQuaternion[2],
              savedView.rootQuaternion[3]
            );
          }
          camera.updateProjectionMatrix();
          controls.update();

          const verticalFov = THREE.MathUtils.degToRad(camera.fov);
          const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
          const fitFov = Math.min(verticalFov, horizontalFov);
          const distance = (modelRadius / Math.sin(fitFov / 2)) * 1.1;
          defaultCamOffset = DEFAULT_CAM_DIR.clone().multiplyScalar(distance);

          intro = null;
        } else {
          frame();
          intro = { startedAt: performance.now() + 250, baseOffset: camera.position.clone().sub(controls.target) };
        }

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
      resetViewRef.current = null;
      saveViewRef.current = null;
      clearViewRef.current = null;
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
      <header className="relative z-20 flex min-h-12 sm:min-h-14 items-center justify-between gap-3 border-b px-3 md:px-4" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
        <div className="flex min-w-0 items-center gap-3">
          {!isPublic ? <><a className="secondary-button" href={adminReturnPath}><ArrowLeft size={16} /> Admin</a><div className="h-6 w-px" style={{ background: "var(--line)" }} /></> : null}
          <div className="min-w-0">
            <h1 className="truncate font-display text-lg font-bold text-[var(--accent)] leading-tight">{model?.name ?? "Model viewer"}</h1>
            {activeRevision ? (
              <div className="truncate text-[11px] font-medium leading-tight" style={{ color: "var(--subtle)" }}>
                {formatRevisionLine(activeRevision)}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showRevisionDropdown ? (
            <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
              <span className="hidden md:inline">Revision</span>
              <select
                className="h-9 max-w-[180px] rounded-lg border px-2 text-xs font-semibold"
                style={{ borderColor: "var(--line)", background: "var(--panel-soft)", color: "var(--text)" }}
                value={activeRevision?.id ?? ""}
                onChange={(event) => selectRevision(Number(event.target.value))}
                aria-label="Revision"
              >
                {activeRevision && !availableRevisions.some((revision) => revision.id === activeRevision.id) ? (
                  <option value={activeRevision.id} disabled>{revisionOptionLabel(activeRevision, true)}</option>
                ) : null}
                {availableRevisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revisionOptionLabel(revision, false)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
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
          {model && !publicToken && "source_filename" in model && hasDisplayGlb ? (
              <a className="secondary-button hidden sm:inline-flex" href={model.glb_download_url ?? `/downloads/${encodeURIComponent(slug)}/display.glb`}><Download size={15} /> GLB</a>
          ) : null}
        </div>
      </header>

      {/* Main 3-D viewport */}
      <main className="relative h-[calc(100dvh-3.5rem)] overflow-hidden" style={{ background: "var(--panel-soft)" }}>
        {/* Toast Notification */}
        {toast && (
          <div
            className="fixed right-4 top-16 z-50 flex items-center gap-2 rounded-xl border px-4 py-2.5 shadow-lg backdrop-blur-md transition-all duration-300"
            style={{
              borderColor: toast.type === "success" ? "var(--ready)" : "var(--failed)",
              background: "color-mix(in srgb, var(--panel) 90%, transparent)",
              color: toast.type === "success" ? "var(--ready)" : "var(--failed)"
            }}
          >
            <span className="font-bold text-xs">{toast.message}</span>
          </div>
        )}

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



        {/*
          Bottom toolbar: Home | separator | Selected object
          ─────────────────────────────────────────────────────────────────────────
        */}
        <div
          className="absolute left-1/2 z-10 flex w-[calc(100vw-32px)] max-w-[520px] sm:w-fit sm:max-w-[720px] -translate-x-1/2 items-center gap-1.5 rounded-2xl border px-3 py-1.5 shadow-panel backdrop-blur"
          style={{
            bottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
            borderColor: "var(--line)",
            background: "color-mix(in srgb, var(--panel) 88%, transparent)",
            color: "var(--muted)",
            transition: "max-width 180ms ease-out, padding 180ms ease-out",
            minWidth: "260px",
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

          {!isPublic && (
            <>
              <button
                className="flex h-10 shrink-0 items-center gap-1 rounded-xl px-2 transition hover:bg-[var(--panel-strong)] hover:text-[var(--ready)] text-[var(--muted)]"
                type="button"
                title="Save current view as start view"
                aria-label="Save start view"
                onClick={() => saveViewRef.current?.()}
              >
                <span className="text-xs font-bold">Save</span>
              </button>

              {model?.default_view_json ? (
                <button
                  className="flex h-10 shrink-0 items-center gap-1 rounded-xl px-2 transition hover:bg-[var(--panel-strong)] hover:text-[var(--failed)] text-[var(--muted)]"
                  type="button"
                  title="Clear saved start view"
                  aria-label="Clear start view"
                  onClick={() => clearViewRef.current?.()}
                >
                  <span className="text-xs font-bold">Clear</span>
                </button>
              ) : null}
            </>
          )}

          <div className="h-5 w-px shrink-0" style={{ background: "var(--line)" }} />

          {/* Selected object name – never pushes buttons; scrolls dynamically if long */}
          <div
            className="flex items-center gap-1 min-w-0 flex-1 px-1 text-xs"
          >
            <strong className="text-[var(--text)] shrink-0 leading-none">Selected:</strong>
            <div className="min-w-0 flex-1 flex items-center">
              <MarqueeText text={selectedName} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function updateRevisionUrl(revisionId: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set("revisionId", String(revisionId));
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function formatRevisionLine(revision: ModelRevisionRecord | PublicRevisionSummary): string {
  const revisionText = `Rev ${revision.revision_label}`;
  if (!revision.issued_date) return revisionText;
  const issuedDate = new Date(`${revision.issued_date}T00:00:00`);
  if (Number.isNaN(issuedDate.valueOf())) return revisionText;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][issuedDate.getMonth()];
  return `${revisionText} · Issued ${issuedDate.getDate()} ${month} ${issuedDate.getFullYear()}`;
}

function revisionOptionLabel(
  revision: ModelRevisionRecord | PublicRevisionSummary,
  linkedOnly: boolean
): string {
  if (linkedOnly) return `Rev ${revision.revision_label} — linked`;
  return `Rev ${revision.revision_label}${revision.is_current ? " — current" : ""}`;
}

function isUsefulDisplayName(name: string): boolean {
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

function selectedDisplayName(object: THREE.Object3D): string {
  const sources = metadataSources(object);

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
  if (!isUsefulDisplayName(name)) return undefined;
  return name;
}

function stableIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value).trim();
  return id || undefined;
}
