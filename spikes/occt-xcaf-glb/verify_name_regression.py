#!/usr/bin/env python3
"""Assert naming and selection invariants in an XCAF converter report."""

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--expect-display", action="append", default=[])
    parser.add_argument("--expect-display-contains", action="append", default=[])
    parser.add_argument("--layer-part-contains")
    parser.add_argument("--expected-part-prefix", default="COPPER TUBE -")
    parser.add_argument("--minimum-layer-boundaries", type=int, default=1)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8", errors="replace"))
    objects = report.get("objects", [])
    if not objects:
        raise AssertionError("report contains no objects")

    displays = [str(item.get("displayName", "")) for item in objects]
    for expected in args.expect_display:
        if expected not in displays:
            raise AssertionError(f"missing exact display name: {expected!r}")
    for expected in args.expect_display_contains:
        if not any(expected.casefold() in value.casefold() for value in displays):
            raise AssertionError(f"missing display name containing: {expected!r}")

    if args.layer_part_contains:
        needle = args.layer_part_contains.casefold()
        matches = [
            item
            for item in objects
            if needle in str(item.get("layer", "")).casefold()
        ]
        if not matches:
            raise AssertionError(f"no layer contains: {args.layer_part_contains!r}")
        bad_names = [
            item
            for item in matches
            if item.get("displayName") != item.get("partName")
            or item.get("partName") != item.get("matchedSubshapeName")
            or item.get("nameSource") not in {"step-layer-target-brep", "xcaf-subshape"}
            or not str(item.get("partName", "")).casefold().startswith(args.expected_part_prefix.casefold())
        ]
        if bad_names:
            raise AssertionError(
                f"{len(bad_names)} matching objects did not use their XCAF subshape part name"
            )
        boundaries = {
            str(item.get("matchedSubshapeLabelPath", ""))
            for item in matches
            if item.get("matchedSubshapeLabelPath")
        }
        selectable_ids = {
            str(item.get("instancePath", ""))
            for item in matches
            if item.get("instancePath")
        }
        if len(boundaries) < args.minimum_layer_boundaries:
            raise AssertionError(
                f"only {len(boundaries)} matched subshape boundaries; "
                f"expected at least {args.minimum_layer_boundaries}"
            )
        if len(selectable_ids) < len(boundaries):
            raise AssertionError("distinct matched subshapes were merged into selectable IDs")
        print(
            f"part-name matches={len(matches)} "
            f"subshapeBoundaries={len(boundaries)} selectableIds={len(selectable_ids)}"
        )

    print(f"name regression checks passed for {len(objects)} objects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
