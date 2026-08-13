# Changelog

## 0.1.6

### NSS editor

- Live diagnostics compile the active NSS buffer while typing (no NCS write); toggle with `nwscript.liveDiagnostics`
- Code actions: add `#include` for workspace symbols, create a missing include, download a language definition, and fix `StartingConditional`
- Parameter inlay hints on ACTION and script function calls
- Conservative formatter, brace/`#include` folding, and semantic token overlay for engine vs script symbols
- Snippets for DelayCommand, AssignCommand, conversation scripts, effects, item properties, and GetScriptParameter

### Project compile

- **Compile All Scripts** and **Compile Folder…** build entry scripts (`main` / `StartingConditional`) with merged diagnostics
- Compile-on-save of an include recompiles dependents that include it
- Home shows the active script’s include graph (includes and included-by)
- **Open Compiled NCS** uses `nwscript.outputDirectory` when set (same path as NDB peek)

### Settings

- New 0.1.5 / 0.1.6 features are toggles under `nwscript.*` (defaults match previous always-on behavior): live editor extras, include graph, ACTION compatibility, and NCS reload / signatures / NDB overlay
- compile dependents now defaults to off

## 0.1.5

### NCS Inspector

- Click `off_*` / `fn_*` address operands or the details Target to jump to that instruction
- Toolbar search (Ctrl/Cmd+F) for hex offsets, mnemonics, ACTION names, and byte sequences
- Inspector reloads when the open `.ncs` (or sibling `.ndb`) changes on disk without wiping layout
- ACTION details and hover show Engine API signatures when `nwscript.nss` is resolved
- Keyboard navigation (Up/Down, Enter to jump, `/` to search, Ctrl+C to copy the selected instruction)
- **Save NCS Disassembly…** writes the textual disassembly to a real file
- Truncated or unknown opcodes keep decoded instructions and show a partial-decode error
- Functions sidebar lists `fn_*` targets and NDB subroutine names
- **Compare NCS Files…** diffs instructions from two `.ncs` files and opens the inspector on click
- Sibling `.ndb` overlay maps the selected instruction to NSS file/line; **Open Source at Instruction** and **Open NCS at Source** use that mapping
- Home and the Language Definition Browser warn when ACTION signatures differ across language specs

## 0.1.4

### NCS

- Opening an `.ncs` file now uses a unified NCS Inspector with synchronized assembly and bytecode panes, semantic operand highlighting, a details panel, and split/assembly/bytecode layouts
- Textual disassembly remains available through **Open NCS Disassembly as Text** instead of opening automatically beside every NCS file

## 0.1.3

### NWScript editing

- Compile no longer fails with "Invalid source registration" for empty scripts, empty includes, or an empty `nwscript.nss`
- Empty (0-byte) `nwscript.nss` files are ignored for language-spec resolution so they cannot shadow nested real definitions
- Home resolution list always offers Remove for discovered `nwscript.nss` files, including when only one definition is present

## 0.1.2

### NWScript editing

- Home auto-open now waits until a workspace folder is available after the extension activates
- Fixed vscode.dev downloads of `nwscript.nss` (and scripts) that failed with "No file system handle registered (\)" when creating the workspace root directory

## 0.1.1

### NWScript editing

- Home now shows a workspace-wide language-definition resolution list for every discovered `nwscript.nss` in resolution order (workspace root first, then nested paths), including coverage regions, script counts, and active/shadowed/isolated/ambiguous states across multi-root folders
- Home resolution list auto-refreshes when `nwscript.nss` files are created, deleted, renamed, or when workspace folders change
- Fixed language-definition discovery so nested `nwscript.nss` files (for example `games/k1/nwscript.nss`) are found via filesystem walk when `findFiles` misses them in web/virtual workspaces
- Activity Bar sidebar icon for NWScript Workbench that opens Home and exposes Script/Language Definition browsers (monochrome SVG for reliable Activity Bar tinting)
- `nwscript.autoOpenHome` setting (default on) to opt out of opening Home automatically on first run
- Compiler activity is logged to the **NWScript Compiler** Output channel, with **Show Compiler Log** and a **Show Log** action on compile toasts
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
