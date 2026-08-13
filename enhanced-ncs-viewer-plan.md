# Enhanced NCS Viewer Implementation Plan

## Goal

Replace the current `.ncs` experience --- a custom hex viewer plus a
separate disassembly preview tab --- with a single **NCS Inspector**
custom editor containing synchronized assembly and bytecode panes.

The viewer should use one parsed instruction model from `nwscript-wasm`,
so the extension never independently re-decodes NCS instructions.

## Desired UX

Opening an `.ncs` file should show one custom editor with a resizable
split:

``` text
┌──────────────────────────────────────────────────────────┐
│ foo.ncs                                                  │
├────────────────────────────┬─────────────────────────────┤
│ Assembly                   │ Bytecode                    │
│                            │                             │
│ 00000000 CONSTI 00000001   │ 0000000D 04 03 00 00 00 01 │
│ 00000006 ACTION Foo(...)   │ 00000013 05 00 01 23 02    │
│ 0000000B JZ off_00000020   │ 00000018 1F 00 00 00 ...   │
│                            │                             │
├────────────────────────────┴─────────────────────────────┤
│ Selected instruction details                            │
└──────────────────────────────────────────────────────────┘
```

Clicking an assembly instruction highlights its complete byte range.

Clicking a semantic operand in assembly highlights only the
corresponding bytes.

Clicking any byte selects the containing instruction and highlights the
corresponding assembly instruction.

Hovering either representation should expose decoded meaning where
available.

The viewer should support:

-   **Split**
-   **Assembly only**
-   **Bytecode only**

Keep **Open Disassembly as Text** as a secondary command for copying,
diffing, searching, or saving assembly.

------------------------------------------------------------------------

## Phase 1 --- Add Structured NCS Decoding to `nwscript-wasm`

Repository:

``` text
KobaltBlu/nwscript-wasm
```

Primary file:

``` text
ncs_disassembler.cpp
```

The current parser already produces:

``` cpp
struct Instruction {
    size_t offset;
    uint8_t op;
    uint8_t aux;
    std::vector<uint8_t> extra;
};
```

Extend this concept so the decoder preserves semantic byte ranges rather
than throwing that information away during text formatting.

### Add an Instruction-Inspection Model

Conceptually:

``` ts
interface NcsInspection {
  header: {
    present: boolean;
    size: number;
    version?: string;
  };

  instructions: NcsInstruction[];
}

interface NcsInstruction {
  index: number;

  codeOffset: number;
  fileOffset: number;
  size: number;

  opcode: number;
  aux: number;

  mnemonic: string;
  operandText: string;
  rawText: string;

  parts: NcsInstructionPart[];

  jumpTarget?: number;
  actionId?: number;
  actionName?: string;
}

interface NcsInstructionPart {
  kind:
    | "opcode"
    | "aux"
    | "integer"
    | "float"
    | "stringLength"
    | "stringData"
    | "object"
    | "actionId"
    | "argumentCount"
    | "address"
    | "stackOffset"
    | "size"
    | "unknown";

  fileOffset: number;
  length: number;

  text?: string;
  value?: string | number;
}
```

Names do not need to match this exactly, but the API needs equivalent
information.

### Preserve Both Kinds of Offsets

This is important.

The existing disassembler displays instruction offsets relative to
executable NCS code, excluding the 13-byte NCS header.

The hex viewer displays physical file offsets.

Structured output therefore needs both:

``` text
codeOffset = 0x00000000
fileOffset = 0x0000000D
```

Do not make the VS Code extension assume the header is always 13 bytes.

The decoder should determine the physical location and report it.

### Describe Instruction Fields Semantically

For example, `ACTION`:

``` text
05 00 01 23 02
│  │  │     │
│  │  │     └ argument count
│  │  └────── action ID
│  └───────── aux
└──────────── opcode
```

Produce parts approximately equivalent to:

