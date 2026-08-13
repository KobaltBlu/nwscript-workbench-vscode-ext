# Changelog

## 0.1.1

### NWScript editing

- Home now shows a workspace-wide language-definition resolution list for every discovered `nwscript.nss` in resolution order (workspace root first, then nested paths), including coverage regions, script counts, and active/shadowed/isolated/ambiguous states across multi-root folders
- Home resolution list auto-refreshes when `nwscript.nss` files are created, deleted, renamed, or when workspace folders change
- Fixed language-definition discovery so nested `nwscript.nss` files (for example `games/k1/nwscript.nss`) are found via filesystem walk when `findFiles` misses them in web/virtual workspaces
- Activity Bar sidebar icon for NWScript Workbench that opens Home and exposes Script/Language Definition browsers (monochrome SVG for reliable Activity Bar tinting)
- `nwscript.autoOpenHome` setting (default on) to opt out of opening Home automatically once a workspace is available after activation
- Compiler activity is logged to the **NWScript Compiler** Output channel, with **Show Compiler Log** and a **Show Log** action on compile toasts
- Fixed vscode.dev downloads of `nwscript.nss` (and scripts) that failed with "No file system handle registered (\)" when creating the workspace root directory
- Redesigned Workbench Home with a resolution-first dashboard, responsive navigation, streamlined settings, and an integrated project guide
- Home panel resolution preview for active, shadowed, and ambiguous `nwscript.nss` definitions, with conflict-removal actions
- Metadata-driven Language Definition Browser for previewing and downloading canonical game definitions
- Language definitions now resolve lazily from each script; manual and embedded target activation has been removed

## 0.1.0

Initial public release.

### NWScript editing

- On-demand Script Browser for searching, previewing, opening, and downloading source from the KOTOR Community Patches catalog
- VS Code-style Workbench Home layout with a dedicated Knowledge Base article rail
- Engine-aware IntelliSense from the active `nwscript.nss`
- Signature help and rich hover documentation
- Include-aware project symbol resolution
- Go to Definition, Find References, scope-aware Rename Symbol for functions, parameters, globals, and local variables, Outline, and workspace symbols
- NWScript and NCS assembly syntax highlighting

### Compilation

- WebAssembly NWScript compiler
- Project and custom language specifications
- Optional embedded game targets
- Recursive include resolution
- Compile-on-save
- O0-O3 optimization levels
- Optional NDB generation

### NCS

- Read-only NCS hex editor
- Automatic side-by-side disassembly preview
