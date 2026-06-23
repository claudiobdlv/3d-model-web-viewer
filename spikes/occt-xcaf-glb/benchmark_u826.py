#!/usr/bin/env python3
import os
import sys
import json
import subprocess
import time
import shutil

# Benchmark Configuration
INPUT_STEP = "/home/claudio/projects/3d-model-web-viewer/data/uploads/u826-steric01-3dview-3dworkingview-20260623011050/original.step"
PLAN_JSON = "/home/claudio/projects/3d-model-web-viewer/data/planner-output/u826/3-chunks/large-model-plan.json"
BENCH_DIR = "/home/claudio/projects/3d-model-web-viewer/data/planner-output/u826/benchmark"
QUALITY = "balanced"
COLOUR_MODE = "xcaf-baseline"

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

def main():
    if not os.path.exists(INPUT_STEP):
        print(f"Error: Input step file not found at {INPUT_STEP}")
        sys.exit(1)
    if not os.path.exists(PLAN_JSON):
        print(f"Error: Plan JSON not found at {PLAN_JSON}")
        sys.exit(1)

    print("=== Starting U826 Apples-to-Apples Benchmark ===")
    print(f"STEP: {INPUT_STEP}")
    print(f"Plan: {PLAN_JSON}")
    print(f"Quality: {QUALITY}")
    print(f"Colour mode: {COLOUR_MODE}")
    print(f"Output directory: {BENCH_DIR}")

    # Recreate benchmark directory
    if os.path.exists(BENCH_DIR):
        shutil.rmtree(BENCH_DIR)
    os.makedirs(BENCH_DIR, exist_ok=True)

    input_dir = os.path.dirname(INPUT_STEP)
    input_basename = os.path.basename(INPUT_STEP)

    # 1. RUN FULL BASELINE
    print("\n--- Running Full Model Conversion (Baseline) ---")
    full_temp_dir = os.path.join(BENCH_DIR, "full-temp")
    os.makedirs(full_temp_dir, exist_ok=True)
    
    full_cmd = [
        "docker", "run", "--rm",
        "-v", f"{input_dir}:/input:ro",
        "-v", f"{BENCH_DIR}:/output",
        "--entrypoint", "/work/spikes/occt-xcaf-glb/build/xcaf-step-to-glb",
        "occt-xcaf-glb-spike:local",
        f"/input/{input_basename}",
        "/output/full-temp",
        QUALITY,
        "--colour-mode", COLOUR_MODE
    ]
    stdout, full_wall_time = run_cmd(full_cmd)

    full_glb = os.path.join(BENCH_DIR, "full.glb")
    full_report = os.path.join(BENCH_DIR, "full-report.json")
    full_log = os.path.join(BENCH_DIR, "full-conversion.log")
    full_profile = os.path.join(BENCH_DIR, "full-profile.json")

    shutil.move(os.path.join(full_temp_dir, "display.glb"), full_glb)
    shutil.move(os.path.join(full_temp_dir, "xcaf-report.json"), full_report)
    shutil.move(os.path.join(full_temp_dir, "conversion.log"), full_log)
    shutil.move(os.path.join(full_temp_dir, "conversion-profile.json"), full_profile)
    shutil.rmtree(full_temp_dir)

    with open(full_report, "r") as f:
        full_rep_data = json.load(f)
    
    full_summary = full_rep_data.get("summary", {})
    full_parse_time = get_stage_time(full_profile, "Reading STEP") + get_stage_time(full_profile, "Transferring XCAF")
    full_mesh_time = get_stage_time(full_profile, "XCAF label traversal")
    full_write_time = get_stage_time(full_profile, "Writing GLB")

    # 2. RUN CHUNKS
    with open(PLAN_JSON, "r") as f:
        plan = json.load(f)
    chunks = plan.get("chunks", [])

    print(f"\n--- Running {len(chunks)} Chunk Conversions ---")
    chunk_glbs = []
    chunk_reports = []
    chunk_timings = []
    
    parallel_start = time.time()
    processes = []
    chunk_dirs = []

    for chunk in chunks:
        idx = chunk["chunk_index"]
        paths = chunk["root_label_paths"]
        
        # Write list file
        list_filename = f"label-list-chunk-{idx}.txt"
        list_path = os.path.join(BENCH_DIR, list_filename)
        with open(list_path, "w") as lf:
            for p in paths:
                lf.write(p + "\n")
        
        c_dir = f"chunk-{idx}-temp"
        c_dir_abs = os.path.join(BENCH_DIR, c_dir)
        os.makedirs(c_dir_abs, exist_ok=True)
        chunk_dirs.append((c_dir_abs, list_path, idx))

        chunk_cmd = [
            "docker", "run", "--rm",
            "-v", f"{input_dir}:/input:ro",
            "-v", f"{BENCH_DIR}:/output",
            "--entrypoint", "/work/spikes/occt-xcaf-glb/build/xcaf-step-to-glb",
            "occt-xcaf-glb-spike:local",
            f"/input/{input_basename}",
            f"/output/{c_dir}",
            QUALITY,
            "--colour-mode", COLOUR_MODE,
            "--label-list", f"/output/{list_filename}"
        ]
        
        print(f"Launching chunk {idx}...")
        proc = subprocess.Popen(chunk_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        processes.append(proc)

    # Wait for all chunks
    for i, proc in enumerate(processes):
        stdout, stderr = proc.communicate()
        if proc.returncode != 0:
            print(f"Chunk process {i} failed!")
            raise RuntimeError("Chunk conversion failed!")

    parallel_makespan = time.time() - parallel_start
    print(f"Chunks complete. Makespan: {parallel_makespan:.2f}s")

    for c_dir_abs, list_path, idx in chunk_dirs:
        glb_dest = os.path.join(BENCH_DIR, f"chunk-{idx}.glb")
        rep_dest = os.path.join(BENCH_DIR, f"chunk-{idx}-report.json")
        prof_dest = os.path.join(BENCH_DIR, f"chunk-{idx}-profile.json")

        shutil.move(os.path.join(c_dir_abs, "display.glb"), glb_dest)
        shutil.move(os.path.join(c_dir_abs, "xcaf-report.json"), rep_dest)
        shutil.move(os.path.join(c_dir_abs, "conversion-profile.json"), prof_dest)
        shutil.rmtree(c_dir_abs)
        os.remove(list_path)

        chunk_glbs.append(glb_dest)
        chunk_reports.append(rep_dest)

        # Parse timings
        c_parse = get_stage_time(prof_dest, "Reading STEP") + get_stage_time(prof_dest, "Transferring XCAF")
        c_mesh = get_stage_time(prof_dest, "XCAF label traversal")
        c_write = get_stage_time(prof_dest, "Writing GLB")
        chunk_timings.append((c_parse, c_mesh, c_write))

    # 3. MERGE GLBS
    print("\n--- Running Merged GLB Creation ---")
    merged_glb = os.path.join(BENCH_DIR, "merged.glb")
    
    # Run merge_runner.js via Node
    node_cmd = [
        "node",
        "/home/claudio/projects/3d-model-web-viewer/spikes/merge_runner.js",
        merged_glb
    ] + chunk_glbs
    
    stdout, merge_time = run_cmd(node_cmd)
    print(f"Merge output:\n{stdout}")

    # Read stats from merge_runner.js output
    # Let's count triangles and nodes from final reports
    sum_chunk_triangles = 0
    sum_chunk_nodes = 0
    sum_chunk_materials = 0
    sum_chunk_size = 0
    for rep in chunk_reports:
        with open(rep, "r") as f:
            data = json.load(f)
        sum_chunk_triangles += data["summary"]["triangles"]
        sum_chunk_nodes += data["summary"]["nodeCount"]
        sum_chunk_materials += data["summary"]["materialCount"]
    
    for glb in chunk_glbs:
        sum_chunk_size += os.path.getsize(glb)

    # Let's read merged verification stats
    # We can inspect the merged.glb with NodeIO to get actual counts
    # Or parsing merge output from stdout
    print("\n=== Benchmark Results ===")
    print(f"{'Metric':<30} | {'Full Baseline':<15} | {'Sum of Chunks':<15} | {'Merged GLB':<15}")
    print("-" * 85)
    print(f"{'Triangles':<30} | {full_summary.get('triangles'):<15} | {sum_chunk_triangles:<15} | {sum_chunk_triangles:<15}")
    print(f"{'Node Count':<30} | {full_summary.get('nodeCount'):<15} | {sum_chunk_nodes:<15} | {sum_chunk_nodes:<15}")
    print(f"{'GLB Size (MB)':<30} | {os.path.getsize(full_glb)/(1024*1024):.2f} MB        | {sum_chunk_size/(1024*1024):.2f} MB        | {os.path.getsize(merged_glb)/(1024*1024):.2f} MB")
    
    # Timing comparison
    print("\n=== Timing Breakdown ===")
    print(f"Full Model wall-clock time: {full_wall_time:.2f}s (Parse: {full_parse_time:.2f}s, Meshing: {full_mesh_time:.2f}s, Writing: {full_write_time:.2f}s)")
    print(f"Parallel Chunks makespan:   {parallel_makespan:.2f}s")
    for i, t in enumerate(chunk_timings):
        print(f"  - Chunk {i}: Parse: {t[0]:.2f}s | Meshing: {t[1]:.2f}s | Writing: {t[2]:.2f}s")
    print(f"GLB merging time:           {merge_time:.2f}s")
    print(f"Total chunked pipeline wall: {parallel_makespan + merge_time:.2f}s")
    
    speedup = full_wall_time / (parallel_makespan + merge_time)
    print(f"Reported wall-clock speedup: {speedup:.2f}x")

    # Analyze triangle difference
    diff = full_summary.get('triangles') - sum_chunk_triangles
    print(f"\nTriangle difference (Full - Chunks): {diff}")
    if diff == 0:
        print("SUCCESS: Triangle counts match exactly between Baseline and Chunked pipeline!")
    else:
        print(f"WARNING: Triangle counts do not match! Baseline: {full_summary.get('triangles')}, Chunks: {sum_chunk_triangles}")
        print("This difference needs to be analyzed (e.g. duplicate boundary faces, mesh-reuse boundaries).")

if __name__ == "__main__":
    main()
