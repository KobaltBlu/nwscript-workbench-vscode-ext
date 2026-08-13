import type { NcsInspection, NcsInstruction } from "@neverwinter/nwscript-wasm";
import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { NCS_HEX_VIEW_TYPE, NcsEditorProvider } from "./ncsEditor";
import { basename } from "./uri";

const VIEW_TYPE = "nwscript.ncsCompare";

interface DiffRow {
  kind: "same" | "changed" | "added" | "removed";
  left?: string;
  right?: string;
  leftOffset?: number;
  rightOffset?: number;
}

function instructionKey(ins: NcsInstruction): string {
  return `${ins.mnemonic}|${ins.rawText}`;
}

function formatRow(ins: NcsInstruction): string {
  const operand = ins.operandText ? ` ${ins.operandText}` : "";
  return `${ins.codeOffset.toString(16).toUpperCase().padStart(8, "0")}  ${ins.mnemonic}${operand}`;
}

function diffInstructions(left: NcsInspection, right: NcsInspection): DiffRow[] {
  const leftMap = new Map(left.instructions.map((ins) => [ins.codeOffset, ins]));
  const rightMap = new Map(right.instructions.map((ins) => [ins.codeOffset, ins]));
  const offsets = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort((a, b) => a - b);
  const rows: DiffRow[] = [];
  for (const offset of offsets) {
    const a = leftMap.get(offset);
    const b = rightMap.get(offset);
    if (a && b && instructionKey(a) === instructionKey(b)) {
      rows.push({ kind: "same", left: formatRow(a), right: formatRow(b), leftOffset: offset, rightOffset: offset });
    } else if (a && b) {
      rows.push({ kind: "changed", left: formatRow(a), right: formatRow(b), leftOffset: offset, rightOffset: offset });
    } else if (a) {
      rows.push({ kind: "removed", left: formatRow(a), leftOffset: offset });
    } else if (b) {
      rows.push({ kind: "added", right: formatRow(b), rightOffset: offset });
    }
  }
  return rows;
}

export async function openNcsCompare(
  compiler: CompilerService,
  ncsEditor: NcsEditorProvider,
  leftUri?: vscode.Uri,
): Promise<void> {
  const left = leftUri ?? (await pickNcs("Select the first NCS file"));
  if (!left) return;
  const right = await pickNcs("Select the NCS file to compare");
  if (!right) return;

  const [leftInspection, rightInspection] = await Promise.all([
    compiler.inspectNcs(left),
    compiler.inspectNcs(right),
  ]);
  const rows = diffInstructions(leftInspection, rightInspection);
  const changed = rows.filter((row) => row.kind !== "same").length;

  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `Compare ${basename(left)} / ${basename(right)}`,
    vscode.ViewColumn.Active,
    { enableScripts: true },
  );

  const nonce = createNonce();
  const csp = `default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  const body = rows.map((row) => {
    const leftAttr = row.leftOffset != null ? ` data-left="${row.leftOffset}"` : "";
    const rightAttr = row.rightOffset != null ? ` data-right="${row.rightOffset}"` : "";
    return `<div class="row ${row.kind}"${leftAttr}${rightAttr}><span class="cell left">${escapeHtml(row.left ?? "")}</span><span class="cell right">${escapeHtml(row.right ?? "")}</span></div>`;
  }).join("");

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type !== "open") return;
    const uri = message.side === "right" ? right : left;
    const codeOffset = Number(message.codeOffset);
    if (Number.isFinite(codeOffset)) {
      ncsEditor.revealAtCodeOffset(uri, codeOffset);
    }
    await vscode.commands.executeCommand("vscode.openWith", uri, NCS_HEX_VIEW_TYPE);
  });

  panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
header{padding:10px 14px;border-bottom:1px solid var(--vscode-editorWidget-border)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:2px 14px;white-space:pre;cursor:pointer}
.row:hover{background:var(--vscode-list-hoverBackground)}
.changed{background:var(--vscode-diffEditor-insertedTextBackground, rgba(255,200,0,.12))}
.added{background:var(--vscode-diffEditor-insertedLineBackground, rgba(80,200,80,.12))}
.removed{background:var(--vscode-diffEditor-removedLineBackground, rgba(200,80,80,.12))}
.same{opacity:.7}
</style></head>
<body>
<header><strong>${escapeHtml(basename(left))} vs ${escapeHtml(basename(right))}</strong>
<div>${changed} differing instruction${changed === 1 ? "" : "s"} of ${rows.length}. Click a line to open that instruction in the NCS Inspector.</div></header>
${body || "<p style='padding:14px'>No instructions.</p>"}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener("click", function (event) {
  const cell = event.target.closest(".cell");
  const row = event.target.closest(".row");
  if (!row) return;
  const side = cell && cell.classList.contains("right") ? "right" : "left";
  const offset = row.getAttribute(side === "right" ? "data-right" : "data-left")
    || row.getAttribute("data-left")
    || row.getAttribute("data-right");
  if (offset == null) return;
  vscode.postMessage({ type: "open", side: side, codeOffset: Number(offset) });
});
</script>
</body></html>`;
}

async function pickNcs(title: string): Promise<vscode.Uri | undefined> {
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "NWScript bytecode": ["ncs"] },
    title,
  });
  return selected?.[0];
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
