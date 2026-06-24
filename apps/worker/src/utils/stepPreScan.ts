import fs from "node:fs";
import readline from "node:readline";

export type StepPreScanResult = {
  fileSizeBytes: number;
  advancedFaceCount: number;
  manifoldSolidBrepCount: number;
  closedShellCount: number;
  productCount: number;
  shapeRepresentationCount: number;
  relationshipCount: number;
  probablyComplex: boolean;
  reasons: string[];
};

function countSubstring(str: string, substr: string): number {
  let count = 0;
  let pos = str.indexOf(substr);
  while (pos !== -1) {
    count++;
    pos = str.indexOf(substr, pos + substr.length);
  }
  return count;
}

export async function preScanStepFile(filePath: string): Promise<StepPreScanResult> {
  const stat = await fs.promises.stat(filePath);
  const fileSizeBytes = stat.size;

  let advancedFaceCount = 0;
  let manifoldSolidBrepCount = 0;
  let closedShellCount = 0;
  let productCount = 0;
  let shapeRepresentationCount = 0;
  let relationshipCount = 0;

  const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (line.includes("ADVANCED_FACE")) {
      advancedFaceCount += countSubstring(line, "ADVANCED_FACE");
    }
    if (line.includes("MANIFOLD_SOLID_BREP")) {
      manifoldSolidBrepCount += countSubstring(line, "MANIFOLD_SOLID_BREP");
    }
    if (line.includes("CLOSED_SHELL")) {
      closedShellCount += countSubstring(line, "CLOSED_SHELL");
    }
    if (line.includes("PRODUCT(")) {
      productCount += countSubstring(line, "PRODUCT(");
    }
    if (line.includes("SHAPE_REPRESENTATION")) {
      shapeRepresentationCount += countSubstring(line, "SHAPE_REPRESENTATION");
    }
    if (line.includes("SHAPE_REPRESENTATION_RELATIONSHIP")) {
      relationshipCount += countSubstring(line, "SHAPE_REPRESENTATION_RELATIONSHIP");
    }
  }

  // Adjust shapeRepresentationCount to subtract occurrences that were actually shape representation relationships
  shapeRepresentationCount = Math.max(0, shapeRepresentationCount - relationshipCount);

  const reasons: string[] = [];
  if (advancedFaceCount >= 50000) {
    reasons.push(`advancedFaceCount ${advancedFaceCount} >= 50000`);
  }
  if (manifoldSolidBrepCount >= 1500) {
    reasons.push(`manifoldSolidBrepCount ${manifoldSolidBrepCount} >= 1500`);
  }
  if (productCount >= 1000) {
    reasons.push(`productCount ${productCount} >= 1000`);
  }
  if (relationshipCount >= 1000) {
    reasons.push(`relationshipCount ${relationshipCount} >= 1000`);
  }

  const probablyComplex = reasons.length > 0;

  return {
    fileSizeBytes,
    advancedFaceCount,
    manifoldSolidBrepCount,
    closedShellCount,
    productCount,
    shapeRepresentationCount,
    relationshipCount,
    probablyComplex,
    reasons
  };
}
