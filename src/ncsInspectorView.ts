import type { NcsInspection } from "@neverwinter/nwscript-wasm";
import type * as vscode from "vscode";

export interface NcsInspectorRenderOptions {
  filename: string;
  bytes: Uint8Array;
  inspection: NcsInspection;
  inspectError?: string;
}

export function renderNcsInspector(
  webview: vscode.Webview,
  options: NcsInspectorRenderOptions,
): string {
  const nonce = createNonce();
  const payload = embedJson({
    filename: options.filename,
    bytes: toBase64(options.bytes),
    inspection: options.inspection,
    inspectError: options.inspectError ?? "",
  });
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.filename)}</title>
  <style>
    :root { color-scheme: light dark; }
    html, body {
      height: 100%;
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    body {
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editor-background);
      flex: 0 0 auto;
    }
    .toolbar strong { font-weight: 600; }
    .toolbar .meta { color: var(--vscode-descriptionForeground); }
    .toolbar .spacer { flex: 1; }
    .modes { display: flex; gap: 4px; }
    button {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      padding: 3px 10px;
      font: inherit;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.active {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .error {
      padding: 8px 12px;
      color: var(--vscode-editorError-foreground);
      background: var(--vscode-inputValidation-errorBackground, transparent);
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      flex: 0 0 auto;
    }
    .workspace {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
    }
    .pane {
      min-width: 0;
      min-height: 0;
      overflow: auto;
    }
    body.layout-split .pane-assembly { flex: 0 0 var(--split-ratio, 48%); }
    body.layout-split .pane-bytecode { flex: 1 1 auto; }
    body.layout-assembly .pane-bytecode,
    body.layout-assembly .divider,
    body.layout-bytecode .pane-assembly,
    body.layout-bytecode .divider { display: none; }
    body.layout-assembly .pane-assembly,
    body.layout-bytecode .pane-bytecode { flex: 1 1 auto; }
    .divider {
      flex: 0 0 5px;
      cursor: col-resize;
      background: var(--vscode-editorWidget-border);
    }
    .divider:hover { background: var(--vscode-focusBorder); }
    .instruction {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6em;
      padding: 1px 12px;
      line-height: 1.45;
      cursor: pointer;
    }
    .instruction:hover { background: var(--vscode-list-hoverBackground); }
    .instruction.selected {
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .label {
      padding: 6px 12px 0;
      color: var(--vscode-symbolIcon-functionForeground, var(--vscode-textLink-foreground));
    }
    .address { color: var(--vscode-editorLineNumber-foreground); }
    .mnemonic { color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-charts-purple)); font-weight: 600; }
    .operand { cursor: pointer; border-radius: 2px; }
    .operand:hover { outline: 1px dashed var(--vscode-focusBorder); }
    .hex-row {
      display: grid;
      grid-template-columns: 8ch 1fr auto;
      gap: 1.2ch;
      padding: 0 12px;
      line-height: 1.45;
      white-space: pre;
    }
    .hex-bytes, .ascii { display: flex; gap: 0.45ch; }
    .byte, .ascii-byte {
      display: inline-block;
      min-width: 2ch;
      text-align: center;
      cursor: pointer;
      border-radius: 2px;
    }
    .ascii-byte { min-width: 1ch; color: var(--vscode-symbolIcon-stringForeground, var(--vscode-editor-foreground)); }
    .byte.in-range, .ascii-byte.in-range, .operand.in-range {
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .byte.selected-field, .ascii-byte.selected-field, .operand.selected-field {
      background: var(--vscode-editor-selectionBackground);
      outline: 1px solid var(--vscode-focusBorder);
    }
    .kind-opcode { color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-charts-purple)); }
    .kind-aux { color: var(--vscode-descriptionForeground); }
    .kind-integer, .kind-float, .kind-argumentCount { color: var(--vscode-symbolIcon-numberForeground, var(--vscode-charts-blue)); }
    .kind-stringLength, .kind-stringData { color: var(--vscode-symbolIcon-stringForeground, var(--vscode-charts-orange)); }
    .kind-object { color: var(--vscode-symbolIcon-classForeground, var(--vscode-charts-yellow)); }
    .kind-actionId { color: var(--vscode-symbolIcon-functionForeground, var(--vscode-charts-green)); }
    .kind-address { color: var(--vscode-textLink-foreground, var(--vscode-charts-blue)); }
    .kind-stackOffset { color: var(--vscode-symbolIcon-variableForeground, var(--vscode-charts-purple)); }
    .kind-size { color: var(--vscode-symbolIcon-constantForeground, var(--vscode-charts-blue)); }
    .kind-header { color: var(--vscode-editorLineNumber-activeForeground); }
    .kind-unknown { color: var(--vscode-editor-foreground); }
    .details {
      flex: 0 0 auto;
      max-height: 38%;
      overflow: auto;
      border-top: 1px solid var(--vscode-editorWidget-border);
      padding: 10px 14px 16px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    body.details-collapsed .details { display: none; }
    .details h2 {
      margin: 0 0 8px;
      font-size: 1em;
    }
    .details dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 2px 16px;
      margin: 0;
    }
    .details dt { color: var(--vscode-descriptionForeground); }
    .details dd { margin: 0; }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body class="layout-split">
  <div class="toolbar">
    <div class="modes">
      <button type="button" data-layout="split">Split</button>
      <button type="button" data-layout="assembly">Assembly</button>
      <button type="button" data-layout="bytecode">Bytecode</button>
    </div>
    <strong id="filename"></strong>
    <span class="meta" id="file-meta"></span>
    <span class="spacer"></span>
    <button type="button" id="toggle-details">Details</button>
  </div>
  <div id="inspect-error" class="error" hidden></div>
  <div class="workspace" id="workspace">
    <div class="pane pane-assembly" id="assembly"></div>
    <div class="divider" id="divider"></div>
    <div class="pane pane-bytecode" id="bytecode"></div>
  </div>
  <aside class="details" id="details"></aside>
  <script nonce="${nonce}">window.__NCS_PAYLOAD__ = ${payload};</script>
  <script nonce="${nonce}">${INSPECTOR_SCRIPT}</script>
