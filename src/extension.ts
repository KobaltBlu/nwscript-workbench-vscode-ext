import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { getSettings } from "./config";
import { CompilerDiagnostics } from "./diagnostics";
import { ResourceResolver } from "./resourceResolver";
import { NWScriptStatusBar } from "./statusBar";
import { NcsEditorProvider } from "./ncsEditor";
import { NWScriptHomePanel } from "./homePanel";
import { basename, toWorkspacePathOrUri } from "./uri";
import { EngineApiService } from "./engineApi";
import { registerLanguageFeatures } from "./languageFeatures";

interface CompilerTargetItem extends vscode.QuickPickItem {
  kindValue: "byo" | "detected" | "embedded";
  target?: string;
  uri?: vscode.Uri;
}

export function activate(context: vscode.ExtensionContext): void {
  const resolver = new ResourceResolver();
  const diagnostics = new CompilerDiagnostics(resolver);
  const compiler = new CompilerService(context, resolver, diagnostics);
  const engineApi = new EngineApiService(compiler);
  const statusBar = new NWScriptStatusBar();
  const ncsEditor = new NcsEditorProvider(compiler);
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

  context.subscriptions.push(
    resolver,
    diagnostics,
    compiler,
    engineApi,
    statusBar,
    ncsEditor,
    home,
  );

  registerLanguageFeatures(context, engineApi, resolver);

  const selectLanguageSpec = async (scope?: vscode.Uri): Promise<boolean> => {
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "NWScript language specification": ["nss"] },
      title: "Select nwscript.nss",
      openLabel: "Use as NWScript Language Specification",
    });

    const uri = selected?.[0];
    if (!uri) {
      return false;
    }

    const config = vscode.workspace.getConfiguration("nwscript", scope);
    const target = configurationTarget(scope);

    await config.update(
      "languageSpec",
      toWorkspacePathOrUri(uri, scope),
      target,
    );
    await config.update("gameTarget", "", target);

    refreshCompiler();
    void vscode.window.showInformationMessage(
      `NWScript Workbench: using ${basename(uri)} as the language specification.`,
    );
    return true;
  };

  const selectCompilerTarget = async (scope?: vscode.Uri): Promise<void> => {
    const settings = getSettings(scope);
    const [targets, detectedSpecs] = await Promise.all([
      compiler.getEmbeddedTargets(),
      compiler.findProjectLanguageSpecs(scope),
    ]);

    const items: CompilerTargetItem[] = [
      ...detectedSpecs.map((uri) => ({
        label: `$(search) Auto-detected: ${basename(uri)}`,
        description: toWorkspacePathOrUri(uri, scope),
        detail:
          "Project nwscript.nss discovered automatically. Selecting it pins this specification in folder settings.",
        kindValue: "detected" as const,
        uri,
      })),
      {
        label: "$(file-code) NWScript.nss: Choose nwscript.nss...",
        description: settings.languageSpec
          ? `Current: ${settings.languageSpec}`
          : "Choose a language specification manually",
        detail: "Works with desktop VS Code, vscode.dev, and virtual workspaces.",
        kindValue: "byo",
      },
      ...targets.map((target) => ({
        label: `$(package) ${target}`,
        description:
          !settings.languageSpec && target === settings.gameTarget
            ? "Current embedded target"
            : "Embedded target",
        kindValue: "embedded" as const,
        target,
      })),
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: "NWScript Workbench: Select Compiler Target",
      placeHolder:
        detectedSpecs.length > 0
          ? "Choose a detected project spec, NWScript.nss, or an embedded target"
          : targets.length > 0
            ? "Choose NWScript.nss or an embedded language specification"
            : "No project spec was detected; choose your nwscript.nss",
    });

    if (!selected) {
      return;
    }

    if (selected.kindValue === "byo") {
      await selectLanguageSpec(scope);
      return;
    }

    if (selected.kindValue === "detected" && selected.uri) {
      const config = vscode.workspace.getConfiguration("nwscript", scope);
      const target = configurationTarget(scope);
      await config.update(
        "languageSpec",
        toWorkspacePathOrUri(selected.uri, scope),
        target,
      );
      await config.update("gameTarget", "", target);
      refreshCompiler();
      return;
    }

    const config = vscode.workspace.getConfiguration("nwscript", scope);
    const target = configurationTarget(scope);
    await config.update("gameTarget", selected.target ?? "", target);
    await config.update("languageSpec", "", target);
    refreshCompiler();
  };

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
      "nwscript.selectCompilerTarget",
      async (resource?: vscode.Uri) => {
        try {
          await selectCompilerTarget(
            resource ?? vscode.window.activeTextEditor?.document.uri,
          );
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.selectLanguageSpec",
      async (resource?: vscode.Uri) => {
        try {
          await selectLanguageSpec(
            resource ?? vscode.window.activeTextEditor?.document.uri,
          );
        } catch (error) {
          showError(error);
        }
      },
    ),

    // Backwards-compatible alias from the initial extension prototype.
    vscode.commands.registerCommand(
      "nwscript.selectGameTarget",
      async (resource?: vscode.Uri) => {
        try {
          await selectCompilerTarget(
            resource ?? vscode.window.activeTextEditor?.document.uri,
          );
        } catch (error) {
          showError(error);
        }
      },
    ),

    vscode.commands.registerCommand(
      "nwscript.showEmbeddedTargets",
      async () => {
        try {
          const targets = await compiler.getEmbeddedTargets();
          void vscode.window.showInformationMessage(
            targets.length > 0
              ? `Embedded NWScript targets: ${targets.join(", ")}`
              : "No embedded NWScript targets are present in this build. NWScript.nss is available.",
          );
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
  await home.open(vscode.window.activeTextEditor?.document.uri);
}

export function deactivate(): void {
  // VS Code disposes ExtensionContext subscriptions automatically.
}

function configurationTarget(scope?: vscode.Uri): vscode.ConfigurationTarget {
  return scope && vscode.workspace.getWorkspaceFolder(scope)
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`NWScript Workbench: ${message}`);
}
