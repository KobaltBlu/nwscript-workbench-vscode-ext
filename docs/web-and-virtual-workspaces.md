# Web and virtual workspaces

## Desktop and browser hosts

The extension has only a `browser` entry point. VS Code therefore runs the same web-extension bundle in:

- VS Code Desktop
- `vscode.dev`
- `github.dev`
- browser-based Codespaces
- other VS Code-compatible web extension hosts

The runtime does not import Node's `fs`, `path`, or child-process APIs. Workspace and extension resources are read and written through `vscode.workspace.fs`.

Compilation does not require network access at runtime. The Script Browser and Language Definition Browser fetch catalogs on demand and do need an internet connection. See [Getting started](getting-started.md) and [Language specifications](language-specifications.md).

## Virtual workspace considerations

VS Code Web does not expose arbitrary host filesystem paths. For maximum compatibility:

- keep NSS source and includes inside the opened workspace;
- configure include paths relative to the workspace;
- configure a custom `nwscript.nss` with a workspace-relative path;
- allow the virtual workspace provider to handle generated NCS/NDB writes.

Language definition and script downloads write through `workspace.fs` and skip creating the workspace-root handle, which vscode.dev's local-folder provider rejects.

A provider may expose a read-only virtual workspace. In that case compilation still works in memory, but writing the generated NCS/NDB to that provider will fail until the workspace is writable.

For packaging and host internals, see [Architecture](architecture.md).
