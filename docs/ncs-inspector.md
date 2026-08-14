# NCS Inspector

Opening an `.ncs` file uses the readonly **NWScript Workbench NCS Inspector** by default. Assembly and bytecode appear side-by-side. Clicking an instruction, operand, or byte highlights the corresponding range in the other pane and updates the details panel. Layout can be switched between Split, Assembly, and Bytecode.

![NWScript Workbench NCS Inspector with synchronized assembly and bytecode panes](../assets/ss-script-dissasembler-with-hex-and-asm-views.png)

## Using the inspector

- Click `off_*` / `fn_*` address operands or the details Target to jump to that instruction
- Search (Ctrl/Cmd+F or `/`) for hex offsets, mnemonics, ACTION names, and byte sequences
- Open the Functions sidebar for JSR targets and NDB subroutine names
- Arrow keys move between instructions; Enter jumps; Ctrl/Cmd+C copies the selected line
- The inspector reloads when the `.ncs` or sibling `.ndb` changes after compile
- ACTION details show Engine API signatures and cross-spec compatibility when `nwscript.nss` is resolved
- A sibling `.ndb` overlays NSS file/line on the selected instruction (**Open Source at Instruction**)

The inspector is backed by structured decoding from `nwscript-wasm`. It does not re-parse the textual disassembly. If `nwscript.nss` cannot be resolved, ACTION IDs stay numeric and the inspector still opens. Truncated files keep decoded instructions and show a partial-decode error.

Related settings: [Configuration](configuration.md) (NCS Inspector section).

## Disassembly and compare

| Command | Description |
| --- | --- |
| **NWScript Workbench: Open NCS Disassembly as Text** | Opens a `<name>.ncsasm` preview of the textual WASM disassembly for search, copy, and diff. This no longer opens automatically when an `.ncs` file is opened. |
| **NWScript Workbench: Save NCS Disassembly…** | Writes the textual disassembly to a file chosen with the save dialog. |
| **NWScript Workbench: Compare NCS Files…** | Inspects two `.ncs` files and shows added, removed, and changed instructions. Click a row to open that instruction in the NCS Inspector. |
| **NWScript Workbench: Open NCS at Source** | From an NSS editor, opens the sibling `.ncs` in the inspector. When a matching `.ndb` is present, the cursor's function is revealed at its subroutine. |
