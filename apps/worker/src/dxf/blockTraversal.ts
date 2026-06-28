import type { DxfBlockTraversalSummary, DxfInsert, ParsedDxf } from "./types.js";
import { expandInsertInstances } from "./insertInstances.js";

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
    mInsertCount: 0,
    expandedMInsertInstanceCount: 0,
  };

  function visitInstance(insert: DxfInsert, depth: number, stack: string[]): void {
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
      visitSource(nestedInsert, depth + 1, path, true);
    }
  }

  function visitSource(insert: DxfInsert, depth: number, stack: string[], nested: boolean): void {
    const instances = expandInsertInstances(insert);
    if (insert.type === "MINSERT") {
      summary.mInsertCount++;
      summary.expandedMInsertInstanceCount += instances.length;
    }
    for (const instance of instances) {
      if (nested) summary.nestedInsertCount++;
      visitInstance(instance.insert, depth, stack);
    }
  }

  for (const insert of parsedDxf.entities.inserts) {
    visitSource(insert, 1, [], false);
  }

  return summary;
}
