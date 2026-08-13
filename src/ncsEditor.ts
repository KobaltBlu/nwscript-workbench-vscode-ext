import type { NcsInspection, NdbInspection } from "@neverwinter/nwscript-wasm";
import * as vscode from "vscode";
import { buildWorkspaceActionCompat, type ActionCompatStatus } from "./actionCompat";
import { CompilerService } from "./compilerService";
import { EngineApiService } from "./engineApi";
import {
  renderNcsError,
  renderNcsInspector,
  toBase64,
  type NcsActionInfo,
} from "./ncsInspectorView";
import { basename, basenameWithoutExtension, dirname } from "./uri";

export const NCS_HEX_VIEW_TYPE = "nwscript.ncsHex";
const DISASSEMBLY_SCHEME = "nwscript-disassembly";

class NcsDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    // The document is readonly and owns no persistent resources.
  }
}

class DisassemblyContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.changeEmitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.changeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "; Disassembly is not available.\n";
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.contents.clear();
  }
}

interface InspectorPayload {
  filename: string;
  bytes: Uint8Array;
  inspection: NcsInspection;
  inspectError?: string;
  actions: NcsActionInfo[];
  compat: Record<number, ActionCompatStatus>;
  ndb?: NdbInspection;
  revealCodeOffset?: number;
}

