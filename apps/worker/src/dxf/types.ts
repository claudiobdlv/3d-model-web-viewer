// FormatIQ DXF backend — shared types

export type DxfToken = { code: number; value: string };

export type DxfLayer = {
  name: string;
  colorIndex: number;   // ACI 0-256
  trueColor: number | null;  // 24-bit packed RGB
  frozen: boolean;
};

export type ResolvedColor = {
  source: "entity-truecolor" | "entity-aci" | "byblock" | "insert-truecolor" | "insert-aci" | "insert-layer" | "layer-truecolor" | "layer-aci" | "default";
  rgb: [number, number, number];
  hex: string;
  aci?: number;
};

export type DxfExtrusion = [number, number, number];

export type DxfOcsMetadata = {
  extrusion: DxfExtrusion;
  hasExplicitExtrusion: boolean;
  ocsApplied: boolean;
};

export type Dxf3DFace = DxfOcsMetadata & {
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

export type DxfPolyfaceMesh = DxfOcsMetadata & {
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

export type DxfMeshEntity = DxfOcsMetadata & {
  type: "MESH";
  handle: string | null;
  layer: string;
  colorIndex: number | null;
  trueColor: number | null;
  color: ResolvedColor;
  version: number;
  blendCrease: boolean;
  subdivisionLevel: number;
  vertexCount: number;
  faceListCount: number;
  positions: [number, number, number][];
  faces: number[][];
  invalidFaceCount: number;
  diagnostics: DxfMeshDiagnostic[];
  triangleCount: number;
  note: string;
};

export type DxfMeshDiagnostic = {
  code:
    | "missing-vertex-list"
    | "vertex-count-mismatch"
    | "missing-face-list"
    | "face-list-count-mismatch"
    | "malformed-face-list"
    | "face-index-out-of-range"
    | "unsupported-subdivision-data"
    | "unsupported-crease-data";
  message: string;
};

export type DxfInsert = DxfOcsMetadata & {
  type: "INSERT" | "MINSERT";
  handle: string | null;
  layer: string;
  blockName: string;
  colorIndex: number | null;
  trueColor: number | null;
  position: [number, number, number];
  scale: [number, number, number];
  rotation: number;  // degrees around Z
  rowCount: number;
  columnCount: number;
  rowSpacing: number;
  columnSpacing: number;
};

export type DxfInsertInstance = {
  insert: DxfInsert;
  position: [number, number, number];
  rowIndex: number;
  columnIndex: number;
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

export type DxfBlockTraversalSummary = {
  maxDepthLimit: number;
  nestedInsertCount: number;
  renderedInsertCount: number;
  maxBlockNestingDepth: number;
  reachableTriangleCount: number;
  cycleWarnings: string[];
  depthLimitWarnings: string[];
  missingBlockWarnings: string[];
  mInsertCount: number;
  expandedMInsertInstanceCount: number;
};

export type DxfBlockReuseStats = {
  uniqueRenderedMeshes: number;
  reusedBlockMeshCount: number;
  geometryDuplicationAvoidedTriangles: number;
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
    MINSERT: number;
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
  mInsertCount: number;
  expandedMInsertInstanceCount: number;
  insertsByBlock: Record<string, number>;
  nestedInsertCount: number;
  maxBlockNestingDepth: number;
  blockCycleWarningCount: number;
  blockDepthLimitWarningCount: number;
  mesh: {
    triangulationStatus: "not-present" | "triangulated" | "detected-invalid";
    entityCount: number;
    triangulatedEntityCount: number;
    triangleCount: number;
    invalidFaceCount: number;
    malformedWarningCount: number;
    diagnostics: { code: DxfMeshDiagnostic["code"]; message: string; handle: string | null }[];
  };
  malformedMeshWarningCount: number;
  layer0InheritedEntityCount: number;
  inheritedLayerSummary: Record<string, number>;
  ocs: {
    explicitExtrusionEntityCount: number;
    transformedEntityCount: number;
    unsupportedEntityCount: number;
    unsupportedWarningCount: number;
  };
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
    nestedInstanceCount: number;
    blockDefinitionsWithGeometry: number;
    emptyBlockDefinitions: number;
    uniqueRenderedMeshes: number;
    reusedBlockMeshCount: number;
    geometryDuplicationAvoidedTriangles: number;
    expandedMInsertInstanceCount: number;
  };
  materials: {
    uniqueMaterials: number;
    materialsByLayer: Record<string, string[]>;
    cardinalityWarning: string | null;
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
  meshopt: {
    requestedMode: "disabled" | "meshopt";
    status: "applied" | "failed" | "disabled" | "skipped-not-smaller";
    validationPassed: boolean;
    fallbackUsed: boolean;
    message: string;
  };
  timing: {
    parseMs: number;
    traversalMs: number;
    meshOptimizationMs: number;
    glbBuildMs: number;
    meshoptMs: number;
    totalMs: number;
  };
  warnings: string[];
};

// --- Converter I/O ---

export type ConvertDxfInput = {
  sourcePath: string;
  outputDir: string;
  slug: string;
  glbOptimizationMode?: "disabled" | "meshopt";
  quality?: "low" | "medium" | "high";
  signal?: AbortSignal;
  onProgress?: (percent: number, label: string) => void | Promise<void>;
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
