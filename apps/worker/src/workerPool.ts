export async function fillAvailableWorkerSlots<T>(input: {
  maxConcurrentJobs: number;
  activeCount: () => number;
  claimNext: () => Promise<T | null>;
  start: (job: T) => void;
}): Promise<{ queueEmpty: boolean }> {
  while (input.activeCount() < input.maxConcurrentJobs) {
    const job = await input.claimNext();
    if (!job) return { queueEmpty: true };
    input.start(job);
  }
  return { queueEmpty: false };
}
