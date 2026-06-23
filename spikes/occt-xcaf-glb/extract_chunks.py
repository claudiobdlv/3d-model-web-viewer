#!/usr/bin/env python3
import os
import sys
import json
import argparse
import subprocess
import time
import shutil

def parse_args():
    parser = argparse.ArgumentParser(description="Stage 2 Chunk Extraction and Conversion Proof Orchestrator")
    parser.add_argument("--input", required=True, help="Path to input original STEP file on host")
    parser.add_argument("--plan", required=True, help="Path to large-model-plan.json on host")
    parser.add_argument("--outdir", required=True, help="Output directory on host to save chunks and results")
    return parser.parse_args()

def write_label_list(outdir, chunk_index, paths):
    filename = f"label-list-chunk-{chunk_index}.txt"
    filepath = os.path.join(outdir, filename)
    with open(filepath, "w") as f:
        for path in paths:
            f.write(path + "\n")
    return filepath, filename

def run_cmd(cmd):
    print(f"Running command: {' '.join(cmd)}")
    start = time.time()
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    elapsed = time.time() - start
    if res.returncode != 0:
        print(f"Command failed with code {res.returncode}")
        print(f"STDOUT:\n{res.stdout}")
        print(f"STDERR:\n{res.stderr}")
        raise RuntimeError(f"Command failed: {' '.join(cmd)}")
    return res.stdout, elapsed

def compare_bboxes(expected, actual, tolerance=0.1):
    """
    expected: list [xmin, ymin, zmin, xmax, ymax, zmax]
    actual: dict {"min": [x,y,z], "max": [x,y,z]}
    """
    if not expected or not actual:
        return False, "Missing bbox data"
    
    act_list = actual["min"] + actual["max"]
    
    # Calculate diagonal size to use relative tolerance
    dx = expected[3] - expected[0]
    dy = expected[4] - expected[1]
    dz = expected[5] - expected[2]
    diag = (dx**2 + dy**2 + dz**2)**0.5
    
    if diag == 0:
        diag = 1.0
        
    diffs = [abs(expected[i] - act_list[i]) for i in range(6)]
    max_diff = max(diffs)
    rel_diff = max_diff / diag
    
    if rel_diff <= tolerance:
        return True, f"Match (rel diff: {rel_diff:.4f}, max diff: {max_diff:.2f}mm)"
    else:
        return False, f"Mismatch (rel diff: {rel_diff:.4f}, max diff: {max_diff:.2f}mm)"

def generate_viewer_html(outdir, chunk_count, chunk_names):
    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stage 2 - Co-loaded Chunks Viewer</title>
    <style>
        body {{
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: #0b0f19;
            font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            color: #fff;
        }}
        #canvas-container {{
            width: 100vw;
            height: 100vh;
        }}
        #ui-overlay {{
            position: absolute;
            top: 20px;
            left: 20px;
            background: rgba(15, 23, 42, 0.85);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            max-width: 320px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
        }}
        h1 {{
            font-size: 1.25rem;
            margin: 0 0 10px 0;
            color: #38bdf8;
            font-weight: 600;
        }}
        p {{
            font-size: 0.85rem;
            margin: 0 0 15px 0;
            color: #94a3b8;
            line-height: 1.4;
        }}
        .chunk-item {{
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            font-size: 0.85rem;
        }}
        .color-dot {{
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 10px;
            border: 1px solid rgba(255,255,255,0.2);
        }}
        .controls-hint {{
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 0.75rem;
            color: #64748b;
        }}
    </style>
    <!-- Three.js and GLTFLoader -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
