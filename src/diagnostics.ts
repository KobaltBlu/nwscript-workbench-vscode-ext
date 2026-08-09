import * as vscode from "vscode";
import { ResourceResolver } from "./resourceResolver";
import { basenameWithoutExtension, normalizeResRef } from "./uri";

export class CompilerDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("nwscript");
  private lastUris: vscode.Uri[] = [];

  constructor(private readonly resolver: ResourceResolver) {}

  dispose(): void {
    this.collection.dispose();
  }

  clear(): void {
    for (const uri of this.lastUris) {
      this.collection.delete(uri);
    }
    this.lastUris = [];
  }

  async setCompilerError(sourceUri: vscode.Uri, error: string): Promise<void> {
    this.clear();

    const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    const lines = error.split(/\r?\n/).filter(Boolean);

    for (const text of lines) {
      const match = text.match(/^(.+?)\.nss\((\d+)\):\s*(?:ERROR:\s*)?(.*)$/i);
      if (!match) {
        continue;
      }

      const [, fileName, lineText, message] = match;
      const resRef = normalizeResRef(fileName);
      let uri = sourceUri;
      if (resRef !== normalizeResRef(basenameWithoutExtension(sourceUri))) {
        uri = (await this.resolver.resolveKnownResRef(resRef)) ?? sourceUri;
      }

      const line = Math.max(Number.parseInt(lineText, 10) - 1, 0);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        message.trim() || text,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = "NWScript";
      diagnostic.code = "compile";

      const key = uri.toString();
      const entry = grouped.get(key);
      if (entry) {
        entry.diagnostics.push(diagnostic);
      } else {
        grouped.set(key, { uri, diagnostics: [diagnostic] });
      }
    }

    if (grouped.size === 0 && error.trim()) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER),
        error.trim(),
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = "NWScript";
      grouped.set(sourceUri.toString(), { uri: sourceUri, diagnostics: [diagnostic] });
    }

    this.lastUris = [...grouped.values()].map((value) => value.uri);
    for (const { uri, diagnostics } of grouped.values()) {
      this.collection.set(uri, diagnostics);
    }
  }
}
