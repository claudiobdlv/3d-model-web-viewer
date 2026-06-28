import type { DxfBlockTraversalSummary, DxfInsert, ParsedDxf } from "./types.js";

export const DEFAULT_BLOCK_NESTING_LIMIT = 10;

export function analyzeBlockTraversal(
  parsedDxf: ParsedDxf,
  maxDepthLimit = DEFAULT_BLOCK_NESTING_LIMIT
): DxfBlockTraversalSummary {
  const summary: DxfBlockTraversalSummary = {
    maxDepthLimit,
    nestedInsertCount: 0,
    renderedInsertCount: 0,
    maxBlockNestingDepth: 0,
    reachableTriangleCount: 0,
    cycleWarnings: [],
    depthLimitWarnings: [],
    missingBlockWarnings: [],
  };

  function visit(insert: DxfInsert, depth: number, stack: string[]): void {
    const path = [...stack, insert.blockName];
    if (stack.includes(insert.blockName)) {
      summary.cycleWarnings.push(`Circular block reference skipped: ${path.join(" -> ")}.`);
      return;
    }
    if (depth > maxDepthLimit) {
      summary.depthLimitWarnings.push(
        `Block nesting depth limit ${maxDepthLimit} exceeded at ${path.join(" -> ")}; deeper branch skipped.`
      );
      return;
    }

    const block = parsedDxf.blocks[insert.blockName];
    if (!block) {
      summary.missingBlockWarnings.push(`INSERT references missing block "${insert.blockName}"; branch skipped.`);
      return;
    }

    summary.renderedInsertCount++;
    summary.maxBlockNestingDepth = Math.max(summary.maxBlockNestingDepth, depth);
    summary.reachableTriangleCount += block.triangleCount;

    for (const nestedInsert of block.inserts) {
      summary.nestedInsertCount++;
      visit(nestedInsert, depth + 1, path);
    }
  }

  for (const insert of parsedDxf.entities.inserts) {
    visit(insert, 1, []);
  }

  return summary;
}
