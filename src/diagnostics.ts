import * as vscode from "vscode";
import { ResourceResolver, type UnresolvedInclude } from "./resourceResolver";
import { basenameWithoutExtension, normalizeResRef } from "./uri";

export const DIAGNOSTIC_SOURCE = "NWScript Workbench";

export class CompilerDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("nwscript");

  constructor(private readonly resolver: ResourceResolver) {}

  dispose(): void {
    this.collection.dispose();
  }

  clear(): void {
    this.collection.clear();
  }

  clearUri(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  setFor(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
    this.collection.set(uri, diagnostics);
  }

  async applyCompileFailure(
    sourceUri: vscode.Uri,
    error: string,
    unresolved: UnresolvedInclude[] = [],
  ): Promise<void> {
    const grouped = await this.parseCompilerError(sourceUri, error);
    for (const missing of unresolved) {
      const diagnostic = createDiagnostic(
        missing.line - 1,
        `Missing include ${missing.resource}`,
        "missing-include",
      );
      const key = missing.from.toString();
      const entry = grouped.get(key);
      if (entry) {
        entry.diagnostics.push(diagnostic);
      } else {
        grouped.set(key, { uri: missing.from, diagnostics: [diagnostic] });
      }
    }

    this.setFor(sourceUri, grouped.get(sourceUri.toString())?.diagnostics ?? []);
    for (const { uri, diagnostics } of grouped.values()) {
      if (uri.toString() !== sourceUri.toString()) {
        this.setFor(uri, diagnostics);
      }
    }
  }

  async applyCompileSuccess(sourceUri: vscode.Uri): Promise<void> {
    this.clearUri(sourceUri);
  }

  private async parseCompilerError(
    sourceUri: vscode.Uri,
    error: string,
  ): Promise<Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>> {
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

      const diagnostic = createDiagnostic(
        Math.max(Number.parseInt(lineText, 10) - 1, 0),
        message.trim() || text,
        "compile",
      );
      pushGrouped(grouped, uri, diagnostic);
    }

    if (grouped.size === 0 && error.trim()) {
      pushGrouped(
        grouped,
        sourceUri,
        createDiagnostic(0, error.trim(), "compile"),
      );
    }

    return grouped;
  }
}

function createDiagnostic(
  line: number,
  message: string,
  code: string,
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(Math.max(line, 0), 0, Math.max(line, 0), Number.MAX_SAFE_INTEGER),
    message,
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = code;
  return diagnostic;
}

function pushGrouped(
  grouped: Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>,
  uri: vscode.Uri,
  diagnostic: vscode.Diagnostic,
): void {
  const key = uri.toString();
  const entry = grouped.get(key);
  if (entry) {
    entry.diagnostics.push(diagnostic);
  } else {
    grouped.set(key, { uri, diagnostics: [diagnostic] });
  }
}
