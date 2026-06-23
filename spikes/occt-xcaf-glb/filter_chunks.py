#!/usr/bin/env python3
import os
import sys
import json
import argparse
import subprocess
import time
import shutil

def parse_args():
    parser = argparse.ArgumentParser(description="Stage 3 Chunk Direct Filtering Orchestrator")
    parser.add_argument("--input", default="/home/claudio/projects/3d-model-web-viewer/data/uploads/u826-steric01-3dview-3dworkingview-20260623011050/original.step", help="Path to input original STEP file on EliteDesk")
    parser.add_argument("--plan", default="/home/claudio/projects/3d-model-web-viewer/data/planner-output/u826/3-chunks/large-model-plan.json", help="Path to large-model-plan.json on EliteDesk")
    parser.add_argument("--outdir", default="/home/claudio/projects/3d-model-web-viewer/data/planner-output/u826/filter-chunks-3", help="Output directory on EliteDesk")
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

def get_stage_time(profile_path, stage_name):
    if not os.path.exists(profile_path):
        return 0.0
    try:
        with open(profile_path, 'r') as f:
            profile = json.load(f)
        for p in profile:
            if p.get("stage") == stage_name:
                return (p.get("elapsed_ms") or 0.0) / 1000.0
    except Exception as e:
        print(f"Warning: could not parse profile stage {stage_name}: {e}")
    return 0.0