</body>
</html>`;
}

export function renderNcsError(webview: vscode.Webview, filename: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(filename)}</title>
  <style>
    body {
      padding: 16px;
      color: var(--vscode-editorError-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
    }
  </style>
</head>
<body>
  <strong>Unable to open ${escapeHtml(filename)}</strong>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

const INSPECTOR_SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const payload = window.__NCS_PAYLOAD__;
  const inspection = payload.inspection;
  const bytes = fromBase64(payload.bytes);
  const saved = vscode.getState() || {};
  const BYTES_PER_ROW = 16;

  let layout = saved.layout || "split";
  let splitRatio = typeof saved.splitRatio === "number" ? saved.splitRatio : 0.48;
  let detailsCollapsed = !!saved.detailsCollapsed;
  let selectedInstructionIndex;
  let selectedPartIndex;
  let selectedHeader = false;
  let selectedHeaderPartIndex;

  const assemblyEl = document.getElementById("assembly");
  const bytecodeEl = document.getElementById("bytecode");
  const detailsEl = document.getElementById("details");
  const dividerEl = document.getElementById("divider");
  const workspaceEl = document.getElementById("workspace");
  const errorEl = document.getElementById("inspect-error");

  document.getElementById("filename").textContent = payload.filename;
  document.getElementById("file-meta").textContent = bytes.length.toLocaleString() + " bytes";
  if (payload.inspectError) {
    errorEl.hidden = false;
    errorEl.textContent = payload.inspectError;
  }

  const labels = {};
  const instructions = inspection.instructions || [];
  for (let i = 0; i < instructions.length; i += 1) {
    const ins = instructions[i];
    if (ins.jumpTarget == null) continue;
    const part = (ins.parts || []).find(function (item) { return item.kind === "address"; });
    if (part && part.text) labels[ins.jumpTarget] = part.text;
  }

  const byteInfo = new Array(bytes.length);
  const headerParts = (inspection.header && inspection.header.parts) || [];
  for (let i = 0; i < headerParts.length; i += 1) {
    const part = headerParts[i];
    for (let offset = part.fileOffset; offset < part.fileOffset + part.length && offset < bytes.length; offset += 1) {
      byteInfo[offset] = { header: true, headerPartIndex: i, kind: "header" };
    }
  }
  for (let i = 0; i < instructions.length; i += 1) {
    const ins = instructions[i];
    for (let offset = ins.fileOffset; offset < ins.fileOffset + ins.size && offset < bytes.length; offset += 1) {
      const current = byteInfo[offset] || {};
      byteInfo[offset] = {
        header: false,
        instructionIndex: ins.index,
        kind: current.kind || "unknown"
      };
    }
    const parts = ins.parts || [];
    for (let p = 0; p < parts.length; p += 1) {
      const part = parts[p];
      for (let offset = part.fileOffset; offset < part.fileOffset + part.length && offset < bytes.length; offset += 1) {
        byteInfo[offset] = {
          header: false,
          instructionIndex: ins.index,
          partIndex: p,
          kind: part.kind
        };
      }
    }
  }

  function persist() {
    vscode.setState({ layout: layout, splitRatio: splitRatio, detailsCollapsed: detailsCollapsed });
  }

  function padHex(value, width) {
    let text = (value >>> 0).toString(16).toUpperCase();
    while (text.length < width) text = "0" + text;
    return text;
  }

  function fromBase64(value) {
    const binary = atob(value);
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) result[i] = binary.charCodeAt(i);
    return result;
  }

  function asciiChar(value) {
    return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".";
  }

  function byteTitle(offset, info) {
    const parts = ["0x" + padHex(offset, 8)];
    if (info.header) {
      const part = info.headerPartIndex != null ? headerParts[info.headerPartIndex] : undefined;
      parts.push("header");
      if (part && part.text) parts.push(part.text);
      return parts.join(" · ");
    }
    if (info.instructionIndex != null) {
      const ins = instructions[info.instructionIndex];
      if (ins) parts.push(ins.mnemonic);
      if (info.partIndex != null && ins && ins.parts && ins.parts[info.partIndex]) {
        const part = ins.parts[info.partIndex];
        parts.push(part.kind);
        if (part.text) parts.push(part.text);
      }
    }
    return parts.join(" · ");
  }

  function displayParts(ins) {
    return (ins.parts || []).filter(function (part) {
      return part.kind !== "opcode" && part.kind !== "aux";
    });
  }

  function renderAssembly() {
    const html = [];
    for (let i = 0; i < instructions.length; i += 1) {
      const ins = instructions[i];
      if (labels[ins.codeOffset]) {
        html.push('<div class="label">' + escapeHtml(labels[ins.codeOffset]) + ':</div>');
      }
      html.push(
        '<div class="instruction" data-index="' + ins.index +
        '" data-code-offset="' + ins.codeOffset +
        '" data-file-offset="' + ins.fileOffset + '">' +
        '<span class="address">' + padHex(ins.codeOffset, 8) + '</span>' +
        '<span class="mnemonic">' + escapeHtml(ins.mnemonic) + '</span>'
      );
      const parts = ins.parts || [];
      for (let p = 0; p < parts.length; p += 1) {
        const part = parts[p];
        if (part.kind === "opcode" || part.kind === "aux") continue;
        html.push(
          '<span class="operand kind-' + part.kind + '" data-part-index="' + p +
          '" title="' + escapeHtml(part.kind + (part.text ? ": " + part.text : "")) + '">' +
          escapeHtml(part.text || "") + "</span>"
        );
      }
      html.push("</div>");
    }
    assemblyEl.innerHTML = html.join("") || '<div class="muted" style="padding:12px">No instructions.</div>';
  }

  function renderBytecode() {
    const html = [];
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
      const hex = [];
      const ascii = [];
      const rowEnd = Math.min(offset + BYTES_PER_ROW, bytes.length);
      for (let i = offset; i < rowEnd; i += 1) {
        const info = byteInfo[i] || {};
        const kind = info.kind || "unknown";
        const title = byteTitle(i, info);
        hex.push(
          '<span class="byte kind-' + kind + '" data-offset="' + i +
          '" title="' + escapeHtml(title) + '">' + padHex(bytes[i], 2) + "</span>"
        );
        ascii.push(
          '<span class="ascii-byte kind-' + kind + '" data-offset="' + i + '">' +
          escapeHtml(asciiChar(bytes[i])) + "</span>"
        );
      }
      html.push(
        '<div class="hex-row">' +
        '<span class="address">' + padHex(offset, 8) + "</span>" +
        '<span class="hex-bytes">' + hex.join("") + "</span>" +
        '<span class="ascii">|' + ascii.join("") + "|</span>" +
        "</div>"
      );
    }
    bytecodeEl.innerHTML = html.join("");
  }

  function clearHighlights() {
    const selected = document.querySelectorAll(".selected, .in-range, .selected-field");
    for (let i = 0; i < selected.length; i += 1) {
      selected[i].classList.remove("selected", "in-range", "selected-field");
    }
  }

  function highlightRange(start, length, strong) {
    for (let offset = start; offset < start + length; offset += 1) {
      const nodes = document.querySelectorAll('[data-offset="' + offset + '"]');
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].classList.add(strong ? "selected-field" : "in-range");
      }
    }
  }

  function applySelection() {
    clearHighlights();
    if (selectedHeader) {
      const header = inspection.header || {};
      highlightRange(0, header.size || 0, false);
      if (selectedHeaderPartIndex != null && headerParts[selectedHeaderPartIndex]) {
        const part = headerParts[selectedHeaderPartIndex];
        highlightRange(part.fileOffset, part.length, true);
      }
      updateDetails();
      return;
    }
    if (selectedInstructionIndex == null) {
      updateDetails();
      return;
    }
    const ins = instructions[selectedInstructionIndex];
    if (!ins) {
      updateDetails();
      return;
    }
    const row = assemblyEl.querySelector('.instruction[data-index="' + ins.index + '"]');
    if (row) row.classList.add("selected");
    highlightRange(ins.fileOffset, ins.size, false);
    if (selectedPartIndex != null && ins.parts && ins.parts[selectedPartIndex]) {
      const part = ins.parts[selectedPartIndex];
      highlightRange(part.fileOffset, part.length, true);
      const operand = row && row.querySelector('[data-part-index="' + selectedPartIndex + '"]');
      if (operand) operand.classList.add("selected-field");
    }
    updateDetails();
  }

  function scrollBytesIntoView() {
    const target = bytecodeEl.querySelector(".selected-field, .in-range");
    if (target && target.scrollIntoView) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function scrollInstructionIntoView() {
    const row = assemblyEl.querySelector(".instruction.selected");
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }

  function detailRow(label, value) {
    return "<dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(String(value)) + "</dd>";
  }

  function updateDetails() {
    if (selectedHeader) {
      const header = inspection.header || {};
      const part = selectedHeaderPartIndex != null ? headerParts[selectedHeaderPartIndex] : undefined;
      let rows = detailRow("Present", header.present ? "yes" : "no") +
        detailRow("Size", String(header.size || 0) + " bytes");
      if (header.version) rows += detailRow("Version", header.version);
      if (header.fileSize != null) rows += detailRow("Declared file size", header.fileSize + " (0x" + padHex(header.fileSize, 8) + ")");
      if (part) {
        rows += detailRow("Field", part.text || part.kind);
        rows += detailRow("File offset", "0x" + padHex(part.fileOffset, 8));
        rows += detailRow("Length", part.length + " bytes");
        if (part.value != null) rows += detailRow("Value", part.value);
      }
      detailsEl.innerHTML = "<h2>NCS Header</h2><dl>" + rows + "</dl>";
      return;
    }
    if (selectedInstructionIndex == null) {
      detailsEl.innerHTML = '<div class="muted">Select an instruction or byte.</div>';
      return;
    }
    const ins = instructions[selectedInstructionIndex];
    let rows = detailRow("Code offset", "0x" + padHex(ins.codeOffset, 8)) +
      detailRow("File offset", "0x" + padHex(ins.fileOffset, 8)) +
      detailRow("Size", ins.size + " bytes") +
      detailRow("Opcode", "0x" + padHex(ins.opcode, 2)) +
      detailRow("Aux", "0x" + padHex(ins.aux, 2));
    if (ins.actionId != null) rows += detailRow("Action ID", "0x" + padHex(ins.actionId, 4));
    if (ins.actionName) rows += detailRow("Action", ins.actionName);
    if (ins.jumpTarget != null) {
      const addressPart = (ins.parts || []).find(function (part) { return part.kind === "address"; });
      if (addressPart && typeof addressPart.value === "number") {
        const rel = addressPart.value;
        rows += detailRow("Relative offset", (rel < 0 ? "-" : "+") + "0x" + padHex(Math.abs(rel), 8));
      }
      rows += detailRow("Target", labels[ins.jumpTarget] || ("0x" + padHex(ins.jumpTarget, 8)));
    }
    const parts = displayParts(ins);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const label = part.kind;
      const value = part.text != null && part.text !== "" ? part.text : (part.value != null ? part.value : "");
      rows += detailRow(label, value);
    }
    detailsEl.innerHTML = "<h2>" + escapeHtml(ins.mnemonic) + "</h2><dl>" + rows + "</dl>";
  }

  function selectInstruction(index, partIndex, scrollAsm) {
    selectedHeader = false;
    selectedHeaderPartIndex = undefined;
    selectedInstructionIndex = index;
    selectedPartIndex = partIndex;
    applySelection();
    scrollBytesIntoView();
    if (scrollAsm) scrollInstructionIntoView();
  }

  function selectHeader(partIndex) {
    selectedHeader = true;
    selectedHeaderPartIndex = partIndex;
    selectedInstructionIndex = undefined;
    selectedPartIndex = undefined;
    applySelection();
    const target = bytecodeEl.querySelector('[data-offset="0"]');
    if (target && target.scrollIntoView) target.scrollIntoView({ block: "nearest" });
  }

  function lookupOffset(offset) {
    return byteInfo[offset];
  }

  assemblyEl.addEventListener("click", function (event) {
    const operand = event.target.closest("[data-part-index]");
    const instruction = event.target.closest(".instruction");
    if (!instruction) return;
    const index = Number(instruction.getAttribute("data-index"));
    const partIndex = operand ? Number(operand.getAttribute("data-part-index")) : undefined;
    selectInstruction(index, partIndex, false);
  });

  bytecodeEl.addEventListener("click", function (event) {
    const byte = event.target.closest("[data-offset]");
    if (!byte) return;
    const offset = Number(byte.getAttribute("data-offset"));
    const info = lookupOffset(offset);
    if (!info) return;
    if (info.header) {
      selectHeader(info.headerPartIndex);
      return;
    }
    selectInstruction(info.instructionIndex, info.partIndex, true);
  });

  function setLayout(next) {
    layout = next;
    document.body.classList.remove("layout-split", "layout-assembly", "layout-bytecode");
    document.body.classList.add("layout-" + layout);
    const buttons = document.querySelectorAll(".modes button");
    for (let i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle("active", buttons[i].getAttribute("data-layout") === layout);
    }
    persist();
  }

  const modeButtons = document.querySelectorAll(".modes button");
  for (let i = 0; i < modeButtons.length; i += 1) {
    modeButtons[i].addEventListener("click", function () {
      setLayout(modeButtons[i].getAttribute("data-layout"));
    });
  }

  document.getElementById("toggle-details").addEventListener("click", function () {
    detailsCollapsed = !detailsCollapsed;
    document.body.classList.toggle("details-collapsed", detailsCollapsed);
    persist();
  });

  function applySplit() {
    document.body.style.setProperty("--split-ratio", Math.round(splitRatio * 100) + "%");
  }

  dividerEl.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    const startX = event.clientX;
    const startRatio = splitRatio;
    const width = workspaceEl.getBoundingClientRect().width;
    function onMove(moveEvent) {
      const delta = (moveEvent.clientX - startX) / width;
      splitRatio = Math.min(0.8, Math.max(0.2, startRatio + delta));
      applySplit();
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persist();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  renderAssembly();
  renderBytecode();
  setLayout(layout);
  applySplit();
  document.body.classList.toggle("details-collapsed", detailsCollapsed);
  updateDetails();
})();
`;

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    output += i + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return output;
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
