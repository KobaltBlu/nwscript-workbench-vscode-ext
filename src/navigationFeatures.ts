import * as vscode from "vscode";
import {
  EngineApiService,
  type EngineApiModel,
  type EngineSymbol,
  parseScriptSymbols,
} from "./engineApi";
import { ResourceResolver } from "./resourceResolver";
import { basename } from "./uri";

const NWScript_SELECTOR: vscode.DocumentSelector = [
  { language: "nwscript", scheme: "file" },
  { language: "nwscript", scheme: "untitled" },
  { language: "nwscript" },
];

const NSS_EXCLUDE = "**/{node_modules,.git,dist,out,build}/**";

interface IdentifierTarget {
  name: string;
  range: vscode.Range;
  symbols: EngineSymbol[];
}

interface IncludeTarget {
  resource: string;
  range: vscode.Range;
}

export function registerNavigationFeatures(
  context: vscode.ExtensionContext,
  engineApi: EngineApiService,
  resolver: ResourceResolver,
): void {
  const definitionProvider = new NWScriptDefinitionProvider(engineApi, resolver);
  const referenceProvider = new NWScriptReferenceProvider(engineApi);

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      NWScript_SELECTOR,
      definitionProvider,
    ),
    vscode.languages.registerDeclarationProvider(
      NWScript_SELECTOR,
      definitionProvider,
    ),
    vscode.languages.registerReferenceProvider(
      NWScript_SELECTOR,
      referenceProvider,
    ),
    vscode.languages.registerRenameProvider(
      NWScript_SELECTOR,
      new NWScriptRenameProvider(engineApi, referenceProvider),
    ),
    vscode.languages.registerDocumentHighlightProvider(
      NWScript_SELECTOR,
      new NWScriptDocumentHighlightProvider(engineApi),
    ),
    vscode.languages.registerDocumentSymbolProvider(
      NWScript_SELECTOR,
      new NWScriptDocumentSymbolProvider(),
      { label: "NWScript" },
    ),
    vscode.languages.registerWorkspaceSymbolProvider(
      new NWScriptWorkspaceSymbolProvider(resolver),
    ),
    vscode.languages.registerDocumentLinkProvider(
      NWScript_SELECTOR,
      new NWScriptIncludeLinkProvider(resolver),
    ),
  );
}

