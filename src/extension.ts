import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { getSettings } from "./config";
import { CompilerDiagnostics } from "./diagnostics";
import { ResourceResolver } from "./resourceResolver";
import { NWScriptStatusBar } from "./statusBar";
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
  const compiler = new CompilerService(context, resolver, diagnostics);
  const engineApi = new EngineApiService(compiler);
  const statusBar = new NWScriptStatusBar();
  const ncsEditor = new NcsEditorProvider(compiler);
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

  const languageDefinitionBrowser = new LanguageDefinitionBrowser();

  context.subscriptions.push(
    resolver,
    diagnostics,
    compiler,
    engineApi,
    statusBar,
    ncsEditor,
    scriptBrowser,
    languageDefinitionBrowser,
    home,
    registerSidebar(context, async () => {
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

    vscode.commands.registerCommand(
      "nwscript.disassembleNcs",
      async (resource?: vscode.Uri) => {
        try {
          let uri = resource;
          if (!uri) {
            const selected = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { "NWScript bytecode": ["ncs"] },
              title: "Select an NCS file to disassemble",
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

async function showHomeOnFirstRun(
  context: vscode.ExtensionContext,
  home: NWScriptHomePanel,
): Promise<void> {
  const key = "nwscript.home.hasShownWelcome";
  if (context.globalState.get<boolean>(key, false)) {
    return;
  }

  await context.globalState.update(key, true);
  if (!getSettings().autoOpenHome) {
    return;
  }
  await home.open(vscode.window.activeTextEditor?.document.uri);
}

export function deactivate(): void {
  // VS Code disposes ExtensionContext subscriptions automatically.
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`NWScript Workbench: ${message}`);
}
