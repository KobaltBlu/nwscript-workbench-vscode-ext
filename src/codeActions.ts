import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { EngineApiService, parseScriptSymbols } from "./engineApi";
import { getSettings } from "./config";
import { NSS_EXCLUDE } from "./nss";
import { ResourceResolver } from "./resourceResolver";
import { basenameWithoutExtension, dirname, resolveWorkspaceUri } from "./uri";

const SELECTOR: vscode.DocumentSelector = [{ language: "nwscript" }];

export function registerCodeActions(
  context: vscode.ExtensionContext,
  engineApi: EngineApiService,
  compiler: CompilerService,
  resolver: ResourceResolver,
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      SELECTOR,
      new NWScriptCodeActionProvider(engineApi, compiler, resolver),
      {
        providedCodeActionKinds: [
          vscode.CodeActionKind.QuickFix,
          vscode.CodeActionKind.Refactor,
        ],
      },
    ),
    vscode.commands.registerCommand(
      "nwscript.createMissingInclude",
      async (documentUri: string, resource: string) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(documentUri));
        await createMissingInclude(document, resource, resolver);
      },
    ),
  );
}

class NWScriptCodeActionProvider implements vscode.CodeActionProvider {
  constructor(
    private readonly engineApi: EngineApiService,
    private readonly compiler: CompilerService,
    private readonly resolver: ResourceResolver,
  ) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): Promise<vscode.CodeAction[]> {
    if (!getSettings(document.uri).codeActions) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code === "missing-include") {
        const match = diagnostic.message.match(/Missing include\s+(\S+)/i);
        if (match) {
          const action = new vscode.CodeAction(
            `Create ${match[1]}`,
            vscode.CodeActionKind.QuickFix,
          );
          action.diagnostics = [diagnostic];
          action.command = {
            command: "nwscript.createMissingInclude",
            title: "Create missing include",
            arguments: [document.uri.toString(), match[1]],
          };
          actions.push(action);
        }
      }
    }

    const spec = await this.compiler.getLanguageSpecStatus(document.uri);
    if (spec.kind === "missing" || spec.kind === "ambiguous") {
      const action = new vscode.CodeAction(
        "Download language definition…",
        vscode.CodeActionKind.QuickFix,
      );
      action.command = {
        command: "nwscript.openLanguageDefinitionBrowser",
        title: "Browse language definitions",
      };
      actions.push(action);
    }

    const starting = startingConditionalFix(document);
    if (starting) actions.push(starting);

    const include = await addIncludeAction(
      document,
      range.start,
      this.engineApi,
      this.resolver,
    );
    if (include) actions.push(include);

    return actions;
  }
}

async function addIncludeAction(
  document: vscode.TextDocument,
  position: vscode.Position,
  engineApi: EngineApiService,
  resolver: ResourceResolver,
): Promise<vscode.CodeAction | undefined> {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!wordRange) return undefined;
  const name = document.getText(wordRange);
  if (!name) return undefined;

  const model = await engineApi.getModel(document).catch(() => undefined);
  if (model?.symbolsByName.get(name)?.length) {
    return undefined;
  }

  const files = await vscode.workspace.findFiles("**/*.nss", NSS_EXCLUDE);
  for (const uri of files) {
    if (uri.toString() === document.uri.toString()) continue;
    let text: string;
    try {
      text = await resolver.readText(uri);
    } catch {
      continue;
    }
    const parsed = parseScriptSymbols(
      text,
      "document",
      uri.path,
      "Workspace",
      uri,
    );
    const found = [...parsed.functions, ...parsed.constants].some((symbol) => symbol.name === name);
    if (!found) continue;

    const resRef = basenameWithoutExtension(uri);
    const action = new vscode.CodeAction(
      `Add #include "${resRef}"`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, includeInsertPosition(document), `#include "${resRef}"\n`);
    return action;
  }
  return undefined;
}

function includeInsertPosition(document: vscode.TextDocument): vscode.Position {
  let last = -1;
  for (let i = 0; i < document.lineCount; i += 1) {
    if (/^\s*#\s*include\s+"/i.test(document.lineAt(i).text)) {
      last = i;
    }
  }
  if (last >= 0) {
    return new vscode.Position(last + 1, 0);
  }
  return new vscode.Position(0, 0);
}

function startingConditionalFix(document: vscode.TextDocument): vscode.CodeAction | undefined {
  const text = document.getText();
  const voidMatch = text.match(/\bvoid\s+StartingConditional\s*\(/);
  if (voidMatch && voidMatch.index != null) {
    const action = new vscode.CodeAction(
      "Change StartingConditional to return int",
      vscode.CodeActionKind.QuickFix,
    );
    const start = document.positionAt(voidMatch.index);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(
      document.uri,
      new vscode.Range(start, start.translate(0, 4)),
      "int",
    );
    return action;
  }

  const fn = text.match(/\bint\s+StartingConditional\s*\([^)]*\)\s*\{/);
  if (!fn || fn.index == null) return undefined;
  const bodyStart = fn.index + fn[0].length;
  const body = text.slice(bodyStart);
  if (/\breturn\b/.test(body)) return undefined;
  const close = body.lastIndexOf("}");
  if (close < 0) return undefined;
  const action = new vscode.CodeAction(
    "Add return TRUE to StartingConditional",
    vscode.CodeActionKind.QuickFix,
  );
  const insertAt = document.positionAt(bodyStart + close);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.insert(document.uri, insertAt, "  return TRUE;\n");
  return action;
}

async function createMissingInclude(
  document: vscode.TextDocument,
  resource: string,
  resolver: ResourceResolver,
): Promise<void> {
  const resRef = resource.replace(/\.nss$/i, "");
  const settings = getSettings(document.uri);
  const includeDir = settings.includePaths[0]
    ? resolveWorkspaceUri(settings.includePaths[0], document.uri)
    : undefined;
  const target = vscode.Uri.joinPath(includeDir ?? dirname(document.uri), `${resRef}.nss`);
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`// ${resRef}.nss\n`));
  resolver.invalidate();
  await vscode.window.showTextDocument(target);
}