class NWScriptDefinitionProvider
implements vscode.DefinitionProvider, vscode.DeclarationProvider {
  constructor(
    private readonly engineApi: EngineApiService,
    private readonly resolver: ResourceResolver,
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | undefined> {
    const include = includeAtPosition(document, position);
    if (include) {
      const uri = await this.resolver.resolve(include.resource, document.uri);
      if (!uri || token.isCancellationRequested) {
        return undefined;
      }
      return new vscode.Location(uri, new vscode.Position(0, 0));
    }

    const target = await resolveIdentifierTarget(
      this.engineApi,
      document,
      position,
    );
    if (!target || token.isCancellationRequested) {
      return undefined;
    }

    const locations = uniqueDefinitions(target.symbols).map(
      (symbol) => new vscode.Location(
        symbol.definition!.uri,
        symbol.definition!.selectionRange,
      ),
    );

    return locations.length > 0 ? locations : undefined;
  }

  provideDeclaration(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Declaration> {
    return this.provideDefinition(document, position, token);
  }
}

class NWScriptReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly engineApi: EngineApiService) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const target = await resolveIdentifierTarget(
      this.engineApi,
      document,
      position,
    );
    if (!target || token.isCancellationRequested) {
      return undefined;
    }

    return this.collectReferences(
      target,
      document,
      context.includeDeclaration,
      token,
    );
  }

  async collectReferences(
    target: IdentifierTarget,
    sourceDocument: vscode.TextDocument,
    includeDeclaration: boolean,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const definitionKeys = new Set(
      target.symbols
        .filter((symbol) => symbol.definition)
        .map(symbolDefinitionKey),
    );
    if (definitionKeys.size === 0) {
      return [];
    }

    const files = await workspaceNssUris(sourceDocument);
    const references: vscode.Location[] = [];
    const seen = new Set<string>();

    for (const uri of files) {
      if (token.isCancellationRequested) {
        break;
      }

      let document: vscode.TextDocument;
      try {
        document = findOpenDocument(uri) ?? await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }

      const model = await safelyGetModel(this.engineApi, document);
      if (!model) {
        continue;
      }

      const visible = preferredSymbols(model, target.name);
      if (!visible.some((symbol) => definitionKeys.has(symbolDefinitionKey(symbol)))) {
        continue;
      }

      const declarations = new Set(
        visible
          .filter((symbol) => definitionKeys.has(symbolDefinitionKey(symbol)))
          .filter((symbol) => symbol.definition?.uri.toString() === uri.toString())
          .map((symbol) => rangeKey(symbol.definition!.selectionRange)),
      );

      for (const range of identifierRanges(document, target.name)) {
        if (!includeDeclaration && declarations.has(rangeKey(range))) {
          continue;
        }

        const key = `${uri.toString()}|${rangeKey(range)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        references.push(new vscode.Location(uri, range));
      }
    }

    return references;
  }
}

class NWScriptRenameProvider implements vscode.RenameProvider {
  constructor(
    private readonly engineApi: EngineApiService,
    private readonly references: NWScriptReferenceProvider,
  ) {}

  async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<{ range: vscode.Range; placeholder: string } | undefined> {
    if (includeAtPosition(document, position)) {
      throw new Error("Rename Symbol does not rename #include resource files.");
    }

    const target = await resolveIdentifierTarget(
      this.engineApi,
      document,
      position,
    );
    if (!target) {
      return undefined;
    }

    if (target.symbols.every((symbol) => symbol.sourceKind === "engine")) {
      throw new Error(
        "Engine API symbols come from the active nwscript.nss and cannot be renamed from a script.",
      );
    }

    return {
      range: target.range,
      placeholder: target.name,
    };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    if (!/^[A-Za-z_]\w*$/.test(newName)) {
      throw new Error(`${JSON.stringify(newName)} is not a valid NWScript identifier.`);
    }

    const target = await resolveIdentifierTarget(
      this.engineApi,
      document,
      position,
    );
    if (!target) {
      return undefined;
    }

    if (target.symbols.every((symbol) => symbol.sourceKind === "engine")) {
      throw new Error(
        "Engine API symbols come from the active nwscript.nss and cannot be renamed from a script.",
      );
    }

    const locations = await this.references.collectReferences(
      target,
      document,
      true,
      token,
    );
    if (token.isCancellationRequested) {
      return undefined;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const location of locations) {
      edit.replace(location.uri, location.range, newName);
    }
    return edit;
  }
}

class NWScriptDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
  constructor(private readonly engineApi: EngineApiService) {}

  async provideDocumentHighlights(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentHighlight[] | undefined> {
    const target = await resolveIdentifierTarget(
      this.engineApi,
      document,
      position,
    );
    if (!target || token.isCancellationRequested) {
      return undefined;
    }

    const declarationRanges = new Set(
      target.symbols
        .filter((symbol) => symbol.definition?.uri.toString() === document.uri.toString())
        .map((symbol) => rangeKey(symbol.definition!.selectionRange)),
    );

    return identifierRanges(document, target.name).map(
      (range) => new vscode.DocumentHighlight(
        range,
        declarationRanges.has(rangeKey(range))
          ? vscode.DocumentHighlightKind.Write
          : vscode.DocumentHighlightKind.Read,
      ),
    );
  }
}

class NWScriptDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.DocumentSymbol[] {
    if (token.isCancellationRequested) {
      return [];
    }

    const parsed = parseScriptSymbols(
      document.getText(),
      "document",
      basename(document.uri),
      "Declared in this document",
      document.uri,
    );

    return [...parsed.functions, ...parsed.constants]
      .filter((symbol) => symbol.definition)
      .sort(compareDefinitions)
      .map((symbol) => {
        const definition = symbol.definition!;
        return new vscode.DocumentSymbol(
          symbol.name,
          symbol.kind === "function" ? symbol.signature : symbol.declaration,
          symbolKind(symbol),
          definition.range,
          definition.selectionRange,
        );
      });
  }
}

class NWScriptWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly resolver: ResourceResolver) {}

  async provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.SymbolInformation[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const files = await vscode.workspace.findFiles("**/*.nss", NSS_EXCLUDE);
    const matches: Array<{ score: number; symbol: vscode.SymbolInformation }> = [];

    for (const uri of files) {
      if (token.isCancellationRequested) {
        break;
      }

      let text: string;
      try {
        text = await this.resolver.readText(uri);
      } catch {
        continue;
      }

      const parsed = parseScriptSymbols(
        text,
        "document",
        basename(uri),
        "Workspace symbol",
        uri,
      );

      for (const symbol of [...parsed.functions, ...parsed.constants]) {
        if (!symbol.definition) {
          continue;
        }

        const score = symbolQueryScore(symbol.name, normalizedQuery);
        if (score < 0) {
          continue;
        }

        matches.push({
          score,
          symbol: new vscode.SymbolInformation(
            symbol.name,
            symbolKind(symbol),
            basename(uri),
            new vscode.Location(uri, symbol.definition.selectionRange),
          ),
        });
      }
    }

    matches.sort((a, b) =>
      a.score - b.score || a.symbol.name.localeCompare(b.symbol.name),
    );
    return matches.slice(0, 500).map((entry) => entry.symbol);
  }
}

class NWScriptIncludeLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly resolver: ResourceResolver) {}

  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const links: vscode.DocumentLink[] = [];

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
      if (token.isCancellationRequested) {
        break;
      }

      const line = document.lineAt(lineNumber).text;
      const include = includeFromLine(line, lineNumber);
      if (!include) {
        continue;
      }

      const uri = await this.resolver.resolve(include.resource, document.uri);
      if (!uri) {
        continue;
      }

      const link = new vscode.DocumentLink(include.range, uri);
      link.tooltip = `Open ${include.resource}.nss`;
      links.push(link);
    }

    return links;
  }
}

async function resolveIdentifierTarget(
  engineApi: EngineApiService,
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<IdentifierTarget | undefined> {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!range) {
    return undefined;
  }

  const name = document.getText(range);
  const model = await safelyGetModel(engineApi, document);
  if (!model) {
    return undefined;
  }

  const symbols = preferredSymbols(model, name, document.uri, position)
    .filter((symbol) => symbol.definition);
  if (symbols.length === 0) {
    return undefined;
  }

  return { name, range, symbols };
}

function preferredSymbols(
  model: EngineApiModel,
  name: string,
  documentUri?: vscode.Uri,
  position?: vscode.Position,
): EngineSymbol[] {
  const symbols = [...(model.symbolsByName.get(name) ?? [])];
  if (symbols.length === 0) {
    return [];
  }

  if (documentUri && position) {
    const declarations = symbols.filter(
      (symbol) =>
        symbol.definition?.uri.toString() === documentUri.toString() &&
        symbol.definition.selectionRange.contains(position),
    );
    if (declarations.length > 0) {
      return declarations;
    }
  }

  const rank = Math.min(...symbols.map(sourceRank));
  return symbols.filter((symbol) => sourceRank(symbol) === rank);
}

function sourceRank(symbol: EngineSymbol): number {
  switch (symbol.sourceKind) {
    case "document":
      return 0;
    case "include":
      return 1;
    default:
      return 2;
  }
}

function uniqueDefinitions(symbols: readonly EngineSymbol[]): EngineSymbol[] {
  const result: EngineSymbol[] = [];
  const seen = new Set<string>();

  for (const symbol of symbols) {
    if (!symbol.definition) {
      continue;
    }
    const key = symbolDefinitionKey(symbol);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(symbol);
  }
  return result;
}

function symbolDefinitionKey(symbol: EngineSymbol): string {
  if (!symbol.definition) {
    return `missing:${symbol.sourceKind}:${symbol.name}`;
  }
  return `${symbol.definition.uri.toString()}|${rangeKey(symbol.definition.selectionRange)}`;
}

function rangeKey(range: vscode.Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function identifierRanges(
  document: vscode.TextDocument,
  name: string,
): vscode.Range[] {
  const text = document.getText();
  const ranges: vscode.Range[] = [];
  let quote: string | undefined;
  let escaped = false;
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
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
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

    if (!/[A-Za-z_]/.test(ch)) {
      continue;
    }

    let end = i + 1;
    while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
      end += 1;
    }

    if (text.slice(i, end) === name) {
      ranges.push(new vscode.Range(
        document.positionAt(i),
        document.positionAt(end),
      ));
    }
    i = end - 1;
  }

  return ranges;
}

async function workspaceNssUris(
  sourceDocument: vscode.TextDocument,
): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles("**/*.nss", NSS_EXCLUDE);
  const byUri = new Map(files.map((uri) => [uri.toString(), uri]));

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === "nwscript" || document.uri.path.toLowerCase().endsWith(".nss")) {
      byUri.set(document.uri.toString(), document.uri);
    }
  }
  byUri.set(sourceDocument.uri.toString(), sourceDocument.uri);

  return [...byUri.values()];
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === key,
  );
}

async function safelyGetModel(
  engineApi: EngineApiService,
  document: vscode.TextDocument,
): Promise<EngineApiModel | undefined> {
  try {
    return await engineApi.getModel(document);
  } catch {
    return undefined;
  }
}

function includeAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): IncludeTarget | undefined {
  return includeFromLine(document.lineAt(position.line).text, position.line, position);
}

function includeFromLine(
  line: string,
  lineNumber: number,
  position?: vscode.Position,
): IncludeTarget | undefined {
  const match = /^\s*#\s*include\s+"([^"]+)"/.exec(line);
  if (!match) {
    return undefined;
  }

  const value = match[1];
  const start = line.indexOf(value, match.index);
  if (start < 0) {
    return undefined;
  }

  const range = new vscode.Range(
    lineNumber,
    start,
    lineNumber,
    start + value.length,
  );

  if (position && !range.contains(position)) {
    return undefined;
  }

  return { resource: value, range };
}

function compareDefinitions(a: EngineSymbol, b: EngineSymbol): number {
  const aStart = a.definition!.selectionRange.start;
  const bStart = b.definition!.selectionRange.start;
  return aStart.line - bStart.line || aStart.character - bStart.character;
}

function symbolKind(symbol: EngineSymbol): vscode.SymbolKind {
  if (symbol.kind === "function") {
    return vscode.SymbolKind.Function;
  }
  return symbol.kind === "constant"
    ? vscode.SymbolKind.Constant
    : vscode.SymbolKind.Variable;
}

function symbolQueryScore(name: string, query: string): number {
  if (!query) {
    return 2;
  }

  const normalized = name.toLowerCase();
  if (normalized === query) {
    return 0;
  }
  if (normalized.startsWith(query)) {
    return 1;
  }
  if (normalized.includes(query)) {
    return 2;
  }
  return -1;
}
