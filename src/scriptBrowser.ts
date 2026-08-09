import * as vscode from "vscode";
import { basename, dirname, workspaceFolderFor } from "./uri";

const REPOSITORY = "KOTORCommunityPatches/Vanilla_KOTOR_Script_Source";
const BRANCH = "master";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const TREE_URL = `https://api.github.com/repos/${REPOSITORY}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE_URL = `https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}/`;
const VIEW_TYPE = "nwscript.scriptBrowser";

interface GitTreeResponse {
  truncated?: boolean;
  tree?: Array<{
    path?: string;
    type?: string;
    size?: number;
  }>;
  message?: string;
}

interface ScriptEntry {
  path: string;
  name: string;
  game: "K1" | "TSL";
  category: string;
  size: number;
}

interface BrowserMessage {
  type?: string;
  path?: string;
}

export class ScriptBrowser implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private catalog?: ScriptEntry[];
  private catalogPromise?: Promise<ScriptEntry[]>;
  private readonly sourceCache = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Script Browser",
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
      (message: BrowserMessage) => void this.handleMessage(message),
      undefined,
      this.disposables,
    );
    panel.webview.html = renderBrowserHtml(panel.webview);
  }

  private async handleMessage(message: BrowserMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.sendCatalog(false);
          break;
        case "refresh":
          await this.sendCatalog(true);
          break;
        case "preview":
          await this.preview(this.requireCatalogPath(message.path));
          break;
        case "open":
          await this.openInEditor(this.requireCatalogPath(message.path));
          break;
        case "download":
          await this.download(this.requireCatalogPath(message.path));
          break;
        case "openRepository":
          await vscode.env.openExternal(vscode.Uri.parse(REPOSITORY_URL));
          break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.panel?.webview.postMessage({
        type: "error",
        message: detail,
        path: message.path,
      });
      void vscode.window.showErrorMessage(`NWScript Workbench: ${detail}`);
    }
  }

  private async sendCatalog(refresh: boolean): Promise<void> {
    if (!this.panel) return;
    await this.panel.webview.postMessage({ type: "loadingCatalog" });
    try {
      if (refresh) {
        this.catalog = undefined;
        this.catalogPromise = undefined;
        this.sourceCache.clear();
      }
      const scripts = await this.getCatalog();
      await this.panel?.webview.postMessage({ type: "catalog", scripts });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.panel?.webview.postMessage({ type: "error", message: detail });
    }
  }

  private async getCatalog(): Promise<ScriptEntry[]> {
    if (this.catalog) return this.catalog;
    this.catalogPromise ??= this.fetchCatalog();
    try {
      this.catalog = await this.catalogPromise;
      return this.catalog;
    } finally {
      this.catalogPromise = undefined;
    }
  }

  private async fetchCatalog(): Promise<ScriptEntry[]> {
    const response = await fetch(TREE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const payload = await response.json() as GitTreeResponse;
    if (!response.ok) {
      const rateRemaining = response.headers.get("x-ratelimit-remaining");
      const suffix = rateRemaining === "0"
        ? " GitHub's anonymous API rate limit has been reached; try again later."
        : "";
      throw new Error(`${payload.message ?? `GitHub returned HTTP ${response.status}`}.${suffix}`);
    }
    if (payload.truncated) {
      throw new Error("GitHub returned a truncated repository tree; the script catalog cannot be shown safely.");
    }

    const scripts: ScriptEntry[] = [];
    for (const item of payload.tree ?? []) {
      if (item.type !== "blob" || !item.path?.toLowerCase().endsWith(".nss")) continue;
      const parts = item.path.split("/");
      const game = parts[0];
      if (game !== "K1" && game !== "TSL") continue;
      scripts.push({
        path: item.path,
        name: parts.at(-1) ?? item.path,
        game,
        category: parts.length > 2 ? parts.slice(1, -1).join(" / ") : "Root",
        size: item.size ?? 0,
      });
    }
    scripts.sort((a, b) => a.path.localeCompare(b.path));
    return scripts;
  }

  private requireCatalogPath(path: string | undefined): ScriptEntry {
    if (!path) throw new Error("No script was selected.");
    const entry = this.catalog?.find((script) => script.path === path);
    if (!entry) throw new Error("The selected script is not part of the current upstream catalog.");
    return entry;
  }

  private async getSource(entry: ScriptEntry): Promise<string> {
    const cached = this.sourceCache.get(entry.path);
    if (cached !== undefined) return cached;
    const response = await fetch(rawUrl(entry.path));
    if (!response.ok) {
      throw new Error(`Unable to download ${entry.path}: GitHub returned HTTP ${response.status}.`);
    }
    const source = await response.text();
    this.sourceCache.set(entry.path, source);
    if (this.sourceCache.size > 20) {
      this.sourceCache.delete(this.sourceCache.keys().next().value as string);
    }
    return source;
  }

  private async preview(entry: ScriptEntry): Promise<void> {
    await this.panel?.webview.postMessage({ type: "loadingPreview", path: entry.path });
    const source = await this.getSource(entry);
    await this.panel?.webview.postMessage({
      type: "preview",
      path: entry.path,
      source,
      size: new TextEncoder().encode(source).byteLength,
    });
  }

  private async openInEditor(entry: ScriptEntry): Promise<void> {
    const source = await this.getSource(entry);
    const document = await vscode.workspace.openTextDocument({
      language: "nwscript",
      content: source,
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async download(entry: ScriptEntry): Promise<void> {
    const folder = workspaceFolderFor();
    const defaultUri = folder
      ? vscode.Uri.joinPath(folder.uri, "vanilla-scripts", ...entry.path.split("/"))
      : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "NWScript source": ["nss"] },
      saveLabel: "Download Script",
      title: `Download ${entry.name}`,
    });
    if (!target) return;

    const source = await this.getSource(entry);
    await vscode.workspace.fs.createDirectory(dirname(target));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(source));
    const action = await vscode.window.showInformationMessage(
      `Downloaded ${basename(target)}.`,
      "Open",
    );
    if (action === "Open") {
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document);
    }
  }
}

function rawUrl(path: string): string {
  return `${RAW_BASE_URL}${path.split("/").map(encodeURIComponent).join("/")}`;
}

function renderBrowserHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Script Browser</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: default; opacity: .55; }
    .shell { height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header { padding: 18px 22px 14px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    h1 { margin: 0 0 5px; font-size: 23px; font-weight: 650; }
    .subtitle, .status, .path, .empty { color: var(--vscode-descriptionForeground); }
    .subtitle { margin: 0; line-height: 1.45; }
    .toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 120px auto; gap: 8px; margin-top: 14px; }
    input, select { width: 100%; border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 7px 9px; outline: none; }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
    .button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 7px 11px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .button:hover { background: var(--vscode-button-hoverBackground); }
    .button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .content { min-height: 0; display: grid; grid-template-columns: minmax(280px, 38%) 1fr; }
    .catalog { min-height: 0; border-right: 1px solid var(--vscode-panel-border); display: grid; grid-template-rows: auto 1fr; }
    .status { padding: 9px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
    .list { overflow: auto; }
    .script { width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--vscode-panel-border); color: inherit; background: transparent; padding: 9px 12px; }
    .script:hover { background: var(--vscode-list-hoverBackground); }
    .script.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .script strong { display: block; font-weight: 600; }
    .path { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; margin-top: 3px; }
    .preview { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto 1fr; }
    .preview-head { padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .preview-title { min-width: 0; }
    .preview-title strong, .preview-title span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preview-actions { display: flex; gap: 7px; flex-shrink: 0; }
    .source-pane { min-height: 0; overflow: hidden; }
    pre { height: 100%; margin: 0; padding: 14px 16px 40px; overflow: auto; white-space: pre; tab-size: 4; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.45; }
    .empty { padding: 22px; line-height: 1.55; }
    .error { color: var(--vscode-errorForeground); }
    @media (max-width: 760px) {
      .toolbar { grid-template-columns: 1fr 105px; }
      .toolbar .repo { grid-column: 1 / -1; }
      .content { grid-template-columns: 1fr; grid-template-rows: minmax(220px, 42%) 1fr; }
      .catalog { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); }
      .preview-head { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="title-row">
        <div><h1>Script Browser</h1><p class="subtitle">Browse KOTOR and TSL source scripts.</p></div>
        <button id="refresh" class="button secondary">Refresh</button>
      </div>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search script names and paths…" aria-label="Search scripts">
        <select id="game" aria-label="Filter by game"><option value="all">All games</option><option value="K1">KOTOR</option><option value="TSL">KOTOR II / TSL</option></select>
        <button id="repository" class="button secondary repo">View Source Repository</button>
      </div>
    </header>
    <div class="content">
      <section class="catalog"><div id="status" class="status">Loading catalog…</div><div id="list" class="list"></div></section>
      <section class="preview">
        <div class="preview-head">
          <div class="preview-title"><strong id="selectedName">Select a script</strong><span id="selectedPath" class="path">Preview and download actions will appear here.</span></div>
          <div class="preview-actions"><button id="open" class="button secondary" disabled>Open in Editor</button><button id="download" class="button" disabled>Download…</button></div>
        </div>
        <div id="source" class="source-pane empty">Search by script name or repository path, then select a result. Search is local to the fetched catalog and does not download script contents.</div>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const search = document.getElementById('search');
    const game = document.getElementById('game');
    const list = document.getElementById('list');
    const status = document.getElementById('status');
    const source = document.getElementById('source');
    const selectedName = document.getElementById('selectedName');
    const selectedPath = document.getElementById('selectedPath');
    const openButton = document.getElementById('open');
    const downloadButton = document.getElementById('download');
    let scripts = [];
    let selected;

    function render() {
      const query = search.value.trim().toLowerCase();
      const gameFilter = game.value;
      const matches = scripts.filter((item) =>
        (gameFilter === 'all' || item.game === gameFilter) &&
        (!query || item.path.toLowerCase().includes(query))
      );
      const visible = matches.slice(0, 500);
      status.textContent = matches.length === scripts.length
        ? scripts.length.toLocaleString() + ' scripts'
        : matches.length.toLocaleString() + ' of ' + scripts.length.toLocaleString() + ' scripts' + (matches.length > 500 ? ' · first 500 shown' : '');
      list.replaceChildren(...visible.map((item) => {
        const button = document.createElement('button');
        button.className = 'script' + (selected?.path === item.path ? ' selected' : '');
        button.title = item.path;
        const name = document.createElement('strong');
        name.textContent = item.name;
        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = item.game + ' · ' + item.category;
        button.append(name, path);
        button.addEventListener('click', () => select(item));
        return button;
      }));
      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = scripts.length ? 'No scripts match this search.' : 'No scripts are available.';
        list.replaceChildren(empty);
      }
    }

    function select(item) {
      selected = item;
      selectedName.textContent = item.name;
      selectedPath.textContent = item.path;
      openButton.disabled = false;
      downloadButton.disabled = false;
      source.className = 'empty';
      source.textContent = 'Loading source…';
      render();
      vscode.postMessage({ type: 'preview', path: item.path });
    }

    search.addEventListener('input', render);
    game.addEventListener('change', render);
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('repository').addEventListener('click', () => vscode.postMessage({ type: 'openRepository' }));
    openButton.addEventListener('click', () => selected && vscode.postMessage({ type: 'open', path: selected.path }));
    downloadButton.addEventListener('click', () => selected && vscode.postMessage({ type: 'download', path: selected.path }));

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'loadingCatalog') {
        status.textContent = 'Loading catalog from GitHub…';
      } else if (message.type === 'catalog') {
        scripts = message.scripts;
        render();
      } else if (message.type === 'loadingPreview' && selected?.path === message.path) {
        source.className = 'empty';
        source.textContent = 'Loading source…';
      } else if (message.type === 'preview' && selected?.path === message.path) {
        const pre = document.createElement('pre');
        pre.textContent = message.source;
        source.className = 'source-pane';
        source.replaceChildren(pre);
      } else if (message.type === 'error' && (!message.path || selected?.path === message.path)) {
        const target = document.getElementById('source');
        target.className = 'empty error';
        target.textContent = message.message;
        status.textContent = scripts.length ? status.textContent : 'Catalog unavailable';
      }
    });
    vscode.postMessage({ type: 'ready' });
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
