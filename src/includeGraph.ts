import * as vscode from "vscode";
import { CompilerService } from "./compilerService";
import { getSettings } from "./config";
import { ResourceResolver, type IncludeResolution } from "./resourceResolver";
import { basename, toWorkspacePathOrUri } from "./uri";

export interface IncludeGraphNode {
  resRef: string;
  uri?: vscode.Uri;
  path: string;
  line?: number;
  unresolved?: boolean;
}

export interface IncludeGraphView {
  script: string;
  includes: IncludeGraphNode[];
  includedBy: IncludeGraphNode[];
}

const FANOUT_CAP = 32;

export class IncludeGraph implements vscode.Disposable {
  private reverse?: Map<string, vscode.Uri[]>;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(
    private readonly compiler: CompilerService,
    private readonly resolver: ResourceResolver,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.nss");
    this.watcher.onDidCreate(() => this.invalidate());
    this.watcher.onDidChange(() => this.invalidate());
    this.watcher.onDidDelete(() => this.invalidate());
  }

  dispose(): void {
    this.watcher.dispose();
  }

  invalidate(): void {
    this.reverse = undefined;
  }

  async includesOf(uri: vscode.Uri, source?: string): Promise<IncludeResolution> {
    const text = source ?? await this.resolver.readText(uri);
    const settings = getSettings(uri);
    return this.resolver.collectIncludes(uri, text, settings.maxResolveAttempts);
  }

  async includedBy(uri: vscode.Uri): Promise<vscode.Uri[]> {
    const index = await this.getReverseIndex();
    return index.get(uri.toString()) ?? [];
  }

  async dependentsOf(includeUri: vscode.Uri): Promise<vscode.Uri[]> {
    const dependents = await this.includedBy(includeUri);
    return dependents.slice(0, FANOUT_CAP);
  }

  async viewFor(uri: vscode.Uri): Promise<IncludeGraphView> {
    const resolution = await this.includesOf(uri);
    const includedBy = await this.includedBy(uri);
    return {
      script: toWorkspacePathOrUri(uri),
      includes: [
        ...resolution.sources.map((source) => ({
          resRef: source.resRef,
          uri: source.uri,
          path: toWorkspacePathOrUri(source.uri, uri),
        })),
        ...resolution.unresolved.map((missing) => ({
          resRef: missing.resource.replace(/\.nss$/i, ""),
          path: missing.resource,
          line: missing.line,
          unresolved: true,
        })),
      ],
      includedBy: includedBy.map((entry) => ({
        resRef: basename(entry).replace(/\.nss$/i, ""),
        uri: entry,
        path: toWorkspacePathOrUri(entry, uri),
      })),
    };
  }

  private async getReverseIndex(): Promise<Map<string, vscode.Uri[]>> {
    if (this.reverse) {
      return this.reverse;
    }

    const reverse = new Map<string, vscode.Uri[]>();
    const entries = await this.compiler.findEntryScripts();
    for (const entry of entries) {
      let resolution: IncludeResolution;
      try {
        resolution = await this.includesOf(entry);
      } catch {
        continue;
      }
      for (const source of resolution.sources) {
        const key = source.uri.toString();
        const list = reverse.get(key);
        if (list) {
          if (!list.some((item) => item.toString() === entry.toString())) {
            list.push(entry);
          }
        } else {
          reverse.set(key, [entry]);
        }
      }
    }
    this.reverse = reverse;
    return reverse;
  }
}
