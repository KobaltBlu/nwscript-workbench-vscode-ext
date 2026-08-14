# Development

Requirements for building the extension itself:

- Node.js 22+
- npm
- Git

You **do not** need Emscripten locally unless you are rebuilding `nwscript-wasm` itself.

## Install and build

```bash
npm install
```

```bash
npm run build
```

The output is:

```text
dist/web/extension.js
dist/web/extension.js.map
dist/web/nwscript-compiler.wasm
```

## Run in VS Code Desktop as a web extension

Open this project in VS Code and run the **Run Web Extension** launch configuration.

It launches an Extension Development Host with:

```text
--extensionDevelopmentKind=web
```

so the exact browser-hosted extension code is tested even on desktop.

## Run in a browser

The project includes `@vscode/test-web`:

```bash
npm run test-web
```

This builds the extension and launches a local VS Code for the Web instance.

## Package a VSIX

```bash
npm run package
```

The generated VSIX contains the bundled extension JavaScript and compiler WASM. For Marketplace and Open VSX publishing steps, see [PUBLISHING.md](../PUBLISHING.md).

## Updating the compiler dependency

The dependency intentionally points at the `master` branch of `KobaltBlu/nwscript-wasm`:

```json
{
  "dependencies": {
    "@neverwinter/nwscript-wasm": "github:KobaltBlu/nwscript-wasm#master"
  }
}
```

To refresh a local checkout to the latest compiler commit:

```bash
npm install
```

If a lockfile is already pinning an older Git commit, update the dependency explicitly or regenerate the lockfile before producing a release.

See [Architecture](architecture.md) for how the WASM artifact is packaged into the extension.
