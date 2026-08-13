import * as vscode from "vscode";
import { buildWorkspaceActionCompat } from "./actionCompat";
import { CompilerService, type LanguageSpecResolutionEntry, type LanguageSpecStatus } from "./compilerService";
import { getSettings, type NWScriptSettings, type OptimizationLevel } from "./config";
import { IncludeGraph, type IncludeGraphView } from "./includeGraph";
import { basename, toWorkspacePathOrUri, workspaceFolderFor } from "./uri";

const HOME_VIEW_TYPE = "nwscript.home";

interface HomeMessage {
  type: string;
  key?: string;
  uri?: string;
  value?: unknown;
}

export class NWScriptHomePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private scope?: vscode.Uri;
  private renderSerial = 0;
  private languageSpecRefreshTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly compiler: CompilerService,
    private readonly includeGraph: IncludeGraph,
    private readonly onConfigurationChanged: () => void,
  ) {
    this.registerLanguageSpecWatchers();
  }

  dispose(): void {
    if (this.languageSpecRefreshTimer !== undefined) {
      clearTimeout(this.languageSpecRefreshTimer);
      this.languageSpecRefreshTimer = undefined;
    }
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  async open(scope?: vscode.Uri): Promise<void> {
    this.scope = scope ?? this.scope ?? currentScope();

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      await this.refresh(this.scope);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      HOME_VIEW_TYPE,
      "NWScript Workbench",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "assets")],
      },
    );

    this.panel = panel;

    panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      this.disposables,
    );

    panel.webview.onDidReceiveMessage(
      (message: HomeMessage) => void this.handleMessage(message),
      undefined,
      this.disposables,
    );

    await this.refresh(this.scope);
  }

  async refresh(scope?: vscode.Uri): Promise<void> {
    if (!this.panel) {
      return;
    }

    this.scope = scope ?? this.scope ?? currentScope();
    const serial = ++this.renderSerial;
    const settings = getSettings(this.scope);

    const resolutionPreview = await buildResolutionPreview(this.compiler, this.scope);
    const specStatus = resolutionPreview.status;
    let actionCompatSummary = "";
    if (settings.actionCompat) {
      try {
        actionCompatSummary = (await buildWorkspaceActionCompat(this.compiler, this.scope)).summary;
      } catch {
        actionCompatSummary = "";
      }
    }

    let includeGraph: IncludeGraphView | undefined;
    if (settings.includeGraph && this.scope?.path.toLowerCase().endsWith(".nss")) {
      try {
        includeGraph = await this.includeGraph.viewFor(this.scope);
      } catch {
        includeGraph = undefined;
      }
    }

    if (!this.panel || serial !== this.renderSerial) {
      return;
    }

    const folder = workspaceFolderFor(this.scope);
    const logoUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "assets", "logo.png"),
    ).toString();

    this.panel.webview.html = renderWorkbenchHomeHtml({
      webview: this.panel.webview,
      logoUri,
      extensionVersion: String(this.context.extension.packageJSON.version ?? ""),
      workspaceName: folder?.name ?? "No workspace folder",
      specStatus,
      resolutionPreview,
      actionCompatSummary,
      includeGraph,
      settings,
      compileOnSave: settings.compileOnSave,
      liveDiagnostics: settings.liveDiagnostics,
      autoOpenHome: settings.autoOpenHome,
      optimizationLevel: settings.optimizationLevel,
      generateDebug: settings.generateDebug,
      includePaths: settings.includePaths,
      outputDirectory: settings.outputDirectory,
      maxIncludeDepth: settings.maxIncludeDepth,
      maxResolveAttempts: settings.maxResolveAttempts,
    });
  }

  private registerLanguageSpecWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.nss");
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.onLanguageSpecUriEvent(uri)),
      watcher.onDidChange((uri) => this.onLanguageSpecUriEvent(uri)),
      watcher.onDidDelete((uri) => this.onLanguageSpecUriEvent(uri)),
      vscode.workspace.onDidCreateFiles((event) => {
        if (event.files.some(isLanguageSpecUri)) {
          this.scheduleLanguageSpecRefresh();
        }
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        if (event.files.some(isLanguageSpecUri)) {
          this.scheduleLanguageSpecRefresh();
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        if (
          event.files.some(
            (item) => isLanguageSpecUri(item.oldUri) || isLanguageSpecUri(item.newUri),
          )
        ) {
          this.scheduleLanguageSpecRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleLanguageSpecRefresh();
      }),
    );
  }

  private onLanguageSpecUriEvent(uri: vscode.Uri): void {
    if (isLanguageSpecUri(uri)) {
      this.scheduleLanguageSpecRefresh();
    }
  }

  private scheduleLanguageSpecRefresh(): void {
    if (this.languageSpecRefreshTimer !== undefined) {
      clearTimeout(this.languageSpecRefreshTimer);
    }
    this.languageSpecRefreshTimer = setTimeout(() => {
      this.languageSpecRefreshTimer = undefined;
      // Invalidate compiler caches and refresh Home when it is open.
      this.onConfigurationChanged();
    }, 120);
  }

  private async handleMessage(message: HomeMessage): Promise<void> {
    try {
      switch (message.type) {
        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `@ext:${this.context.extension.id}`,
          );
          break;

        case "openScriptBrowser":
          await vscode.commands.executeCommand(
            "nwscript.openScriptBrowser",
          );
          break;

        case "openLanguageDefinitionBrowser":
          await vscode.commands.executeCommand(
            "nwscript.openLanguageDefinitionBrowser",
          );
          break;

        case "refresh":
          await this.refresh(currentScope() ?? this.scope);
          return;

        case "removeLanguageSpec":
          await this.removeLanguageSpec(message.uri);
          break;

        case "openCompilerRepository":
          await vscode.env.openExternal(
            vscode.Uri.parse("https://github.com/KobaltBlu/nwscript-wasm"),
          );
          break;

        case "openExtensionRepository":
          await vscode.env.openExternal(
            vscode.Uri.parse("https://github.com/KobaltBlu/nwscript-workbench-vscode-ext"),
          );
          break;

        case "updateSetting":
          await this.updateSetting(message.key, message.value);
          break;

        case "openUri":
          if (message.uri) {
            await vscode.window.showTextDocument(vscode.Uri.parse(message.uri, true));
          }
          return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`NWScript Workbench: ${detail}`);
    } finally {
      if (message.type !== "refresh") {
        await this.refresh(currentScope() ?? this.scope);
      }
    }
  }

  private async updateSetting(key: string | undefined, value: unknown): Promise<void> {
    if (!key || !EDITABLE_SETTINGS.has(key)) {
      throw new Error("Unsupported NWScript setting.");
    }

    const scope = this.scope ?? currentScope();
    const config = vscode.workspace.getConfiguration("nwscript", scope);
    const target = configurationTarget(scope);

    switch (key) {
      case "compileOnSave":
      case "liveDiagnostics":
      case "compileDependentsOnSave":
      case "inlayHints":
      case "semanticTokens":
      case "formatting":
      case "folding":
      case "codeActions":
      case "includeGraph":
      case "actionCompat":
      case "ncsReloadOnChange":
      case "ncsActionSignatures":
      case "ncsNdbOverlay":
      case "generateDebug":
      case "autoOpenHome":
        if (typeof value !== "boolean") {
          throw new TypeError(`${key} expects a boolean value.`);
        }
        await config.update(key, value, settingTarget(key, scope));
        break;

      case "optimizationLevel":
        if (!isOptimizationLevel(value)) {
          throw new TypeError("optimizationLevel expects O0, O1, O2, or O3.");
        }
        await config.update(key, value, target);
        break;
    }

    this.onConfigurationChanged();
  }

  private async removeLanguageSpec(value: string | undefined): Promise<void> {
    if (!value) throw new Error("No language specification was selected for removal.");
    const requested = vscode.Uri.parse(value, true);
    const candidates = await this.compiler.findWorkspaceLanguageSpecs();
    const target = candidates.matches.find((candidate) => candidate.toString() === requested.toString());
    if (!target) {
      throw new Error("The selected file is no longer a discovered workspace nwscript.nss.");
    }

    const displayPath = toWorkspacePathOrUri(target, this.scope ?? target);
    const action = await vscode.window.showWarningMessage(
      `Remove ${displayPath}?`,
      { modal: true, detail: "The file will be moved to the operating system trash when supported." },
      "Move to Trash",
    );
    if (action !== "Move to Trash") return;

    try {
      await vscode.workspace.fs.delete(target, { recursive: false, useTrash: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const permanent = await vscode.window.showWarningMessage(
        `This workspace could not move ${displayPath} to the trash. Delete it permanently instead?`,
        { modal: true, detail },
        "Delete Permanently",
      );
      if (permanent !== "Delete Permanently") return;
      await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
    }

    this.onConfigurationChanged();
    void vscode.window.showInformationMessage(`Removed ${displayPath}.`);
  }
}

const EDITABLE_SETTINGS = new Set([
  "compileOnSave",
  "liveDiagnostics",
  "compileDependentsOnSave",
  "inlayHints",
  "semanticTokens",
  "formatting",
  "folding",
  "codeActions",
  "includeGraph",
  "actionCompat",
  "ncsReloadOnChange",
  "ncsActionSignatures",
  "ncsNdbOverlay",
  "generateDebug",
  "optimizationLevel",
  "autoOpenHome",
]);

function currentScope(): vscode.Uri | undefined {
  return (
    vscode.window.activeTextEditor?.document.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri
  );
}

function isLanguageSpecUri(uri: vscode.Uri): boolean {
  return basename(uri).toLowerCase() === "nwscript.nss";
}

function configurationTarget(scope?: vscode.Uri): vscode.ConfigurationTarget {
  return scope && vscode.workspace.getWorkspaceFolder(scope)
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
}

function settingTarget(key: string, scope?: vscode.Uri): vscode.ConfigurationTarget {
  if (key === "autoOpenHome") {
    return vscode.ConfigurationTarget.Global;
  }
  if (key === "includeGraph" || key === "actionCompat") {
    return vscode.ConfigurationTarget.Workspace;
  }
  return configurationTarget(scope);
}

function isOptimizationLevel(value: unknown): value is OptimizationLevel {
  return value === "O0" || value === "O1" || value === "O2" || value === "O3";
}

interface HomeHtmlOptions {
  webview: vscode.Webview;
  logoUri: string;
  extensionVersion: string;
  workspaceName: string;
  specStatus: LanguageSpecStatus;
  resolutionPreview: ResolutionPreview;
  actionCompatSummary: string;
  includeGraph?: IncludeGraphView;
  settings: NWScriptSettings;
  compileOnSave: boolean;
  liveDiagnostics: boolean;
  autoOpenHome: boolean;
  optimizationLevel: OptimizationLevel;
  generateDebug: boolean;
  includePaths: string[];
  outputDirectory: string;
  maxIncludeDepth: number;
  maxResolveAttempts: number;
}

interface ResolutionPreview {
  status: LanguageSpecStatus;
  severity: "ok" | "warning" | "error";
  summary: string;
  scope: string;
  truncated: boolean;
  entries: LanguageSpecResolutionEntry[];
}

function renderToggle(key: string, title: string, description: string, checked: boolean, heading: "h2" | "h3" = "h2"): string {
  return `<div class="setting-row"><div><${heading}>${escapeHtml(title)}</${heading}><p>${escapeHtml(description)}</p></div><label class="toggle"><input type="checkbox" aria-label="${escapeHtml(title)}" data-setting="${escapeHtml(key)}" ${checked ? "checked" : ""}><span></span></label></div>`;
}

function renderIncludeGraph(graph: IncludeGraphView | undefined, enabled: boolean): string {
  if (!enabled) {
    return `<p class="muted">Include graph is turned off in Settings.</p>`;
  }
  if (!graph) {
    return `<p class="muted">Includes and dependents appear here for the active script.</p>`;
  }
  const includeRows = graph.includes.length
    ? graph.includes.map((node) => {
      const label = node.unresolved ? `${node.path} (missing)` : node.path;
      const open = node.uri
        ? ` data-open-uri="${escapeHtml(node.uri.toString())}"`
        : "";
      return `<button class="kb-link"${open} ${node.uri ? "" : "disabled"}><strong>${escapeHtml(node.resRef)}</strong><span>${escapeHtml(label)}</span></button>`;
    }).join("")
    : `<p class="muted">No #include directives.</p>`;
  const includedByRows = graph.includedBy.length
    ? graph.includedBy.map((node) => {
      const open = node.uri ? ` data-open-uri="${escapeHtml(node.uri.toString())}"` : "";
      return `<button class="kb-link"${open}><strong>${escapeHtml(node.resRef)}</strong><span>${escapeHtml(node.path)}</span></button>`;
    }).join("")
    : `<p class="muted">No entry scripts include this file.</p>`;
  return `<div class="action-list"><div class="muted">Includes</div>${includeRows}<div class="muted">Included by</div>${includedByRows}</div>`;
}

async function buildResolutionPreview(
  compiler: CompilerService,
  scope: vscode.Uri | undefined,
): Promise<ResolutionPreview> {
  const explained = await compiler.explainLanguageSpecResolution(scope);
  return {
    status: explained.status,
    severity: explained.severity,
    summary: explained.summary,
    scope: explained.scope,
    truncated: explained.truncated,
    entries: explained.entries,
  };
}

function renderResolutionList(
  entries: LanguageSpecResolutionEntry[],
  canRemove: boolean,
): string {
  if (entries.length === 0) {
    return `<div class="empty-state"><span aria-hidden="true">◇</span><div><strong>No definitions found</strong><p>Download a canonical definition or add nwscript.nss to this workspace.</p><button class="button" data-action="openLanguageDefinitionBrowser">Browse language definitions</button></div></div>`;
  }

  return entries.map((entry) => {
    const remove = canRemove && entry.removable
      ? `<button class="text-danger" data-remove-uri="${escapeHtml(entry.uri)}" aria-label="Remove ${escapeHtml(entry.path)}">Remove…</button>`
      : "";
    return `
      <div class="definition-row ${escapeHtml(entry.state)}">
        <span class="definition-mark" aria-hidden="true"></span>
        <div class="definition-copy">
          <div class="definition-topline">
            <span class="definition-state">${escapeHtml(entry.state)}</span>
            <code>${escapeHtml(entry.path)}</code>
          </div>
          <p>${escapeHtml(entry.detail)}</p>
        </div>
        ${remove}
      </div>`;
  }).join("");
}

function renderWorkbenchHomeHtml(options: HomeHtmlOptions): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${options.webview.cspSource} 'unsafe-inline'`,
    `img-src ${options.webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const preview = options.resolutionPreview;
  const tone = preview.severity;
  const stateLabel = tone === "ok" ? "Resolved" : tone === "warning" ? "Conflict" : "Error";
  const stateIcon = tone === "ok" ? "✓" : tone === "warning" ? "!" : "×";
  const includeSummary = options.includePaths.length
    ? options.includePaths.map(escapeHtml).join(", ")
    : "Automatic workspace discovery";
  const outputSummary = options.outputDirectory
    ? escapeHtml(options.outputDirectory)
    : "Next to source script";
  const definitionRows = renderResolutionList(preview.entries, true);
  const truncationNote = preview.truncated
    ? `<p class="list-note">Discovery may be incomplete; the per-folder definition scan hit its limit.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NWScript Workbench</title>
  <style>
    :root { color-scheme: light dark; --page: min(1180px, calc(100% - 40px)); --radius: 10px; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 280px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.5 var(--vscode-font-family); }
    button, select, input { font: inherit; }
    button { cursor: pointer; }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    code { font-family: var(--vscode-editor-font-family); font-size: .92em; overflow-wrap: anywhere; }
    p { margin: 0; }
    .topbar { position: sticky; top: 0; z-index: 5; border-bottom: 1px solid var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent); backdrop-filter: blur(12px); }
    .topbar-inner { width: var(--page); min-height: 58px; margin: auto; display: flex; align-items: center; gap: 22px; }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 230px; }
    .brand-logo { width: 34px; height: 34px; display: block; object-fit: contain; }
    .brand strong, .brand span { display: block; }
    .brand strong { font-size: 13px; }
    .brand span { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; }
    .nav { margin-left: auto; display: flex; align-self: stretch; }
    .nav button { position: relative; border: 0; padding: 0 13px; color: var(--vscode-descriptionForeground); background: transparent; }
    .nav button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .nav button.active { color: var(--vscode-foreground); }
    .nav button.active::after { content: ""; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; background: var(--vscode-focusBorder); }
    .version { color: var(--vscode-descriptionForeground); font-size: 11px; }
    main { width: var(--page); margin: auto; padding: 32px 0 56px; }
    .page { display: none; }
    .page.active { display: block; }
    .welcome { margin-bottom: 20px; display: flex; justify-content: space-between; gap: 24px; align-items: end; }
    .eyebrow { margin-bottom: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; }
    h1, h2, h3 { margin: 0; line-height: 1.2; }
    h1 { font-size: 24px; }
    h2 { font-size: 16px; }
    h3 { font-size: 13px; }
    .welcome p { margin-top: 5px; color: var(--vscode-descriptionForeground); }
    .button { min-height: 32px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 5px; padding: 6px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .button:hover { background: var(--vscode-button-hoverBackground); }
    .button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .overview-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(285px, .75fr); gap: 18px; align-items: start; }
    .stack { display: grid; gap: 18px; }
    .panel { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: var(--radius); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); overflow: hidden; }
    .panel-body { padding: 20px; }
    .panel-head { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 16px; }
    .panel-head p { margin-top: 5px; color: var(--vscode-descriptionForeground); }
    .resolution-hero { padding: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    .resolution-title { display: flex; align-items: center; gap: 11px; }
    .state-icon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; font-weight: 800; }
    .state-icon.ok { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 14%, transparent); }
    .state-icon.warning { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 14%, transparent); }
    .state-icon.error { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); }
    .status-label { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .resolution-hero h2 { margin-top: 2px; font-size: 17px; }
    .resolution-summary { margin-top: 12px; max-width: 760px; }
    .scope { margin-top: 14px; display: flex; gap: 8px; align-items: baseline; color: var(--vscode-descriptionForeground); }
    .scope code { color: var(--vscode-foreground); }
    .definitions { padding: 8px 14px 14px; }
    .list-note { margin: 4px 8px 10px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .definition-row { min-width: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .definition-row:last-child { border-bottom: 0; }
    .definition-mark { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .definition-row.active .definition-mark { background: var(--vscode-testing-iconPassed); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed) 17%, transparent); }
    .definition-row.shadowed .definition-mark, .definition-row.ignored .definition-mark { background: var(--vscode-editorWarning-foreground); }
    .definition-row.ignored { opacity: .72; }
    .definition-row.isolated .definition-mark { background: var(--vscode-textLink-foreground); }
    .definition-row.ambiguous .definition-mark { background: var(--vscode-errorForeground); }
    .definition-topline { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
    .definition-state { flex: none; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .definition-copy p { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .text-danger { border: 0; padding: 5px 6px; color: var(--vscode-errorForeground); background: transparent; }
    .text-danger:hover { text-decoration: underline; }
    .empty-state { display: flex; gap: 12px; align-items: center; padding: 20px 8px 12px; color: var(--vscode-descriptionForeground); }
    .empty-state > span { font-size: 24px; }
    .empty-state strong { color: var(--vscode-foreground); }
    .empty-state .button { margin-top: 12px; }
    .panel-footer { padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .panel-footer span { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .action-list { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .action-card { min-height: 82px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 13px; text-align: left; color: var(--vscode-foreground); background: transparent; }
    .action-card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .action-card strong, .action-card span { display: block; }
    .action-card span { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .setting-rows { display: grid; }
    .setting-row { min-height: 55px; display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--vscode-panel-border); }
    .setting-row:last-child { border-bottom: 0; }
    .setting-row p { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    select { min-width: 84px; padding: 5px 8px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; }
    .toggle { position: relative; width: 34px; height: 20px; flex: none; }
    .toggle input { position: absolute; opacity: 0; }
    .toggle span { position: absolute; inset: 0; border-radius: 10px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
    .toggle span::after { content: ""; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; border-radius: 50%; background: var(--vscode-descriptionForeground); transition: transform .15s; }
    .toggle input:checked + span { background: var(--vscode-button-background); }
    .toggle input:checked + span::after { transform: translateX(14px); background: var(--vscode-button-foreground); }
    .toggle input:focus-visible + span { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .fact { padding: 13px; border-radius: 7px; background: var(--vscode-textCodeBlock-background); }
    .fact span, .fact strong { display: block; }
    .fact span { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .fact strong { margin-top: 4px; font-weight: 600; overflow-wrap: anywhere; }
    .section-title { margin-bottom: 20px; }
    .section-title p { margin-top: 7px; color: var(--vscode-descriptionForeground); max-width: 700px; }
    .settings-layout { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(260px, .7fr); gap: 18px; }
    .guide-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .guide-card { padding: 20px; }
    .guide-card.full { grid-column: 1 / -1; }
    .guide-card h2 { margin-bottom: 9px; }
    .guide-card p, .guide-card li { color: var(--vscode-descriptionForeground); }
    .guide-card li { margin: 8px 0; }
    .guide-card strong { color: var(--vscode-foreground); }
    pre { margin: 14px 0 0; overflow: auto; padding: 14px; border-radius: 7px; background: var(--vscode-textCodeBlock-background); font: 12px/1.55 var(--vscode-editor-font-family); }
    .callout { margin-top: 14px; padding: 12px 14px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
    .about-card { max-width: 760px; }
    .about-actions { margin-top: 18px; display: flex; gap: 8px; flex-wrap: wrap; }
    @media (max-width: 850px) { .overview-grid, .settings-layout { grid-template-columns: 1fr; } .action-list { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 620px) { :root { --page: calc(100% - 24px); } .topbar-inner { min-height: auto; padding-top: 10px; display: grid; grid-template-columns: 1fr auto; } .brand { min-width: 0; } .version { display: none; } .nav { grid-column: 1 / -1; margin: 0; overflow-x: auto; align-self: auto; } .nav button { min-height: 38px; } main { padding-top: 22px; } .welcome { align-items: start; flex-direction: column; } .welcome .button { display: none; } .action-list, .facts, .guide-grid { grid-template-columns: 1fr; } .guide-card.full { grid-column: auto; } .definition-row { grid-template-columns: 10px minmax(0, 1fr); } .definition-row .text-danger { grid-column: 2; justify-self: start; } .definition-topline { align-items: start; flex-direction: column; gap: 2px; } .panel-footer { align-items: start; flex-direction: column; } }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand"><img class="brand-logo" src="${escapeHtml(options.logoUri)}" alt=""><div><strong>NWScript Workbench</strong><span title="${escapeHtml(options.workspaceName)}">${escapeHtml(options.workspaceName)}</span></div></div>
      <nav class="nav" aria-label="Workbench sections">
        <button class="active" data-page="overview">Overview</button>
        <button data-page="settings">Settings</button>
        <button data-page="guide">Guide</button>
        <button data-page="about">About</button>
      </nav>
      <span class="version">v${escapeHtml(options.extensionVersion)}</span>
    </div>
  </header>
  <main>
    <section id="page-overview" class="page active">
      <div class="welcome"><div><div class="eyebrow">Workspace</div><h1>NWScript workspace</h1><p>Language definition resolution and compiler configuration.</p></div><button class="button secondary" data-action="refresh">Refresh</button></div>
      <div class="overview-grid">
        <div class="stack">
          <article class="panel">
            <div class="resolution-hero"><div class="resolution-title"><span class="state-icon ${tone}" aria-hidden="true">${stateIcon}</span><div><span class="status-label">${stateLabel}</span><h2>Language definition resolution</h2></div></div><p class="resolution-summary">${escapeHtml(preview.summary)}</p>${options.actionCompatSummary ? `<p class="resolution-summary">${escapeHtml(options.actionCompatSummary)}</p>` : ""}<div class="scope"><span>Evaluated for</span><code>${escapeHtml(preview.scope)}</code></div></div>
            <div class="definitions">${truncationNote}${definitionRows}</div>
            <div class="panel-footer"><span>${escapeHtml(options.specStatus.detail)}</span><button class="button secondary" data-page-link="guide">Resolution rules</button></div>
          </article>
          <article class="panel"><div class="panel-body"><div class="panel-head"><div><h2>Repositories</h2><p>Browse upstream NWScript files.</p></div></div><div class="action-list"><button class="action-card" data-action="openScriptBrowser"><strong>Script sources</strong><span>Search, preview, or download KOTOR and TSL scripts.</span></button><button class="action-card" data-action="openLanguageDefinitionBrowser"><strong>Language definitions</strong><span>Inspect or download canonical nwscript.nss files.</span></button></div></div></article>
        </div>
        <aside class="stack">
          <article class="panel"><div class="panel-body"><div class="panel-head"><div><h2>Compiler</h2><p>Workspace settings.</p></div></div><div class="setting-rows">
            ${renderToggle("compileOnSave", "Compile on save", "Build NSS whenever it is saved.", options.compileOnSave, "h3")}
            ${renderToggle("compileDependentsOnSave", "Compile dependents", "Recompile entry scripts that include a saved include file.", options.settings.compileDependentsOnSave, "h3")}
            ${renderToggle("liveDiagnostics", "Live diagnostics", "Compile the active buffer while typing (does not write NCS).", options.liveDiagnostics, "h3")}
            ${renderToggle("autoOpenHome", "Open Home on first run", "Waits for a workspace, then opens Home once. Opt out to skip.", options.autoOpenHome, "h3")}
            <div class="setting-row"><div><h3>Optimization</h3><p>Compiler optimization preset.</p></div><select aria-label="Optimization level" data-setting="optimizationLevel">${["O0", "O1", "O2", "O3"].map((level) => `<option value="${level}" ${level === options.optimizationLevel ? "selected" : ""}>${level}</option>`).join("")}</select></div>
            ${renderToggle("generateDebug", "Generate NDB", "Write debugger metadata.", options.generateDebug, "h3")}
          </div></div><div class="panel-footer"><span>More controls are available in VS Code Settings.</span><button class="button secondary" data-action="openSettings">Open settings</button></div></article>
          <article class="panel"><div class="panel-body"><div class="panel-head"><div><h2>Include graph</h2><p>${!options.settings.includeGraph ? "Disabled in Settings." : options.includeGraph ? escapeHtml(options.includeGraph.script) : "Open an NSS file to inspect includes."}</p></div></div>${renderIncludeGraph(options.includeGraph, options.settings.includeGraph)}</div></article>
          <article class="panel"><div class="panel-body"><div class="panel-head"><div><h2>Resolved values</h2></div></div><div class="facts"><div class="fact"><span>Workspace</span><strong>${escapeHtml(options.workspaceName)}</strong></div><div class="fact"><span>Output</span><strong>${outputSummary}</strong></div><div class="fact"><span>Include depth</span><strong>${options.maxIncludeDepth}</strong></div><div class="fact"><span>Resolve attempts</span><strong>${options.maxResolveAttempts}</strong></div></div></div></article>
        </aside>
      </div>
    </section>
    <section id="page-settings" class="page">
      <div class="section-title"><div class="eyebrow">Workspace</div><h1>Workbench settings</h1><p>Common options are editable here. Paths and limits are available in VS Code Settings.</p></div>
      <div class="settings-layout"><article class="panel"><div class="panel-body"><div class="setting-rows">
        ${renderToggle("compileOnSave", "Compile on save", "Compile NWScript files automatically whenever they are saved.", options.settings.compileOnSave)}
        ${renderToggle("liveDiagnostics", "Live diagnostics", "Background-compile the active NSS buffer without writing bytecode.", options.settings.liveDiagnostics)}
        ${renderToggle("compileDependentsOnSave", "Compile dependents on save", "When compile-on-save is on, recompile entry scripts that include a saved include file.", options.settings.compileDependentsOnSave)}
        ${renderToggle("inlayHints", "Inlay hints", "Show parameter names on function and ACTION calls.", options.settings.inlayHints)}
        ${renderToggle("semanticTokens", "Semantic highlighting", "Overlay engine, include, and script symbol colors.", options.settings.semanticTokens)}
        ${renderToggle("formatting", "Formatter", "Enable the conservative brace-indent document formatter.", options.settings.formatting)}
        ${renderToggle("folding", "Folding", "Enable brace and grouped #include folding ranges.", options.settings.folding)}
        ${renderToggle("codeActions", "Code actions", "Enable quick fixes such as add include and StartingConditional.", options.settings.codeActions)}
        ${renderToggle("includeGraph", "Include graph", "Show the active script's includes and dependents on Home.", options.settings.includeGraph)}
        ${renderToggle("actionCompat", "ACTION compatibility", "Compare ACTION signatures across language specs on Home, the Language Definition Browser, and NCS Inspector.", options.settings.actionCompat)}
        ${renderToggle("ncsReloadOnChange", "NCS reload on change", "Reload the NCS Inspector when the open .ncs or sibling .ndb changes on disk.", options.settings.ncsReloadOnChange)}
        ${renderToggle("ncsActionSignatures", "NCS ACTION signatures", "Show Engine API ACTION names and signatures in the NCS Inspector.", options.settings.ncsActionSignatures)}
        ${renderToggle("ncsNdbOverlay", "NCS NDB overlay", "Overlay sibling .ndb source mapping in the NCS Inspector.", options.settings.ncsNdbOverlay)}
        ${renderToggle("autoOpenHome", "Open Home on first run", "Automatically open Home the first time a workspace is available after the extension activates. Turn this off to opt out.", options.settings.autoOpenHome)}
        <div class="setting-row"><div><h2>Optimization level</h2><p>Select the optimization preset passed to the WebAssembly compiler.</p></div><select aria-label="Optimization level" data-setting="optimizationLevel">${["O0", "O1", "O2", "O3"].map((level) => `<option value="${level}" ${level === options.optimizationLevel ? "selected" : ""}>${level}</option>`).join("")}</select></div>
        ${renderToggle("generateDebug", "Generate NDB output", "Emit debugger metadata alongside successful NCS output.", options.settings.generateDebug)}
      </div></div></article><aside class="stack"><article class="panel"><div class="panel-body"><div class="panel-head"><div><h2>Resolved configuration</h2><p>Read-only summary of advanced settings.</p></div></div><div class="facts"><div class="fact"><span>Include paths</span><strong>${includeSummary}</strong></div><div class="fact"><span>Output directory</span><strong>${outputSummary}</strong></div><div class="fact"><span>Max include depth</span><strong>${options.maxIncludeDepth}</strong></div><div class="fact"><span>Max resolve attempts</span><strong>${options.maxResolveAttempts}</strong></div></div></div><div class="panel-footer"><span>Edit paths and limits in VS Code Settings.</span><button class="button" data-action="openSettings">Advanced settings</button></div></article></aside></div>
    </section>
    <section id="page-guide" class="page">
      <div class="section-title"><div class="eyebrow">Reference</div><h1>Project layout and resolution</h1><p>The active script determines its API. Keep each game definition above the scripts that use it.</p></div>
      <div class="guide-grid"><article class="panel guide-card"><h2>Resolution order</h2><ol><li><strong>Workspace root:</strong> authoritative for the entire workspace.</li><li><strong>Nearest ancestor:</strong> closest nwscript.nss above the active script.</li><li><strong>Single candidate:</strong> the only definition discovered in the workspace.</li><li><strong>Ambiguous:</strong> no choice is made when unrelated candidates remain.</li></ol></article><article class="panel guide-card"><h2>When a conflict appears</h2><p>A root definition shadows nested game definitions. Use the Overview resolution list to inspect coverage, then remove the unwanted file or reorganize the workspace so each script sits beneath the correct game folder.</p><div class="callout"><strong>Tip:</strong> use one root definition only when every script targets the same game API.</div></article><article class="panel guide-card full"><h2>Recommended layout</h2><pre>My NWScript Workspace/
├─ games/
│  ├─ k1/
│  │  ├─ nwscript.nss
│  │  └─ scripts/
│  └─ k2/
│     ├─ nwscript.nss
│     └─ scripts/
└─ shared-includes/</pre></article><article class="panel guide-card"><h2>Includes</h2><p>Includes resolve beside the source first, then through configured include paths and workspace discovery. Keep game-specific includes inside the matching game tree.</p></article><article class="panel guide-card"><h2>Troubleshooting</h2><ul><li>Wrong completions: inspect Overview for a shadowing root definition in the resolution list.</li><li>No API found: download or add nwscript.nss above the script.</li><li>Ambiguous API: move the script into a game tree or remove a candidate.</li></ul></article></div>
    </section>
    <section id="page-about" class="page"><div class="section-title"><div class="eyebrow">Extension</div><h1>NWScript Workbench</h1></div><article class="panel about-card"><div class="panel-body"><div class="facts"><div class="fact"><span>Version</span><strong>${escapeHtml(options.extensionVersion)}</strong></div><div class="fact"><span>Workspace</span><strong>${escapeHtml(options.workspaceName)}</strong></div><div class="fact"><span>Compiler</span><strong>KobaltBlu/nwscript-wasm</strong></div><div class="fact"><span>Runtime</span><strong>WebAssembly</strong></div></div><div class="about-actions"><button class="button secondary" data-action="openExtensionRepository">Extension repository</button><button class="button secondary" data-action="openCompilerRepository">Compiler repository</button></div></div></article></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const selectPage = (name) => { const valid = document.getElementById('page-' + name) ? name : 'overview'; document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === 'page-' + valid)); document.querySelectorAll('.nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === valid)); vscode.setState({ page: valid }); window.scrollTo(0, 0); };
    document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => selectPage(button.dataset.page)));
    document.querySelectorAll('[data-page-link]').forEach((button) => button.addEventListener('click', () => selectPage(button.dataset.pageLink)));
    document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => !button.disabled && vscode.postMessage({ type: button.dataset.action })));
    document.querySelectorAll('[data-remove-uri]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'removeLanguageSpec', uri: button.dataset.removeUri })));
    document.querySelectorAll('[data-open-uri]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openUri', uri: button.dataset.openUri })));
    document.querySelectorAll('[data-setting]').forEach((control) => control.addEventListener('change', () => vscode.postMessage({ type: 'updateSetting', key: control.dataset.setting, value: control.type === 'checkbox' ? control.checked : control.value })));
    selectPage(vscode.getState()?.page ?? 'overview');
  </script>
</body>
</html>`;
}

function renderHomeHtml(options: HomeHtmlOptions): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${options.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const specClass = options.specStatus.kind === "missing" || options.specStatus.kind === "ambiguous"
    ? "status warning"
    : "status ok";

  const includeSummary = options.includePaths.length > 0
    ? options.includePaths.map(escapeHtml).join(", ")
    : "Workspace/project discovery";

  const outputSummary = options.outputDirectory
    ? escapeHtml(options.outputDirectory)
    : "Beside source NSS";

  const resolutionEntries = options.resolutionPreview.entries.length
    ? options.resolutionPreview.entries.map((entry) => `
        <div class="spec-row ${entry.state}">
          <span class="spec-state">${escapeHtml(entry.state)}</span>
          <div><code>${escapeHtml(entry.path)}</code><span>${escapeHtml(entry.detail)}</span></div>
          ${entry.removable ? `<button class="remove-spec" data-remove-uri="${escapeHtml(entry.uri)}" title="Remove ${escapeHtml(entry.path)}">Remove…</button>` : ""}
        </div>`).join("")
    : `<div class="muted">No workspace nwscript.nss files were discovered.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NWScript Workbench</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button, select, input { font: inherit; }
    .shell { min-height: 100vh; }
    .hero {
      border-bottom: 1px solid var(--vscode-panel-border);
      background: linear-gradient(135deg, var(--vscode-sideBar-background), var(--vscode-editor-background));
    }
    .hero-inner, main {
      width: min(1120px, calc(100% - 48px));
      margin: 0 auto;
    }
    .hero-inner { padding: 42px 0 28px; }
    .eyebrow {
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: .08em;
      font-size: 11px;
      font-weight: 700;
    }
    h1 { margin: 8px 0 6px; font-size: 32px; font-weight: 650; }
    .subtitle { margin: 0; color: var(--vscode-descriptionForeground); max-width: 760px; line-height: 1.55; }
    .nav { display: flex; gap: 4px; margin-top: 28px; flex-wrap: wrap; }
    .nav button {
      color: var(--vscode-foreground);
      border: 0;
      border-radius: 4px 4px 0 0;
      background: transparent;
      padding: 8px 13px;
      cursor: pointer;
    }
    .nav button.active {
      background: var(--vscode-editor-background);
      color: var(--vscode-textLink-foreground);
    }
    main { padding: 28px 0 56px; }
    .page { display: none; }
    .page.active { display: block; }
    .home-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 300px); gap: 24px; align-items: start; }
    .home-primary { display: grid; gap: 14px; }
    .home-primary .card { grid-column: auto; }
    .kb-rail { border-left: 1px solid var(--vscode-panel-border); padding-left: 20px; }
    .kb-rail h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
    .kb-link {
      width: 100%;
      display: block;
      border: 0;
      border-radius: 4px;
      padding: 9px 10px;
      text-align: left;
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      background: transparent;
    }
    .kb-link:hover { background: var(--vscode-list-hoverBackground); }
    .kb-link strong { display: block; font-weight: 600; }
    .kb-link span { display: block; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
    .kb-article { max-width: 850px; }
    .article-back { margin-bottom: 18px; }
    .article-kicker { color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .08em; font-size: 11px; font-weight: 700; }
    .kb-article > h1 { margin: 6px 0 18px; font-size: 27px; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 14px; }
    .card {
      grid-column: span 6;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 7px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      padding: 18px;
    }
    .card.full { grid-column: 1 / -1; }
    .card h2, .card h3 { margin: 0 0 8px; font-weight: 600; }
    .card h2 { font-size: 17px; }
    .card h3 { font-size: 14px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      margin: 5px 0 10px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    }
    .status.ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
    .status.warning { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
    .resolution-preview { margin-top: 12px; display: grid; gap: 7px; }
    .spec-row { display: grid; grid-template-columns: 76px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 9px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
    .spec-row.active { border-color: var(--vscode-testing-iconPassed, var(--vscode-focusBorder)); }
    .spec-row.shadowed { border-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border)); }
    .spec-state { text-transform: uppercase; font-size: 10px; font-weight: 700; letter-spacing: .06em; padding-top: 2px; }
    .spec-row.active .spec-state { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
    .spec-row.shadowed .spec-state { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
    .spec-row code { overflow-wrap: anywhere; }
    .spec-row div span { display: block; margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .remove-spec { border: 0; color: var(--vscode-errorForeground); background: transparent; padding: 2px 4px; cursor: pointer; }
    .remove-spec:hover { text-decoration: underline; }
    .kv { display: grid; grid-template-columns: minmax(120px, 150px) 1fr; gap: 8px 14px; margin-top: 12px; }
    .kv > div:nth-child(odd) { color: var(--vscode-descriptionForeground); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 7px 11px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .button:hover { background: var(--vscode-button-hoverBackground); }
    .button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .button:disabled { opacity: .45; cursor: default; }
    .setting {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: center;
      padding: 13px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .setting:last-child { border-bottom: 0; }
    .setting label { font-weight: 600; }
    .setting p { margin: 4px 0 0; color: var(--vscode-descriptionForeground); line-height: 1.4; }
    select {
      min-width: 90px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 5px 7px;
    }
    input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--vscode-focusBorder); }
    code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      padding: 1px 4px;
    }
    pre {
      overflow: auto;
      padding: 12px;
      border-radius: 5px;
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
      line-height: 1.45;
    }
        .resolution-list {
      margin: 14px 0 0;
      padding-left: 22px;
    }
    .resolution-list li {
      margin: 10px 0;
      line-height: 1.5;
    }
    .resolution-list strong { display: block; margin-bottom: 2px; }
    .tree-note { margin-top: 10px; }
    .docs h2 { margin-top: 30px; }
    .docs h2:first-child { margin-top: 0; }
    .docs p, .docs li { line-height: 1.55; }
    .callout {
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 10px 13px;
      background: var(--vscode-textBlockQuote-background);
      color: var(--vscode-descriptionForeground);
      margin: 14px 0;
    }
    a { color: var(--vscode-textLink-foreground); }
    @media (max-width: 760px) {
      .hero-inner, main { width: min(100% - 28px, 1120px); }
      .card { grid-column: 1 / -1; }
      .home-layout { grid-template-columns: 1fr; }
      .kb-rail { border-left: 0; border-top: 1px solid var(--vscode-panel-border); padding: 18px 0 0; }
      .setting { align-items: flex-start; }
      .kv { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-inner">
        <div class="eyebrow">NWScript Workbench · ${escapeHtml(options.workspaceName)}</div>
        <h1>NWScript Workbench</h1>
        <p class="subtitle">Configure the NWScript environment, understand how language specifications are resolved, and keep each game's scripts isolated to the correct API.</p>
        <nav class="nav" aria-label="NWScript Workbench sections">
          <button class="active" data-page="home">Home</button>
          <button data-page="configuration">Configuration</button>
          <button data-page="help">Help</button>
          <button data-page="about">About</button>
        </nav>
      </div>
    </section>

    <main>
      <section id="page-home" class="page active">
        <div class="home-layout">
          <div class="home-primary">
          <article class="card">
            <h2>Script Browser</h2>
            <p class="muted">Search and preview decompiled KOTOR and TSL scripts from the KOTOR Community Patches repository, then download only the scripts you choose.</p>
            <div class="actions"><button class="button" data-action="openScriptBrowser">Browse Scripts</button></div>
          </article>

          <article class="card">
            <h2>Language Definition Browser</h2>
            <p class="muted">Browse canonical nwscript.nss definitions by game, inspect their metadata and source, then download the definition you need.</p>
            <div class="actions"><button class="button" data-action="openLanguageDefinitionBrowser">Browse Definitions</button></div>
          </article>

          <article class="card">
            <h2>nwscript.nss Resolution Preview</h2>
            <div class="status ${options.resolutionPreview.severity === "ok" ? "ok" : "warning"}">${escapeHtml(options.resolutionPreview.severity === "ok" ? "Resolved" : options.resolutionPreview.severity === "warning" ? "Conflict detected" : "Resolution problem")}</div>
            <p>${escapeHtml(options.resolutionPreview.summary)}</p>
            ${options.actionCompatSummary ? `<p class="muted">${escapeHtml(options.actionCompatSummary)}</p>` : ""}
            <div class="muted">Scope: <code>${escapeHtml(options.resolutionPreview.scope)}</code></div>
            <div class="resolution-preview">${resolutionEntries}</div>
            <div class="actions"><button class="button secondary" data-action="refresh">Refresh Preview</button></div>
          </article>

          <article class="card">
            <h2>NWScript environment</h2>
            <div class="${specClass}">${escapeHtml(options.specStatus.label)}</div>
            <div class="muted">${escapeHtml(options.specStatus.detail)}</div>
            <div class="kv">
              <div>Workspace</div><div>${escapeHtml(options.workspaceName)}</div>
              <div>Optimization</div><div>${options.optimizationLevel}</div>
              <div>Compile on save</div><div>${options.compileOnSave ? "Enabled" : "Disabled"}</div>
              <div>NDB output</div><div>${options.generateDebug ? "Enabled" : "Disabled"}</div>
            </div>
            <div class="actions">
              <button class="button secondary" data-action="openSettings">Open Settings</button>
              <button class="button secondary" data-action="refresh">Refresh</button>
            </div>
          </article>
          </div>

          <aside class="kb-rail">
            <h2>Knowledge Base</h2>
            <button class="kb-link" data-page-link="kb-resolution"><strong>How nwscript.nss is resolved</strong><span>Understand target precedence and project discovery.</span></button>
            <button class="kb-link" data-page-link="kb-project-layout"><strong>Recommended multi-game project layout</strong><span>Keep KOTOR, TSL, and custom APIs isolated.</span></button>
          </aside>
        </div>
      </section>

      <section id="page-kb-resolution" class="page docs kb-article">
        <button class="button secondary article-back" data-page-link="home">← Back to Home</button>
        <div class="article-kicker">Knowledge Base</div>
        <h1>How nwscript.nss is resolved</h1>
        <p>Resolution is scoped to the file you are working with and its workspace folder. Explicit configuration always wins; automatic project discovery is used only when no target has been pinned.</p>
        <ol class="resolution-list">
          <li><strong>Workspace-root nwscript.nss</strong>A file at the workspace-folder root is authoritative for that workspace folder.</li>
          <li><strong>Nearest ancestor nwscript.nss</strong>If there is no workspace-root spec, the extension walks the active script's folder ancestry and uses the closest matching <code>nwscript.nss</code>. Deeper folders can therefore define a more specific game/custom API for their descendants.</li>
          <li><strong>Single discovered spec</strong>If no ancestor contains a spec but exactly one specification exists in the workspace folder, that file is used.</li>
          <li><strong>Ambiguous</strong>If multiple unrelated specs remain, NWScript Workbench refuses to guess. Move the script into the appropriate tree or remove the conflict in the Home preview.</li>
        </ol>
        <div class="callout"><strong>Important:</strong> a workspace-root <code>nwscript.nss</code> is a workspace-wide authority. If you want separate KOTOR, TSL, or custom script trees to resolve independently, do not place a competing <code>nwscript.nss</code> at the common workspace root.</div>
      </section>

      <section id="page-kb-project-layout" class="page docs kb-article">
        <button class="button secondary article-back" data-page-link="home">← Back to Home</button>
        <div class="article-kicker">Knowledge Base</div>
        <h1>Recommended multi-game project layout</h1>
        <p>Put each game's scripts under its own folder and place that game's <code>nwscript.nss</code> at the root of the game folder. Every descendant script naturally resolves against the closest applicable language specification.</p>
        <pre>My NWScript Workspace/
├─ kotor1/
│  ├─ nwscript.nss
│  ├─ includes/
│  │  └─ k_inc_custom.nss
│  └─ scripts/
│     ├─ k_dialog.nss
│     └─ modules/
│        └─ tar_m03aa.nss
├─ kotor2/
│  ├─ nwscript.nss
│  ├─ includes/
│  └─ scripts/
│     └─ a_104per.nss
└─ custom-game/
   ├─ nwscript.nss
   └─ scripts/</pre>
        <p><code>kotor1/scripts/modules/tar_m03aa.nss</code> resolves to <code>kotor1/nwscript.nss</code>, while <code>kotor2/scripts/a_104per.nss</code> resolves independently to <code>kotor2/nwscript.nss</code>.</p>
      </section>

      <section id="page-configuration" class="page">
        <div class="grid">
          <article class="card full">
            <h2>Language specification</h2>
            <div class="${specClass}">${escapeHtml(options.specStatus.label)}</div>
            <p class="muted">${escapeHtml(options.specStatus.detail)}</p>
            <div class="actions">
            </div>
          </article>

          <article class="card full">
            <h2>Common settings</h2>
            <div class="setting">
              <div><label for="compileOnSave">Compile on save</label><p>Compile NSS files automatically whenever they are saved.</p></div>
              <input id="compileOnSave" type="checkbox" data-setting="compileOnSave" ${options.compileOnSave ? "checked" : ""}>
            </div>
            <div class="setting">
              <div><label for="optimization">Optimization</label><p>Choose the optimization preset passed to the native NWScript compiler.</p></div>
              <select id="optimization" data-setting="optimizationLevel">
                ${["O0", "O1", "O2", "O3"].map((level) => `<option value="${level}" ${level === options.optimizationLevel ? "selected" : ""}>${level}</option>`).join("")}
              </select>
            </div>
            <div class="setting">
              <div><label for="generateDebug">Generate NDB</label><p>Emit compiler debug information when available.</p></div>
              <input id="generateDebug" type="checkbox" data-setting="generateDebug" ${options.generateDebug ? "checked" : ""}>
            </div>
          </article>

          <article class="card">
            <h2>Resource resolution</h2>
            <div class="kv">
              <div>Include paths</div><div>${includeSummary}</div>
              <div>Max include depth</div><div>${options.maxIncludeDepth}</div>
              <div>Resolve attempts</div><div>${options.maxResolveAttempts}</div>
            </div>
          </article>

          <article class="card">
            <h2>Output</h2>
            <div class="kv">
              <div>Directory</div><div>${outputSummary}</div>
              <div>NCS</div><div>Generated on successful compile</div>
              <div>NDB</div><div>${options.generateDebug ? "Enabled" : "Disabled"}</div>
            </div>
          </article>

          <article class="card full">
            <div class="actions"><button class="button secondary" data-action="openSettings">Open Advanced Settings</button></div>
          </article>
        </div>
      </section>

      <section id="page-help" class="page docs">
        <h2>Language specification resolution</h2>
        <p>NWScript APIs are defined by <code>nwscript.nss</code>. The extension resolves a language specification for the active resource before compilation, IntelliSense, signature help, hover documentation, and navigation features.</p>
        <p>Resolution is automatic and scoped to the active script. Discovery prefers a workspace-root <code>nwscript.nss</code>; without one, the closest ancestor spec to the script wins. If only one spec exists anywhere in the workspace folder, it is the final unambiguous fallback.</p>

        <h2>Organizing K1, K2, and custom scripts</h2>
        <p>For a workspace that contains scripts for more than one game or language-spec variant, keep each environment in its own folder. Put the matching <code>nwscript.nss</code> at that folder's root and keep the scripts/includes beneath it.</p>
        <pre>scripts-workspace/
├─ k1/
│  ├─ nwscript.nss
│  └─ scripts/
├─ k2/
│  ├─ nwscript.nss
│  └─ scripts/
└─ my-custom-spec/
   ├─ nwscript.nss
   └─ scripts/</pre>
        <div class="callout">Avoid a common workspace-root <code>nwscript.nss</code> in this layout. A root spec is intentionally authoritative, so it is best used when the entire workspace targets one NWScript API.</div>

        <h2>Nested specifications</h2>
        <p>When there is no workspace-root spec, language specifications inherit down the directory tree. A deeper <code>nwscript.nss</code> becomes the closest ancestor for scripts beneath that folder.</p>
        <pre>k1/
├─ nwscript.nss              # default for k1 descendants
├─ scripts/
│  └─ normal_script.nss      # uses k1/nwscript.nss
└─ custom-api/
   ├─ nwscript.nss           # more specific spec
   └─ special_script.nss     # uses custom-api/nwscript.nss</pre>

        <h2>Workspace-root NWScript.nss</h2>
        <p>A root <code>nwscript.nss</code> applies to every script in that workspace folder and shadows nested definitions. Use it only when the entire workspace targets one API.</p>

        <h2>Includes</h2>
        <p>The extension recursively resolves <code>#include</code> resources before invoking the compiler and uses that same include graph for editor IntelliSense/navigation. Configure additional search roots with <code>nwscript.includePaths</code>.</p>
        <pre>#include "k_inc_debug"

void main() {
  PrintString("Hello from NWScript");
}</pre>

        <h2>Troubleshooting</h2>
        <ul>
          <li><strong>Wrong API or completions:</strong> check which <code>nwscript.nss</code> applies to the script and make sure no workspace-root spec is unintentionally overriding nested project specs.</li>
          <li><strong>No nwscript.nss found:</strong> add a spec to the relevant game/project folder.</li>
          <li><strong>Multiple unrelated specs found:</strong> move scripts beneath the appropriate game folder or remove an offending definition from the Home preview.</li>
          <li><strong>Missing include:</strong> place the include within the project tree or add its directory to <code>nwscript.includePaths</code>.</li>
        </ul>
      </section>

      <section id="page-about" class="page">
        <div class="grid">
          <article class="card full">
            <h2>About NWScript Workbench</h2>
            <p class="muted">Complete NWScript development tools for VS Code and VS Code for the Web, powered by the WebAssembly NWScript compiler.</p>
            <div class="kv">
              <div>Extension version</div><div>${escapeHtml(options.extensionVersion)}</div>
              <div>Compiler backend</div><div>KobaltBlu/nwscript-wasm</div>
              <div>Hosts</div><div>Desktop VS Code · vscode.dev · virtual workspaces</div>
              <div>Runtime</div><div>WebAssembly, packaged with the extension</div>
            </div>
            <div class="actions">
              <button class="button secondary" data-action="openCompilerRepository">Compiler Repository</button>
              <button class="button secondary" data-action="openExtensionRepository">Extension Repository</button>
            </div>
          </article>
        </div>
      </section>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const selectPage = (name) => {
      document.querySelectorAll('.page').forEach((page) => {
        page.classList.toggle('active', page.id === 'page-' + name);
      });
      document.querySelectorAll('.nav button').forEach((button) => {
        button.classList.toggle('active', button.dataset.page === name);
      });
      vscode.setState({ page: name });
    };

    document.querySelectorAll('.nav button').forEach((button) => {
      button.addEventListener('click', () => selectPage(button.dataset.page));
    });

    document.querySelectorAll('[data-page-link]').forEach((button) => {
      button.addEventListener('click', () => selectPage(button.dataset.pageLink));
    });

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!button.disabled) {
          vscode.postMessage({ type: button.dataset.action });
        }
      });
    });

    document.querySelectorAll('[data-remove-uri]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeLanguageSpec', uri: button.dataset.removeUri });
      });
    });

    document.querySelectorAll('[data-setting]').forEach((control) => {
      control.addEventListener('change', () => {
        const value = control.type === 'checkbox' ? control.checked : control.value;
        vscode.postMessage({
          type: 'updateSetting',
          key: control.dataset.setting,
          value,
        });
      });
    });

    const state = vscode.getState();
    if (state?.page) {
      selectPage(state.page);
    }
  </script>
</body>
</html>`;
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
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
