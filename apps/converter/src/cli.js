const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const { StatsRecorder } = require('./stats');
const { convertStepToGlb } = require('./convertStepToGlb');
const { validateGlb } = require('./validateGlb');

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

class StageLogger {
  constructor(logFile) {
    this.logFile = logFile;
    this.logStream = fs.createWriteStream(logFile, { flags: 'w' });
    this.originalLog = console.log;
    this.originalWarn = console.warn;
    this.originalError = console.error;
    this.activeStages = new Map();
    this.cliStartTime = Date.now();
    this.currentStage = null;
    this.heartbeat = setInterval(() => this.printHeartbeat(), 10000);
    this.heartbeat.unref();

    console.log = (...args) => {
      this.writeLog('INFO', ...args);
      this.originalLog(...args);
    };
    console.warn = (...args) => {
      this.writeLog('WARN', ...args);
      this.originalWarn(...args);
    };
    console.error = (...args) => {
      this.writeLog('ERROR', ...args);
      this.originalError(...args);
    };
  }

  writeLog(prefix, ...args) {
    const msg = args.map((arg) => {
      if (arg instanceof Error) {
        return `${arg.stack || arg.message}`;
      }
      return typeof arg === 'string' ? arg : JSON.stringify(arg);
    }).join(' ');
    this.logStream.write(`[${new Date().toISOString()}] ${prefix} ${msg}\n`);
  }

  start(stage, detail) {
    this.currentStage = stage;
    this.activeStages.set(stage, Date.now());
    console.log(`[stage:start] ${stage}${detail ? ` - ${detail}` : ''}`);
  }

  end(stage, detail) {
    const startedAt = this.activeStages.get(stage);
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    this.activeStages.delete(stage);
    this.currentStage = this.activeStages.size > 0
      ? Array.from(this.activeStages.keys()).at(-1)
      : null;
    console.log(`[stage:end] ${stage} elapsed=${formatSeconds(elapsed)}${detail ? ` - ${detail}` : ''}`);
  }

  warn(message) {
    console.warn(message);
  }

  error(message, err) {
    if (err) {
      console.error(message, err);
    } else {
      console.error(message);
    }
  }

  printHeartbeat() {
    if (!this.currentStage) return;
    const startedAt = this.activeStages.get(this.currentStage);
    const elapsed = startedAt ? Date.now() - startedAt : Date.now() - this.cliStartTime;
    const usage = process.memoryUsage();
    console.log(
      `[heartbeat] still running stage="${this.currentStage}" elapsed=${formatSeconds(elapsed)} rssMb=${(usage.rss / 1024 / 1024).toFixed(1)} heapMb=${(usage.heapUsed / 1024 / 1024).toFixed(1)}`
    );
  }

  async close() {
    clearInterval(this.heartbeat);
    console.log(`[cli:end] totalElapsed=${formatSeconds(Date.now() - this.cliStartTime)}`);
    console.log = this.originalLog;
    console.warn = this.originalWarn;
    console.error = this.originalError;
    await new Promise((resolve) => this.logStream.end(resolve));
  }
}

async function main() {
  const program = new Command();

  program
    .name('converter')
    .description('CLI to convert STEP/STP files to GLB using OpenCascade')
    .option('-i, --input <path>', 'Input STEP/STP file path')
    .option('-o, --outdir <path>', 'Output directory for generated files', './output')
    .option('-q, --quality <preset>', 'Quality preset: fast | balanced | high', 'balanced')
    .action(runConvert);

  program
    .command('validate')
    .description('Validate a generated GLB by reading it back and counting meshes/triangles')
    .requiredOption('-g, --glb <path>', 'GLB file to validate')
    .action(runValidate);

  await program.parseAsync(process.argv);
}

async function runConvert(options) {
  const cliStartedAt = Date.now();

  if (!options.input) {
    console.error('[ERROR] Input file is required. Use --input <path>.');
    process.exit(1);
  }

  const inputPath = path.resolve(options.input);
  const outDir = path.resolve(options.outdir);
  const quality = options.quality;

  if (!fs.existsSync(inputPath)) {
    console.error(`[ERROR] Input file does not exist: ${inputPath}`);
    process.exit(1);
  }

  const inputStat = fs.statSync(inputPath);

  if (!['fast', 'balanced', 'high'].includes(quality)) {
    console.error(`[ERROR] Invalid quality preset: ${quality}. Use fast, balanced, or high.`);
    process.exit(1);
  }

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const logFile = path.join(outDir, 'conversion.log');
  const logger = new StageLogger(logFile);

  console.log(`[cli:start] converter CLI start at ${new Date(cliStartedAt).toISOString()}`);
  console.log(`[input] resolved path: ${inputPath}`);
  console.log(`[input] exists=true sizeBytes=${inputStat.size} sizeMb=${(inputStat.size / 1024 / 1024).toFixed(2)}`);
  console.log(`[output] directory ready: ${outDir}`);
  console.log('Starting conversion...');
  console.log(`Input: ${inputPath}`);
  console.log(`Output Directory: ${outDir}`);
  console.log(`Quality: ${quality}`);

  const outGlbPath = path.join(outDir, 'display.raw.glb');
  const statsPath = path.join(outDir, 'stats.json');

  const statsRecorder = new StatsRecorder();

  try {
    const success = await convertStepToGlb(inputPath, outGlbPath, quality, statsRecorder, logger);

    logger.start('stats writing', statsPath);
    await statsRecorder.save(statsPath);
    logger.end('stats writing', statsPath);

    if (success) {
      console.log('Conversion successful.');
    } else {
      console.error('Conversion failed.');
      process.exit(1);
    }
  } catch (err) {
    statsRecorder.error(`Unexpected error: ${err.message}`);
    logger.start('stats writing', statsPath);
    await statsRecorder.save(statsPath);
    logger.end('stats writing', statsPath);
    console.error('Conversion crashed:', err);
    process.exit(1);
  } finally {
    await logger.close();
  }
}

async function runValidate(options) {
  const glbPath = path.resolve(options.glb);
  const validation = await validateGlb(glbPath);
  console.log(JSON.stringify(validation, null, 2));

  if (!validation.success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});
