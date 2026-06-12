import fs from "node:fs";
import path from "node:path";

export type FakeProcessorInput = {
  slug: string;
  sourcePath: string;
  outputDir: string;
  placeholderGlb?: string;
};

export type FakeProcessorOutput = {
  displayGlbPath: string;
  manifestPath: string;
  statsPath: string;
};

export async function fakeProcess(input: FakeProcessorInput): Promise<FakeProcessorOutput> {
  const jobDir = path.join(input.outputDir, input.slug);
  fs.mkdirSync(jobDir, { recursive: true });

  const displayGlbPath = path.join(jobDir, "display.glb");
  if (input.placeholderGlb && fs.existsSync(input.placeholderGlb)) {
    fs.copyFileSync(input.placeholderGlb, displayGlbPath);
  } else {
    fs.writeFileSync(displayGlbPath, createMinimalGlb());
  }

  const now = new Date().toISOString();
  const sourceStats = fs.statSync(input.sourcePath);
  const displayStats = fs.statSync(displayGlbPath);

  const manifestPath = path.join(jobDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        slug: input.slug,
        status: "ready",
        displayFile: "display.glb",
        generatedBy: "fake-worker",
        generatedAt: now
      },
      null,
      2
    )}\n`
  );

  const statsPath = path.join(jobDir, "stats.json");
  fs.writeFileSync(
    statsPath,
    `${JSON.stringify(
      {
        sourceBytes: sourceStats.size,
        displayBytes: displayStats.size,
        processor: "fake",
        generatedAt: now
      },
      null,
      2
    )}\n`
  );

  return {
    displayGlbPath,
    manifestPath,
    statsPath
  };
}

function createMinimalGlb(): Buffer {
  const positions = Buffer.alloc(36);
  const values = [0, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0];
  values.forEach((value, index) => positions.writeFloatLE(value, index * 4));

  const indices = Buffer.alloc(8);
  indices.writeUInt16LE(0, 0);
  indices.writeUInt16LE(1, 2);
  indices.writeUInt16LE(2, 4);

  const binaryChunk = Buffer.concat([positions, indices]);
  const json = {
    asset: { version: "2.0", generator: "3d-viewer-fake-worker" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            mode: 4
          }
        ]
      }
    ],
    buffers: [{ byteLength: binaryChunk.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: 6, target: 34963 }
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [-0.5, -0.5, 0],
        max: [0.5, 0.5, 0]
      },
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5123,
        count: 3,
        type: "SCALAR"
      }
    ]
  };

  const jsonChunk = padChunk(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = padChunk(binaryChunk, 0x00);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

function padChunk(buffer: Buffer, padByte: number): Buffer {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding, padByte)]);
}
