import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { CompilerLog } from "./compilerLog";
import { getSettings } from "./config";
import { CompilerDiagnostics } from "./diagnostics";
import { ResourceResolver } from "./resourceResolver";
import { NWScriptStatusBar } from "./statusBar";
import { openNcsCompare } from "./ncsCompare";
import { NcsEditorProvider } from "./ncsEditor";
import { NWScriptHomePanel } from "./homePanel";
import { EngineApiService } from "./engineApi";
import { registerLanguageFeatures } from "./languageFeatures";
import { ScriptBrowser } from "./scriptBrowser";
import { LanguageDefinitionBrowser } from "./languageDefinitionBrowser";
import { registerSidebar } from "./sidebar";

export function activate(context: vscode.ExtensionContext): void {
  const resolver = new ResourceResolver();
  const diagnostics = new CompilerDiagnostics(resolver);
  const compilerLog = new CompilerLog();
  const compiler = new CompilerService(context, resolver, diagnostics, compilerLog);
  const engineApi = new EngineApiService(compiler);
  const statusBar = new NWScriptStatusBar();
  const ncsEditor = new NcsEditorProvider(compiler, engineApi);
  const scriptBrowser = new ScriptBrowser();
  let home: NWScriptHomePanel;

  const refreshCompiler = (): void => {
    compiler.invalidateCompiler();
    engineApi.invalidate();
    resolver.invalidate();
    const scope = vscode.window.activeTextEditor?.document.uri;
    statusBar.update(scope);
    void home?.refresh(scope);
  };

  home = new NWScriptHomePanel(context, compiler, refreshCompiler);

  const languageDefinitionBrowser = new LanguageDefinitionBrowser(compiler);

  context.subscriptions.push(
    resolver,
    diagnostics,
    compilerLog,
    compiler,
    engineApi,
    statusBar,
    ncsEditor,
    scriptBrowser,
    languageDefinitionBrowser,
    home,
    registerSidebar(context, async () => {
      if (!hasWorkspaceFolder()) {
        return;
      }
      await home.open(vscode.window.activeTextEditor?.document.uri);
    }),
  );

  registerLanguageFeatures(context, engineApi, resolver);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nwscript.openHome",
      async () => {
        try {
          await home.open(vscode.window.activeTextEditor?.document.uri);
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.openScriptBrowser",
      async () => {
        try {
          await scriptBrowser.open();
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.openLanguageDefinitionBrowser",
      async () => {
        try {
          await languageDefinitionBrowser.open();
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.compileCurrentFile",
      async (resource?: vscode.Uri) => {
        try {
          let uri = resource ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri?.path.toLowerCase().endsWith(".nss")) {
            const selected = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { "NWScript source": ["nss"] },
              title: "Select an NSS file to compile",
              openLabel: "Compile",
            });
            uri = selected?.[0];
          }
          if (!uri) {
            return;
          }
          await compiler.compileUri(uri);
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand("nwscript.showCompilerLog", () => {
      compilerLog.show(false);
    }),

    vscode.commands.registerCommand(
      "nwscript.disassembleNcs",
      async (resource?: vscode.Uri) => {
        try {
          let uri = ncsUriFromCommand(resource);
          if (!uri) {
            const selected = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { "NWScript bytecode": ["ncs"] },
              title: "Select an NCS file to open as text disassembly",
            });
            uri = selected?.[0];
          }
          if (!uri) {
            return;
          }
          await ncsEditor.openDisassemblyPreview(uri);
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.saveNcsDisassembly",
      async (resource?: vscode.Uri) => {
        try {
          let uri = ncsUriFromCommand(resource);
          if (!uri) {
            const selected = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { "NWScript bytecode": ["ncs"] },
              title: "Select an NCS file to save as disassembly",
            });
            uri = selected?.[0];
          }
          if (!uri) {
            return;
          }
          await ncsEditor.saveDisassembly(uri);
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.compareNcs",
      async (resource?: vscode.Uri) => {
        try {
          await openNcsCompare(compiler, ncsEditor, ncsUriFromCommand(resource));
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.openNcsForSource",
      async (resource?: vscode.Uri) => {
        try {
          const editor = vscode.window.activeTextEditor;
          const uri = resource
            ?? (editor?.document.languageId === "nwscript" ? editor.document.uri : undefined);
          if (!uri?.path.toLowerCase().endsWith(".nss")) {
            throw new Error("Open an NSS file to jump to its sibling NCS.");
          }
          const wordRange = editor?.document.uri.toString() === uri.toString()
            ? editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_]\w*/)
            : undefined;
          const name = wordRange ? editor?.document.getText(wordRange) : undefined;
          await ncsEditor.openNcsForSource(uri, name);
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.languageId !== "nwscript" || !getSettings(document.uri).compileOnSave) {
        return;
      }
      try {
        await compiler.compileDocument(document, false);
      } catch (error) {
        showError(error);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nwscript")) {
        refreshCompiler();
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      statusBar.update(editor?.document.uri);
      void home.refresh(editor?.document.uri);
    }),
  );

  void showHomeOnFirstRun(context, home);
}

function hasWorkspaceFolder(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

function whenWorkspaceReady(context: vscode.ExtensionContext): Promise<void> {
  if (hasWorkspaceFolder()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!hasWorkspaceFolder()) {
        return;
      }
      subscription.dispose();
      resolve();
    });
    context.subscriptions.push(subscription);
  });
}

async function showHomeOnFirstRun(
  context: vscode.ExtensionContext,
  home: NWScriptHomePanel,
): Promise<void> {
  const key = "nwscript.home.hasShownWelcome";
  if (context.globalState.get<boolean>(key, false)) {
    return;
  }

  if (!getSettings().autoOpenHome) {
    await context.globalState.update(key, true);
    return;
  }

  await whenWorkspaceReady(context);

  if (context.globalState.get<boolean>(key, false) || !getSettings().autoOpenHome) {
    return;
  }

  await context.globalState.update(key, true);
  await home.open(vscode.window.activeTextEditor?.document.uri);
}

export function deactivate(): void {
  // VS Code disposes ExtensionContext subscriptions automatically.
}

function ncsUriFromCommand(resource?: vscode.Uri): vscode.Uri | undefined {
  if (resource?.path.toLowerCase().endsWith(".ncs")) {
    return resource;
  }

  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input && typeof input === "object" && "uri" in input) {
    const uri = (input as { uri?: vscode.Uri }).uri;
    if (uri?.path.toLowerCase().endsWith(".ncs")) {
      return uri;
    }
  }

  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri?.path.toLowerCase().endsWith(".ncs")) {
    return editorUri;
  }

  return undefined;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`NWScript Workbench: ${message}`);
}
