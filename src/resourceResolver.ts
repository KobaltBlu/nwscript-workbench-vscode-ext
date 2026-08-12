import * as vscode from "vscode";
import { getSettings } from "./config";
import {
  basenameWithoutExtension,
  dirname,
  exists,
  normalizeResRef,
  resolveWorkspaceUri,
  workspaceFolderFor,
} from "./uri";

const decoder = new TextDecoder();

export interface ResolvedSource {
  resRef: string;
  uri: vscode.Uri;
  source: string;
}

export interface UnresolvedInclude {
  resource: string;
  from: vscode.Uri;
  line: number;
}

export interface IncludeResolution {
  sources: ResolvedSource[];
  unresolved: UnresolvedInclude[];
}

export class ResourceResolver implements vscode.Disposable {
  private index?: Map<string, vscode.Uri[]>;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.nss");
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(() => this.invalidate()),
      this.watcher.onDidDelete(() => this.invalidate()),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  invalidate(): void {
    this.index = undefined;
  }

  async readText(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === key,
    );
    if (openDocument) {
      return openDocument.getText();
    }

    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  }

  async resolve(resource: string, from: vscode.Uri): Promise<vscode.Uri | undefined> {
    const resRef = normalizeResRef(resource);
    const filename = `${resRef}.nss`;

    const besideSource = vscode.Uri.joinPath(dirname(from), filename);
    if (await exists(besideSource)) {
      return besideSource;
    }

    const settings = getSettings(from);
    for (const includePath of settings.includePaths) {
      const base = resolveWorkspaceUri(includePath, from);
      if (!base) {
        continue;
      }
      const candidate = vscode.Uri.joinPath(base, filename);
      if (await exists(candidate)) {
        return candidate;
      }
    }

    const index = await this.getIndex();
    const candidates = index.get(resRef) ?? [];
    if (candidates.length === 0) {
      return undefined;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    // Prefer a resource from the same workspace folder as the including file.
    const sourceFolder = workspaceFolderFor(from);
    if (sourceFolder) {
      const sameWorkspace = candidates.find(
        (candidate) => vscode.workspace.getWorkspaceFolder(candidate)?.uri.toString() === sourceFolder.uri.toString(),
      );
      if (sameWorkspace) {
        return sameWorkspace;
      }
    }

    return candidates[0];
  }

  async collectIncludes(
    rootUri: vscode.Uri,
    rootSource: string,
    maxResources: number,
  ): Promise<IncludeResolution> {
    const visited = new Set<string>();
    const sources: ResolvedSource[] = [];
    const unresolved: UnresolvedInclude[] = [];
    let loaded = 0;

    const visit = async (uri: vscode.Uri, source: string): Promise<void> => {
      if (loaded >= maxResources) {
        return;
      }

      const includeRegex = /^\s*#\s*include\s+"([^"]+)"/gm;
      let match: RegExpExecArray | null;

      while ((match = includeRegex.exec(source)) !== null && loaded < maxResources) {
        const resource = match[1];
        const resRef = normalizeResRef(resource);
        if (visited.has(resRef)) {
          continue;
        }
        visited.add(resRef);

        const includeUri = await this.resolve(resource, uri);
        if (!includeUri) {
          const line = source.slice(0, match.index).split(/\r?\n/).length;
          unresolved.push({ resource: `${resRef}.nss`, from: uri, line });
          continue;
        }

        const includeSource = await this.readText(includeUri);
        sources.push({
          resRef,
          uri: includeUri,
          source: includeSource,
        });
        loaded += 1;
        await visit(includeUri, includeSource);
      }
    };

    await visit(rootUri, rootSource);
    return { sources, unresolved };
  }

  async preloadIncludes(
    rootUri: vscode.Uri,
    rootSource: string,
    addSource: (resRef: string, source: string) => void,
    maxResources: number,
  ): Promise<IncludeResolution> {
    const resolution = await this.collectIncludes(
      rootUri,
      rootSource,
      maxResources,
    );

    for (const source of resolution.sources) {
      addSource(source.resRef, source.source);
    }

    return resolution;
  }

  async resolveKnownResRef(resRef: string): Promise<vscode.Uri | undefined> {
    const index = await this.getIndex();
    return index.get(normalizeResRef(resRef))?.[0];
  }

  private async getIndex(): Promise<Map<string, vscode.Uri[]>> {
    if (this.index) {
      return this.index;
    }

    const files = await vscode.workspace.findFiles(
      "**/*.nss",
      "**/{node_modules,.git,dist,out,build}/**",
    );

    const index = new Map<string, vscode.Uri[]>();
    for (const uri of files) {
      const resRef = normalizeResRef(basenameWithoutExtension(uri));
      const values = index.get(resRef);
      if (values) {
        values.push(uri);
      } else {
        index.set(resRef, [uri]);
      }
    }

    this.index = index;
    return index;
  }
}
