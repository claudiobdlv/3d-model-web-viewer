#!/usr/bin/env python3
"""Append a compact colour-change audit to an XCAF v8 report.

This is an isolated spike helper. It compares versioned `xcaf-report.json`
files by stable object id where possible, then by display name/layer fallback.
It does not modify generated GLBs or production data.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


VERSION_ORDER = ["v4", "v5", "v6", "v7_raw", "v7_linear", "v8"]
FINAL_RE = re.compile(r"(?:^|;\s*)final=([^;\s]+)")


def load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def object_key(obj: dict[str, Any]) -> str:
    instance = obj.get("instancePath")
    if instance:
        return "instance:{}|{}|{}".format(
            instance,
            obj.get("displayName", ""),
            obj.get("layer", ""),
        )
    return "label:{}|{}|{}".format(
        obj.get("labelPath", ""),
        obj.get("displayName", ""),
        obj.get("layer", ""),
    )


def object_entry(obj: dict[str, Any]) -> dict[str, Any]:
    final_colour = obj.get("finalColour") or obj.get("colour", "")
    if not final_colour:
        match = FINAL_RE.search(obj.get("colourTrace", ""))
        if match:
            final_colour = match.group(1)
    return {
        "displayName": obj.get("displayName", ""),
        "layer": obj.get("layer", ""),
        "finalColour": final_colour,
        "finalColourValue": final_colour,
        "source": obj.get("materialSource", ""),
        "colourSource": obj.get("colourSource", ""),
        "rawStepStyledItemId": obj.get("rawStepStyledItemId", ""),
        "rawStepTargetType": obj.get("rawStepTargetType", ""),
        "rawStepTargetScope": obj.get("rawStepTargetScope", ""),
        "rawStepConfidence": obj.get("rawStepMappingConfidence", ""),
        "rawStepRejectedReason": obj.get("rawStepRejectedReason", ""),
        "triangles": obj.get("triangles", 0),
        "faces": obj.get("faces", 0),
    }


def index_report(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {object_key(obj): object_entry(obj) for obj in report.get("objects", [])}


def changed(*entries: dict[str, Any] | None) -> bool:
    colours = {
        (entry or {}).get("finalColourValue", "")
        for entry in entries
        if entry is not None
    }
    sources = {
        (entry or {}).get("source", "")
        for entry in entries
        if entry is not None
    }
    return len(colours) > 1 or len(sources) > 1


def build_audit(reports: dict[str, dict[str, Any]]) -> dict[str, Any]:
    indexes = {version: index_report(report) for version, report in reports.items()}
    keys = set()
    for index in indexes.values():
        keys.update(index)

    rows: list[dict[str, Any]] = []
    for key in sorted(keys):
        entries = {version: indexes.get(version, {}).get(key) for version in VERSION_ORDER}
        v5 = entries.get("v5")
        v6 = entries.get("v6")
        if not changed(v5, v6, entries.get("v7_raw"), entries.get("v7_linear"), entries.get("v8")):
            continue
        representative = next((entry for entry in entries.values() if entry), {})
        rows.append({
            "key": key,
            "displayName": representative.get("displayName", ""),
            "layer": representative.get("layer", ""),
            "v5": entries.get("v5"),
            "v6": entries.get("v6"),
            "v7_raw": entries.get("v7_raw"),
            "v7_linear": entries.get("v7_linear"),
            "v8": entries.get("v8"),
            "changedFromV5ToV6": changed(v5, v6),
            "changedInV8": changed(entries.get("v7_raw"), entries.get("v8")),
        })

    rows.sort(key=lambda row: (
        not row["changedFromV5ToV6"],
        not row["changedInV8"],
        row["displayName"],
        row["layer"],
    ))
    return {
        "method": "Compared objects by stableObjectId, with displayName/layer/labelPath fallback. Focus rows include any final colour or material-source change across v5/v6/v7/v8.",
        "versionOrder": VERSION_ORDER,
        "rowCount": len(rows),
        "changedFromV5ToV6Count": sum(1 for row in rows if row["changedFromV5ToV6"]),
        "changedInV8Count": sum(1 for row in rows if row["changedInV8"]),
        "rows": rows[:240],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Append colourChangeAudit to a v8 XCAF report.")
    parser.add_argument("--v4", type=Path)
    parser.add_argument("--v5", type=Path)
    parser.add_argument("--v6", type=Path, required=True)
    parser.add_argument("--v7-raw", type=Path, required=True)
    parser.add_argument("--v7-linear", type=Path, required=True)
    parser.add_argument("--v8", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    reports: dict[str, dict[str, Any]] = {}
    for version, path in {
        "v4": args.v4,
        "v5": args.v5,
        "v6": args.v6,
        "v7_raw": args.v7_raw,
        "v7_linear": args.v7_linear,
        "v8": args.v8,
    }.items():
        if path and path.exists():
            reports[version] = load_report(path)

    v8_report = load_report(args.v8)
    v8_report["colourChangeAudit"] = build_audit(reports)
    args.v8.write_text(json.dumps(v8_report, indent=2), encoding="utf-8")
    print(
        "Appended colourChangeAudit with {} rows to {}".format(
            v8_report["colourChangeAudit"]["rowCount"],
            args.v8,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