``` ts
[
  { kind: "opcode",        fileOffset: 0x20, length: 1 },
  { kind: "aux",           fileOffset: 0x21, length: 1 },
  { kind: "actionId",      fileOffset: 0x22, length: 2 },
  { kind: "argumentCount", fileOffset: 0x24, length: 1 }
]
```

Likewise:

``` text
CONSTI
opcode | aux | int32

CONSTS
opcode | aux | uint16 length | string bytes

JMP / JZ / JNZ / JSR
opcode | aux | relative target

CPDOWNSP / CPTOPSP
opcode | aux | stack offset | size

STORE_STATE
opcode | aux | first uint32 | second uint32
```

Use the existing `fixedExtraSize()` and operand decoding logic as the
canonical source of instruction layout.

**Do not create a second decoder.**

------------------------------------------------------------------------

## Phase 2 --- Expose the Structured Decoder Through the WASM API

Keep the current:

``` ts
compiler.disassemble(bytes): string
```

for backwards compatibility.

Add a structured API, ideally:

``` ts
compiler.inspectNcs(bytes): NcsInspection
```

Preferred name: `inspectNcs()` because the result is broader than text
disassembly.

### Implementation Options

If returning nested JavaScript objects directly through Emscripten is
awkward, expose serialized JSON from C++:

``` cpp
nwsc_inspect_ncs(...)
nwsc_inspection_data()
nwsc_inspection_size()
```

and parse it in `index.mjs`.

That is acceptable for this workload. NCS files are small enough that
JSON serialization is unlikely to matter.

### Update TypeScript Declarations

Update:

``` text
index.d.ts
```

with exported interfaces for the structured inspection data.

The extension should consume those actual package types rather than
defining duplicate versions.

### Keep One Parser

Refactor so:

``` text
parseInstructions()
        │
        ├── format textual disassembly
        └── build structured inspection
```

Both APIs must be produced from the same decoded instruction objects.

------------------------------------------------------------------------

## Phase 3 --- Refactor the VS Code NCS Editor

Repository:

``` text
KobaltBlu/nwscript-workbench-vscode-ext
```

Primary files:

``` text
src/ncsEditor.ts
src/compilerService.ts
```

The current behavior in `ncsEditor.ts` is:

``` text
.ncs custom editor → hex webview
                +
virtual text document → assembly preview beside it
```

Replace that primary workflow with:

``` text
.ncs custom editor → one NCS Inspector webview
```

### Change `CompilerService`

Add something like:

``` ts
async inspectNcs(uri: vscode.Uri): Promise<NcsInspection>
```

Implementation:

``` text
read .ncs bytes
get compiler
call compiler.inspectNcs(bytes)
return structured result
```

Retain:

``` ts
disassembleText()
```

for the secondary text-disassembly command.

------------------------------------------------------------------------

## Phase 4 --- Build the Unified Custom Editor

Refactor `renderHexView()` into something closer to:

``` ts
renderNcsInspector(...)
```

The webview should receive:

``` ts
{
  bytes,
  inspection,
  filename
}
```

### Enable Scripts

The current custom editor has:

``` ts
enableScripts: false
```

Change to:

``` ts
enableScripts: true
```

Use a nonce-based Content Security Policy.

All synchronization can then happen locally inside the webview without
round-tripping every click through the extension host.

------------------------------------------------------------------------

## Phase 5 --- Render the Assembly Pane

Do not render the assembly as one flat text blob.

Each instruction should have its own element:

``` html
<div
  class="instruction"
  data-index="17"
  data-code-offset="42"
  data-file-offset="55">
```

Render separate semantic elements inside it:

``` html
<span class="address">0000002A</span>
<span class="mnemonic">ACTION</span>
<span class="operand action-id">GetObjectByTag(0123)</span>
<span class="operand argc">02</span>
```

Each semantic operand should carry a reference to its corresponding
instruction part.

Example:

