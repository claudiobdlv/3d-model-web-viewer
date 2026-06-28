// FormatIQ DXF — full 256-entry ACI colour table + resolver
import type { DxfLayer, ResolvedColor } from "./types.js";

// ACI "lighter" variant: for each channel, add (maxChannel - channel) / 2.
// Formula: (channel + maxChannel) / 2  (integer division)
function lighterVariant([r, g, b]: [number, number, number]): [number, number, number] {
  const mx = Math.max(r, g, b);
  return [Math.floor((r + mx) / 2), Math.floor((g + mx) / 2), Math.floor((b + mx) / 2)];
}

// 24 base hue colours used at positions x0 (indices 10, 20, ..., 240)
const BASE_HUE_COLORS: [number, number, number][] = [
  [255, 0, 0],    // 10
  [255, 63, 0],   // 20
  [255, 127, 0],  // 30
  [255, 191, 0],  // 40
  [255, 255, 0],  // 50
  [191, 255, 0],  // 60
  [127, 255, 0],  // 70
  [63, 255, 0],   // 80
  [0, 255, 0],    // 90
  [0, 255, 63],   // 100
  [0, 255, 127],  // 110
  [0, 255, 191],  // 120
  [0, 255, 255],  // 130
  [0, 191, 255],  // 140
  [0, 127, 255],  // 150
  [0, 63, 255],   // 160
  [0, 0, 255],    // 170
  [63, 0, 255],   // 180
  [127, 0, 255],  // 190
  [191, 0, 255],  // 200
  [255, 0, 255],  // 210
  [255, 0, 191],  // 220
  [255, 0, 127],  // 230
  [255, 0, 63],   // 240
];

// Scale factors for positions 0,2,4,6,8 within each hue group
const SCALE_NUMERATORS = [255, 165, 127, 76, 38];

function buildAciTable(): Map<number, [number, number, number]> {
  const table = new Map<number, [number, number, number]>();

  // ACI 1-9: exact standard colours
  table.set(1, [255, 0, 0]);
  table.set(2, [255, 255, 0]);
  table.set(3, [0, 255, 0]);
  table.set(4, [0, 255, 255]);
  table.set(5, [0, 0, 255]);
  table.set(6, [255, 0, 255]);
  table.set(7, [255, 255, 255]);
  table.set(8, [65, 65, 65]);
  table.set(9, [128, 128, 128]);

  // ACI 10-249: 24 hue groups × 10 entries (5 scale levels × 2: base + lighter)
  for (let hue = 0; hue < 24; hue++) {
    const base = BASE_HUE_COLORS[hue]!;
    for (let level = 0; level < 5; level++) {
      const scale = SCALE_NUMERATORS[level]!;
      const scaled: [number, number, number] = [
        Math.round((base[0] * scale) / 255),
        Math.round((base[1] * scale) / 255),
        Math.round((base[2] * scale) / 255),
      ];
      const lighter = lighterVariant(scaled);
      const idx = 10 + hue * 10 + level * 2;
      table.set(idx, scaled);
      table.set(idx + 1, lighter);
    }
  }

  // ACI 250-255: greyscale ramp
  table.set(250, [51, 51, 51]);
  table.set(251, [80, 80, 80]);
  table.set(252, [105, 105, 105]);
  table.set(253, [130, 130, 130]);
  table.set(254, [190, 190, 190]);
  table.set(255, [255, 255, 255]);

  return table;
}

const ACI_TABLE = buildAciTable();

export function aciToRgb(index: number): [number, number, number] {
  const abs = Math.abs(index);
  return ACI_TABLE.get(abs) ?? [200, 200, 200];
}

export function trueColorToRgb(value: number): [number, number, number] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// Resolve the display colour for an entity, honouring the BYLAYER chain.
// Priority: entity true-colour > entity ACI (not 0/256) > BYBLOCK > BYLAYER > default grey
export function resolveColor(
  entityColorIndex: number | null,
  entityTrueColor: number | null,
  layerName: string,
  layers: Record<string, DxfLayer>,
  inheritedByBlockColor?: ResolvedColor
): ResolvedColor {
  if (entityTrueColor !== null && entityTrueColor !== undefined) {
    const rgb = trueColorToRgb(entityTrueColor);
    return { source: "entity-truecolor", rgb, hex: rgbToHex(rgb) };
  }

  const aci = entityColorIndex;

  if (aci === 0) {
    if (inheritedByBlockColor) {
      const source = inheritedByBlockColor.source === "entity-truecolor" || inheritedByBlockColor.source === "insert-truecolor"
        ? "insert-truecolor"
        : inheritedByBlockColor.source === "entity-aci" || inheritedByBlockColor.source === "insert-aci"
          ? "insert-aci"
          : "insert-layer";
      return { ...inheritedByBlockColor, source };
    }
    return { source: "byblock", rgb: [200, 200, 200], hex: "#c8c8c8" };
  }

  if (aci === null || aci === undefined || aci === 256) {
    // BYLAYER — look up the layer table
    const layer = layers[layerName] ?? layers["0"];
    if (!layer) return { source: "default", rgb: [200, 200, 200], hex: "#c8c8c8" };
    if (layer.trueColor !== null && layer.trueColor !== undefined) {
      const rgb = trueColorToRgb(layer.trueColor);
      return { source: "layer-truecolor", rgb, hex: rgbToHex(rgb) };
    }
    const rgb = aciToRgb(layer.colorIndex);
    return { source: "layer-aci", aci: layer.colorIndex, rgb, hex: rgbToHex(rgb) };
  }

  const rgb = aciToRgb(aci);
  return { source: "entity-aci", aci, rgb, hex: rgbToHex(rgb) };
}

export function materialKey(layer: string, hex: string): string {
  return `Layer:${layer}${hex}`;
}
