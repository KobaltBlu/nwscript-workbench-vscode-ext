import * as vscode from "vscode";
import { getSettings } from "./config";

const SELECTOR: vscode.DocumentSelector = [{ language: "nwscript" }];
const INDENT = "  ";

export function registerFormatting(context: vscode.ExtensionContext): void {
  const folding = new NWScriptFoldingProvider();
  context.subscriptions.push(
    folding,
    vscode.languages.registerDocumentFormattingEditProvider(
      SELECTOR,
      new NWScriptFormattingProvider(),
    ),
    vscode.languages.registerFoldingRangeProvider(SELECTOR, folding),
  );
}

class NWScriptFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    if (!getSettings(document.uri).formatting) {
      return [];
    }
    const original = document.getText();
    const formatted = formatNss(original);
    if (formatted === original) {
      return [];
    }
    const last = document.lineAt(document.lineCount - 1).range.end;
    return [vscode.TextEdit.replace(new vscode.Range(new vscode.Position(0, 0), last), formatted)];
  }
}

class NWScriptFoldingProvider implements vscode.FoldingRangeProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly configChange: vscode.Disposable;

  readonly onDidChangeFoldingRanges = this.changeEmitter.event;

  constructor() {
    this.configChange = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nwscript.folding")) {
        this.changeEmitter.fire();
      }
    });
  }

  dispose(): void {
    this.configChange.dispose();
    this.changeEmitter.dispose();
  }

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    if (!getSettings(document.uri).folding) {
      return [];
    }
    return foldNss(document.getText());
  }
}

export function formatNss(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let blockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const leadingClose = !quote && !blockComment && /^\}/.test(trimmed);
    const indent = Math.max(0, depth - (leadingClose ? 1 : 0));
    out.push(trimmed ? INDENT.repeat(indent) + trimmed : "");

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
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
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        blockComment = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }

  return out.join("\n");
}

export function foldNss(text: string): vscode.FoldingRange[] {
  const ranges: vscode.FoldingRange[] = [];
  const braceStack: number[] = [];
  let includeStart = -1;
  let includeEnd = -1;
  const lines = text.split(/\r?\n/);
  let quote: string | undefined;
  let blockComment = false;

  const flushIncludes = (): void => {
    if (includeStart >= 0 && includeEnd > includeStart) {
      ranges.push(new vscode.FoldingRange(includeStart, includeEnd));
    }
    includeStart = -1;
    includeEnd = -1;
  };

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    if (!quote && !blockComment && /^\s*#\s*include\s+"/i.test(line)) {
      if (includeStart < 0) includeStart = lineNumber;
      includeEnd = lineNumber;
    } else {
      flushIncludes();
    }

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
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
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        blockComment = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") braceStack.push(lineNumber);
      else if (ch === "}") {
        const start = braceStack.pop();
        if (start != null && lineNumber > start) {
          ranges.push(new vscode.FoldingRange(start, lineNumber));
        }
      }
    }
  }
  flushIncludes();
  return ranges;
}
