const fs = require('fs');
const path = require('path');

class StatsRecorder {
  constructor() {
    this.stats = {
      sourceFileName: null,
      sourceFileSizeBytes: 0,
      outputGlbSizeBytes: 0,
      processingSeconds: 0,
      converterName: 'occt-import-js + gltf-transform',
      converterVersion: '1.0.0', // Fixed version for POC
      qualityPreset: 'balanced',
      success: false,
      warningMessages: [],
      errorMessages: [],
      triangleCount: 0,
      nodeCount: 0,
      meshCount: 0,
      objectCount: 0,
      validation: null,
      importOptionsUsed: null
    };
    this.startTime = null;
  }

  start() {
    this.startTime = process.hrtime();
  }

  stop() {
    if (this.startTime) {
      const diff = process.hrtime(this.startTime);
      this.stats.processingSeconds = diff[0] + diff[1] / 1e9;
    }
  }

  setSourceFile(filePath) {
    this.stats.sourceFileName = path.basename(filePath);
    try {
      const stat = fs.statSync(filePath);
      this.stats.sourceFileSizeBytes = stat.size;
    } catch (e) {
      this.warn(`Could not read source file size: ${e.message}`);
    }
  }

  setOutputSize(sizeBytes) {
    this.stats.outputGlbSizeBytes = sizeBytes;
  }

  setQuality(preset, importOptions) {
    this.stats.qualityPreset = preset;
    this.stats.importOptionsUsed = importOptions;
  }

  recordCounts(triangles, nodes, meshes, objects) {
    this.stats.triangleCount = triangles;
    this.stats.nodeCount = nodes;
    this.stats.meshCount = meshes;
    this.stats.objectCount = objects;
  }

  recordValidation(validation) {
    this.stats.validation = validation;
    if (validation) {
      this.stats.outputGlbSizeBytes = validation.fileSizeBytes || 0;
      this.stats.meshCount = validation.meshCount || 0;
      this.stats.triangleCount = validation.triangleCount || 0;
      this.stats.nodeCount = validation.nodeCount || 0;
      this.stats.objectCount = validation.nodeCount || 0;
    }
  }

  setSuccess(isSuccess) {
    this.stats.success = isSuccess;
  }

  warn(message) {
    this.stats.warningMessages.push(message);
    console.warn(`[WARN] ${message}`);
  }

  error(message) {
    this.stats.errorMessages.push(message);
    console.error(`[ERROR] ${message}`);
  }

  async save(outputPath) {
    try {
      fs.writeFileSync(outputPath, JSON.stringify(this.stats, null, 2));
    } catch (e) {
      console.error(`[ERROR] Failed to write stats file: ${e.message}`);
    }
  }

  get log() {
    return this.stats;
  }
}

module.exports = { StatsRecorder };
