// FormatIQ DXF backend — shared types

export type DxfToken = { code: number; value: string };

export type DxfLayer = {
  name: string;
  colorIndex: number;   // ACI 0-256
  trueColor: number | null;  // 24-bit packed RGB
  frozen: boolean;
};

export type ResolvedColor = {
  source: "entity-truecolor" | "entity-aci" | "byblock" | "layer-truecolor" | "layer-aci" | "default";
  rgb: [number, number, number];
  hex: string;
  aci?: number;
};

export type Dxf3DFace = {
  type: "3DFACE";
  handle: string | null;
  layer: string;
  colorIndex: number | null;
  trueColor: number | null;
  color: ResolvedColor;
  v0: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
  isTriangle: boolean;
  triangleCount: number;
};

export type DxfFaceRecord = { flags: number; i71: number; i72: number; i73: number; i74: number };

export type DxfPolyfaceMesh = {
  type: "POLYFACE_MESH" | "POLYMESH";
  handle: string | null;
  layer: string;
  colorIndex: number | null;
  trueColor: number | null;
  color: ResolvedColor;
  positions: [number, number, number][];
  faceRecords: DxfFaceRecord[];
  triangleCount: number;
};

export type DxfMeshEntity = {
  type: "MESH";
  handle: string | null;
  layer: string;
  colorIndex: number | null;
  trueColor: number | null;
  color: ResolvedColor;
  subdivisionLevel: number;
  vertexCount: number;
  faceListCount: number;
  triangleCount: 0;  // MESH triangulation not yet implemented; always 0
  note: string;
};

export type DxfInsert = {
  type: "INSERT";
  handle: string | null;
  layer: string;
  blockName: string;
  colorIndex: number | null;
  trueColor: number | null;
  position: [number, number, number];
  scale: [number, number, number];
  rotation: number;  // degrees around Z
};

export type DxfAcisEntity = {
  type: "3DSOLID" | "BODY" | "REGION";
  handle: string | null;
  layer: string;
  hasAcisData: boolean;
};

export type DxfSupportedEntity = Dxf3DFace | DxfPolyfaceMesh | DxfMeshEntity;

export type DxfBlock = {
  name: string;
  layer: string;
  origin: [number, number, number];
  flags: number;
  supported: DxfSupportedEntity[];
  acis: DxfAcisEntity[];
  inserts: DxfInsert[];
  skipped: Record<string, number>;
  triangleCount: number;
};

export type ParsedDxf = {
  dxfVersion: string | null;
  layers: Record<string, DxfLayer>;
  blocks: Record<string, DxfBlock>;
  entities: {
    supported: DxfSupportedEntity[];
    acis: DxfAcisEntity[];
    inserts: DxfInsert[];
    skipped: Record<string, number>;
  };
};

// --- Geometry ---

export type Triangle = {
  v: [[number, number, number], [number, number, number], [number, number, number]];
  materialKey: string;   // "Layer:{name}#{hex}"
  layer: string;
  colorHex: string;
  rgb: [number, number, number];
};

export type MaterialGroup = {
  materialKey: string;
  layer: string;
  colorHex: string;
  rgb: [number, number, number];
  positions: Float32Array;   // flat: x0,y0,z0, x1,y1,z1, ...
  normals: Float32Array;     // flat: nx0,ny0,nz0, ...
  triangleCount: number;
  vertexCount: number;
};

export type OptimizationStats = {
  rawTriangleCount: number;
  rawVertexCount: number;
  degenerateTrianglesRemoved: number;
  duplicateVerticesWelded: number;
  outputTriangleCount: number;
  outputVertexCount: number;
};

// --- Reports ---

export type DxfConversionStatus =
  | "ok"
  | "partial-with-warnings"
  | "acis-only-hard-error"
  | "no-usable-3d-geometry";

export type DxfFormatReport = {
  schemaVersion: 1;
  sourceFormat: "dxf";
  converterBackend: "dxf-js";
  dxfVersion: string | null;
  sourceFileName: string;
  sourceFileSizeBytes: number;
  entityCounts: {
    "3DFACE": number;
    POLYFACE_MESH: number;
    POLYMESH: number;
    MESH: number;
    INSERT: number;
    "3DSOLID": number;
    BODY: number;
    REGION: number;
  };
  skippedEntitySummary: Record<string, number>;
  acisEntityCount: number;
  layerCount: number;
  layers: { name: string; colorIndex: number; trueColor: number | null; hex: string; frozen: boolean }[];
  blockCount: number;
  blocks: { name: string; entityCount: number; acisCount: number; triangleCount: number }[];
  insertCount: number;
  insertsByBlock: Record<string, number>;
  conversionStatus: DxfConversionStatus;
  warnings: string[];
  exportAdvice: string | null;
};

export type DxfOptimizationReport = {
  schemaVersion: 1;
  converterBackend: "dxf-js";
  sourceFileName: string;
  geometry: {
    rawTriangleCount: number;
    rawVertexCount: number;
    outputTriangleCount: number;
    degenerateTrianglesRemoved: number;
    outputVertexCount: number;
    duplicateVerticesWelded: number;
  };
  blocks: {
    uniqueBlockDefinitions: number;
    totalInstanceCount: number;
    blockDefinitionsWithGeometry: number;
    emptyBlockDefinitions: number;
  };
  materials: {
    uniqueMaterials: number;
    materialsByLayer: Record<string, string[]>;
  };
  normals: {
    strategy: "flat";
    smoothAngleThreshold: null;
  };
  glb: {
    rawSizeBytes: number;
    displaySizeBytes: number | null;
    reductionPercent: number | null;
  };
  timing: {
    parseMs: number;
    meshOptimizationMs: number;
    glbBuildMs: number;
    totalMs: number;
  };
  warnings: string[];
};

// --- Converter I/O ---

export type ConvertDxfInput = {
  sourcePath: string;
  outputDir: string;
  slug: string;
};

export type ConvertDxfOutput = {
  displayGlbPath: string;
  manifestPath: string;
  statsPath: string;
  materialDebugPath: string;
  formatReportPath: string;
  dxfOptimizationReportPath: string;
  conversionLogPath: string;
};