</head>
<body>
    <div id="canvas-container"></div>
    
    <div id="ui-overlay">
        <h1>U826 Chunk Co-load Proof</h1>
        <p>Proof-of-concept showing {chunk_count} independently converted STEP chunks loaded together. Correct global alignment verifies that transforms remain intact.</p>
        <div id="chunks-list"></div>
        <div class="controls-hint">
            <strong>Controls:</strong><br>
            Left Click + Drag: Rotate<br>
            Right Click + Drag: Pan<br>
            Scroll: Zoom
        </div>
    </div>

    <script>
        const chunkColors = ["#ef4444", "#10b981", "#3b82f6", "#f59e0b", "#8b5cf6"];
        const chunkNames = {json.dumps(chunk_names)};
        
        // Populate UI
        const listContainer = document.getElementById('chunks-list');
        chunkNames.forEach((name, i) => {{
            const div = document.createElement('div');
            div.className = 'chunk-item';
            div.innerHTML = `<span class="color-dot" style="background-color: ${{chunkColors[i % chunkColors.length]}}"></span>${{name}}`;
            listContainer.appendChild(div);
        }});

        // Setup Scene
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0b0f19);

        // Setup Camera
        const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000000);
        camera.position.set(30000, 30000, 30000);

        // Setup Renderer
        const renderer = new THREE.WebGLRenderer({{ antialias: true }});
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.shadowMap.enabled = true;
        document.getElementById('canvas-container').appendChild(renderer.domElement);

        // Controls
        const controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.maxPolarAngle = Math.PI;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight1.position.set(1, 1, 1).normalize();
        scene.add(dirLight1);

        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
        dirLight2.position.set(-1, -1, -1).normalize();
        scene.add(dirLight2);

        // Load Chunks
        const loader = new THREE.GLTFLoader();
        const bbox = new THREE.Box3();
        let loadedCount = 0;

        for (let i = 0; i < {chunk_count}; i++) {{
            const file = `chunk-${{i}}.glb`;
            console.log(`Loading ${{file}}...`);
            loader.load(file, (gltf) => {{
                scene.add(gltf.scene);
                
                // Colorize chunk slightly for visual demarcation (optional, disabled to see original STEP colors)
                // gltf.scene.traverse((node) => {{
                //     if (node.isMesh && node.material) {{
                //         node.material.color.multiplyScalar(0.9).add(new THREE.Color(chunkColors[i % chunkColors.length]).multiplyScalar(0.1));
                //     }}
                // }});

                const chunkBox = new THREE.Box3().setFromObject(gltf.scene);
                bbox.union(chunkBox);
                
                loadedCount++;
                if (loadedCount === {chunk_count}) {{
                    console.log("All chunks loaded. Adjusting camera target...");
                    const center = new THREE.Vector3();
                    bbox.getCenter(center);
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    
                    controls.target.copy(center);
                    const maxDim = Math.max(size.x, size.y, size.z);
                    camera.position.set(center.x + maxDim, center.y + maxDim, center.z + maxDim);
                    camera.lookAt(center);
                    controls.update();
                }}
            }}, undefined, (err) => {{
                console.error(`Error loading ${{file}}:`, err);
            }});
        }}

        // Resize handler
        window.addEventListener('resize', () => {{
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        }});

        // Animation loop
        function animate() {{
            requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        }}
        animate();
    </script>
