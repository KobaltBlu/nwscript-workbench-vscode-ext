import type { NcsInspection, NdbInspection } from "@neverwinter/nwscript-wasm";
import type * as vscode from "vscode";
import type { ActionCompatStatus } from "./actionCompat";
import { INSPECTOR_SCRIPT } from "./ncsInspectorScript";

export interface NcsActionInfo {
  actionId: number;
  name: string;
  signature: string;
  documentation?: string;
}

export interface NcsInspectorRenderOptions {
  filename: string;
  bytes: Uint8Array;
  inspection: NcsInspection;
  inspectError?: string;
  actions?: NcsActionInfo[];
  compat?: Record<number, ActionCompatStatus>;
  ndb?: NdbInspection;
  revealCodeOffset?: number;
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
    actions: options.actions ?? [],
    compat: options.compat ?? {},
    ndb: options.ndb ?? null,
    revealCodeOffset: options.revealCodeOffset,
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
    #search {
      min-width: 160px;
      max-width: 240px;
      padding: 3px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
      border-radius: 2px;
      font: inherit;
    }
    .search-meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
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
    .pane-functions {
      flex: 0 0 180px;
      border-right: 1px solid var(--vscode-editorWidget-border);
      overflow: auto;
      display: none;
    }
    body.functions-open .pane-functions { display: block; }
    .fn-item {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: 0;
      border-radius: 0;
      padding: 4px 10px;
    }
    .fn-item:hover, .fn-item.active { background: var(--vscode-list-hoverBackground); }
    .instruction.search-hit { outline: 1px dashed var(--vscode-editorWarning-foreground, var(--vscode-focusBorder)); }
    .jump-target {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
    }
    .open-source { margin-top: 8px; }
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
    <input id="search" type="search" placeholder="Find mnemonic, offset, bytes…" aria-label="Search instructions">
    <span class="search-meta" id="search-meta"></span>
    <button type="button" id="toggle-functions">Functions</button>
    <strong id="filename"></strong>
    <span class="meta" id="file-meta"></span>
    <span class="spacer"></span>
    <button type="button" id="toggle-details">Details</button>
  </div>
  <div id="inspect-error" class="error" hidden></div>
  <div class="workspace" id="workspace">
    <div class="pane pane-functions" id="functions"></div>
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

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function toBase64(bytes: Uint8Array): string {
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