``` html
data-part-index="2"
```

That enables field-level synchronization.

------------------------------------------------------------------------

## Phase 6 --- Render the Bytecode Pane Byte-by-Byte

Do not keep each row as one large `<span class="hex">`.

Each byte needs its own element:

``` html
<span
  class="byte"
  data-offset="42">
  05
</span>
```

This makes selection and semantic highlighting straightforward.

Keep rows at 16 bytes.

Still show:

``` text
file offset
hex bytes
ASCII
```

but make the individual bytes addressable.

------------------------------------------------------------------------

## Phase 7 --- Implement Synchronized Selection

Maintain webview state such as:

``` ts
let selectedInstructionIndex: number | undefined;
let selectedPartIndex: number | undefined;
```

### Assembly Click

Clicking an instruction should:

1.  Select the instruction.
2.  Highlight the assembly row.
3.  Highlight every byte from `fileOffset` through `fileOffset + size`.
4.  Scroll the byte range into view if necessary.
5.  Update the details pane.

### Assembly Operand Click

Clicking an operand should:

1.  Select the instruction.
2.  Select the semantic part.
3.  Highlight the entire instruction lightly.
4.  Highlight the corresponding byte range strongly.

For example, clicking the action ID in:

``` text
ACTION GetObjectByTag(0123), 02
       ^^^^^^^^^^^^^^^^^^^^
```

should highlight only the two action-ID bytes.

Clicking:

``` text
02
```

should highlight only the argument-count byte.

### Byte Click

Clicking a byte should:

1.  Find the instruction where:

``` ts
byteOffset >= instruction.fileOffset &&
byteOffset < instruction.fileOffset + instruction.size
```

2.  Select that instruction.
3.  Find the semantic part containing that byte, if one exists.
4.  Highlight the corresponding assembly token.
5.  Scroll the assembly row into view.

------------------------------------------------------------------------

## Phase 8 --- Semantic Coloring

Use semantic CSS classes, not fixed RGB values.

Suggested categories:

-   `opcode`
-   `aux`
-   `integer`
-   `float`
-   `string`
-   `object`
-   `action-id`
-   `argument-count`
-   `address`
-   `stack-offset`
-   `size`
-   `header`
-   `unknown`

Use VS Code theme variables wherever practical.

The visual hierarchy should be:

``` text
semantic color
+
light whole-instruction selection
+
strong currently-selected field
```

Selection must remain obvious regardless of theme.

------------------------------------------------------------------------

## Phase 9 --- Highlight the NCS Header

Treat the physical NCS header separately.

Approximately:

``` text
NCS V1.0
B
file size / header fields
```

The header bytes should have their own visual category and should not
map to an assembly instruction.

Clicking them can populate the details pane with header information.

------------------------------------------------------------------------

## Phase 10 --- Add the Details Pane

Initial version can be simple.

For a selected instruction show:

``` text
ACTION

Code offset:  0x0000002A
File offset:  0x00000037
Size:         5 bytes

Opcode:       0x05
Aux:          0x00
Action ID:    0x0123
Action:       GetObjectByTag
Arguments:    2
```

For jumps:

``` text
JZ

Relative offset: +0x00000042
Target:          off_00000120
```

For constants:

``` text
CONSTF

Raw:   41 20 00 00
Value: 10.0
```

Make the pane collapsible.

------------------------------------------------------------------------

## Phase 11 --- Add Layout Controls

Add a small toolbar inside the custom editor:

``` text
[ Split ] [ Assembly ] [ Bytecode ]
```

In split mode, make the divider draggable.

Store the last selected layout in webview state using:

``` ts
vscode.getState()
vscode.setState()
```

It does not need to become a global VS Code setting initially.

------------------------------------------------------------------------

## Phase 12 --- Preserve Text Disassembly as a Secondary Feature

Keep the existing virtual disassembly provider.

Expose a command such as:

