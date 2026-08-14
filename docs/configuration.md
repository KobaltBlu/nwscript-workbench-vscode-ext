# Configuration

Language-specification discovery is automatic. Prefer a workspace-root `nwscript.nss`, then the nearest ancestor of the script being compiled or edited. If no ancestor applies and exactly one specification exists in the workspace, that file is used. Multiple unrelated specifications are treated as ambiguous. Full rules: [Language specifications](language-specifications.md).

For multi-game workspaces, keep each game's scripts under its own folder with that folder's `nwscript.nss`. Avoid a workspace-root `nwscript.nss` when the workspace contains multiple independent game environments.

## `nwscript.includePaths`

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

## `nwscript.outputDirectory`

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

## `nwscript.compileOnSave`

```json
{
  "nwscript.compileOnSave": true
}
```

Compiles an NSS document after it is saved. Saving an include recompiles entry scripts that depend on it when `nwscript.compileDependentsOnSave` is on.

## `nwscript.liveDiagnostics`

```json
{
  "nwscript.liveDiagnostics": true
}
```

Background-compiles the active NSS buffer while typing. Diagnostics update without writing `.ncs` or `.ndb`. Turn off if the exclusive WASM queue feels busy.

## `nwscript.compileDependentsOnSave`

```json
{
  "nwscript.compileDependentsOnSave": true
}
```

When compile-on-save is enabled, saving an include recompiles entry scripts that `#include` it.

## Editor extras

All default to `true`. Turn them off in Settings or on Workbench Home.

| Setting | Effect |
| --- | --- |
| `nwscript.inlayHints` | Parameter names on function and ACTION calls |
| `nwscript.semanticTokens` | Engine / include / script symbol overlay |
| `nwscript.formatting` | Conservative brace-indent formatter |
| `nwscript.folding` | Brace and grouped `#include` folding |
| `nwscript.codeActions` | Quick fixes (add include, StartingConditional, language definition) |
| `nwscript.includeGraph` | Include graph on Workbench Home |
| `nwscript.actionCompat` | ACTION signature comparison on Home, Language Definition Browser, and NCS Inspector |

## NCS Inspector

All default to `true`.

| Setting | Effect |
| --- | --- |
| `nwscript.ncsReloadOnChange` | Reload when the open `.ncs` or sibling `.ndb` changes |
| `nwscript.ncsActionSignatures` | Engine API ACTION names and signatures |
| `nwscript.ncsNdbOverlay` | Sibling `.ndb` source mapping |

## `nwscript.autoOpenHome`

```json
{
  "nwscript.autoOpenHome": false
}
```

When `true` (default), Home opens automatically the first time a workspace folder is available after the extension activates. Set to `false` to opt out of that welcome launch. Manual opens from the Activity Bar, Command Palette, and editor actions are unchanged.

## `nwscript.optimizationLevel`

Supported values:

```text
O0
O1
O2
O3
```

Default: `O1`.

## `nwscript.generateDebug`

Generate `.ndb` output when supported by the compiler:

```json
{
  "nwscript.generateDebug": true
}
```

## `nwscript.maxIncludeDepth`

Maximum native compiler include depth. Default: `32`.

## `nwscript.maxResolveAttempts`

Maximum number of include resources recursively loaded before a compilation. Default: `64`.
