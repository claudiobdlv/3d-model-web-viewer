#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 /path/to/input.step /path/to/output-dir [preview|balanced|high]" >&2
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi

input_path="$1"
output_dir="$2"
quality="${3:-balanced}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image_name="${OCCT_XCAF_GLB_IMAGE:-occt-xcaf-glb-spike:local}"

if [ ! -f "$input_path" ]; then
  echo "Input STEP/STP file not found: $input_path" >&2
  exit 1
fi

mkdir -p "$output_dir"

if command -v docker >/dev/null 2>&1; then
  docker build -t "$image_name" "$script_dir"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$(dirname "$input_path"):/input:ro" \
    -v "$output_dir:/output" \
    "$image_name" \
    "/input/$(basename "$input_path")" \
    /output \
    "$quality"
  exit 0
fi

build_dir="$script_dir/build"
cmake -S "$script_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir" --parallel
"$build_dir/xcaf-step-to-glb" "$input_path" "$output_dir" "$quality"
