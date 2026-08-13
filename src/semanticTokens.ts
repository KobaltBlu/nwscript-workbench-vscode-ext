import * as vscode from "vscode";
import { getSettings } from "./config";
import { EngineApiService } from "./engineApi";

const legend = new vscode.SemanticTokensLegend(
  ["function", "enumMember", "variable", "type"],
  ["defaultLibrary"],
);

const SELECTOR: vscode.DocumentSelector = [{ language: "nwscript" }];

export function registerSemanticTokens(
  context: vscode.ExtensionContext,
  engineApi: EngineApiService,
): void {
  const provider = new NWScriptSemanticTokensProvider(engineApi);
  context.subscriptions.push(
    provider,
    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, provider, legend),
  );
}

class NWScriptSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly configChange: vscode.Disposable;

  readonly onDidChangeSemanticTokens = this.changeEmitter.event;

  constructor(private readonly engineApi: EngineApiService) {
    this.configChange = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nwscript.semanticTokens")) {
        this.changeEmitter.fire();
      }
    });
  }

  dispose(): void {
    this.configChange.dispose();
    this.changeEmitter.dispose();
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): Promise<vscode.SemanticTokens> {
    const builder = new vscode.SemanticTokensBuilder(legend);
    if (!getSettings(document.uri).semanticTokens) {
      return builder.build();
    }
    const model = await this.engineApi.getModel(document).catch(() => undefined);
    if (!model) {
      return builder.build();
    }

    const text = document.getText();
    let quote: string | undefined;
    let lineComment = false;
    let blockComment = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1];
      if (lineComment) {
        if (ch === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (ch === "*" && next === "/") {
          blockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (ch === "\\" && next) i += 1;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === "/" && next === "/") {
        lineComment = true;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        blockComment = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (!/[A-Za-z_]/.test(ch)) continue;

      let end = i + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
      const name = text.slice(i, end);
      const symbols = model.symbolsByName.get(name);
      if (symbols?.length) {
        const symbol = symbols[0];
        const position = document.positionAt(i);
        const type = symbol.kind === "function" ? 0 : symbol.kind === "constant" ? 1 : 2;
        const mods = symbol.sourceKind === "engine" ? 1 : 0;
        builder.push(position.line, position.character, name.length, type, mods);
      }
      i = end - 1;
    }

    return builder.build();
  }
}
