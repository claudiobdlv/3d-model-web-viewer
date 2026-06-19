# Viewer performance comparison

## Reference project

The `Silanna PCW Panel AR - Model Viewer` reference is a small static page that uses Google's `<model-viewer>` web component directly. It does not use application-owned Three.js scene setup, traversal, or raycasting. Its notable settings are `camera-controls`, `enable-pan`, `bounds="tight"`, a neutral environment, one shadow, a poster, and a custom progress bar. It also adds pointer handling for panning and tap-to-recenter.

The reference asset is an externally hosted `.gltf`, not ModelBase's generated GLB. Its host was no longer DNS-resolvable during this investigation, so its payload size, mesh count, and caching headers could not be measured. The reference's faster load therefore cannot be attributed solely to viewer code; asset size and hosting may be material differences.

## ModelBase before this change

ModelBase uses Three.js directly because it needs application-specific behavior: API-derived GLB URLs, Z-up presentation, centre-pivot X/Y quarter-turn animation, CAD object picking, and selected-name resolution. The scene is already simple: hemisphere plus two directional lights, no shadows, no environment map, and no GLB post-processing. Mesh collection happens once after load, and raycasting happens only after a click/tap rather than on pointer movement.

The main avoidable cost was the unconditional animation loop. It rendered the full scene every browser animation frame forever, including when the model and camera were idle. This is especially costly for the representative 25.6 MB U843 GLB and on high-DPI displays.

## Implemented safe improvements

- Render only when the camera, controls, model rotation, viewport size, or loaded scene changes. OrbitControls damping and the existing 240 ms quarter-turn animation still request consecutive frames while active.
- Cap renderer device-pixel ratio at 1.5 instead of 2 to reduce fill-rate cost on high-DPI screens while retaining antialiasing.
- Reuse the raycaster and pointer vector instead of allocating them for every pick.
- Raycast non-recursively because the selectable cache already contains every mesh.
- Cache resolved display names per picked object.
- Use `ResizeObserver` on the viewer host so layout-driven size changes invalidate the renderer directly.

## Intentionally not implemented

- `<model-viewer>` was not substituted for the current viewer. That would be an architectural rewrite with risk to pivot rotation, Z-up behavior, object picking, name resolution, and current controls.
- The reference's AR, poster, neutral environment, shadow, custom panning, and tap-to-recenter behavior were not ported. They do not address the identified steady-state rendering cost and would add UI or GPU work.
- No converter, GLB, decoder, Meshopt, Draco, quantization, simplification, welding, joining, or post-processing changes were made.
- No repeated scene traversal or continuous pointer raycasting existed to remove.

## Expected effect

Initial network transfer and GLB parsing are unchanged. Camera interaction and animated X/Y rotation still render at animation-frame cadence, while an idle viewer drops from continuous full-scene rendering to no rendering work. The DPR cap should also improve interaction frame time on high-DPI displays. Exact comparison with the reference asset is unavailable because that asset host could not be resolved.
