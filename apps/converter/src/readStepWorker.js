const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

function post(message) {
  parentPort.postMessage(message);
}

function start(stage, detail) {
  post({ type: 'stage:start', stage, detail });
}

function end(stage, detail) {
  post({ type: 'stage:end', stage, detail });
}

async function main() {
  const { inputPath, options } = workerData;

  start('occt-import-js initialization', 'loading wasm module');
  const occt = await require('occt-import-js')();
  end('occt-import-js initialization', 'module ready');

  start('STEP file read', inputPath);
  const fileContent = new Uint8Array(fs.readFileSync(inputPath));
  end('STEP file read', `bytes=${fileContent.byteLength}`);

  start('OCCT ReadStepFile', `bytes=${fileContent.byteLength}`);
  const result = occt.ReadStepFile(fileContent, options);
  end('OCCT ReadStepFile', `success=${Boolean(result && result.success)} meshes=${result && result.meshes ? result.meshes.length : 0}`);

  post({ type: 'result', result });
}

main().catch((err) => {
  post({ type: 'error', message: err.message, stack: err.stack });
  process.exitCode = 1;
});
