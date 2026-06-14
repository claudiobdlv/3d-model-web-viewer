# Converter

This app provides a local CLI to convert STEP/STP mechanical CAD files into GLB files. It is powered by `occt-import-js` (OpenCascade compiled to WebAssembly) and `@gltf-transform/core`. This toolchain avoids native C++ or FreeCAD dependencies, making it easy to run directly on Windows via Node.js.

## Installation

Run `npm install` inside the `apps/converter` folder.

```bash
cd apps/converter
npm install
```

## CLI Usage

You can run the converter using `npm run start` or running the script directly with `node src/cli.js`.

```bash
npm run start -- --input <path_to_step_file> [--outdir <output_directory>] [--quality <preset>]
```

Or using `node`:

```bash
node src/cli.js --input "C:\path\to\model.step" --outdir ".\output" --quality high
```

### Options

- `-i, --input <path>`: Required. Absolute or relative path to the source STEP/STP file.
- `-o, --outdir <path>`: Optional. Directory to write the output files. Defaults to `./output`.
- `-q, --quality <preset>`: Optional. Quality preset for the generated mesh. Can be `fast`, `balanced`, or `high`. Defaults to `balanced`.

### Outputs

The converter will produce three files in the output directory:

1. `display.raw.glb`: The generated 3D model.
2. `stats.json`: A JSON file containing metadata such as triangle count, processing time, and file sizes.
3. `conversion.log`: A log file with standard output and error output from the conversion process.

## Validation

Conversion is only marked successful after the generated GLB is read back with `@gltf-transform/core` and confirmed to contain:

- an existing, non-empty `display.raw.glb`
- at least one mesh
- at least one primitive
- at least one triangle

You can run readback validation on an existing GLB without converting a STEP file:

```bash
npm run validate -- --glb ".\output\display.raw.glb"
```

If import succeeds but the mesh hierarchy is empty, geometry arrays are malformed, indices are invalid, or GLB readback finds no usable triangles, the CLI exits non-zero and `stats.json` records `success: false`.

## Real model validation checklist

Use this checklist before claiming the converter works for real mechanical files:

1. Run the converter with a real local STEP/STP file:

   ```powershell
   cd "D:\Software Projects\3D Model Web Viewer\apps\converter"
   npm run start -- --input "D:\path\to\real-model.step" --outdir output\real-model --quality balanced
   ```

2. Inspect `output\real-model\stats.json` and confirm:
   - `success` is `true`
   - `sourceFileSizeBytes` is greater than `0`
   - `outputGlbSizeBytes` is greater than `0`
   - `processingSeconds` is recorded
   - `meshCount` is greater than `0`
   - `triangleCount` is greater than `0`
   - `errorMessages` is empty

3. Run standalone GLB readback validation:

   ```powershell
   npm run validate -- --glb output\real-model\display.raw.glb
   ```

4. Open `display.raw.glb` in the existing viewer path and check:
   - `<model-viewer>` displays the model
   - orientation and scale are plausible
   - colors/materials are present or the fallback material is acceptable
   - object names and hierarchy are present where the STEP import exposes them
   - model interaction remains responsive

5. Do not commit real STEP/STP/GLB files or generated converter outputs.

## Known current limitations

- **Colors and Materials**: `occt-import-js` extracts basic colors from some STEP files but may fall back to default materials if colors are missing or in complex hierarchy setups.
- **Normals**: Sometimes OpenCascade doesn't generate vertex normals correctly depending on the shape. If missing, the converter tries to calculate flat normals automatically.
- **Measurement and Metadata**: The converter extracts the base geometry tree but currently does not support topological measurement data or advanced attributes.
- **Orientation and Scale**: The model is exported in the orientation and scale native to the imported data. In a web viewer context, you may need to apply standard camera scaling or rely on `<model-viewer>`'s auto-scale features.
- **Assembly Fidelity**: This proof-of-concept preserves the hierarchy and names exposed by `occt-import-js`, but it does not yet prove full CAD assembly semantics, constraints, product metadata, or per-face material fidelity.
- **Large Models**: Memory use and processing time have not yet been characterized on large real-world models.

## What this converter proves / does not prove yet

Currently proven:

- The CLI can call `occt-import-js` locally from Node.js.
- The converter can transform imported triangle geometry into a GLB.
- The output GLB is read back and checked for non-empty meshes and triangles before reporting success.
- Failures such as empty import results, malformed geometry arrays, invalid indices, empty output files, and unreadable GLBs are reported as failures.

Not proven yet:

- Reliable conversion of arbitrary real mechanical STEP files.
- Preservation of all colors, hierarchy, names, metadata, units, and assembly intent across CAD systems.
- Acceptable performance on large or complex manufacturing models.
- End-to-end worker integration. The converter is intentionally not wired into the worker yet.

## Testing Output

To test the generated output in the existing Pi server viewer:
1. Copy the generated `display.raw.glb`, `stats.json`, and an empty `manifest.json` into a folder structure that mimics a completed worker job.
2. The easiest way is to use the existing web viewer upload page if the server supports direct GLB uploads or using a local static file server to serve the GLB into `<model-viewer>`.
