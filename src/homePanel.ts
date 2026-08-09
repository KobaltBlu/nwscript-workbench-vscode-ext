import * as vscode from "vscode";
import { CompilerService, type LanguageSpecStatus } from "./compilerService";
import { getSettings, type OptimizationLevel } from "./config";
import { workspaceFolderFor } from "./uri";

const HOME_VIEW_TYPE = "nwscript.home";

interface HomeMessage {
  type: string;
  key?: string;
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
      "NWScript Home",
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

    const [specStatus, embeddedTargets] = await Promise.all([
      this.compiler.getLanguageSpecStatus(this.scope),
      this.compiler.getEmbeddedTargets().catch(() => [] as string[]),
    ]);

    if (!this.panel || serial !== this.renderSerial) {
      return;
    }

    const folder = workspaceFolderFor(this.scope);

    this.panel.webview.html = renderHomeHtml({
      webview: this.panel.webview,
      extensionVersion: String(this.context.extension.packageJSON.version ?? ""),
      workspaceName: folder?.name ?? "No workspace folder",
      specStatus,
      embeddedTargets,
      languageSpec: settings.languageSpec,
      gameTarget: settings.gameTarget,
      autoDetectLanguageSpec: settings.autoDetectLanguageSpec,
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
        case "selectTarget":
          await vscode.commands.executeCommand(
            "nwscript.selectCompilerTarget",
            this.scope,
          );
          break;

        case "selectLanguageSpec":
          await vscode.commands.executeCommand(
            "nwscript.selectLanguageSpec",
            this.scope,
          );
          break;

        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `@ext:${this.context.extension.id}`,
          );
          break;

        case "refresh":
          await this.refresh(currentScope() ?? this.scope);
          return;

        case "openCompilerRepository":
          await vscode.env.openExternal(
            vscode.Uri.parse("https://github.com/KobaltBlu/nwscript-wasm"),
          );
          break;

        case "openExtensionRepository":
          await vscode.env.openExternal(
            vscode.Uri.parse("https://github.com/KobaltBlu/nwscript-vscode"),
          );
          break;

        case "updateSetting":
          await this.updateSetting(message.key, message.value);
          break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`NWScript Home: ${detail}`);
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
      case "autoDetectLanguageSpec":
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
}

