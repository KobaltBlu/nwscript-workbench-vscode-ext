import * as vscode from "vscode";
import { scanCallSites, skipTrivia } from "./callSites";
import { EngineApiService } from "./engineApi";

const SELECTOR: vscode.DocumentSelector = [{ language: "nwscript" }];

export function registerInlayHints(
  context: vscode.ExtensionContext,
  engineApi: EngineApiService,
): void {
  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      SELECTOR,
      new NWScriptInlayHintsProvider(engineApi),
    ),
  );
}

class NWScriptInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly engineApi: EngineApiService) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    const model = await this.engineApi.getModel(document).catch(() => undefined);
    if (!model || token.isCancellationRequested) {
      return [];
    }

    const text = document.getText();
    const hints: vscode.InlayHint[] = [];
    for (const call of scanCallSites(text)) {
      const overloads = model.functionsByName.get(call.functionName);
      if (!overloads?.length) continue;
      const fn = overloads.find((item) => item.parameters.length >= call.argumentStarts.length)
        ?? overloads[0];
      if (!fn.parameters.length) continue;

      for (let i = 0; i < call.argumentStarts.length && i < fn.parameters.length; i += 1) {
        const start = skipTrivia(text, call.argumentStarts[i]);
        if (start >= call.closeOffset) continue;
        const position = document.positionAt(start);
        if (!range.contains(position)) continue;
        const argText = text.slice(start, nextArgEnd(text, start, call.closeOffset)).trim();
        if (!argText) continue;
        if (argText === fn.parameters[i].name || argText.startsWith(fn.parameters[i].name + " ")) {
          continue;
        }
        const hint = new vscode.InlayHint(
          position,
          `${fn.parameters[i].name}:`,
          vscode.InlayHintKind.Parameter,
        );
        hint.paddingRight = true;
        hints.push(hint);
      }
    }
    return hints;
  }
}

function nextArgEnd(text: string, start: number, close: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < close; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return i;
    }
  }
  return close;
}