``` text
NWScript Workbench: Open NCS Disassembly as Text
```

This is useful for:

-   Search
-   Copy/paste
-   Diffs
-   External tooling
-   Saving `.ncsasm`

Do not automatically open it beside every `.ncs`.

The unified inspector becomes the default.

------------------------------------------------------------------------

## Phase 13 --- Navigation Enhancements After the Base Viewer Works

These are follow-up features, not blockers for the first implementation.

### Jump Navigation

Click:

``` text
off_00000120
```

to jump to the target instruction.

### Function Navigation

Click:

``` text
fn_00000240
```

to navigate to that function.

### Action Information

Hover or click an action such as:

``` text
ACTION GetObjectByTag
```

and show:

``` text
action ID
argument count
active compiler signature
compatibility override status
```

This becomes especially valuable once action-signature compatibility
profiles exist.

### Search

Eventually support searching by:

-   Mnemonic
-   Action name
-   Offset
-   Byte sequence

from inside the inspector.

------------------------------------------------------------------------

## Phase 14 --- Keep the Architecture Clean

The important ownership boundary should be:

``` text
nwscript-wasm
    owns:
        NCS parsing
        instruction sizes
        operand decoding
        byte ranges
        action IDs/names
        jump targets
        textual disassembly

VS Code extension
    owns:
        visualization
        selection
        scrolling
        layout
        hover UI
        navigation
```

**Do not make the VS Code extension understand that `ACTION` has a
two-byte action ID or that `CONSTF` has a four-byte operand.**

That knowledge belongs exclusively in `nwscript-wasm`.

------------------------------------------------------------------------

## Acceptance Criteria

The implementation is complete when all of these work:

-   [ ] Opening an `.ncs` produces one NCS Inspector tab.
-   [ ] Assembly and hex are visible side-by-side by default.
-   [ ] Assembly instructions are backed by structured decoder metadata.
-   [ ] Clicking an assembly instruction highlights exactly its bytes.
-   [ ] Clicking an assembly operand highlights exactly its operand
    bytes.
-   [ ] Clicking a byte selects its containing assembly instruction.
-   [ ] Semantic instruction fields have distinguishable theme-aware
    styling.
-   [ ] The NCS header is represented separately from executable code.
-   [ ] Code offsets and physical file offsets are both correct.
-   [ ] Jump/action/constant operands show decoded values.
-   [ ] The details pane updates with the current selection.
-   [ ] Split, assembly-only, and bytecode-only modes work.
-   [ ] Existing textual disassembly remains accessible through a
    command.
-   [ ] No NCS decoding logic is duplicated inside the VS Code
    extension.
-   [ ] Existing `.ncs` files continue to open read-only.
-   [ ] Malformed or truncated NCS data produces a useful error instead
    of crashing the webview.

------------------------------------------------------------------------

## Implementation Order for Cursor

Implement this in the following order:

1.  Add the structured NCS inspection model to `nwscript-wasm`.
2.  Refactor the existing disassembler so structured inspection and
    textual disassembly share the same parser.
3.  Export `inspectNcs()` through the WASM/JavaScript API.
4.  Add public TypeScript definitions for the inspection model.
5.  Add `CompilerService.inspectNcs()` to the VS Code extension.
6.  Convert the existing `.ncs` custom editor into the unified NCS
    Inspector.
7.  Render structured assembly and bytecode panes.
8.  Implement instruction-level bidirectional selection.
9.  Implement semantic operand-level selection.
10. Add the details pane.
11. Add split/assembly/bytecode layout controls.
12. Preserve textual disassembly as an explicit secondary command.
13. Add jump/function navigation only after the base inspector is
    stable.

> **Important:** Do the WASM structured-inspection API first, then
> refactor the viewer around it. Do not temporarily parse the textual
> disassembly in TypeScript to recover instruction offsets. That
> duplicates decoder logic and will create unnecessary technical debt.
