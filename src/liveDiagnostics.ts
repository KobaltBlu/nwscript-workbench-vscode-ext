import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { getSettings } from "./config";
import { isEntryScriptSource, isLanguageSpecFile } from "./nss";
import { NWScriptStatusBar } from "./statusBar";

const DEBOUNCE_MS = 500;

export class LiveDiagnostics implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private readonly disposable: vscode.Disposable;

  constructor(
    private readonly compiler: CompilerService,
    private readonly statusBar: NWScriptStatusBar,
  ) {
    this.disposable = vscode.workspace.onDidChangeTextDocument((event) => {
      void this.schedule(event.document);
    });
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.disposable.dispose();
  }

  private schedule(document: vscode.TextDocument): void {
    if (document.languageId !== "nwscript" || !document.uri.path.toLowerCase().endsWith(".nss")) {
      return;
    }
    if (isLanguageSpecFile(document.uri) || !isEntryScriptSource(document.getText())) {
      return;
    }
    if (!getSettings(document.uri).liveDiagnostics) {
      return;
    }
    if (this.compiler.isBatchRunning) {
      return;
    }

    const generation = ++this.generation;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.run(document, generation);
    }, DEBOUNCE_MS);
  }

  private async run(document: vscode.TextDocument, generation: number): Promise<void> {
    if (generation !== this.generation || this.compiler.isBatchRunning) {
      return;
    }
    if (document.isClosed) {
      return;
    }

    this.statusBar.setBusy(true);
    try {
      await this.compiler.compileDocument(document, {
        writeOutputs: false,
        announce: false,
        generateDebug: false,
        diagnosticOwner: "live",
      });
    } catch {
      // Live compile failures are already diagnostics; do not toast.
    } finally {
      if (generation === this.generation) {
        this.statusBar.setBusy(false);
      }
    }
  }
}
