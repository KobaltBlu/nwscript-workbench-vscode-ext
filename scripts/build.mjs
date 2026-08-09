import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist", "web");
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production") || !watch;

const compilerWasm = resolve(
  root,
  "node_modules",
  "@neverwinter",
  "nwscript-wasm",
  "dist",
  "nwscript-compiler.wasm",
);

if (!existsSync(compilerWasm)) {
  throw new Error(
    "nwscript-compiler.wasm was not found. Run npm install so the KobaltBlu/nwscript-wasm dependency is available.",
  );
}

await mkdir(outDir, { recursive: true });
await cp(compilerWasm, resolve(outDir, "nwscript-compiler.wasm"));

const options = {
  entryPoints: [resolve(root, "src", "extension.ts")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  outfile: resolve(outDir, "extension.js"),
  external: [
    "vscode",
    "node:module",
    "node:fs",
    "node:path",
    "node:url",
    "node:crypto",
  ],
  sourcemap: production ? "external" : "inline",
  minify: production,
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("[watch] NWScript Workbench extension build active");
} else {
  await esbuild.build(options);
}
