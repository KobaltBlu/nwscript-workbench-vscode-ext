# Language specifications

The extension builds compilation and editor intelligence from the automatically resolved `nwscript.nss` for each script. Moving between game trees changes the active engine API without rebuilding the extension.

## Resolution order

The extension resolves the `nwscript.nss` used by a script in this order:

1. **Workspace-root specification** — `nwscript.nss` at the root of the active workspace folder.
2. **Nearest ancestor specification** — the closest `nwscript.nss` above the script being edited or compiled.
3. **Single discovered project specification** — if exactly one `nwscript.nss` exists in the workspace, it is used automatically.
4. **Ambiguous** — if multiple specifications remain possible, the extension does not guess; use the Home resolution list to identify coverage and remove conflicts.

A workspace-root `nwscript.nss` is authoritative for that workspace folder. For multi-game workspaces, place each game in its own subfolder with its own `nwscript.nss` rather than putting a shared specification at the workspace root. See the recommended layout in [Getting started](getting-started.md).

Optional embedded game targets supplied by `nwscript-wasm` may also be available when present in the compiler package.

## Language Definition Browser

Run **NWScript Workbench: Browse Language Definitions** to browse the canonical `nwscript.nss` catalog from [KobaltBlu/nwscript-language-definitions](https://github.com/KobaltBlu/nwscript-language-definitions).

The browser discovers games and releases from the repository metadata, supports local search, and shows each definition's engine, aliases, version, provenance, size, checksum, and source. A definition can be opened in an untitled editor or downloaded into the workspace. Missing download directories are created automatically.

The catalog and selected source are fetched on demand, so an internet connection is required. Saved definitions remain available in the workspace afterward. Previewing a catalog definition also reports whether its ACTION signatures match the workspace language specification.

## ACTION compatibility

When multiple workspace `nwscript.nss` files disagree on ACTION ID, arity, or parameter types, Workbench Home surfaces compatibility warnings. The Language Definition Browser and NCS Inspector can also report ACTION signature comparison when `nwscript.actionCompat` is enabled (default on). See [Configuration](configuration.md).

Language specifications must be accessible in the workspace so compilation and editor intelligence resolve the same API for each script.
