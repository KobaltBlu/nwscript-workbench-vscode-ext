import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { IncludeGraph } from "./includeGraph";
import { isEntryScriptSource, isLanguageSpecFile } from "./nss";

export async function compileEntryScripts(
  compiler: CompilerService,
  root?: vscode.Uri,
): Promise<void> {
  const entries = await compiler.findEntryScripts(root);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage("No NWScript entry scripts (main / StartingConditional) were found.");
    return;
  }

  compiler.beginBatch();
  let ok = 0;
  let failed = 0;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Compiling NWScript",
        cancellable: true,
      },
      async (progress, token) => {
        for (let i = 0; i < entries.length; i += 1) {
          if (token.isCancellationRequested) {
            break;
          }
          const uri = entries[i];
          progress.report({
            message: `${i + 1}/${entries.length} ${uri.path.split("/").pop()}`,
            increment: i === 0 ? 0 : 100 / entries.length,
          });
          try {
            const result = await compiler.compileUri(uri, { announce: false });
            if (result.ok) ok += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        }
      },
    );
  } finally {
    compiler.endBatch();
  }

  const cancelled = failed + ok < entries.length;
  const suffix = cancelled ? " (cancelled)" : "";
  void vscode.window.showInformationMessage(
    `Compiled ${ok} script${ok === 1 ? "" : "s"}, ${failed} failed${suffix}.`,
  );
}

export async function compileDirtyDependents(
  compiler: CompilerService,
  graph: IncludeGraph,
  document: vscode.TextDocument,
): Promise<void> {
  if (document.languageId !== "nwscript" || isLanguageSpecFile(document.uri)) {
    return;
  }
  if (isEntryScriptSource(document.getText())) {
    return;
  }

  graph.invalidate();
  const dependents = await graph.dependentsOf(document.uri);
  if (dependents.length === 0) {
    return;
  }

  compiler.beginBatch();
  try {
    for (const uri of dependents) {
      try {
        await compiler.compileUri(uri, { announce: false });
      } catch {
        // Diagnostics already recorded.
      }
    }
  } finally {
    compiler.endBatch();
  }
}
