import assert from "node:assert/strict";
import test from "node:test";
import { fillAvailableWorkerSlots } from "./workerPool.js";

test("worker pool starts up to three jobs while leaving the fourth queued", async () => {
  const queued = [1, 2, 3, 4];
  const active = new Set<number>();
  const result = await fillAvailableWorkerSlots({
    maxConcurrentJobs: 3,
    activeCount: () => active.size,
    claimNext: async () => queued.shift() ?? null,
    start: (job) => active.add(job)
  });
  assert.deepEqual([...active], [1, 2, 3]);
  assert.deepEqual(queued, [4]);
  assert.equal(result.queueEmpty, false);
});
