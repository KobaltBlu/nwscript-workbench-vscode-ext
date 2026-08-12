# NWScript Workbench

Complete NWScript development tools for **VS Code Desktop** and **VS Code for the Web** (`vscode.dev`, `github.dev`, Codespaces web editor).

The extension uses [`KobaltBlu/nwscript-wasm`](https://github.com/KobaltBlu/nwscript-wasm/tree/master), which packages the native NWScript compiler as WebAssembly. The compiler JavaScript is bundled into the extension and the `.wasm` binary is shipped inside the VSIX, so **no native compiler, Nim, Python, Emscripten, or network access is required at runtime**.

![NWScript Workbench](https://raw.githubusercontent.com/KobaltBlu/nwscript-workbench-vscode-ext/master/assets/logo.png)

## NWScript Workbench Home

Run **NWScript Workbench: Open Home** to open the extension control center in an editor tab.

NWScript Workbench Home provides:

- current workspace and active language-specification status
- a workspace-wide language-definition resolution list showing every discovered `nwscript.nss` in resolution order, with coverage regions, active/shadowed/isolated states, and conflicting layouts, plus confirmed removal actions for offending files
- automatic, script-scoped language-specification resolution and conflict controls
- inline controls for compile-on-save, optimization, and NDB output
- summaries of include/output configuration
- a clear explanation of how `nwscript.nss` is resolved for each script
- recommended workspace layouts for K1, K2, and custom game targets
- offline help for project language specifications, includes, configuration, and troubleshooting
- links to the extension and compiler repositories

The Home tab opens automatically once on first run and remains available from the Command Palette afterward.

## Script Browser

Run **NWScript Workbench: Browse Scripts** to search the decompiled KOTOR and TSL source catalog maintained by [KOTOR Community Patches](https://github.com/KOTORCommunityPatches/Vanilla_KOTOR_Script_Source).

The browser fetches the repository catalog from GitHub. Search operates locally over script names and repository paths; selecting a result fetches only that script for preview. You can open a source copy in an untitled NWScript editor or download it through VS Code's URI-aware save dialog into a desktop, browser, or virtual workspace.

![NWScript Workbench Script Browser showing searchable KOTOR and TSL source with an inline preview](https://raw.githubusercontent.com/KobaltBlu/nwscript-workbench-vscode-ext/master/assets/ss-script-browser.png)

No upstream script source is packaged with NWScript Workbench. An internet connection is required, and downloaded sources remain subject to the upstream repository and game-content terms.

## Language Definition Browser

Run **NWScript Workbench: Browse Language Definitions** to browse the canonical `nwscript.nss` catalog from [KobaltBlu/nwscript-language-definitions](https://github.com/KobaltBlu/nwscript-language-definitions).

The browser discovers games and releases from the repository metadata, supports local search, and shows each definition's engine, aliases, version, provenance, size, checksum, and source. A definition can be opened in an untitled editor or downloaded into the workspace. Missing download directories are created automatically.

The catalog and selected source are fetched on demand, so an internet connection is required. Saved definitions remain available in the workspace afterward.

### Language specification resolution

The extension resolves the `nwscript.nss` used by a script in this order:

1. **Workspace-root specification** — `nwscript.nss` at the root of the active workspace folder.
2. **Nearest ancestor specification** — the closest `nwscript.nss` above the script being edited or compiled.
3. **Single discovered project specification** — if exactly one `nwscript.nss` exists in the workspace, it is used automatically.
4. **Ambiguous** — if multiple specifications remain possible, the extension does not guess; use the Home resolution list to identify coverage and remove conflicts.

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
- **Script-scoped language specifications**: the extension automatically discovers the applicable `nwscript.nss` from each script's workspace and ancestor folders.
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

### Opening NCS files

Opening an `.ncs` file uses the extension's readonly **NWScript NCS Hex** custom editor by default. The primary editor shows the binary as a conventional 16-byte-per-row hex dump with offsets and an ASCII column.

At the same time, the extension resolves the project language specification and opens `<name>.ncsasm` beside the hex view as a **preview tab** without stealing focus.

![NWScript Workbench NCS hex editor and side-by-side assembly disassembly view](https://raw.githubusercontent.com/KobaltBlu/nwscript-workbench-vscode-ext/master/assets/ss-script-dissasembler-with-hex-and-asm-views.png)

If the language specification cannot be resolved, the hex view still opens normally and the assembly preview displays the disassembly error.

### NWScript Workbench: Disassemble NCS

Reads an `.ncs` file, calls the WASM disassembler, and opens the same named `<name>.ncsasm` preview used by the automatic NCS viewer.

## Configuration

The extension automatically searches the active script's workspace folder for `nwscript.nss`.

Detection prefers a workspace-root `nwscript.nss`, then the nearest `nwscript.nss` in an ancestor directory of the script being compiled or edited. If no ancestor applies and exactly one specification exists in the workspace, that file is used automatically. Multiple unrelated specifications are treated as ambiguous so the extension does not guess between game targets.

For multi-game workspaces, place each game's scripts below its own game folder and keep that folder's `nwscript.nss` alongside them. Avoid a workspace-root `nwscript.nss` when the workspace contains multiple independent game environments, because the root specification is authoritative for the workspace folder.

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

The extension builds IntelliSense directly from the automatically resolved `nwscript.nss` language specification. Project specifications are parsed into a cached engine API model, so moving between game trees changes the editor API without rebuilding the extension.

![NWScript editor showing engine-aware IntelliSense and API documentation](https://raw.githubusercontent.com/KobaltBlu/nwscript-workbench-vscode-ext/master/assets/ss-script-editor-with-intellisense.png)

The NWScript editor provides:

- engine function completions with parameter and return-type metadata
- engine constants and global symbols from the active language specification
- snippet-style function insertion with parameter placeholders
- signature help on `(` and `,`, including defaults and active-argument highlighting
- multiple signatures when the active specification declares the same function name more than once
- rich hover cards with the declaration, return type, parameter documentation, engine ACTION ID, active-spec availability, and curated NWScript notes for selected APIs

ACTION IDs are derived from function declaration order in the active `nwscript.nss`, matching the engine command table represented by the language specification.

Language specifications must be accessible in the workspace so compilation and editor intelligence resolve the same API for each script.

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