export class NcsEditorProvider
  implements vscode.CustomReadonlyEditorProvider<NcsDocument>, vscode.Disposable {
  private readonly disassemblyProvider = new DisassemblyContentProvider();
  private readonly registrations: vscode.Disposable[] = [];
  private readonly revealByUri = new Map<string, number>();
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly compiler: CompilerService,
    private readonly engineApi: EngineApiService,
  ) {
    this.registrations.push(
      vscode.workspace.registerTextDocumentContentProvider(
        DISASSEMBLY_SCHEME,
        this.disassemblyProvider,
      ),
      vscode.window.registerCustomEditorProvider(
        NCS_HEX_VIEW_TYPE,
        this,
        {
          supportsMultipleEditorsPerDocument: true,
          webviewOptions: {
            retainContextWhenHidden: true,
          },
        },
      ),
    );
  }

  dispose(): void {
    for (const registration of this.registrations) {
      registration.dispose();
    }
    this.disassemblyProvider.dispose();
  }

  revealAtCodeOffset(uri: vscode.Uri, codeOffset: number): void {
    this.revealByUri.set(uri.toString(), codeOffset);
    const panel = this.panels.get(uri.toString());
    if (panel) {
      void panel.webview.postMessage({ type: "reveal", codeOffset });
    }
  }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): NcsDocument {
    return new NcsDocument(uri);
  }

  async resolveCustomEditor(
    document: NcsDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };

    const payload = await this.loadPayload(document.uri);
    if (token.isCancellationRequested) {
      return;
    }
    if (!payload) {
      webviewPanel.webview.html = renderNcsError(
        webviewPanel.webview,
        basename(document.uri),
        new Error("Unable to read the NCS file."),
      );
      return;
    }

    this.panels.set(document.uri.toString(), webviewPanel);
    webviewPanel.webview.html = renderNcsInspector(webviewPanel.webview, payload);

    const folder = dirname(document.uri);
    const stem = basenameWithoutExtension(document.uri);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, basename(document.uri)),
    );
    const ndbWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${stem}.ndb`),
    );
    const reload = async (): Promise<void> => {
      const next = await this.loadPayload(document.uri);
      if (!next) return;
      await webviewPanel.webview.postMessage({
        type: "reload",
        filename: next.filename,
        bytes: toBase64(next.bytes),
        inspection: next.inspection,
        inspectError: next.inspectError ?? "",
        actions: next.actions,
        compat: next.compat,
        ndb: next.ndb ?? null,
      });
    };

    const subscriptions = [
      watcher,
      ndbWatcher,
      watcher.onDidChange(() => void reload()),
      watcher.onDidCreate(() => void reload()),
      ndbWatcher.onDidChange(() => void reload()),
      ndbWatcher.onDidCreate(() => void reload()),
      ndbWatcher.onDidDelete(() => void reload()),
      webviewPanel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type === "copy" && typeof message.text === "string") {
          await vscode.env.clipboard.writeText(message.text);
          return;
        }
        if (message?.type === "openSource") {
          await openNdbSource(document.uri, String(message.file ?? ""), Number(message.line));
        }
      }),
    ];
    webviewPanel.onDidDispose(() => {
      this.panels.delete(document.uri.toString());
      for (const item of subscriptions) item.dispose();
    });
  }

  async openDisassemblyPreview(
    source: vscode.Uri,
    preserveFocus = false,
  ): Promise<void> {
    const previewUri = disassemblyUri(source);
    let content: string;

    try {
      content = await this.compiler.disassembleText(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      content = [
        "; NWScript NCS disassembly could not be generated.",
        `; Source: ${source.toString(true)}`,
        `; ${message.replace(/\r?\n/g, "\n; ")}`,
        "",
      ].join("\n");
    }

    this.disassemblyProvider.set(previewUri, content);

    const document = await vscode.workspace.openTextDocument(previewUri);
    if (document.languageId !== "nwscript-asm") {
      await vscode.languages.setTextDocumentLanguage(document, "nwscript-asm");
    }

    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus,
    });
  }

  async openNcsForSource(source: vscode.Uri, symbolName?: string): Promise<void> {
    const ncsUri = source.with({
      path: `${source.path.replace(/\.nss$/i, "")}.ncs`,
    });
    try {
      await vscode.workspace.fs.stat(ncsUri);
    } catch {
      throw new Error(`No sibling NCS file was found for ${basename(source)}.`);
    }

    const name = symbolName || basenameWithoutExtension(source);
    let codeOffset: number | undefined;
    const ndbUri = source.with({
      path: `${source.path.replace(/\.nss$/i, "")}.ndb`,
    });
    try {
      const ndb = await this.compiler.inspectNdb(ndbUri);
      const match = ndb.functions.find(
        (fn) => fn.label.toLowerCase() === name.toLowerCase(),
      );
      if (match) {
        codeOffset = match.codeOffsetStart;
      }
    } catch {
      // NDB is optional; fall through to opening the inspector.
    }

    if (codeOffset != null) {
      this.revealAtCodeOffset(ncsUri, codeOffset);
    }
    await vscode.commands.executeCommand("vscode.openWith", ncsUri, NCS_HEX_VIEW_TYPE);
  }

  async saveDisassembly(source: vscode.Uri): Promise<void> {
    const content = await this.compiler.disassembleText(source);
    const defaultUri = source.with({
      path: `${source.path.slice(0, source.path.length - 4)}.ncsasm`,
    });
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "NCS assembly": ["ncsasm", "asm", "txt"] },
      saveLabel: "Save Disassembly",
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  }

  private async loadPayload(uri: vscode.Uri): Promise<InspectorPayload | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return undefined;
    }

    let inspection: NcsInspection = {
      header: { present: false, size: 0, parts: [] },
      instructions: [],
    };
    let inspectError: string | undefined;
    try {
      inspection = await this.compiler.inspectNcs(uri);
      if (inspection.error?.message) {
        inspectError = inspection.error.message;
      }
    } catch (error) {
      inspectError = error instanceof Error ? error.message : String(error);
    }

    const [actions, compat, ndb] = await Promise.all([
      this.loadActions(uri),
      this.loadCompat(uri),
      this.loadNdb(uri),
    ]);

    const revealCodeOffset = this.revealByUri.get(uri.toString());
    if (revealCodeOffset != null) {
      this.revealByUri.delete(uri.toString());
    }

    return {
      filename: `${basenameWithoutExtension(uri)}.ncs`,
      bytes,
      inspection,
      inspectError,
      actions,
      compat,
      ndb,
      revealCodeOffset,
    };
  }

  private async loadActions(uri: vscode.Uri): Promise<NcsActionInfo[]> {
    try {
      const model = await this.engineApi.getModelForUri(uri);
      return (model?.functions ?? [])
        .filter((fn) => fn.actionId != null)
        .map((fn) => ({
          actionId: fn.actionId as number,
          name: fn.name,
          signature: fn.signature,
          documentation: fn.documentation,
        }));
    } catch {
      return [];
    }
  }

  private async loadCompat(uri: vscode.Uri): Promise<Record<number, ActionCompatStatus>> {
    try {
      const report = await buildWorkspaceActionCompat(this.compiler, uri);
      return report.byActionId;
    } catch {
      return {};
    }
  }

  private async loadNdb(uri: vscode.Uri): Promise<NdbInspection | undefined> {
    const ndbUri = uri.with({ path: `${uri.path.slice(0, uri.path.length - 4)}.ndb` });
    try {
      return await this.compiler.inspectNdb(ndbUri);
    } catch {
      return undefined;
    }
  }
}

function disassemblyUri(source: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({
    scheme: DISASSEMBLY_SCHEME,
    path: `${source.path.slice(0, source.path.length - 4)}.ncsasm`,
    query: `source=${encodeURIComponent(source.toString(true))}`,
  });
}

async function openNdbSource(ncsUri: vscode.Uri, file: string, line: number): Promise<void> {
  const name = file.toLowerCase().endsWith(".nss") ? file : `${file}.nss`;
  const sibling = vscode.Uri.joinPath(dirname(ncsUri), name);
  const candidates = [sibling];
  const folder = vscode.workspace.getWorkspaceFolder(ncsUri);
  if (folder) {
    candidates.push(vscode.Uri.joinPath(folder.uri, name));
  }
  for (const candidate of candidates) {
    try {
      await vscode.workspace.fs.stat(candidate);
      const document = await vscode.workspace.openTextDocument(candidate);
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(position, position),
      });
      return;
    } catch {
      // try the next candidate
    }
  }
  void vscode.window.showWarningMessage(`Could not open source ${name}:${line}`);
}
