#!/usr/bin/env python3
"""Inspect raw STEP presentation/style colour data.

The parser is intentionally shallow: it reads entity records, extracts entity
types, references, names, and compact previews, then builds a reference graph.
It does not parse BREP geometry or expand large argument arrays.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any


TARGET_TYPES = [
    "STYLED_ITEM",
    "PRESENTATION_STYLE_ASSIGNMENT",
    "SURFACE_STYLE_USAGE",
    "SURFACE_SIDE_STYLE",
    "SURFACE_STYLE_FILL_AREA",
    "FILL_AREA_STYLE",
    "FILL_AREA_STYLE_COLOUR",
    "COLOUR_RGB",
    "DRAUGHTING_PRE_DEFINED_COLOUR",
    "PRESENTATION_LAYER_ASSIGNMENT",
    "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION",
]

STYLE_WORDS = (
    "COLOUR",
    "COLOR",
    "STYLE",
    "LAYER",
    "PRESENTATION",
    "DRAUGHTING",
    "RENDER",
    "MATERIAL",
)

REF_RE = re.compile(r"#\d+")
NUMBER_RE = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][-+]?\d+)?")


def compact(value: str, limit: int = 260) -> str:
    value = " ".join(value.split())
    if len(value) <= limit:
        return value
    return value[: limit - 3] + "..."


def unquote_step_string(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def first_step_string(value: str) -> str:
    in_string = False
    start = -1
    i = 0
    while i < len(value):
        c = value[i]
        if c == "'":
            if in_string and i + 1 < len(value) and value[i + 1] == "'":
                i += 2
                continue
            if in_string:
                return value[start + 1 : i].replace("''", "'")
            in_string = True
            start = i
        i += 1
    return ""


def split_top_level(args: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    in_string = False
    i = 0
    while i < len(args):
        c = args[i]
        if c == "'":
            if in_string and i + 1 < len(args) and args[i + 1] == "'":
                i += 2
                continue
            in_string = not in_string
        elif not in_string:
            if c == "(":
                depth += 1
            elif c == ")":
                depth = max(0, depth - 1)
            elif c == "," and depth == 0:
                parts.append(args[start:i].strip())
                start = i + 1
        i += 1
    tail = args[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def extract_entity_records(text: str) -> dict[str, dict[str, Any]]:
    entities: dict[str, dict[str, Any]] = {}
    data_match = re.search(r"\bDATA\s*;", text, re.IGNORECASE)
    start = data_match.end() if data_match else 0
    end_match = re.search(r"\bENDSEC\s*;", text[start:], re.IGNORECASE)
    end = start + end_match.start() if end_match else len(text)
    data = text[start:end]

    i = 0
    while True:
        hash_at = data.find("#", i)
        if hash_at < 0:
            break
        id_start = hash_at + 1
        id_end = id_start
        while id_end < len(data) and data[id_end].isdigit():
            id_end += 1
        if id_end == id_start:
            i = hash_at + 1
            continue
        entity_id = data[hash_at:id_end]
        j = id_end
        while j < len(data) and data[j].isspace():
            j += 1
        if j >= len(data) or data[j] != "=":
            i = id_end
            continue
        j += 1
        while j < len(data) and data[j].isspace():
            j += 1
        type_start = j
        while j < len(data) and (data[j].isalnum() or data[j] == "_"):
            j += 1
        entity_type = data[type_start:j].upper()
        while j < len(data) and data[j].isspace():
            j += 1
        if j >= len(data) or data[j] != "(":
            i = j
            continue

        args_start = j + 1
        depth = 1
        in_string = False
        j += 1
        while j < len(data):
            c = data[j]
            if c == "'":
                if in_string and j + 1 < len(data) and data[j + 1] == "'":
                    j += 2
                    continue
                in_string = not in_string
            elif not in_string:
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        args = data[args_start:j]
                        entities[entity_id] = {
                            "id": entity_id,
                            "type": entity_type,
                            "args": args,
                            "refs": sorted(set(REF_RE.findall(args)), key=lambda ref: int(ref[1:])),
                            "name": first_step_string(args),
                            "preview": compact(args),
                        }
                        j += 1
                        while j < len(data) and data[j] != ";":
                            j += 1
                        break
            j += 1
        i = j + 1
    return entities


def entity_summary(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entity["id"],
        "type": entity["type"],
        "name": entity.get("name", ""),
        "refs": entity.get("refs", []),
        "preview": entity.get("preview", ""),
    }


def colour_value(entity: dict[str, Any]) -> dict[str, Any]:
    parts = split_top_level(entity["args"])
    if entity["type"] == "COLOUR_RGB":
        nums = [float(n) for n in NUMBER_RE.findall(entity["args"])]
        rgb = nums[-3:] if len(nums) >= 3 else []
        return {"kind": "rgb", "name": unquote_step_string(parts[0]) if parts else "", "rgb": rgb}
    if entity["type"] == "DRAUGHTING_PRE_DEFINED_COLOUR":
        return {"kind": "named", "name": unquote_step_string(parts[0]) if parts else entity.get("name", "")}
    return {"kind": "unknown", "name": entity.get("name", "")}


def build_reverse_refs(entities: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    reverse: dict[str, list[str]] = defaultdict(list)
    for entity_id, entity in entities.items():
        for ref in entity["refs"]:
            reverse[ref].append(entity_id)
    return {key: sorted(value, key=lambda ref: int(ref[1:])) for key, value in reverse.items()}


def trace_to_types(
    start: str,
    reverse_refs: dict[str, list[str]],
    entities: dict[str, dict[str, Any]],
    target_types: set[str],
    max_depth: int = 10,
) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    seen = {start}
    queue: deque[tuple[str, list[str]]] = deque([(start, [start])])
    while queue:
        current, path = queue.popleft()
        if len(path) > max_depth:
            continue
        for parent in reverse_refs.get(current, []):
            if parent in seen:
                continue
            seen.add(parent)
            next_path = path + [parent]
            parent_type = entities.get(parent, {}).get("type", "")
            if parent_type in target_types:
                hits.append(
                    {
                        "id": parent,
                        "type": parent_type,
                        "name": entities[parent].get("name", ""),
                        "path": next_path,
                        "pathTypes": [entities[p]["type"] for p in next_path if p in entities],
                    }
                )
            queue.append((parent, next_path))
    return hits


def style_entities_report(entities: dict[str, dict[str, Any]], reverse_refs: dict[str, list[str]]) -> dict[str, Any]:
    counts_by_type = Counter(entity["type"] for entity in entities.values())
    related_types = {
        entity_type: count
        for entity_type, count in sorted(counts_by_type.items())
        if any(word in entity_type for word in STYLE_WORDS)
    }
    target_counts = {entity_type: counts_by_type.get(entity_type, 0) for entity_type in TARGET_TYPES}
    examples = {
        entity_type: [
            entity_summary(entity)
            for entity in sorted(entities.values(), key=lambda item: int(item["id"][1:]))
            if entity["type"] == entity_type
        ][:8]
        for entity_type in TARGET_TYPES
    }

    colour_ids = [
        entity_id
        for entity_id, entity in sorted(entities.items(), key=lambda item: int(item[0][1:]))
        if entity["type"] in {"COLOUR_RGB", "DRAUGHTING_PRE_DEFINED_COLOUR"}
    ]
    colour_reports = []
    for colour_id in colour_ids:
        entity = entities[colour_id]
        style_refs = trace_to_types(
            colour_id,
            reverse_refs,
            entities,
            {
                "FILL_AREA_STYLE_COLOUR",
                "FILL_AREA_STYLE",
                "SURFACE_STYLE_FILL_AREA",
                "SURFACE_SIDE_STYLE",
                "SURFACE_STYLE_USAGE",
                "PRESENTATION_STYLE_ASSIGNMENT",
            },
        )
        styled_refs = trace_to_types(colour_id, reverse_refs, entities, {"STYLED_ITEM"}, max_depth=12)
        colour_reports.append(
            {
                "id": colour_id,
                "type": entity["type"],
                "value": colour_value(entity),
                "referencingStyleEntities": style_refs,
                "styledItemIds": [hit["id"] for hit in styled_refs],
                "styledItemTraces": styled_refs[:20],
            }
        )

    styled_items = []
    for entity_id, entity in sorted(entities.items(), key=lambda item: int(item[0][1:])):
        if entity["type"] != "STYLED_ITEM":
            continue
        colour_refs = trace_to_types(entity_id, reverse_refs, entities, {"COLOUR_RGB", "DRAUGHTING_PRE_DEFINED_COLOUR"})
        direct_linked_colours = [
            colour_id
            for colour_id in colour_ids
            if any(hit["id"] == entity_id for hit in trace_to_types(colour_id, reverse_refs, entities, {"STYLED_ITEM"}, max_depth=12))
        ]
        refs = entity["refs"]
        styled_items.append(
            {
                "id": entity_id,
                "name": entity.get("name", ""),
                "refs": refs,
                "styleAssignmentIds": [ref for ref in refs if entities.get(ref, {}).get("type") == "PRESENTATION_STYLE_ASSIGNMENT"],
                "referencedItemIds": [ref for ref in refs if entities.get(ref, {}).get("type") != "PRESENTATION_STYLE_ASSIGNMENT"],
                "linkedColourIds": direct_linked_colours,
                "reverseColourRefs": colour_refs[:10],
                "preview": entity["preview"],
            }
        )

    layers = []
    for entity_id, entity in sorted(entities.items(), key=lambda item: int(item[0][1:])):
        if entity["type"] != "PRESENTATION_LAYER_ASSIGNMENT":
            continue
        parts = split_top_level(entity["args"])
        member_ids = entity["refs"]
        layer_colour_hits = []
        for ref in member_ids:
            layer_colour_hits.extend(
                hit
                for hit in trace_to_types(ref, reverse_refs, entities, {"COLOUR_RGB", "DRAUGHTING_PRE_DEFINED_COLOUR"}, max_depth=5)
            )
        layers.append(
            {
                "id": entity_id,
                "name": unquote_step_string(parts[0]) if parts else entity.get("name", ""),
                "description": unquote_step_string(parts[1]) if len(parts) > 1 else "",
                "memberStepEntityIds": member_ids,
                "memberExamples": [entity_summary(entities[ref]) for ref in member_ids[:12] if ref in entities],
                "hasColourOrStyleEntity": any(
                    entities.get(ref, {}).get("type", "").find("COLOUR") >= 0
                    or entities.get(ref, {}).get("type", "").find("STYLE") >= 0
                    for ref in member_ids
                ),
                "colourRefsFoundThroughMembers": layer_colour_hits[:20],
            }
        )

    return {
        "totalEntities": len(entities),
        "targetCounts": target_counts,
        "styleRelatedTypesFound": related_types,
        "targetExamples": examples,
        "colours": colour_reports,
        "styledItems": styled_items,
        "presentationLayers": layers,
        "mechanicalDesignPresentationRepresentations": [
            entity_summary(entity)
            for entity in entities.values()
            if entity["type"] == "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION"
        ],
    }


def normalize_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def token_set(value: Any) -> set[str]:
    return {token for token in normalize_text(value).split() if len(token) >= 3}


def index_named_entities(entities: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    indexed = []
    for entity in entities.values():
        name = entity.get("name", "")
        if not name:
            continue
        indexed.append(
            {
                "id": entity["id"],
                "type": entity["type"],
                "name": name,
                "tokens": token_set(name),
                "refs": entity["refs"],
            }
        )
    return indexed


def styled_item_colour_map(report: dict[str, Any]) -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = defaultdict(list)
    for colour in report["colours"]:
        for styled_id in colour.get("styledItemIds", []):
            mapping[styled_id].append(colour["id"])
    return dict(mapping)


def styled_items_near_entity(
    start_id: str,
    entities: dict[str, dict[str, Any]],
    reverse_refs: dict[str, list[str]],
    max_depth: int = 5,
) -> list[dict[str, Any]]:
    """Find styled items reachable through representation/BREP links.

    This deliberately walks only representation and topological item types that
    are useful for correlating a named shape representation with its styled BREP
    solids. It avoids broad product/context/unit graphs.
    """

    traversable_words = (
        "REPRESENTATION",
        "BREP",
        "SHELL",
        "FACE",
        "SOLID",
        "TRANSFORMATION",
        "PLACEMENT",
    )
    hits: list[dict[str, Any]] = []
    seen = {start_id}
    queue: deque[tuple[str, list[str]]] = deque([(start_id, [start_id])])

    def can_traverse(entity_id: str) -> bool:
        entity_type = entities.get(entity_id, {}).get("type", "")
        return entity_type == "STYLED_ITEM" or any(word in entity_type for word in traversable_words)

    while queue:
        current, path = queue.popleft()
        if len(path) > max_depth:
            continue
        neighbours = list(entities.get(current, {}).get("refs", [])) + list(reverse_refs.get(current, []))
        for neighbour in neighbours:
            if neighbour in seen or neighbour not in entities or not can_traverse(neighbour):
                continue
            seen.add(neighbour)
            next_path = path + [neighbour]
            entity = entities[neighbour]
            if entity["type"] == "STYLED_ITEM":
                hits.append(
                    {
                        "id": neighbour,
                        "name": entity.get("name", ""),
                        "referencedItemIds": [
                            ref
                            for ref in entity.get("refs", [])
                            if entities.get(ref, {}).get("type") != "PRESENTATION_STYLE_ASSIGNMENT"
                        ],
                        "path": next_path,
                        "pathTypes": [entities[item]["type"] for item in next_path if item in entities],
                    }
                )
            else:
                queue.append((neighbour, next_path))
    hits.sort(key=lambda item: (len(item["path"]), int(item["id"][1:])))
    return hits[:30]


def find_raw_candidates(
    grey: dict[str, Any],
    raw_report: dict[str, Any],
    entities: dict[str, dict[str, Any]],
    reverse_refs: dict[str, list[str]],
    named_entities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    grey_tokens = token_set(" ".join(str(grey.get(k, "")) for k in ["displayName", "layer", "labelPath", "parentLabelPath"]))
    grey_layer = normalize_text(grey.get("layer", ""))
    colour_by_styled = styled_item_colour_map(raw_report)

    for styled in raw_report["styledItems"]:
        refs = styled.get("referencedItemIds", [])
        ref_names = [entities[ref].get("name", "") for ref in refs if ref in entities and entities[ref].get("name")]
        styled_tokens = token_set(" ".join([styled.get("name", ""), *ref_names]))
        overlap = sorted(grey_tokens & styled_tokens)
        if not overlap:
            continue
        candidates.append(
            {
                "matchType": "styled-item-name-token",
                "score": len(overlap),
                "matchedTokens": overlap,
                "styledItemId": styled["id"],
                "styledItemName": styled.get("name", ""),
                "referencedItemIds": refs,
                "referencedItemNames": ref_names,
                "colourIds": colour_by_styled.get(styled["id"], styled.get("linkedColourIds", [])),
            }
        )

    for layer in raw_report["presentationLayers"]:
        layer_name = normalize_text(layer.get("name", ""))
        if not grey_layer or not layer_name:
            continue
        if grey_layer == layer_name or grey_layer in layer_name or layer_name in grey_layer:
            member_style_ids = [
                member_id
                for member_id in layer.get("memberStepEntityIds", [])
                if entities.get(member_id, {}).get("type") == "STYLED_ITEM"
            ]
            candidates.append(
                {
                    "matchType": "presentation-layer-name",
                    "score": 5,
                    "layerId": layer["id"],
                    "layerName": layer.get("name", ""),
                    "memberStyledItemIds": member_style_ids,
                    "hasColourOrStyleEntity": layer.get("hasColourOrStyleEntity", False),
                    "colourRefsFoundThroughMembers": layer.get("colourRefsFoundThroughMembers", []),
                }
            )

    for named in named_entities:
        overlap = sorted(grey_tokens & named["tokens"])
        if len(overlap) < 2:
            continue
        nearby_styled_items = styled_items_near_entity(named["id"], entities, reverse_refs)
        nearby_colour_ids = sorted(
            {
                colour_id
                for styled in nearby_styled_items
                for colour_id in colour_by_styled.get(styled["id"], [])
            },
            key=lambda ref: int(ref[1:]),
        )
        candidates.append(
            {
                "matchType": "raw-entity-name-token",
                "score": len(overlap),
                "matchedTokens": overlap,
                "entityId": named["id"],
                "entityType": named["type"],
                "entityName": named["name"],
                "refs": named["refs"][:20],
                "nearbyStyledItems": nearby_styled_items,
                "colourIds": nearby_colour_ids,
            }
        )

    candidates.sort(key=lambda item: (-item.get("score", 0), item.get("matchType", ""), item.get("styledItemId", item.get("entityId", ""))))
    return candidates[:25]


def build_crossref(xcaf_report_path: Path, raw_report: dict[str, Any], entities: dict[str, dict[str, Any]]) -> dict[str, Any]:
    xcaf = json.loads(xcaf_report_path.read_text(encoding="utf-8"))
    reverse_refs = build_reverse_refs(entities)
    default_groups = xcaf.get("defaultPrimitiveGroups", [])
    named_entities = index_named_entities(entities)
    grey_candidates = []
    groups_with_candidates = 0
    groups_with_colour_candidates = 0

    for group in default_groups:
        candidates = find_raw_candidates(group, raw_report, entities, reverse_refs, named_entities)
        if candidates:
            groups_with_candidates += 1
        if any(candidate.get("colourIds") or candidate.get("colourRefsFoundThroughMembers") for candidate in candidates):
            groups_with_colour_candidates += 1
        grey_candidates.append({**group, "rawStyleCandidates": candidates})

    return {
        "xcafReport": str(xcaf_report_path),
        "xcafOpenCascadeVersion": xcaf.get("openCascadeVersion"),
        "xcafLayerColourAvailability": xcaf.get("layerColourAvailability"),
        "xcafSummary": xcaf.get("summary"),
        "defaultGreyGroupCount": len(default_groups),
        "defaultGreyGroupsWithRawCandidates": groups_with_candidates,
        "defaultGreyGroupsWithRawColourCandidates": groups_with_colour_candidates,
        "candidateMethod": [
            "Token overlap between XCAF grey group display/layer/label text and raw STEP styled item or referenced item names.",
            "Representation/BREP graph walk from matched raw entities to nearby STYLED_ITEM entries and their COLOUR_RGB ids.",
            "Presentation-layer name equality/containment when XCAF exposes a layer name.",
            "Token overlap against other named raw STEP entities as weak fallback context.",
        ],
        "greyObjectRawStyleCandidates": grey_candidates,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect raw STEP colour/style/layer entities.")
    parser.add_argument("step_file", type=Path)
    parser.add_argument("--xcaf-report", type=Path)
    parser.add_argument("--out", type=Path, default=Path("/tmp/u843-step-style-report.json"))
    parser.add_argument("--crossref-out", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    text = args.step_file.read_text(encoding="utf-8", errors="replace")
    entities = extract_entity_records(text)
    reverse_refs = build_reverse_refs(entities)
    raw_report = style_entities_report(entities, reverse_refs)
    raw_report["inputFile"] = str(args.step_file)
    raw_report["notes"] = [
        "Raw STEP scan is shallow and reference-graph based; it does not parse BREP geometry arrays.",
        "Colour-to-styled-item traces follow reverse STEP references from colour entities.",
        "Layer colour detection is based on explicit colour/style members or traced member colours, not layer-name rules.",
    ]

    if args.xcaf_report:
        crossref = build_crossref(args.xcaf_report, raw_report, entities)
        raw_report["xcafCrossReference"] = {
            key: value
            for key, value in crossref.items()
            if key != "greyObjectRawStyleCandidates"
        }
        raw_report["greyObjectRawStyleCandidates"] = crossref["greyObjectRawStyleCandidates"]
        if args.crossref_out:
            args.crossref_out.write_text(json.dumps(crossref, indent=2), encoding="utf-8")

    args.out.write_text(json.dumps(raw_report, indent=2), encoding="utf-8")
    print(f"Parsed {len(entities)} STEP entities")
    print(f"Wrote {args.out}")
    if args.crossref_out and args.xcaf_report:
        print(f"Wrote {args.crossref_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