def compare_bboxes(expected, actual, tolerance=0.1):
    if not expected or not actual:
        return False, "Missing bbox data"
    
    act_list = actual["min"] + actual["max"]
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
    <title>Stage 3 - Direct Filtered Chunks Viewer</title>
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
        <h1>U826 Chunk Direct Filtered Viewer</h1>
        <p>Stage 3 proof-of-concept showing direct-filtered converted GLB chunks loaded together. Correct alignment verifies that parent transforms and bounds remain intact.</p>
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
        
        const listContainer = document.getElementById('chunks-list');
        chunkNames.forEach((name, i) => {{
            const div = document.createElement('div');
            div.className = 'chunk-item';
            div.innerHTML = `<span class="color-dot" style="background-color: ${{chunkColors[i % chunkColors.length]}}"></span>${{name}}`;
            listContainer.appendChild(div);
        }});

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0b0f19);

        const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000000);
        camera.position.set(30000, 30000, 30000);

        const renderer = new THREE.WebGLRenderer({{ antialias: true }});
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.shadowMap.enabled = true;
        document.getElementById('canvas-container').appendChild(renderer.domElement);

        const controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.maxPolarAngle = Math.PI;

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight1.position.set(1, 1, 1).normalize();
        scene.add(dirLight1);

        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
        dirLight2.position.set(-1, -1, -1).normalize();
        scene.add(dirLight2);

        const loader = new THREE.GLTFLoader();
        const bbox = new THREE.Box3();
        let loadedCount = 0;

        for (let i = 0; i < {chunk_count}; i++) {{
            const file = `chunk-${{i}}.glb`;
            console.log(`Loading ${{file}}...`);
            loader.load(file, (gltf) => {{
                scene.add(gltf.scene);
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

        window.addEventListener('resize', () => {{
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        }});

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
    
    # Re-create output directory safely
    if os.path.exists(outdir_abs):
        shutil.rmtree(outdir_abs)
    os.makedirs(outdir_abs, exist_ok=True)
    
    print(f"Input STEP: {input_abs}")
    print(f"Plan JSON:  {plan_abs}")
    print(f"Output dir:  {outdir_abs}")
    
    with open(plan_abs, "r") as f:
        plan = json.load(f)
        
    chunks = plan.get("chunks", [])
    chunk_count = len(chunks)
    print(f"Plan defines {chunk_count} chunks.")
    
    input_dir = os.path.dirname(input_abs)
    input_basename = os.path.basename(input_abs)
    
    results = {
        "plan_file": plan_abs,
        "input_file": input_abs,
        "chunk_count": chunk_count,
        "sequential_conversion": [],
        "parallel_conversion": {}
    }
    
    chunk_names = []
    
    # 1. SEQUENTIAL CONVERSIONS AND VALIDATIONS
    for chunk in chunks:
        idx = chunk["chunk_index"]
        name = chunk["chunk_name"]
        chunk_names.append(name)
        paths = chunk["root_label_paths"]
        expected_bbox = chunk["bbox"]
        
        print(f"\n--- [Sequential] Processing Chunk {idx} ({name}) with {len(paths)} root paths ---")
        
        # Write label list txt file
        list_path_abs, list_filename = write_label_list(outdir_abs, idx, paths)
        print(f"Wrote label list to {list_path_abs}")
        
        # Temp build directory for this chunk
        temp_conv_dir = f"chunk-{idx}-dir"
        temp_conv_dir_abs = os.path.join(outdir_abs, temp_conv_dir)
        os.makedirs(temp_conv_dir_abs, exist_ok=True)
        
        # Docker command for filtered conversion (no partial STEP written)
        docker_cmd_conv = [
            "docker", "run", "--rm",
            "-v", f"{input_dir}:/input:ro",
            "-v", f"{outdir_abs}:/output",
            "--entrypoint", "/work/spikes/occt-xcaf-glb/build/xcaf-step-to-glb",
            "occt-xcaf-glb-spike:local",
            f"/input/{input_basename}",
            f"/output/{temp_conv_dir}",
            "low", # Map low to preview
            "--colour-mode", "xcaf-baseline",
            "--label-list", f"/output/{list_filename}"
        ]
        
        stdout_conv, conv_time = run_cmd(docker_cmd_conv)
        print(f"Converted chunk directly to GLB in {conv_time:.2f}s")
        
        # Finalized locations
        glb_src = os.path.join(temp_conv_dir_abs, "display.glb")
        report_src = os.path.join(temp_conv_dir_abs, "xcaf-report.json")
        log_src = os.path.join(temp_conv_dir_abs, "conversion.log")
        profile_src = os.path.join(temp_conv_dir_abs, "conversion-profile.json")
        
        glb_dest = os.path.join(outdir_abs, f"chunk-{idx}.glb")
        report_dest = os.path.join(outdir_abs, f"chunk-{idx}-report.json")
        log_dest = os.path.join(outdir_abs, f"chunk-{idx}-conversion.log")
        profile_dest = os.path.join(outdir_abs, f"chunk-{idx}-profile.json")
        
        if not os.path.isfile(glb_src):
            raise RuntimeError(f"GLB not generated for chunk {idx}!")
            
        shutil.move(glb_src, glb_dest)
        shutil.move(report_src, report_dest)
        shutil.move(log_src, log_dest)
        shutil.move(profile_src, profile_dest)
        
        # Clean up temp files
        shutil.rmtree(temp_conv_dir_abs)
        os.remove(list_path_abs)
        
        # Parse profile times
        step_parse_seconds = get_stage_time(profile_dest, "Reading STEP") + get_stage_time(profile_dest, "Transferring XCAF")
        meshing_seconds = get_stage_time(profile_dest, "XCAF label traversal")
        writing_seconds = get_stage_time(profile_dest, "Writing GLB")
        
        # Parse report and validate
        with open(report_dest, "r") as rf:
            report_data = json.load(rf)
            
        summary = report_data.get("summary", {})
        actual_bbox = report_data.get("globalBoundingBox", {})
        
        # Bbox verification
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
            "glb_size_bytes": os.path.getsize(glb_dest),
            "triangles": summary.get("triangles", 0),
            "faces_meshed": summary.get("shapesTessellated", 0),
            "nodes": summary.get("nodeCount", 0),
            "materials": summary.get("materialCount", 0),
            "conversion_seconds_reported": summary.get("conversionSeconds", 0.0),
            "conversion_seconds_wall": conv_time,
            "step_parse_seconds": step_parse_seconds,
            "meshing_seconds": meshing_seconds,
            "writing_seconds": writing_seconds,
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
        results["sequential_conversion"].append(chunk_report)
        
        print(f"Validation Chunk {idx}:")
        print(f"  GLB size:  {chunk_report['glb_size_bytes'] / (1024*1024):.2f} MB")
        print(f"  Triangles: {chunk_report['triangles']}")
        print(f"  STEP parse time: {step_parse_seconds:.2f}s | Meshing: {meshing_seconds:.2f}s | Writing: {writing_seconds:.2f}s")
        print(f"  BBox match: {bbox_match} ({bbox_msg})")
        print(f"  Semantics: {named_objects}/{total_objects} named, {coloured_objects}/{total_objects} coloured, stable IDs: {has_stable_ids}")
        
    print("\nSequential direct-filtered conversions succeeded for all chunks.")
    
    # 2. CONCURRENT/PARALLEL RUN TO MEASURE WALL-CLOCK MAKESPAN
    print("\n--- Starting Concurrent Parallel Conversions of all Chunks ---")
    parallel_conv_dirs = []
    processes = []
    
    parallel_start_time = time.time()
    
    for chunk in chunks:
        idx = chunk["chunk_index"]
        paths = chunk["root_label_paths"]
        
        # Write list file
        list_path_abs, list_filename = write_label_list(outdir_abs, idx, paths)
        
        # Temp parallel dir
        p_dir = f"parallel-chunk-{idx}-dir"
        p_dir_abs = os.path.join(outdir_abs, p_dir)
        os.makedirs(p_dir_abs, exist_ok=True)
        parallel_conv_dirs.append((p_dir_abs, list_path_abs))
        
        docker_cmd_p = [
            "docker", "run", "--rm",
            "-v", f"{input_dir}:/input:ro",
            "-v", f"{outdir_abs}:/output",
            "--entrypoint", "/work/spikes/occt-xcaf-glb/build/xcaf-step-to-glb",
            "occt-xcaf-glb-spike:local",
            f"/input/{input_basename}",
            f"/output/{p_dir}",
            "low",
            "--colour-mode", "xcaf-baseline",
            "--label-list", f"/output/{list_filename}"
        ]
        
        print(f"Launching Chunk {idx} concurrently...")
        proc = subprocess.Popen(docker_cmd_p, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        processes.append(proc)
        
    # Wait for all processes to finish
    print("Waiting for all concurrent conversions to complete...")
    for i, proc in enumerate(processes):
        stdout, stderr = proc.communicate()
        if proc.returncode != 0:
            print(f"Concurrent process {i} failed with code {proc.returncode}")
            print(f"STDOUT:\n{stdout.decode()}")
            print(f"STDERR:\n{stderr.decode()}")
            raise RuntimeError(f"Concurrent chunk conversion failed for chunk {i}")
            
    parallel_makespan = time.time() - parallel_start_time
    print(f"All concurrent conversions finished! Wall-clock makespan: {parallel_makespan:.2f}s")
    
    results["parallel_conversion"] = {
        "wall_clock_makespan_seconds": parallel_makespan,
        "concurrency": chunk_count
    }
    
    # Clean up parallel temp folders and list files
    for p_dir_abs, list_path_abs in parallel_conv_dirs:
        shutil.rmtree(p_dir_abs)
        if os.path.exists(list_path_abs):
            os.remove(list_path_abs)
            
    # 3. GENERATE VIEWER AND REPORTS
    viewer_path = generate_viewer_html(outdir_abs, chunk_count, chunk_names)
    print(f"\nCreated co-load HTML viewer page at: {viewer_path}")
    
    report_json_path = os.path.join(outdir_abs, "stage3-report.json")
    with open(report_json_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Saved stage3-report.json to {report_json_path}")
    
    print("\n--- Stage 3 Spike direct filtering orchestrator execution completed successfully! ---")

if __name__ == "__main__":
    main()
