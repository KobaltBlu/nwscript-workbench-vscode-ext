import * as vscode from "vscode";
import {
  EngineApiService,
  type EngineApiModel,
  type EngineFunction,
  type EngineParameter,
  type EngineSymbol,
  renderSymbolDocumentation,
} from "./engineApi";
import { ResourceResolver } from "./resourceResolver";
import { registerNavigationFeatures } from "./navigationFeatures";

interface CallContext {
  functionName: string;
  argumentIndex: number;
}

interface DelimiterFrame {
  kind: "paren" | "bracket" | "brace";
  functionName?: string;
  argumentIndex: number;
}

const NWScript_SELECTOR: vscode.DocumentSelector = [
  { language: "nwscript", scheme: "file" },
  { language: "nwscript", scheme: "untitled" },
  { language: "nwscript" },
];

export function registerLanguageFeatures(
  context: vscode.ExtensionContext,
  engineApi: EngineApiService,
  resolver: ResourceResolver,
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      NWScript_SELECTOR,
      new EngineCompletionProvider(engineApi),
    ),
    vscode.languages.registerSignatureHelpProvider(
      NWScript_SELECTOR,
      new EngineSignatureHelpProvider(engineApi),
      {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","],
      },
    ),
    vscode.languages.registerHoverProvider(
      NWScript_SELECTOR,
      new EngineHoverProvider(engineApi),
    ),
  );

  registerNavigationFeatures(context, engineApi, resolver);
}

class EngineCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly engineApi: EngineApiService) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    _position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const model = await safelyGetModel(this.engineApi, document);
    if (!model || token.isCancellationRequested) {
      return undefined;
    }

    return model.symbols.map((symbol) => createCompletionItem(symbol, model));
  }
}

class EngineSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly engineApi: EngineApiService) {}

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.SignatureHelpContext,
  ): Promise<vscode.SignatureHelp | undefined> {
    const call = findCallContext(document.getText(), document.offsetAt(position));
    if (!call) {
      return undefined;
    }

    const model = await safelyGetModel(this.engineApi, document);
    if (!model || token.isCancellationRequested) {
      return undefined;
    }

    const overloads = model.functionsByName.get(call.functionName);
    if (!overloads?.length) {
      return undefined;
    }

    const help = new vscode.SignatureHelp();
    help.signatures = overloads.map((fn) => createSignatureInformation(fn, model));
    help.activeSignature = chooseActiveSignature(overloads, call.argumentIndex, context);
    const activeFunction = overloads[help.activeSignature] ?? overloads[0];
    help.activeParameter = activeFunction.parameters.length > 0
      ? Math.min(call.argumentIndex, activeFunction.parameters.length - 1)
      : 0;
    return help;
  }
}

class EngineHoverProvider implements vscode.HoverProvider {
  constructor(private readonly engineApi: EngineApiService) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!range) {
      return undefined;
    }

    const name = document.getText(range);
    const model = await safelyGetModel(this.engineApi, document);
    if (!model || token.isCancellationRequested) {
      return undefined;
    }

    const symbols = model.symbolsByName.get(name);
    if (!symbols?.length) {
      return undefined;
    }

    const markdown: vscode.MarkdownString[] = [];
    for (const symbol of symbols) {
      markdown.push(renderSymbolDocumentation(symbol, model.source));
    }
    return new vscode.Hover(markdown, range);
  }
}

async function safelyGetModel(
  engineApi: EngineApiService,
  document: vscode.TextDocument,
): Promise<EngineApiModel | undefined> {
  try {
    return await engineApi.getModel(document);
  } catch {
    // Language features should quietly yield to normal editor behavior when
    // the project does not yet have a resolvable language specification.
    return undefined;
  }
}

function createCompletionItem(
  symbol: EngineSymbol,
  model: EngineApiModel,
): vscode.CompletionItem {
  if (symbol.kind === "function") {
    const label: vscode.CompletionItemLabel = {
      label: symbol.name,
      detail: `(${symbol.parameters.map(formatParameterCompact).join(", ")})`,
      description: symbol.returnType,
    };
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
    item.detail = symbol.actionId !== undefined
      ? `${symbol.signature} · ACTION #${symbol.actionId}`
      : `${symbol.signature} · ${symbol.sourceLabel}`;
    item.documentation = renderSymbolDocumentation(symbol, model.source);
    item.insertText = createFunctionSnippet(symbol);
    item.sortText = `${sourceSortPrefix(symbol)}_0_${symbol.name}`;
    item.command = {
      command: "editor.action.triggerParameterHints",
      title: "Show NWScript signature help",
    };
    return item;
  }

  const item = new vscode.CompletionItem(
    {
      label: symbol.name,
      detail: symbol.value !== undefined ? ` = ${symbol.value}` : "",
      description: symbol.type,
    },
    symbol.kind === "constant"
      ? vscode.CompletionItemKind.Constant
      : vscode.CompletionItemKind.Variable,
  );
  item.detail = symbol.declaration;
  item.documentation = renderSymbolDocumentation(symbol, model.source);
  item.sortText = `${sourceSortPrefix(symbol)}_1_${symbol.name}`;
  return item;
}

