# Commands

## Compile

| Command | Description |
| --- | --- |
| **NWScript Workbench: Compile Current File** | Compile the active or Explorer-selected `.nss` file |
| **NWScript Workbench: Compile All Scripts** | Compile every entry script (`void main` / `int StartingConditional`) in the workspace |
| **NWScript Workbench: Compile Folder…** | Compile every entry script under a chosen folder |
| **NWScript Workbench: Open Compiled NCS** | Open the `.ncs` written beside the source or under `nwscript.outputDirectory` |
| **NWScript Workbench: Show Compiler Log** | Open **View → Output → NWScript Compiler** |

Include files are pulled in as dependencies; they are not compiled as entry scripts. Failures stay in the Problems panel per file.

Compile progress, language-spec selection, include resolution, full error text, and output paths are written to the **NWScript Compiler** Output channel. Manual compiles also show a toast (with a **Show Log** action); compile-on-save and live diagnostics log quietly without focusing Output.

### Output layout

Default (beside the source):

```text
script.nss
script.ncs
```

With NDB generation enabled:

```text
script.nss
script.ncs
script.ndb
```

Configure a workspace-relative output folder with `nwscript.outputDirectory`. See [Configuration](configuration.md).

### Diagnostics

Compiler errors such as:

```text
k_test.nss(12): ERROR: DECLARATION DOES NOT MATCH PARAMETERS
```

are converted into VS Code diagnostics on the corresponding NSS file and line. The same messages are appended to the Output channel so multi-line errors and compile-on-save runs remain inspectable after the toast disappears.

The extension also pre-resolves `#include` resources before invoking the compiler, which keeps missing includes identifiable even with older `nwscript-wasm` builds whose native `FILE NOT FOUND` diagnostic does not name the missing resref.

## Workbench and browsers

| Command | Description |
| --- | --- |
| **NWScript Workbench: Open Home** | Open the Workbench Home control center |
| **NWScript Workbench: Browse Scripts** | Search and preview vanilla KOTOR/TSL sources |
| **NWScript Workbench: Browse Language Definitions** | Browse and download `nwscript.nss` definitions |

## NCS tools

| Command | Description |
| --- | --- |
| **NWScript Workbench: Open NCS Disassembly as Text** | Open a `<name>.ncsasm` preview of the textual WASM disassembly |
| **NWScript Workbench: Save NCS Disassembly…** | Write the textual disassembly via the save dialog |
| **NWScript Workbench: Compare NCS Files…** | Diff two `.ncs` files by instruction |
| **NWScript Workbench: Open NCS at Source** | From an NSS editor, open the sibling `.ncs` in the inspector |

Opening an `.ncs` file uses the readonly NCS Inspector by default. Details are in [NCS Inspector](ncs-inspector.md).