</body>
</html>
"""
    filepath = os.path.join(outdir, "index.html")
    with open(filepath, "w") as f:
        f.write(html_content)
    return filepath

def main():
    args = parse_args()
    
    input_abs = os.path.abspath(args.input)
    plan_abs = os.path.abspath(args.plan)
    outdir_abs = os.path.abspath(args.outdir)
    
    os.makedirs(outdir_abs, exist_ok=True)
    
    print(f"Input STEP: {input_abs}")
    print(f"Plan JSON:  {plan_abs}")
    print(f"Output dir:  {outdir_abs}")
    
    with open(plan_abs, "r") as f:
        plan = json.load(f)
        
    if not plan.get("chunking_recommendation", {}).get("chunking_enabled", False):
        print("Warning: Plan does not recommend chunking, proceeding anyway.")
        
    chunks = plan.get("chunks", [])
    chunk_count = len(chunks)
    print(f"Plan defines {chunk_count} chunks.")
    
    input_dir = os.path.dirname(input_abs)
    input_basename = os.path.basename(input_abs)
    
    results = {
        "plan_file": plan_abs,
        "input_file": input_abs,
        "chunk_count": chunk_count,
        "total_extraction_seconds": 0.0,
        "total_conversion_seconds": 0.0,
        "chunks": []
    }
    
    chunk_names = []
    
    for chunk in chunks:
        idx = chunk["chunk_index"]
        name = chunk["chunk_name"]
        chunk_names.append(name)
        paths = chunk["root_label_paths"]
        expected_bbox = chunk["bbox"]
        
        print(f"\n--- Processing Chunk {idx} ({name}) with {len(paths)} root paths ---")
        
        # 1. Write label list txt file
        list_path_abs, list_filename = write_label_list(outdir_abs, idx, paths)
        print(f"Wrote label list to {list_path_abs}")
        
        # 2. Extract STEP chunk via docker
        print("Extracting STEP chunk...")
        docker_cmd_ext = [
            "docker", "run", "--rm",
            "-v", f"{input_dir}:/input:ro",
            "-v", f"{outdir_abs}:/output",
            "--entrypoint", "/work/spikes/occt-xcaf-glb/build/xcaf-step-extractor",
            "occt-xcaf-glb-spike:local",
            f"/input/{input_basename}",
            f"/output/chunk-{idx}.step",
            "--list", f"/output/{list_filename}"
        ]
        
        stdout_ext, ext_time = run_cmd(docker_cmd_ext)
        results["total_extraction_seconds"] += ext_time
        print(f"Extracted chunk STEP in {ext_time:.2f}s")
        
        # Verify STEP file exists and is non-empty
        chunk_step_path = os.path.join(outdir_abs, f"chunk-{idx}.step")
        if not os.path.isfile(chunk_step_path) or os.path.getsize(chunk_step_path) == 0:
            raise RuntimeError(f"STEP chunk {idx} was not written or is empty!")
            
        # 3. Convert STEP chunk to GLB via docker
        print("Converting STEP chunk to GLB...")
        # xcaf-step-to-glb writes display.glb, xcaf-report.json etc in target dir
        temp_conv_dir = f"chunk-{idx}-dir"
        temp_conv_dir_abs = os.path.join(outdir_abs, temp_conv_dir)
        os.makedirs(temp_conv_dir_abs, exist_ok=True)
        
        docker_cmd_conv = [
            "docker", "run", "--rm",
            "-v", f"{outdir_abs}:/output",
            "--entrypoint", "/work/spikes/occt-xcaf-glb/build/xcaf-step-to-glb",
            "occt-xcaf-glb-spike:local",
            f"/output/chunk-{idx}.step",
            f"/output/{temp_conv_dir}",
            "balanced",
            "--colour-mode", "xcaf-baseline"
        ]
        
        stdout_conv, conv_time = run_cmd(docker_cmd_conv)
        results["total_conversion_seconds"] += conv_time
        print(f"Converted chunk to GLB in {conv_time:.2f}s")
        
        # 4. Move files to finalized locations and cleanup
        glb_src = os.path.join(temp_conv_dir_abs, "display.glb")
        report_src = os.path.join(temp_conv_dir_abs, "xcaf-report.json")
        log_src = os.path.join(temp_conv_dir_abs, "conversion.log")
        
        glb_dest = os.path.join(outdir_abs, f"chunk-{idx}.glb")
        report_dest = os.path.join(outdir_abs, f"chunk-{idx}-report.json")
        log_dest = os.path.join(outdir_abs, f"chunk-{idx}-conversion.log")
        
        if not os.path.isfile(glb_src):
            raise RuntimeError(f"GLB not generated for chunk {idx}!")
            
        shutil.move(glb_src, glb_dest)
        shutil.move(report_src, report_dest)
        shutil.move(log_src, log_dest)
        
        # Clean up temp files
        shutil.rmtree(temp_conv_dir_abs)
        os.remove(list_path_abs)
        
        # 5. Read report and validate metadata
        with open(report_dest, "r") as rf:
            report_data = json.load(rf)
            
        summary = report_data.get("summary", {})
        actual_bbox = report_data.get("globalBoundingBox", {})
        
        # Bounds check
        bbox_match, bbox_msg = compare_bboxes(expected_bbox, actual_bbox)
        
        # Semantic checks
        total_objects = len(report_data.get("objects", []))
        named_objects = sum(1 for obj in report_data.get("objects", []) if obj.get("displayName") or obj.get("objectName"))
        coloured_objects = sum(1 for obj in report_data.get("objects", []) if obj.get("finalColour") and obj.get("colourSource") != "default")
        layered_objects = sum(1 for obj in report_data.get("objects", []) if obj.get("layer"))
        has_stable_ids = all("stableObjectId" in obj for obj in report_data.get("objects", []))
        
        chunk_report = {
            "chunk_index": idx,
            "chunk_name": name,
            "step_size_bytes": os.path.getsize(chunk_step_path),
            "glb_size_bytes": os.path.getsize(glb_dest),
            "triangles": summary.get("triangles", 0),
            "faces_meshed": summary.get("shapesTessellated", 0),
            "nodes": summary.get("nodeCount", 0),
            "materials": summary.get("materialCount", 0),
            "conversion_seconds_reported": summary.get("conversionSeconds", 0.0),
            "conversion_seconds_wall": conv_time,
            "bbox_check": {
                "expected": expected_bbox,
                "actual": actual_bbox,
                "matched": bbox_match,
                "message": bbox_msg
            },
            "semantics_check": {
                "total_objects": total_objects,
                "named_objects": named_objects,
                "coloured_objects": coloured_objects,
                "layered_objects": layered_objects,
                "has_stable_ids": has_stable_ids
            }
        }
        results["chunks"].append(chunk_report)
        
        print(f"Validation:")
        print(f"  STEP size: {chunk_report['step_size_bytes'] / (1024*1024):.2f} MB")
        print(f"  GLB size:  {chunk_report['glb_size_bytes'] / (1024*1024):.2f} MB")
        print(f"  Triangles: {chunk_report['triangles']}")
        print(f"  BBox match: {bbox_match} ({bbox_msg})")
        print(f"  Semantics: {named_objects}/{total_objects} named, {coloured_objects}/{total_objects} coloured, stable IDs: {has_stable_ids}")

    # Generate co-load HTML viewer page
    viewer_path = generate_viewer_html(outdir_abs, chunk_count, chunk_names)
    print(f"\nCreated co-load HTML viewer page at: {viewer_path}")
    
    # Save validation report JSON
    report_json_path = os.path.join(outdir_abs, "stage2-report.json")
    with open(report_json_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Saved stage2-report.json to {report_json_path}")
    
    print("\n--- Stage 2 Chunking proof run completed successfully! ---")

if __name__ == "__main__":
    main()
