#!/usr/bin/env python3
"""Append a simple-object versus assembly colour comparison to XCAF reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_report(path: Path, report: dict[str, Any]) -> None:
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")


def normalise(value: str) -> str:
    return " ".join(value.lower().replace("_", " ").replace("-", " ").split())


def object_summary(obj: dict[str, Any]) -> dict[str, Any]:
    return {
        "stableObjectId": obj.get("stableObjectId", ""),
        "displayName": obj.get("displayName", ""),
        "labelPath": obj.get("labelPath", ""),
        "instancePath": obj.get("instancePath", ""),
        "labelRole": obj.get("labelRole", ""),
        "layer": obj.get("layer", ""),
        "instanceLabelLayers": obj.get("instanceLabelLayers", ""),
        "referredLabelLayers": obj.get("referredLabelLayers", ""),
        "ancestorLayers": obj.get("ancestorLayers", ""),
        "matchedSubshapeLayers": obj.get("matchedSubshapeLayers", ""),
        "finalColour": obj.get("finalColour", ""),
        "colourSource": obj.get("colourSource", ""),
        "materialSource": obj.get("materialSource", ""),
        "colourLookupPath": obj.get("colourLookupPath", ""),
        "candidateColours": obj.get("candidateColours", ""),
        "instanceLabelColour": obj.get("instanceLabelColour", ""),
        "referredLabelColour": obj.get("referredLabelColour", ""),
        "owningShapeColour": obj.get("owningShapeColour", ""),
        "ancestorColour": obj.get("ancestorColour", ""),
        "layerColour": obj.get("layerColour", ""),
        "rawStepMappingConfidence": obj.get("rawStepMappingConfidence", ""),
        "rawStepStyledItemId": obj.get("rawStepStyledItemId", ""),
        "rawStepRejectedReason": obj.get("rawStepRejectedReason", ""),
        "originalStepLabel": obj.get("originalStepLabel", ""),
        "originalStepName": obj.get("originalStepName", ""),
        "parentLabelPath": obj.get("parentLabelPath", ""),
        "shapeType": obj.get("shapeType", ""),
        "transformSource": obj.get("transformSource", ""),
        "faces": obj.get("faces", 0),
        "triangles": obj.get("triangles", 0),
    }


def score_candidate(simple: dict[str, Any], assembly: dict[str, Any]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    simple_name = normalise(simple.get("displayName", ""))
    assembly_text = normalise(
        " ".join([
            assembly.get("displayName", ""),
            assembly.get("originalStepName", ""),
            assembly.get("layer", ""),
            assembly.get("instanceLabelLayers", ""),
            assembly.get("referredLabelLayers", ""),
            assembly.get("matchedSubshapeLayers", ""),
        ])
    )
    if simple_name and simple_name in assembly_text:
        score += 80
        reasons.append("name match")
    if simple.get("layer") and simple.get("layer") == assembly.get("layer"):
        score += 25
        reasons.append("same primary layer")
    if simple.get("finalColour") and simple.get("finalColour") == assembly.get("finalColour"):
        score += 20
        reasons.append("same final colour")
    if simple.get("colourSource") and simple.get("colourSource") == assembly.get("colourSource"):
        score += 10
        reasons.append("same colour source")
    if simple.get("shapeType") and simple.get("shapeType") == assembly.get("shapeType"):
        score += 5
        reasons.append("same shape type")
    simple_triangles = int(simple.get("triangles") or 0)
    assembly_triangles = int(assembly.get("triangles") or 0)
    if simple_triangles and assembly_triangles:
        ratio = min(simple_triangles, assembly_triangles) / max(simple_triangles, assembly_triangles)
        if ratio > 0.80:
            score += 15
            reasons.append("similar triangle count")
    return score, reasons


def pick_simple_object(report: dict[str, Any], name_hint: str) -> dict[str, Any]:
    objects = report.get("objects", [])
    if not objects:
        return {}
    hint = normalise(name_hint)
    if hint:
        matches = [obj for obj in objects if hint in normalise(obj.get("displayName", ""))]
        if matches:
            return max(matches, key=lambda obj: int(obj.get("triangles") or 0))
    return max(objects, key=lambda obj: int(obj.get("triangles") or 0))


def build_comparison(
    simple_report: dict[str, Any],
    assembly_report: dict[str, Any],
    simple_name_hint: str,
) -> dict[str, Any]:
    simple = object_summary(pick_simple_object(simple_report, simple_name_hint))
    assembly_rows: list[dict[str, Any]] = []
    for obj in assembly_report.get("objects", []):
        summary = object_summary(obj)
        score, reasons = score_candidate(simple, summary)
        if score > 0:
            summary["matchScore"] = score
            summary["matchReasons"] = reasons
            assembly_rows.append(summary)
    assembly_rows.sort(key=lambda row: (-row["matchScore"], -int(row.get("triangles") or 0), row.get("displayName", "")))
    candidates = assembly_rows[:20]

    simple_colour = simple.get("finalColour", "")
    same_colour = [row for row in candidates if row.get("finalColour") == simple_colour]
    different_colour = [row for row in candidates if row.get("finalColour") != simple_colour]
    conclusion_parts = []
    if candidates:
        conclusion_parts.append(f"{len(candidates)} likely assembly candidates found by name/layer/colour/topology scoring.")
    else:
        conclusion_parts.append("No confident assembly candidate was found by report-only scoring.")
    if same_colour:
        conclusion_parts.append("At least one candidate carries the same final baseline colour.")
    if different_colour:
        conclusion_parts.append("At least one candidate differs from the simple object's final baseline colour.")
    if any(row.get("referredLabelColour") != "none" and row.get("instanceLabelColour") == "none" for row in candidates):
        conclusion_parts.append("Some candidates expose colour on the referred/original label but not the instance label.")
    if any(row.get("instanceLabelColour") != "none" and row.get("referredLabelColour") == "none" for row in candidates):
        conclusion_parts.append("Some candidates expose colour on the instance label but not the referred/original label.")

    return {
        "status": "generated",
        "method": "Simple report object selected by name hint or largest object; full assembly candidates scored by display/original name, layer, final colour, colour source, shape type, and triangle-count similarity.",
        "simpleTestObjectMetadata": simple,
        "matchingCandidateComponentsInFullAssembly": candidates,
        "colourCandidates": {
            "simple": simple.get("candidateColours", ""),
            "assembly": [
                {
                    "displayName": row.get("displayName", ""),
                    "instancePath": row.get("instancePath", ""),
                    "candidateColours": row.get("candidateColours", ""),
                }
                for row in candidates
            ],
        },
        "finalColours": {
            "simple": simple_colour,
            "assemblyCandidates": sorted({row.get("finalColour", "") for row in candidates}),
        },
        "hierarchyDifferences": [
            {
                "displayName": row.get("displayName", ""),
                "labelRole": row.get("labelRole", ""),
                "transformSource": row.get("transformSource", ""),
                "instanceLabelColour": row.get("instanceLabelColour", ""),
                "referredLabelColour": row.get("referredLabelColour", ""),
                "ancestorColour": row.get("ancestorColour", ""),
                "instanceLabelLayers": row.get("instanceLabelLayers", ""),
                "referredLabelLayers": row.get("referredLabelLayers", ""),
                "matchedSubshapeLayers": row.get("matchedSubshapeLayers", ""),
            }
            for row in candidates
        ],
        "conclusion": " ".join(conclusion_parts),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--simple", type=Path, required=True)
    parser.add_argument("--assembly", type=Path, required=True)
    parser.add_argument("--simple-name-hint", default="test 1")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    simple_report = load_report(args.simple)
    assembly_report = load_report(args.assembly)
    comparison = build_comparison(simple_report, assembly_report, args.simple_name_hint)
    simple_report["simpleVsAssemblyColourComparison"] = comparison
    assembly_report["simpleVsAssemblyColourComparison"] = comparison
    save_report(args.simple, simple_report)
    save_report(args.assembly, assembly_report)
    print(
        "Appended simpleVsAssemblyColourComparison with {} assembly candidates".format(
            len(comparison["matchingCandidateComponentsInFullAssembly"])
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
