#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 /path/to/input.step /path/to/report.json" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

input_path="$1"
report_path="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image_name="${OCCT_XCAF_IMAGE:-occt-xcaf-colour-spike:local}"

if [ ! -f "$input_path" ]; then
  echo "Input STEP/STP file not found: $input_path" >&2
  exit 1
fi

mkdir -p "$(dirname "$report_path")"

if command -v docker >/dev/null 2>&1; then
  docker build -t "$image_name" "$script_dir"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$(dirname "$input_path"):/input:ro" \
    -v "$(dirname "$report_path"):/output" \
    "$image_name" \
    "/input/$(basename "$input_path")" \
    "/output/$(basename "$report_path")"
  exit 0
fi

build_dir="$script_dir/build"
cmake -S "$script_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir" --parallel
"$build_dir/occt-xcaf-report" "$input_path" "$report_path"
