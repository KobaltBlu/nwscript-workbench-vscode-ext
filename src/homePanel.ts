import * as vscode from "vscode";
import { CompilerService, type LanguageSpecStatus } from "./compilerService";
import { getSettings, type OptimizationLevel } from "./config";
import { toWorkspacePathOrUri, workspaceFolderFor } from "./uri";

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
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly compiler: CompilerService,
    private readonly onConfigurationChanged: () => void,
  ) {}

  dispose(): void {
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

    const specStatus = await this.compiler.getLanguageSpecStatus(this.scope);

    const resolutionPreview = await buildResolutionPreview(
      this.compiler,
      this.scope,
      specStatus,
    );

    if (!this.panel || serial !== this.renderSerial) {
      return;
    }

    const folder = workspaceFolderFor(this.scope);

    this.panel.webview.html = renderHomeHtml({
      webview: this.panel.webview,
      extensionVersion: String(this.context.extension.packageJSON.version ?? ""),
      workspaceName: folder?.name ?? "No workspace folder",
      specStatus,
      resolutionPreview,
      compileOnSave: settings.compileOnSave,
      optimizationLevel: settings.optimizationLevel,
      generateDebug: settings.generateDebug,
      includePaths: settings.includePaths,
      outputDirectory: settings.outputDirectory,
      maxIncludeDepth: settings.maxIncludeDepth,
      maxResolveAttempts: settings.maxResolveAttempts,
    });
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
      case "generateDebug":
        if (typeof value !== "boolean") {
          throw new TypeError(`${key} expects a boolean value.`);
        }
        await config.update(key, value, target);
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
    const candidates = await this.compiler.findProjectLanguageSpecs(this.scope);
    const target = candidates.find((candidate) => candidate.toString() === requested.toString());
    if (!target) {
      throw new Error("The selected file is no longer a discovered workspace nwscript.nss.");
    }

    const displayPath = toWorkspacePathOrUri(target, this.scope ?? target);
    const action = await vscode.window.showWarningMessage(
      `Remove ${displayPath} to resolve the language-definition conflict?`,
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
  "generateDebug",
  "optimizationLevel",
]);

function currentScope(): vscode.Uri | undefined {
  return (
    vscode.window.activeTextEditor?.document.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri
  );
}

function configurationTarget(scope?: vscode.Uri): vscode.ConfigurationTarget {
  return scope && vscode.workspace.getWorkspaceFolder(scope)
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
}

function isOptimizationLevel(value: unknown): value is OptimizationLevel {
  return value === "O0" || value === "O1" || value === "O2" || value === "O3";
}

interface HomeHtmlOptions {
  webview: vscode.Webview;
  extensionVersion: string;
  workspaceName: string;
  specStatus: LanguageSpecStatus;
  resolutionPreview: ResolutionPreview;
  compileOnSave: boolean;
  optimizationLevel: OptimizationLevel;
  generateDebug: boolean;
  includePaths: string[];
  outputDirectory: string;
  maxIncludeDepth: number;
  maxResolveAttempts: number;
}

interface ResolutionPreviewEntry {
  uri: string;
  path: string;
  state: "active" | "shadowed" | "available";
  detail: string;
  removable: boolean;
}

interface ResolutionPreview {
  severity: "ok" | "warning" | "error";
  summary: string;
  scope: string;
  entries: ResolutionPreviewEntry[];
}

async function buildResolutionPreview(
  compiler: CompilerService,
  scope: vscode.Uri | undefined,
  status: LanguageSpecStatus,
): Promise<ResolutionPreview> {
  const folder = workspaceFolderFor(scope);
  const candidates = await compiler.findProjectLanguageSpecs(scope);
  const displayPath = (uri: vscode.Uri): string => toWorkspacePathOrUri(uri, scope ?? uri);
  const activeKey = status.uri?.toString();
  const rootSpec = folder ? vscode.Uri.joinPath(folder.uri, "nwscript.nss") : undefined;
  const rootKey = rootSpec?.toString();
  const hasRoot = rootKey !== undefined && candidates.some((uri) => uri.toString() === rootKey);
  const nested = candidates.filter((uri) => uri.toString() !== rootKey);
  const entries: ResolutionPreviewEntry[] = candidates.map((uri) => {
    const active = uri.toString() === activeKey;
    return {
      uri: uri.toString(),
      path: displayPath(uri),
      state: active ? "active" : activeKey ? "shadowed" : "available",
      detail: active
        ? "Selected for the active resource"
        : activeKey
          ? "Not selected at this scope"
          : "Discovered candidate",
      removable: true,
    };
  });

  if (status.kind === "ambiguous") {
    return {
      severity: "error",
      summary: "Resolution is ambiguous. No definition can be selected safely for this resource.",
      scope: scope ? displayPath(scope) : "No active workspace resource",
      entries,
    };
  }

  if (hasRoot && nested.length > 0) {
    return {
      severity: "warning",
      summary: `Workspace-root nwscript.nss overrides ${nested.length} nested definition${nested.length === 1 ? "" : "s"}, including game-specific definitions.`,
      scope: scope ? displayPath(scope) : "Workspace folder",
      entries: entries.map((entry) => entry.state === "active" ? entry : {
        ...entry,
        state: "shadowed",
        detail: "Shadowed by workspace-root nwscript.nss",
      }),
    };
  }

  return {
    severity: status.kind === "missing" ? "error" : "ok",
    summary: status.kind === "missing"
      ? status.label
      : candidates.length > 1
        ? "The nearest ancestor definition is selected for the active resource; other game trees remain isolated."
        : "Resolution is unambiguous for the active resource.",
    scope: scope ? displayPath(scope) : "No active workspace resource",
    entries,
  };
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

  const showResolutionActions = options.resolutionPreview.severity !== "ok";
  const resolutionEntries = options.resolutionPreview.entries.length
    ? options.resolutionPreview.entries.map((entry) => `
        <div class="spec-row ${entry.state}">
          <span class="spec-state">${escapeHtml(entry.state)}</span>
          <div><code>${escapeHtml(entry.path)}</code><span>${escapeHtml(entry.detail)}</span></div>
          ${showResolutionActions && entry.removable ? `<button class="remove-spec" data-remove-uri="${escapeHtml(entry.uri)}" title="Remove ${escapeHtml(entry.path)}">Remove…</button>` : ""}
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