function sourceSortPrefix(symbol: EngineSymbol): string {
  switch (symbol.sourceKind) {
    case "document":
      return "0";
    case "include":
      return "1";
    default:
      return "2";
  }
}

function createFunctionSnippet(fn: EngineFunction): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  snippet.appendText(`${fn.name}(`);
  fn.parameters.forEach((parameter, index) => {
    if (index > 0) {
      snippet.appendText(", ");
    }
    snippet.appendPlaceholder(parameter.name, index + 1);
  });
  snippet.appendText(")");
  return snippet;
}

function createSignatureInformation(
  fn: EngineFunction,
  model: EngineApiModel,
): vscode.SignatureInformation {
  const info = new vscode.SignatureInformation(
    fn.signature,
    renderSymbolDocumentation(fn, model.source),
  );

  info.parameters = fn.parameters.map((parameter) => {
    const label = formatParameter(parameter);
    const start = fn.signature.indexOf(label);
    const parameterInfo = new vscode.ParameterInformation(
      start >= 0 ? [start, start + label.length] : label,
      parameterDocumentation(parameter),
    );
    return parameterInfo;
  });

  return info;
}

function parameterDocumentation(parameter: EngineParameter): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${parameter.name}** · \`${parameter.type}\``);
  if (parameter.defaultValue !== undefined) {
    markdown.appendMarkdown(`  \nDefault: \`${escapeInlineCode(parameter.defaultValue)}\``);
  }
  if (parameter.documentation) {
    markdown.appendMarkdown(`\n\n${escapeMarkdownText(parameter.documentation)}`);
  }
  return markdown;
}

function chooseActiveSignature(
  overloads: readonly EngineFunction[],
  argumentIndex: number,
  context: vscode.SignatureHelpContext,
): number {
  const previous = context.activeSignatureHelp?.activeSignature;
  if (
    previous !== undefined &&
    previous >= 0 &&
    previous < overloads.length &&
    canAcceptArgument(overloads[previous], argumentIndex)
  ) {
    return previous;
  }

  const exact = overloads.findIndex((fn) => canAcceptArgument(fn, argumentIndex));
  return exact >= 0 ? exact : 0;
}

function canAcceptArgument(fn: EngineFunction, argumentIndex: number): boolean {
  return fn.parameters.length === 0
    ? argumentIndex === 0
    : argumentIndex < fn.parameters.length;
}

function findCallContext(text: string, offset: number): CallContext | undefined {
  const stack: DelimiterFrame[] = [];
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < offset; i += 1) {
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

    if (ch === "(") {
      stack.push({
        kind: "paren",
        functionName: identifierBefore(text, i),
        argumentIndex: 0,
      });
      continue;
    }
    if (ch === "[") {
      stack.push({ kind: "bracket", argumentIndex: 0 });
      continue;
    }
    if (ch === "{") {
      stack.push({ kind: "brace", argumentIndex: 0 });
      continue;
    }
    if (ch === ")") {
      popDelimiter(stack, "paren");
      continue;
    }
    if (ch === "]") {
      popDelimiter(stack, "bracket");
      continue;
    }
    if (ch === "}") {
      popDelimiter(stack, "brace");
      continue;
    }
    if (ch === "," && stack.at(-1)?.kind === "paren") {
      stack[stack.length - 1].argumentIndex += 1;
    }
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    if (frame.kind === "paren" && frame.functionName) {
      return {
        functionName: frame.functionName,
        argumentIndex: frame.argumentIndex,
      };
    }
  }
  return undefined;
}

function popDelimiter(stack: DelimiterFrame[], kind: DelimiterFrame["kind"]): void {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].kind === kind) {
      stack.splice(i, 1);
      return;
    }
  }
}

function identifierBefore(text: string, offset: number): string | undefined {
  let end = offset;
  while (end > 0 && /\s/.test(text[end - 1])) {
    end -= 1;
  }
  let start = end;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) {
    start -= 1;
  }
  const value = text.slice(start, end);
  return /^[A-Za-z_]\w*$/.test(value) ? value : undefined;
}

function formatParameter(parameter: EngineParameter): string {
  return `${parameter.type} ${parameter.name}${
    parameter.defaultValue !== undefined ? ` = ${parameter.defaultValue}` : ""
  }`;
}

function formatParameterCompact(parameter: EngineParameter): string {
  return `${parameter.type} ${parameter.name}${
    parameter.defaultValue !== undefined ? `=${parameter.defaultValue}` : ""
  }`;
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}
