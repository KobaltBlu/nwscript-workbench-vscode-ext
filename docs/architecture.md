# Architecture

```text
VS Code / vscode.dev
        │
        ▼
Web Extension Host
        │
        ├── VS Code workspace.fs
        │      ├── NSS source
        │      ├── includes
        │      └── NCS/NDB output
        │
        ▼
CompilerService
        │
        ├── ResourceResolver
        ├── Diagnostics
        ├── CompilerLog (Output → NWScript Compiler)
        └── @neverwinter/nwscript-wasm
                    │
                    ▼
              WebAssembly
                    │
                    ▼
              NCS / NDB
```

## WASM packaging

During the extension build, `@neverwinter/nwscript-wasm` is pulled from:

```text
https://github.com/KobaltBlu/nwscript-wasm/tree/master
```

Its JavaScript wrapper is bundled into `dist/web/extension.js` and its compiled WASM is copied to:

```text
dist/web/nwscript-compiler.wasm
```

At runtime the extension reads the WASM bytes from its own installation and passes them directly to Emscripten. A user installing the VSIX does not need access to GitHub or npm afterward.

See [Development](development.md) for build steps and [Web and virtual workspaces](web-and-virtual-workspaces.md) for host compatibility.
