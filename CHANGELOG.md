# Changelog

## 0.1.1

### NWScript editing

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
