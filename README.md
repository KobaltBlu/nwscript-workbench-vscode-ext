# NWScript Workbench

Complete NWScript development tools for **VS Code Desktop** and **VS Code for the Web** (`vscode.dev`, `github.dev`, Codespaces web editor).

The extension uses [`KobaltBlu/nwscript-wasm`](https://github.com/KobaltBlu/nwscript-wasm/tree/master), which packages the native NWScript compiler as WebAssembly. The compiler JavaScript is bundled into the extension and the `.wasm` binary is shipped inside the VSIX, so **no native compiler, Nim, Python, Emscripten, or network access is required at runtime**.

## NWScript Workbench Home

Run **NWScript Workbench: Open Home** to open the extension control center in an editor tab.

NWScript Workbench Home provides:

- current workspace and active language-specification status
- language-specification selection and project auto-detection controls
- inline controls for compile-on-save, optimization, and NDB output
- summaries of include/output configuration
- a clear explanation of how `nwscript.nss` is resolved for each script
- recommended workspace layouts for K1, K2, and custom game targets
- offline help for project language specifications, includes, configuration, and troubleshooting
- links to the extension and compiler repositories

The Home tab opens automatically once on first run and remains available from the Command Palette afterward.

### Language specification resolution

The extension resolves the `nwscript.nss` used by a script in this order:

1. **Custom Language Specification** — an `nwscript.nss` explicitly selected in extension configuration.
2. **Embedded Game Target** — a language specification bundled into the installed `nwscript-wasm` build.
3. **Workspace-root specification** — `nwscript.nss` at the root of the active workspace folder.
4. **Nearest ancestor specification** — the closest `nwscript.nss` above the script being edited or compiled.
5. **Single discovered project specification** — if exactly one `nwscript.nss` exists in the workspace, it is used automatically.
6. **Ambiguous** — if multiple specifications remain possible, the extension does not guess and asks the user to choose one.

A workspace-root `nwscript.nss` is authoritative for that workspace folder. For projects that contain scripts for multiple games, we recommend placing each game in its own subfolder with its own `nwscript.nss` rather than putting a shared specification at the workspace root.

Recommended layout:

```text
My NWScript Workspace/
├─ kotor1/
│  ├─ nwscript.nss
│  ├─ includes/
│  └─ scripts/
│     └─ k1_script.nss
│
├─ kotor2/
│  ├─ nwscript.nss
│  ├─ includes/
│  └─ scripts/
│     └─ k2_script.nss
│
└─ custom-game/
   ├─ nwscript.nss
   └─ scripts/
      └─ custom_script.nss
```

With this layout, scripts under `kotor1/` resolve against `kotor1/nwscript.nss`, scripts under `kotor2/` resolve against `kotor2/nwscript.nss`, and custom projects can provide their own language specification independently.


## Features

- Compile `.nss` files to `.ncs` entirely through WebAssembly.
- Runs in the browser extension host and the desktop extension host.
- Uses only VS Code URI / `workspace.fs` APIs at runtime, including virtual workspaces.
- **Custom Language Specification**: explicitly select an `nwscript.nss` from the workspace or any URI exposed by VS Code.
- **Project auto-detection**: when no explicit language spec or embedded target is selected, the extension automatically discovers `nwscript.nss` in the active workspace folder.
- Optional embedded game targets supplied by `nwscript-wasm` when present.
- Recursive `#include` discovery and loading.
- Configurable include search paths.
- Compiler errors surfaced as VS Code diagnostics.
- Optional compile-on-save.
- Optional NDB generation.
- Configurable O0/O1/O2/O3 optimization level.
- Read-only NCS hex editor with automatic side-by-side disassembly preview.
- NCS disassembly when the installed `nwscript-wasm` build exposes it.
- Basic NWScript and NCS assembly syntax highlighting.

## Why this works online and offline

The extension has only a `browser` entry point. VS Code therefore runs the same web-extension bundle in:

- VS Code Desktop
- `vscode.dev`
- `github.dev`
- browser-based Codespaces
- other VS Code-compatible web extension hosts

The runtime does not import Node's `fs`, `path`, or child-process APIs. Workspace and extension resources are read and written through `vscode.workspace.fs`.

During the extension build, `@neverwinter/nwscript-wasm` is pulled from:

```text
https://github.com/KobaltBlu/nwscript-wasm/tree/master
```

Its JavaScript wrapper is bundled into `dist/web/extension.js` and its compiled WASM is copied to:

```text
dist/web/nwscript-compiler.wasm
```

At runtime the extension reads the WASM bytes from its own installation and passes them directly to Emscripten.

## Development

Requirements for building the extension itself:

- Node.js 22+
- npm
- Git

You **do not** need Emscripten locally unless you are rebuilding `nwscript-wasm` itself.

Install dependencies:

```bash
npm install
```

Build:

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

The generated VSIX contains the bundled extension JavaScript and compiler WASM. A user installing that VSIX on desktop does not need access to GitHub or npm afterward.

## Commands

### NWScript Workbench: Compile Current File

Compile the active or Explorer-selected `.nss` file.

The default output location is beside the source file:

```text
script.nss
script.ncs
```

If NDB generation is enabled:

```text
script.nss
script.ncs
script.ndb
```

### NWScript Workbench: Select Compiler Target

Choose either:

- **Custom Language Specification: Choose nwscript.nss...**
- any game target embedded in the bundled `nwscript-wasm`

Embedded targets are optional. A WASM build containing no embedded language specifications is fully supported.

### NWScript Workbench: Select Custom Language Specification

Opens VS Code's URI-aware file picker and stores the selected language specification in the current workspace/workspace-folder configuration. This works with desktop files, `vscode.dev`, `github.dev`, and virtual workspace file-system providers.

### NWScript Workbench: Show Embedded Game Targets

Displays the target names compiled into the WASM package.

### Opening NCS files

Opening an `.ncs` file uses the extension's readonly **NWScript NCS Hex** custom editor by default. The primary editor shows the binary as a conventional 16-byte-per-row hex dump with offsets and an ASCII column.

At the same time, the extension disassembles the NCS with the active custom, project-detected, or embedded language specification and opens `<name>.ncsasm` beside the hex view as a **preview tab** without stealing focus.

If the language specification cannot be resolved, the hex view still opens normally and the assembly preview displays the disassembly error.

### NWScript Workbench: Disassemble NCS

Reads an `.ncs` file, calls the WASM disassembler, and opens the same named `<name>.ncsasm` preview used by the automatic NCS viewer.

## Custom Language Specifications

The extension does not require the WASM package to contain game-specific `nwscript.nss` files. Users can explicitly select a custom language specification at runtime.

Use **NWScript Workbench: Select Compiler Target** and choose **Custom Language Specification: Choose nwscript.nss...**, or run **NWScript Workbench: Select Custom Language Specification** directly.

The selected resource is read through `vscode.workspace.fs`, not Node filesystem APIs. That means the language spec can come from a normal desktop workspace or from a virtual/browser workspace provider.

A workspace-relative selection is persisted as `${workspaceFolder}/...`; resources outside the workspace are stored as explicit VS Code URIs.

Example workspace configuration:

```json
{
  "nwscript.languageSpec": "${workspaceFolder}/game/k1/nwscript.nss"
}
```

No game assets need to be included in the extension or the `nwscript-wasm` distribution.

## Configuration

### `nwscript.gameTarget`

Default:

```json
""
```

Optional embedded game target used to supply `nwscript.nss`. Embedded targets are a convenience only; leave this empty when using a custom or project language specification.

### `nwscript.autoDetectLanguageSpec`

```json
{
  "nwscript.autoDetectLanguageSpec": true
}
```

When enabled, the extension automatically searches the active workspace folder for `nwscript.nss` whenever neither `nwscript.languageSpec` nor `nwscript.gameTarget` is configured.

Detection prefers a workspace-root `nwscript.nss`, then the nearest `nwscript.nss` in an ancestor directory of the script being compiled or edited. If no ancestor applies and exactly one specification exists in the workspace, that file is used automatically. Multiple unrelated specifications are treated as ambiguous so the extension does not guess between game targets.

For multi-game workspaces, place each game's scripts below its own game folder and keep that folder's `nwscript.nss` alongside them. Avoid a workspace-root `nwscript.nss` when the workspace contains multiple independent game environments, because the root specification is authoritative for the workspace folder.

### `nwscript.languageSpec`

Default:

```json
""
```

**Custom Language Specification** workspace-relative path or explicit URI to an `nwscript.nss`.

When set, it overrides `nwscript.gameTarget`. This is the baseline configuration when the WASM package contains no embedded targets.

Example:

```json
{
  "nwscript.languageSpec": "scripts/nwscript.nss"
}
```

Using a workspace-relative path is recommended because it also works in `vscode.dev` and virtual workspaces.

### `nwscript.includePaths`

Example:

```json
{
  "nwscript.includePaths": [
    "scripts",
    "scripts/includes",
    "shared"
  ]
}
```

Include resolution checks, in order:

1. The directory containing the including NSS file.
2. `nwscript.includePaths`.
3. A lazily generated workspace-wide `.nss` resource index.

The extension recursively scans discovered includes and preloads them into the in-memory compiler resource manager.

### `nwscript.outputDirectory`

Default:

```json
""
```

Empty writes generated files beside the source NSS.

A workspace-relative output directory can be configured:

```json
{
  "nwscript.outputDirectory": "compiled"
}
```

### `nwscript.compileOnSave`

```json
{
  "nwscript.compileOnSave": true
}
```

Compiles an NSS document after it is saved.

### `nwscript.optimizationLevel`

Supported values:

```text
O0
O1
O2
O3
```

Default: `O1`.

### `nwscript.generateDebug`

Generate `.ndb` output when supported by the compiler:

```json
{
  "nwscript.generateDebug": true
}
```

### `nwscript.maxIncludeDepth`

Maximum native compiler include depth. Default: `32`.

### `nwscript.maxResolveAttempts`

Maximum number of include resources recursively loaded before a compilation. Default: `64`.

## Diagnostics

Compiler errors such as:

```text
k_test.nss(12): ERROR: DECLARATION DOES NOT MATCH PARAMETERS
```

are converted into VS Code diagnostics and attached to the corresponding NSS file and line.

The extension also pre-resolves `#include` resources before invoking the compiler. This makes the extension usable even with older `nwscript-wasm` builds whose native `FILE NOT FOUND` diagnostic does not identify the missing resref.

## Browser / virtual workspace considerations

VS Code Web does not expose arbitrary host filesystem paths. For maximum compatibility:

- keep NSS source and includes inside the opened workspace;
- configure include paths relative to the workspace;
- configure a custom `nwscript.nss` with a workspace-relative path;
- allow the virtual workspace provider to handle generated NCS/NDB writes.

A provider may expose a read-only virtual workspace. In that case compilation still works in memory, but writing the generated NCS/NDB to that provider will fail until the workspace is writable.

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

## Architecture

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
        └── @neverwinter/nwscript-wasm
                    │
                    ▼
              WebAssembly
                    │
                    ▼
              NCS / NDB
```

## Licensing

The extension source is distributed under GPL-3.0-only because the packaged extension includes the linked NWScript compiler WebAssembly artifact, which is subject to the upstream compiler's GPL-3.0 licensing.

See `THIRD_PARTY_NOTICES.md` for the upstream compiler dependency.

## Engine-aware editor intelligence

The extension builds IntelliSense directly from the active `nwscript.nss` language specification. Custom and auto-detected project specifications are parsed into a cached engine API model, so changing the active spec changes the editor API without rebuilding the extension.

The NWScript editor provides:

- engine function completions with parameter and return-type metadata
- engine constants and global symbols from the active language specification
- snippet-style function insertion with parameter placeholders
- signature help on `(` and `,`, including defaults and active-argument highlighting
- multiple signatures when the active specification declares the same function name more than once
- rich hover cards with the declaration, return type, parameter documentation, engine ACTION ID, active-spec availability, and curated NWScript notes for selected APIs

ACTION IDs are derived from function declaration order in the active `nwscript.nss`, matching the engine command table represented by the language specification.

The current `nwscript-wasm` public API exposes the names of embedded targets but does not expose the decompressed source text of an embedded `nwscript.nss`. Compilation can still use an embedded target, but editor intelligence requires an accessible custom or project `nwscript.nss` until the WASM package exposes that source text to consumers.

## Native VS Code navigation

NWScript symbols participate in VS Code's normal language-navigation workflow. The extension resolves symbols using the same translation-unit model as IntelliSense: declarations in the current script take precedence over recursively included NSS files, which take precedence over the active `nwscript.nss` engine API.

Supported editor features include:

- Go to Definition and Peek Definition for script, include, and engine symbols
- Go to Declaration using the same NWScript symbol resolution
- Find All References across NSS files that actually see the same declaration through their include/spec scope
- Rename Symbol for user script/include symbols; engine API symbols are intentionally read-only
- Document Highlights for the active symbol
- Outline / Go to Symbol in Editor for top-level functions, constants, and globals
- Go to Symbol in Workspace across NSS files
- clickable `#include` resource links and Go to Definition on include resrefs

Reference and rename searches ignore comments and string literals and validate each candidate NSS file against its resolved translation-unit symbol model instead of performing a blind workspace text replacement.
