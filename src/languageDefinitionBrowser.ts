import * as vscode from "vscode";
import { basename, dirname, workspaceFolderFor, writeFileCreatingParents } from "./uri";

const REPOSITORY = "KobaltBlu/nwscript-language-definitions";
const BRANCH = "main";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const TREE_URL = `https://api.github.com/repos/${REPOSITORY}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE_URL = `https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}/`;
const VIEW_TYPE = "nwscript.languageDefinitionBrowser";

interface TreeResponse {
  truncated?: boolean;
  tree?: Array<{ path?: string; type?: string }>;
  message?: string;
}

interface DefinitionMetadata {
  schemaVersion?: number;
  id?: string;
  name?: string;
  aliases?: string[];
  engine?: string;
  language?: string;
  definitionFile?: string;
  gameVersion?: string | null;
  source?: { provenance?: string | null; notes?: string | null };
  file?: { encoding?: string; sizeBytes?: number; sha256?: string };
}

interface DefinitionEntry extends DefinitionMetadata {
  metadataPath: string;
  definitionPath: string;
}

interface BrowserMessage { type?: string; path?: string }

export class LanguageDefinitionBrowser implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private catalog?: DefinitionEntry[];
  private catalogPromise?: Promise<DefinitionEntry[]>;
  private readonly sourceCache = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Language Definitions", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
    panel.webview.onDidReceiveMessage((message: BrowserMessage) => void this.handleMessage(message), undefined, this.disposables);
    panel.webview.html = renderHtml(panel.webview);
  }

  private async handleMessage(message: BrowserMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready": await this.sendCatalog(false); break;
        case "refresh": await this.sendCatalog(true); break;
        case "preview": await this.preview(this.requireEntry(message.path)); break;
        case "open": await this.openInEditor(this.requireEntry(message.path)); break;
        case "download": await this.download(this.requireEntry(message.path)); break;
        case "openRepository": await vscode.env.openExternal(vscode.Uri.parse(REPOSITORY_URL)); break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.panel?.webview.postMessage({ type: "error", message: detail, path: message.path });
      void vscode.window.showErrorMessage(`NWScript Workbench: ${detail}`);
    }
  }

  private async sendCatalog(refresh: boolean): Promise<void> {
    await this.panel?.webview.postMessage({ type: "loadingCatalog" });
    if (refresh) {
      this.catalog = undefined;
      this.catalogPromise = undefined;
      this.sourceCache.clear();
    }
    try {
      const definitions = await this.getCatalog();
      await this.panel?.webview.postMessage({ type: "catalog", definitions });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.panel?.webview.postMessage({ type: "error", message: detail });
    }
  }

  private async getCatalog(): Promise<DefinitionEntry[]> {
    if (this.catalog) return this.catalog;
    this.catalogPromise ??= this.fetchCatalog();
    try { return this.catalog = await this.catalogPromise; }
    finally { this.catalogPromise = undefined; }
  }

  private async fetchCatalog(): Promise<DefinitionEntry[]> {
    const response = await fetch(TREE_URL, { headers: githubHeaders() });
    const payload = await response.json() as TreeResponse;
    if (!response.ok) throw githubError(response, payload.message);
    if (payload.truncated) throw new Error("GitHub returned a truncated repository tree; the definition catalog cannot be shown safely.");
    const metadataPaths = (payload.tree ?? [])
      .filter((item) => item.type === "blob" && /^games\/.+\/metadata\.json$/i.test(item.path ?? ""))
      .map((item) => item.path as string);
    const entries = await Promise.all(metadataPaths.map(async (metadataPath) => {
      const metadataResponse = await fetch(rawUrl(metadataPath));
      if (!metadataResponse.ok) throw new Error(`Unable to load ${metadataPath}: GitHub returned HTTP ${metadataResponse.status}.`);
      const metadata = await metadataResponse.json() as DefinitionMetadata;
      const parent = metadataPath.slice(0, metadataPath.lastIndexOf("/") + 1);
      const definitionFile = metadata.definitionFile?.trim() || "nwscript.nss";
      if (definitionFile.includes("..") || definitionFile.includes("/") || definitionFile.includes("\\")) {
        throw new Error(`${metadataPath} contains an unsafe definitionFile.`);
      }
      return { ...metadata, metadataPath, definitionPath: parent + definitionFile };
    }));
    return entries.sort((a, b) => (a.name ?? a.id ?? a.definitionPath).localeCompare(b.name ?? b.id ?? b.definitionPath));
  }

  private requireEntry(path: string | undefined): DefinitionEntry {
    if (!path) throw new Error("No language definition was selected.");
    const entry = this.catalog?.find((item) => item.definitionPath === path);
    if (!entry) throw new Error("The selected definition is not part of the current upstream catalog.");
    return entry;
  }

  private async getSource(entry: DefinitionEntry): Promise<string> {
    const cached = this.sourceCache.get(entry.definitionPath);
    if (cached !== undefined) return cached;
    const response = await fetch(rawUrl(entry.definitionPath));
    if (!response.ok) throw new Error(`Unable to download ${entry.definitionPath}: GitHub returned HTTP ${response.status}.`);
    const source = await response.text();
    this.sourceCache.set(entry.definitionPath, source);
    return source;
  }

  private async preview(entry: DefinitionEntry): Promise<void> {
    await this.panel?.webview.postMessage({ type: "loadingPreview", path: entry.definitionPath });
    await this.panel?.webview.postMessage({ type: "preview", path: entry.definitionPath, source: await this.getSource(entry) });
  }

  private async openInEditor(entry: DefinitionEntry): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: "nwscript", content: await this.getSource(entry) });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async download(entry: DefinitionEntry): Promise<void> {
    const target = await this.chooseTarget(entry, "Download Language Definition");
    if (!target) return;
    await writeFileCreatingParents(
      target,
      new TextEncoder().encode(await this.getSource(entry)),
    );
    const action = await vscode.window.showInformationMessage(`Downloaded ${basename(target)}.`, "Open");
    if (action === "Open") await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  }

  private async chooseTarget(entry: DefinitionEntry, title: string): Promise<vscode.Uri | undefined> {
    const folder = workspaceFolderFor();
    const segments = entry.definitionPath.split("/").slice(1);
    let defaultUri: vscode.Uri | undefined;
    if (folder) {
      const repositoryStyleUri = vscode.Uri.joinPath(folder.uri, "games", ...segments);
      try {
        const parent = dirname(repositoryStyleUri);
        const stat = await vscode.workspace.fs.stat(parent);
        defaultUri = (stat.type & vscode.FileType.Directory) !== 0
          ? repositoryStyleUri
          : vscode.Uri.joinPath(folder.uri, "nwscript.nss");
      } catch {
        // Keep the save dialog side-effect free. Missing directories are
        // created from the user's final selection only after confirmation.
        defaultUri = vscode.Uri.joinPath(folder.uri, "nwscript.nss");
      }
    }
    return vscode.window.showSaveDialog({
      defaultUri,
      filters: { "NWScript language specification": ["nss"] },
      saveLabel: "Save nwscript.nss",
      title,
    });
  }
}

function githubHeaders(): Record<string, string> {
  return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

function githubError(response: Response, message?: string): Error {
  const suffix = response.headers.get("x-ratelimit-remaining") === "0" ? " GitHub's anonymous API rate limit has been reached; try again later." : "";
  return new Error(`${message ?? `GitHub returned HTTP ${response.status}`}.${suffix}`);
}

function rawUrl(path: string): string {
  return `${RAW_BASE_URL}${path.split("/").map(encodeURIComponent).join("/")}`;
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const csp = ["default-src 'none'", `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join("; ");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Language Definitions</title>
  <style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}.shell{height:100vh;display:grid;grid-template-rows:auto 1fr}header{padding:18px 22px 14px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}.title-row,.preview-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}h1{margin:0 0 5px;font-size:23px}.subtitle,.status,.detail,.empty{color:var(--vscode-descriptionForeground)}.subtitle{margin:0;line-height:1.45}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:8px;margin-top:14px}input{width:100%;border:1px solid var(--vscode-input-border,transparent);color:var(--vscode-input-foreground);background:var(--vscode-input-background);padding:7px 9px;outline:none}input:focus{border-color:var(--vscode-focusBorder)}.button{border:1px solid var(--vscode-button-border,transparent);border-radius:3px;padding:7px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.button:hover{background:var(--vscode-button-hoverBackground)}.button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.content{min-height:0;display:grid;grid-template-columns:minmax(300px,36%) 1fr}.catalog{min-height:0;border-right:1px solid var(--vscode-panel-border);display:grid;grid-template-rows:auto 1fr}.status{padding:9px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px}.list{overflow:auto}.entry{width:100%;text-align:left;border:0;border-bottom:1px solid var(--vscode-panel-border);color:inherit;background:transparent;padding:12px}.entry:hover{background:var(--vscode-list-hoverBackground)}.entry.selected{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}.entry strong,.entry span{display:block}.detail{font-size:11px;margin-top:4px}.preview{min-width:0;min-height:0;display:grid;grid-template-rows:auto auto 1fr}.preview-head{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);align-items:center}.preview-title{min-width:0}.preview-title strong,.preview-title span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.metadata{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);display:grid;grid-template-columns:110px 1fr;gap:5px 12px}.metadata div:nth-child(odd){color:var(--vscode-descriptionForeground)}.source{min-height:0;overflow:hidden}pre{height:100%;margin:0;padding:14px 16px 40px;overflow:auto;white-space:pre;tab-size:4;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.45}.empty{padding:22px;line-height:1.55}.error{color:var(--vscode-errorForeground)}@media(max-width:760px){.content{grid-template-columns:1fr;grid-template-rows:minmax(220px,42%) 1fr}.catalog{border-right:0;border-bottom:1px solid var(--vscode-panel-border)}.preview-head{flex-direction:column}.metadata{grid-template-columns:90px 1fr}}
  </style></head><body><div class="shell"><header><div class="title-row"><div><h1>Language Definitions</h1><p class="subtitle">Browse canonical nwscript.nss files for each game.</p></div><button id="refresh" class="button secondary">Refresh</button></div><div class="toolbar"><input id="search" type="search" placeholder="Search games, aliases, engines, and versions…" aria-label="Search language definitions"><button id="repository" class="button secondary">View Source Repository</button></div></header><div class="content"><section class="catalog"><div id="status" class="status">Loading catalog…</div><div id="list" class="list"></div></section><section class="preview"><div class="preview-head"><div class="preview-title"><strong id="name">Select a definition</strong><span id="path" class="detail">Metadata and source preview will appear here.</span></div><div class="actions"><button id="open" class="button secondary" disabled>Open in Editor</button><button id="download" class="button" disabled>Download…</button></div></div><div id="metadata" class="metadata" hidden></div><div id="source" class="source empty">Select a game to inspect its canonical NWScript API definition.</div></section></div></div>
  <script nonce="${nonce}">
    const vscode=acquireVsCodeApi(),search=document.getElementById('search'),list=document.getElementById('list'),status=document.getElementById('status'),source=document.getElementById('source'),metadata=document.getElementById('metadata'),name=document.getElementById('name'),path=document.getElementById('path'),openButton=document.getElementById('open'),downloadButton=document.getElementById('download');let definitions=[],selected;
    const text=(value,fallback='Not specified')=>value===null||value===undefined||value===''?fallback:String(value);
    function render(){const query=search.value.trim().toLowerCase();const matches=definitions.filter(item=>[item.id,item.name,...(item.aliases||[]),item.engine,item.gameVersion,item.definitionPath].filter(Boolean).join(' ').toLowerCase().includes(query));status.textContent=(query?matches.length+' of ': '')+definitions.length+' language definition'+(definitions.length===1?'':'s');list.replaceChildren(...matches.map(item=>{const button=document.createElement('button');button.className='entry'+(selected?.definitionPath===item.definitionPath?' selected':'');button.title=item.definitionPath;const title=document.createElement('strong');title.textContent=item.name||item.id||item.definitionPath;const detail=document.createElement('span');detail.className='detail';detail.textContent=[item.id,item.engine,item.gameVersion].filter(Boolean).join(' · ');button.append(title,detail);button.addEventListener('click',()=>select(item));return button}));if(!matches.length){const empty=document.createElement('div');empty.className='empty';empty.textContent=definitions.length?'No definitions match this search.':'No definitions are available.';list.replaceChildren(empty)}}
    function select(item){selected=item;name.textContent=item.name||item.id||'Language definition';path.textContent=item.definitionPath;for(const button of [openButton,downloadButton])button.disabled=false;const rows=[['Game ID',text(item.id)],['Aliases',(item.aliases||[]).join(', ')||'None'],['Engine',text(item.engine)],['Game version',text(item.gameVersion,'Unverified')],['File size',item.file?.sizeBytes?item.file.sizeBytes.toLocaleString()+' bytes':'Not specified'],['SHA-256',text(item.file?.sha256)],['Source',text(item.source?.provenance,'Unverified')]];metadata.replaceChildren(...rows.flatMap(([label,value])=>{const a=document.createElement('div'),b=document.createElement('div');a.textContent=label;b.textContent=value;return[a,b]}));metadata.hidden=false;source.className='source empty';source.textContent='Loading source…';render();vscode.postMessage({type:'preview',path:item.definitionPath})}
    search.addEventListener('input',render);document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.getElementById('repository').addEventListener('click',()=>vscode.postMessage({type:'openRepository'}));openButton.addEventListener('click',()=>selected&&vscode.postMessage({type:'open',path:selected.definitionPath}));downloadButton.addEventListener('click',()=>selected&&vscode.postMessage({type:'download',path:selected.definitionPath}));window.addEventListener('message',event=>{const message=event.data;if(message.type==='loadingCatalog')status.textContent='Loading catalog from GitHub…';else if(message.type==='catalog'){definitions=message.definitions;render()}else if(message.type==='loadingPreview'&&selected?.definitionPath===message.path){source.className='source empty';source.textContent='Loading source…'}else if(message.type==='preview'&&selected?.definitionPath===message.path){const pre=document.createElement('pre');pre.textContent=message.source;source.className='source';source.replaceChildren(pre)}else if(message.type==='error'&&(!message.path||selected?.definitionPath===message.path)){source.className='source empty error';source.textContent=message.message;if(!definitions.length)status.textContent='Catalog unavailable'}});vscode.postMessage({type:'ready'});
  </script></body></html>`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return value;
}
