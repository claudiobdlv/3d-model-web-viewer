import fs from "node:fs";
import path from "node:path";
import type { WorkerConfig } from "./config.js";

export type WorkerJob = {
  id: number;
  modelSlug: string;
  sourceFilename: string;
  downloadUrl: string;
};

export class WorkerClient {
  constructor(private readonly config: WorkerConfig) {}

  async getNextJob(): Promise<WorkerJob | null> {
    const response = await this.request("/api/worker/jobs/next");
    const payload = (await response.json()) as { job: WorkerJob | null };
    return payload.job;
  }

  async startJob(jobId: number): Promise<void> {
    await this.request(`/api/worker/jobs/${jobId}/start`, { method: "POST" });
  }

  async downloadSource(job: WorkerJob, outputPath: string): Promise<void> {
    const response = await this.request(job.downloadUrl);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(outputPath, buffer);
  }

  async completeJob(jobId: number, output: {
    displayGlbPath: string;
    manifestPath: string;
    statsPath: string;
    materialDebugPath: string;
    conversionLogPath: string;
    xcafReportPath?: string;
  }): Promise<void> {
    const displayGlbBytes = (await fs.promises.stat(output.displayGlbPath)).size;
    if (displayGlbBytes > this.config.maxModelArtifactBytes) {
      throw new Error(
        `Converted GLB is ${displayGlbBytes} bytes, exceeding MAX_MODEL_ARTIFACT_BYTES=${this.config.maxModelArtifactBytes} bytes.`
      );
    }

    const form = new FormData();
    form.set("display.glb", await fileBlob(output.displayGlbPath), "display.glb");
    form.set("manifest.json", await fileBlob(output.manifestPath), "manifest.json");
    form.set("stats.json", await fileBlob(output.statsPath), "stats.json");
    form.set("material-debug.json", await fileBlob(output.materialDebugPath), "material-debug.json");
    form.set("conversion.log", await fileBlob(output.conversionLogPath), "conversion.log");
    if (output.xcafReportPath) {
      form.set("xcaf-report.json", await fileBlob(output.xcafReportPath), "xcaf-report.json");
    }

    await this.request(`/api/worker/jobs/${jobId}/complete`, {
      method: "POST",
      body: form
    });
  }

  async failJob(jobId: number, message: string, conversionLogPath?: string): Promise<void> {
    const form = new FormData();
    form.set("message", message);
    if (conversionLogPath && fs.existsSync(conversionLogPath)) {
      form.set("conversion.log", await fileBlob(conversionLogPath), "conversion.log");
    }

    await this.request(`/api/worker/jobs/${jobId}/fail`, {
      method: "POST",
      body: form
    });
  }

  private async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${this.config.serverUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.token}`);

    const response = await fetch(url, {
      ...init,
      headers
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${init.method || "GET"} ${url} failed: ${response.status} ${text}`);
    }

    return response;
  }
}

async function fileBlob(filePath: string): Promise<Blob> {
  const buffer = await fs.promises.readFile(filePath);
  return new Blob([buffer]);
}
