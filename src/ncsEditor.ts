import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { basename, basenameWithoutExtension } from "./uri";

export const NCS_HEX_VIEW_TYPE = "nwscript.ncsHex";
const DISASSEMBLY_SCHEME = "nwscript-disassembly";
const BYTES_PER_ROW = 16;

class NcsDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    // The document is readonly and owns no persistent resources.
  }
}

class DisassemblyContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.changeEmitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.changeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "; Disassembly is not available.\n";
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.contents.clear();
  }
}

export class NcsEditorProvider
  implements vscode.CustomReadonlyEditorProvider<NcsDocument>, vscode.Disposable {
  private readonly disassemblyProvider = new DisassemblyContentProvider();
  private readonly registrations: vscode.Disposable[] = [];

  constructor(private readonly compiler: CompilerService) {
    this.registrations.push(
      vscode.workspace.registerTextDocumentContentProvider(
        DISASSEMBLY_SCHEME,
        this.disassemblyProvider,
      ),
      vscode.window.registerCustomEditorProvider(
        NCS_HEX_VIEW_TYPE,
        this,
        {
          supportsMultipleEditorsPerDocument: true,
          webviewOptions: {
            retainContextWhenHidden: false,
          },
        },
      ),
    );
  }

  dispose(): void {
    for (const registration of this.registrations) {
      registration.dispose();
    }
    this.disassemblyProvider.dispose();
  }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): NcsDocument {
    return new NcsDocument(uri);
  }

  async resolveCustomEditor(
    document: NcsDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: false,
    };

    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      if (token.isCancellationRequested) {
        return;
      }

      webviewPanel.webview.html = renderHexView(
        webviewPanel.webview,
        document.uri,
        bytes,
      );
    } catch (error) {
      webviewPanel.webview.html = renderHexError(
        webviewPanel.webview,
        document.uri,
        error,
      );
      return;
    }

    // The NCS remains the focused/main editor. The assembly opens beside it as
    // a preview tab without stealing focus.
    void this.openDisassemblyPreview(document.uri, true);
  }

  async openDisassemblyPreview(
    source: vscode.Uri,
    preserveFocus = false,
  ): Promise<void> {
    const previewUri = disassemblyUri(source);
    let content: string;

    try {
      content = await this.compiler.disassembleText(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      content = [
        "; NWScript NCS disassembly could not be generated.",
        `; Source: ${source.toString(true)}`,
        `; ${message.replace(/\r?\n/g, "\n; ")}`,
        "",
      ].join("\n");
    }

    this.disassemblyProvider.set(previewUri, content);

    const document = await vscode.workspace.openTextDocument(previewUri);
    if (document.languageId !== "nwscript-asm") {
      await vscode.languages.setTextDocumentLanguage(document, "nwscript-asm");
    }

    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus,
    });
  }
}

function disassemblyUri(source: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({
    scheme: DISASSEMBLY_SCHEME,
    path: `${source.path.slice(0, source.path.length - 4)}.ncsasm`,
    query: `source=${encodeURIComponent(source.toString(true))}`,
  });
}

function renderHexView(
  webview: vscode.Webview,
  uri: vscode.Uri,
  bytes: Uint8Array,
): string {
  const lines: string[] = [];

  for (let offset = 0; offset < bytes.byteLength; offset += BYTES_PER_ROW) {
    const row = bytes.subarray(offset, Math.min(offset + BYTES_PER_ROW, bytes.byteLength));
    const hex = Array.from(row, (value) => value.toString(16).padStart(2, "0").toUpperCase())
      .join(" ")
      .padEnd(BYTES_PER_ROW * 3 - 1, " ");
    const ascii = Array.from(row, (value) =>
      value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".",
    ).join("");

    lines.push(
      `<span class="offset">${offset.toString(16).padStart(8, "0").toUpperCase()}</span>  ` +
      `<span class="hex">${escapeHtml(hex)}</span>  ` +
      `<span class="ascii">|${escapeHtml(ascii.padEnd(BYTES_PER_ROW, " "))}|</span>`,
    );
  }

  const title = escapeHtml(basename(uri));
  const stem = escapeHtml(basenameWithoutExtension(uri));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: baseline;
      gap: 1rem;
      padding: 8px 14px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editor-background);
    }
    header strong { font-weight: 600; }
    header span { color: var(--vscode-descriptionForeground); }
    pre {
      box-sizing: border-box;
      margin: 0;
      padding: 12px 14px 32px;
      min-width: max-content;
      line-height: 1.45;
      tab-size: 4;
    }
    .offset { color: var(--vscode-editorLineNumber-foreground); }
    .hex { color: var(--vscode-editor-foreground); }
    .ascii { color: var(--vscode-symbolIcon-stringForeground, var(--vscode-editor-foreground)); }
  </style>
</head>
<body>
  <header>
    <strong>${stem}.ncs</strong>
    <span>${bytes.byteLength.toLocaleString()} bytes</span>
  </header>
  <pre>${lines.join("\n")}</pre>
</body>
</html>`;
}

function renderHexError(
  webview: vscode.Webview,
  uri: vscode.Uri,
  error: unknown,
): string {
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(basename(uri))}</title>
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
  <strong>Unable to read ${escapeHtml(basename(uri))}</strong>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
