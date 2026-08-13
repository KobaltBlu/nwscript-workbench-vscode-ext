import type { NcsInspection } from "@neverwinter/nwscript-wasm";
import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { renderNcsError, renderNcsInspector } from "./ncsInspectorView";
import { basename, basenameWithoutExtension } from "./uri";

export const NCS_HEX_VIEW_TYPE = "nwscript.ncsHex";
const DISASSEMBLY_SCHEME = "nwscript-disassembly";

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
            retainContextWhenHidden: true,
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
      enableScripts: true,
    };

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(document.uri);
    } catch (error) {
      webviewPanel.webview.html = renderNcsError(
        webviewPanel.webview,
        basename(document.uri),
        error,
      );
      return;
    }

    if (token.isCancellationRequested) {
      return;
    }

    let inspection: NcsInspection = {
      header: { present: false, size: 0, parts: [] },
      instructions: [],
    };
    let inspectError: string | undefined;
    try {
      inspection = await this.compiler.inspectNcs(document.uri);
    } catch (error) {
      inspectError = error instanceof Error ? error.message : String(error);
    }

    if (token.isCancellationRequested) {
      return;
    }

    webviewPanel.webview.html = renderNcsInspector(webviewPanel.webview, {
      filename: `${basenameWithoutExtension(document.uri)}.ncs`,
      bytes,
      inspection,
      inspectError,
    });
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
