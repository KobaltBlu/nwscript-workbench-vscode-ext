import type { EngineFunction } from "./engineApi";
import { parseEngineApi } from "./engineApi";
import type { CompilerService } from "./compilerService";
import { toWorkspacePathOrUri } from "./uri";
import * as vscode from "vscode";

export interface ActionCompatStatus {
  actionId: number;
  name: string;
  status: "match" | "differs" | "unique";
  detail: string;
}

export interface ActionCompatReport {
  summary: string;
  byActionId: Record<number, ActionCompatStatus>;
}

function signatureKey(fn: EngineFunction): string {
  const params = fn.parameters.map((parameter) => parameter.type).join(",");
  return `${fn.returnType}|${fn.name}|${fn.parameters.length}|${params}`;
}

export function diffActionSignatures(
  active: EngineFunction[],
  others: Array<{ label: string; functions: EngineFunction[] }>,
): ActionCompatReport {
  const byActionId: Record<number, ActionCompatStatus> = {};
  const activeById = new Map<number, EngineFunction>();
  for (const fn of active) {
    if (fn.actionId == null) continue;
    activeById.set(fn.actionId, fn);
  }

  let differs = 0;
  for (const [actionId, fn] of activeById) {
    const mismatches: string[] = [];
    for (const other of others) {
      const candidate = other.functions.find((item) => item.actionId === actionId);
      if (!candidate) {
        mismatches.push(`missing in ${other.label}`);
        continue;
      }
      if (signatureKey(candidate) !== signatureKey(fn)) {
        mismatches.push(`${other.label}: ${candidate.signature}`);
      }
    }
    if (mismatches.length > 0) {
      differs += 1;
      byActionId[actionId] = {
        actionId,
        name: fn.name,
        status: "differs",
        detail: `${fn.signature} differs (${mismatches.join("; ")})`,
      };
    } else if (others.length > 0) {
      byActionId[actionId] = {
        actionId,
        name: fn.name,
        status: "match",
        detail: `Matches ${others.map((item) => item.label).join(", ")}`,
      };
    } else {
      byActionId[actionId] = {
        actionId,
        name: fn.name,
        status: "unique",
        detail: fn.signature,
      };
    }
  }

  const summary = others.length === 0
    ? "No other workspace language specifications to compare."
    : differs > 0
      ? `${differs} ACTION signature${differs === 1 ? "" : "s"} differ from other workspace nwscript.nss files.`
      : `ACTION signatures match the other workspace language specification${others.length === 1 ? "" : "s"}.`;

  return { summary, byActionId };
}

export async function buildWorkspaceActionCompat(
  compiler: CompilerService,
  scope?: vscode.Uri,
): Promise<ActionCompatReport> {
  const activeSource = await compiler.getLanguageSpecSource(scope);
  if (!activeSource?.text) {
    return {
      summary: "No active language specification to compare.",
      byActionId: {},
    };
  }

  const active = parseEngineApi(activeSource).functions;
  const discovered = await compiler.findWorkspaceLanguageSpecs();
  const others: Array<{ label: string; functions: EngineFunction[] }> = [];

  for (const uri of discovered.matches) {
    if (activeSource.uri && uri.toString() === activeSource.uri.toString()) {
      continue;
    }
    try {
      others.push({
        label: toWorkspacePathOrUri(uri, scope),
        functions: await readEngineFunctions(uri),
      });
    } catch {
      // Skip unreadable specifications.
    }
  }

  return diffActionSignatures(active, others);
}

export async function readEngineFunctions(uri: vscode.Uri): Promise<EngineFunction[]> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(bytes);
  return parseEngineApi({
    kind: "detected",
    label: toWorkspacePathOrUri(uri),
    availability: "workspace",
    cacheKey: uri.toString(),
    uri,
    text,
  }).functions;
}
