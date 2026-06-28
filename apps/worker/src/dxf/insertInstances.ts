import type { DxfInsert, DxfInsertInstance } from "./types.js";
import { ocsToWcs } from "./ocs.js";

// AutoCAD stores MINSERT columns along the local X axis and rows along the
// local Y axis. Spacing is rotated with the INSERT, while block scale applies
// to the shared block geometry rather than the array spacing.
export function expandInsertInstances(insert: DxfInsert): DxfInsertInstance[] {
  const rowCount = Math.max(1, Math.trunc(insert.rowCount));
  const columnCount = Math.max(1, Math.trunc(insert.columnCount));
  const radians = (insert.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const instances: DxfInsertInstance[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const localX = columnIndex * insert.columnSpacing;
      const localY = rowIndex * insert.rowSpacing;
      const rotatedOffset: [number, number, number] = [
        localX * cos - localY * sin,
        localX * sin + localY * cos,
        0,
      ];
      const offset = insert.ocsApplied ? ocsToWcs(rotatedOffset, insert.extrusion) : rotatedOffset;
      instances.push({
        insert,
        position: [
          insert.position[0] + offset[0],
          insert.position[1] + offset[1],
          insert.position[2] + offset[2],
        ],
        rowIndex,
        columnIndex,
      });
    }
  }

  return instances;
}