const EDITABLE_SETTINGS = new Set([
  "autoDetectLanguageSpec",
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
  embeddedTargets: string[];
  languageSpec: string;
  gameTarget: string;
  autoDetectLanguageSpec: boolean;
  compileOnSave: boolean;
  optimizationLevel: OptimizationLevel;
  generateDebug: boolean;
  includePaths: string[];
  outputDirectory: string;
  maxIncludeDepth: number;
  maxResolveAttempts: number;
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

  const targetSummary = options.embeddedTargets.length > 0
    ? options.embeddedTargets.map(escapeHtml).join(", ")
    : "None in this compiler build";

  const includeSummary = options.includePaths.length > 0
    ? options.includePaths.map(escapeHtml).join(", ")
    : "Workspace/project discovery";

  const outputSummary = options.outputDirectory
    ? escapeHtml(options.outputDirectory)
    : "Beside source NSS";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NWScript Home</title>
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
      .setting { align-items: flex-start; }
      .kv { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-inner">
        <div class="eyebrow">NWScript Compiler · ${escapeHtml(options.workspaceName)}</div>
        <h1>NWScript Home</h1>
        <p class="subtitle">Configure the NWScript environment, understand how language specifications are resolved, and keep each game's scripts isolated to the correct API.</p>
        <nav class="nav" aria-label="NWScript Home sections">
          <button class="active" data-page="home">Home</button>
          <button data-page="configuration">Configuration</button>
          <button data-page="help">Help</button>
          <button data-page="about">About</button>
        </nav>
      </div>
    </section>

    <main>
      <section id="page-home" class="page active">
        <div class="grid">
          <article class="card full">
            <h2>NWScript environment</h2>
            <div class="${specClass}">${escapeHtml(options.specStatus.label)}</div>
            <div class="muted">${escapeHtml(options.specStatus.detail)}</div>
            <div class="kv">
              <div>Workspace</div><div>${escapeHtml(options.workspaceName)}</div>
              <div>Optimization</div><div>${options.optimizationLevel}</div>
              <div>Compile on save</div><div>${options.compileOnSave ? "Enabled" : "Disabled"}</div>
              <div>NDB output</div><div>${options.generateDebug ? "Enabled" : "Disabled"}</div>
              <div>Embedded targets</div><div>${targetSummary}</div>
            </div>
            <div class="actions">
              <button class="button" data-action="selectTarget">Select Compiler Target</button>
              <button class="button secondary" data-action="selectLanguageSpec">Choose nwscript.nss</button>
              <button class="button secondary" data-action="openSettings">Open Settings</button>
              <button class="button secondary" data-action="refresh">Refresh</button>
            </div>
          </article>

          <article class="card full">
            <h2>How nwscript.nss is resolved</h2>
            <p class="muted">Resolution is scoped to the file you are working with and its workspace folder. Explicit configuration always wins; automatic project discovery is used only when no target has been pinned.</p>
            <ol class="resolution-list">
              <li><strong>Explicit NWScript.nss</strong><code>nwscript.languageSpec</code> is used when configured for the active resource/workspace folder.</li>
              <li><strong>Explicit embedded target</strong>An explicitly selected compiler target is used when no NWScript.nss file is configured.</li>
              <li><strong>Workspace-root nwscript.nss</strong>During auto-detection, a file at the workspace-folder root is authoritative for that workspace folder.</li>
              <li><strong>Nearest ancestor nwscript.nss</strong>If there is no workspace-root spec, the extension walks the active script's folder ancestry and uses the closest matching <code>nwscript.nss</code>. Deeper folders can therefore define a more specific game/custom API for their descendants.</li>
              <li><strong>Single discovered spec</strong>If no ancestor contains a spec but exactly one <code>nwscript.nss</code> exists in the workspace folder, that file is used.</li>
              <li><strong>Ambiguous</strong>If multiple unrelated specs remain, the extension refuses to guess and asks you to choose one explicitly.</li>
            </ol>
            <div class="callout"><strong>Important:</strong> a workspace-root <code>nwscript.nss</code> is a workspace-wide authority. If you want separate K1, K2, or custom script trees to resolve independently, do not place a competing <code>nwscript.nss</code> at the common workspace root.</div>
          </article>

          <article class="card full">
            <h2>Recommended multi-game project layout</h2>
            <p class="muted">Put each game's scripts under its own folder and place that game's <code>nwscript.nss</code> at the root of the game folder. Every descendant script naturally resolves against the closest applicable language specification.</p>
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
            <p class="muted tree-note"><code>kotor1/scripts/modules/tar_m03aa.nss</code> resolves to <code>kotor1/nwscript.nss</code>, while <code>kotor2/scripts/a_104per.nss</code> resolves independently to <code>kotor2/nwscript.nss</code>.</p>
          </article>
        </div>
      </section>

      <section id="page-configuration" class="page">
        <div class="grid">
          <article class="card full">
            <h2>Language specification</h2>
            <div class="${specClass}">${escapeHtml(options.specStatus.label)}</div>
            <p class="muted">${escapeHtml(options.specStatus.detail)}</p>
            <div class="actions">
              <button class="button" data-action="selectTarget">Select Compiler Target</button>
              <button class="button secondary" data-action="selectLanguageSpec">Choose nwscript.nss</button>
            </div>
          </article>

          <article class="card full">
            <h2>Common settings</h2>
            <div class="setting">
              <div><label for="autoDetect">Auto-detect nwscript.nss</label><p>Resolve the applicable project language specification automatically when no NWScript.nss or embedded target is pinned.</p></div>
              <input id="autoDetect" type="checkbox" data-setting="autoDetectLanguageSpec" ${options.autoDetectLanguageSpec ? "checked" : ""}>
            </div>
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
        <p>Explicit <code>nwscript.languageSpec</code> configuration wins first, followed by an explicit embedded target. Automatic discovery then prefers a workspace-root <code>nwscript.nss</code>; without one, the closest ancestor spec to the active script wins. If only one spec exists anywhere in the workspace folder, it can be used as the final unambiguous fallback.</p>

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

        <h2>Global NWScript.nss</h2>
        <p>Use <strong>Choose nwscript.nss</strong> when you want to explicitly pin a language specification instead of relying on folder discovery. The selected file is stored in NWScript settings at the appropriate workspace/workspace-folder scope.</p>

        <h2>Includes</h2>
        <p>The extension recursively resolves <code>#include</code> resources before invoking the compiler and uses that same include graph for editor IntelliSense/navigation. Configure additional search roots with <code>nwscript.includePaths</code>.</p>
        <pre>#include "k_inc_debug"

void main() {
  PrintString("Hello from NWScript");
}</pre>

        <h2>Troubleshooting</h2>
        <ul>
          <li><strong>Wrong API or completions:</strong> check which <code>nwscript.nss</code> applies to the script and make sure no workspace-root spec is unintentionally overriding nested project specs.</li>
          <li><strong>No nwscript.nss found:</strong> add a spec to the relevant game/project folder or explicitly choose a NWScript.nss file.</li>
          <li><strong>Multiple unrelated specs found:</strong> move scripts beneath the appropriate game folder or explicitly choose the desired language specification.</li>
          <li><strong>Missing include:</strong> place the include within the project tree or add its directory to <code>nwscript.includePaths</code>.</li>
        </ul>
      </section>

      <section id="page-about" class="page">
        <div class="grid">
          <article class="card full">
            <h2>About NWScript Compiler</h2>
            <p class="muted">A standalone VS Code and VS Code for the Web frontend for the WebAssembly NWScript compiler.</p>
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

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!button.disabled) {
          vscode.postMessage({ type: button.dataset.action });
        }
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
