import * as vscode from "vscode";
import {
  NWScriptCompiler,
  type NWScriptCompileResult,
} from "@neverwinter/nwscript-wasm";
import { compilerSettingsKey, getSettings } from "./config";
import { CompilerDiagnostics } from "./diagnostics";
import { ResourceResolver, type ResolvedSource } from "./resourceResolver";
import {
  basename,
  basenameWithoutExtension,
  dirname,
  resolveWorkspaceUri,
  workspaceFolderFor,
} from "./uri";

interface DisassemblerCompiler {
  disassemble(ncs: Uint8Array): string;
}

export interface LanguageSpecStatus {
  kind: "configured" | "embedded" | "detected" | "missing" | "ambiguous";
  label: string;
  detail: string;
  uri?: vscode.Uri;
}

export interface LanguageSpecSource {
  kind: "configured" | "embedded" | "detected";
  label: string;
  availability: string;
  cacheKey: string;
  uri?: vscode.Uri;
  gameTarget?: string;
  text?: string;
}

export type LanguageSpecResolutionEntryState =
  | "active"
  | "shadowed"
  | "isolated"
  | "ambiguous"
  | "available";

export interface LanguageSpecResolutionEntry {
  uri: string;
  path: string;
  state: LanguageSpecResolutionEntryState;
  detail: string;
  removable: boolean;
}

export interface LanguageSpecResolutionExplain {
  status: LanguageSpecStatus;
  severity: "ok" | "warning" | "error";
  summary: string;
  scope: string;
  candidates: vscode.Uri[];
  active?: vscode.Uri;
  truncated: boolean;
  entries: LanguageSpecResolutionEntry[];
}

const decoder = new TextDecoder();
const LANGUAGE_SPEC_FIND_LIMIT = 256;
const NSS_SCRIPT_FIND_LIMIT = 10_000;
const NSS_EXCLUDE = "**/{.git,node_modules,dist,out,build}/**";

interface FolderLanguageSpecs {
  folder: vscode.WorkspaceFolder;
  matches: vscode.Uri[];
  truncated: boolean;
}

export class CompilerService implements vscode.Disposable {
  private compiler?: NWScriptCompiler;
  private compilerKey?: string;
  private wasmBinary?: Uint8Array;
  private embeddedTargets?: string[];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly resolver: ResourceResolver,
    private readonly diagnostics: CompilerDiagnostics,
  ) {}

  dispose(): void {
    this.compiler?.dispose();
    this.compiler = undefined;
  }

  invalidateCompiler(): void {
    this.compiler?.dispose();
    this.compiler = undefined;
    this.compilerKey = undefined;
  }

  async getEmbeddedTargets(): Promise<string[]> {
    if (this.embeddedTargets) {
      return [...this.embeddedTargets];
    }

    const moduleOptions = await this.getModuleOptions();
    this.embeddedTargets = await NWScriptCompiler.getEmbeddedGameTargets(moduleOptions);
    return [...this.embeddedTargets];
  }

  async getLanguageSpecStatus(scope?: vscode.Uri): Promise<LanguageSpecStatus> {
    try {
      const detected = await this.detectProjectLanguageSpec(scope);
      return detected
        ? {
            kind: "detected",
            label: "Project nwscript.nss auto-detected",
            detail: this.displayPath(detected, scope ?? detected),
            uri: detected,
          }
        : {
            kind: "missing",
            label: "No project nwscript.nss detected",
            detail: "Add NWScript.nss to the project or choose one with NWScript.nss.",
          };
    } catch (error) {
      return {
        kind: "ambiguous",
        label: "Multiple project language specifications found",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }


  /**
   * Resolve the language specification that defines the engine API for a
   * document. NWScript.nss and project-detected specs expose their source text
   * for editor intelligence. The current nwscript-wasm public API exposes
   * embedded target names, but not their decompressed nwscript.nss text.
   */
  async getLanguageSpecSource(scope?: vscode.Uri): Promise<LanguageSpecSource | undefined> {
    const uri = await this.detectProjectLanguageSpec(scope);
    if (!uri) {
      return undefined;
    }

    return this.readLanguageSpecSource(
      uri,
      "detected",
      `Project: ${this.displayPath(uri, scope ?? uri)}`,
      `Active project language specification · ${this.displayPath(uri, scope ?? uri)}`,
    );
  }


  async getDocumentIncludeSources(
    document: vscode.TextDocument,
  ): Promise<ResolvedSource[]> {
    const settings = getSettings(document.uri);
    const resolution = await this.resolver.collectIncludes(
      document.uri,
      document.getText(),
      settings.maxResolveAttempts,
    );
    return resolution.sources;
  }

  async compileDocument(document: vscode.TextDocument, announce = true): Promise<NWScriptCompileResult> {
    return this.exclusive(async () => {
      const source = document.getText();
      const settings = getSettings(document.uri);
      const compiler = await this.getCompiler(document.uri);

      // The identifier specification has already been parsed during create().
      // Reset script/include resources so deleted or renamed includes cannot
      // remain stale between compilations.
      compiler.clearSources();

      const unresolved = await this.resolver.preloadIncludes(
        document.uri,
        source,
        (resRef, includeSource) => compiler.addSource(resRef, includeSource),
        settings.maxResolveAttempts,
      );

      const scriptName = basenameWithoutExtension(document.uri);
      const rawResult = compiler.compile(scriptName, source);
      const result = this.augmentMissingIncludeError(rawResult, unresolved.map((item) => item.resource));

      if (!result.ok) {
        await this.diagnostics.setCompilerError(document.uri, result.error);
        if (announce) {
          void vscode.window.showErrorMessage(`NWScript compile failed: ${this.firstErrorLine(result.error)}`);
        }
        return result;
      }

      this.diagnostics.clear();
      const outputs = await this.writeOutputs(document.uri, result);

      if (announce) {
        const suffix = outputs.debug ? " + NDB" : "";
        void vscode.window.showInformationMessage(`Compiled ${scriptName}.nss → ${outputs.ncs}${suffix}`);
      }

      return result;
    });
  }

  async compileUri(uri: vscode.Uri): Promise<NWScriptCompileResult> {
    const document = await vscode.workspace.openTextDocument(uri);
    return this.compileDocument(document, true);
  }

  async disassembleText(uri: vscode.Uri): Promise<string> {
    return this.exclusive(async () => {
      const compiler = await this.getCompiler(uri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const disassembler = compiler as unknown as DisassemblerCompiler;

      if (typeof disassembler.disassemble !== "function") {
        throw new Error(
          "The installed nwscript-wasm build does not expose NCS disassembly. Update KobaltBlu/nwscript-wasm and rebuild the extension.",
        );
      }

      return disassembler.disassemble(bytes);
    });
  }

  private async getCompiler(scope?: vscode.Uri): Promise<NWScriptCompiler> {
    const settings = getSettings(scope);
    const moduleOptions = await this.getModuleOptions();

    const languageSpecUri = await this.detectProjectLanguageSpec(scope);
    if (!languageSpecUri) {
      throw new Error(
        "No nwscript.nss could be resolved for the active script. Add nwscript.nss to the script's project tree.",
      );
    }
    const languageSpecKey = await this.languageSpecCacheKey(languageSpecUri, "detected");

    const key = `${compilerSettingsKey(settings)}|${languageSpecKey}`;
    if (this.compiler && this.compilerKey === key) {
      return this.compiler;
    }

    this.compiler?.dispose();
    this.compiler = undefined;

    let languageSpec: Uint8Array | undefined;
    if (languageSpecUri) {
      try {
        languageSpec = await vscode.workspace.fs.readFile(languageSpecUri);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Unable to read NWScript language specification ${languageSpecUri.toString(true)}: ${message}`,
        );
      }
    }

    this.compiler = await NWScriptCompiler.create({
      languageSpec,
      writeDebug: settings.generateDebug,
      maxIncludeDepth: settings.maxIncludeDepth,
      optimizationFlags: settings.optimizationFlags,
      moduleOptions,
    });
    this.compilerKey = key;
    return this.compiler;
  }

  /**
   * Find nwscript.nss files visible in the workspace folder containing scope.
   *
   * A RelativePattern keeps discovery scoped to the active project in
   * multi-root workspaces and works with virtual/browser file systems.
   */
  async findProjectLanguageSpecs(scope?: vscode.Uri): Promise<vscode.Uri[]> {
    const folder = workspaceFolderFor(scope);
    if (!folder) {
      return [];
    }
    const result = await this.findLanguageSpecsInFolder(folder);
    return result.matches;
  }

  /**
   * Find nwscript.nss files across every workspace folder.
   */
  async findWorkspaceLanguageSpecs(): Promise<{
    matches: vscode.Uri[];
    truncated: boolean;
  }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const matches: vscode.Uri[] = [];
    let truncated = false;

    for (const folder of folders) {
      const result = await this.findLanguageSpecsInFolder(folder);
      truncated = truncated || result.truncated;
      for (const uri of result.matches) {
        if (!matches.some((candidate) => this.sameUri(candidate, uri))) {
          matches.push(uri);
        }
      }
    }

    return {
      matches: matches.sort((a, b) => a.path.localeCompare(b.path)),
      truncated,
    };
  }

  /**
   * Build a workspace-wide resolution list for Home, including coverage
   * partitions and which definition wins for the active scope.
   */
  async explainLanguageSpecResolution(
    scope?: vscode.Uri,
  ): Promise<LanguageSpecResolutionExplain> {
    const status = await this.getLanguageSpecStatus(scope);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folderResults: FolderLanguageSpecs[] = [];
    let truncated = false;

    for (const folder of folders) {
      const result = await this.findLanguageSpecsInFolder(folder);
      truncated = truncated || result.truncated;
      folderResults.push({ folder, matches: result.matches, truncated: result.truncated });
    }

    const candidates = folderResults
      .flatMap((entry) => entry.matches)
      .sort((a, b) => a.path.localeCompare(b.path));

    const displayScope = scope
      ? this.displayPath(scope, scope)
      : folders.length > 0
        ? "Workspace"
        : "No active workspace resource";

    const entries: LanguageSpecResolutionEntry[] = [];
    let anyRootShadowing = false;

    for (const entry of folderResults) {
      const folderEntries = await this.buildFolderResolutionEntries(
        entry.folder,
        entry.matches,
        status,
        scope,
        folderResults.length > 1,
      );
      if (folderEntries.rootShadowing) {
        anyRootShadowing = true;
      }
      entries.push(...folderEntries.entries);
    }

    const severity = this.resolutionSeverity(status, anyRootShadowing);
    const summary = this.resolutionSummary(
      status,
      candidates,
      anyRootShadowing,
      truncated,
      folders.length,
    );

    return {
      status,
      severity,
      summary,
      scope: displayScope,
      candidates,
      active: status.uri,
      truncated,
      entries,
    };
  }

  /**
   * Select the unambiguous project language specification.
   *
   * Preference order:
   * 1. nwscript.nss in the workspace root.
   * 2. The nearest nwscript.nss in an ancestor directory of the source.
   * 3. The only discovered nwscript.nss.
   *
   * Multiple unrelated specifications are intentionally treated as ambiguous
   * rather than guessing between game targets.
   */
  private async detectProjectLanguageSpec(scope?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const folder = workspaceFolderFor(scope);
    if (!folder) {
      return undefined;
    }

    // Root-level nwscript.nss is authoritative and should not depend on
    // workspace.findFiles() returning zero-segment "**/" matches.
    const rootSpec = vscode.Uri.joinPath(folder.uri, "nwscript.nss");
    try {
      const stat = await vscode.workspace.fs.stat(rootSpec);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        return rootSpec;
      }
    } catch {
      // Fall through to recursive project discovery.
    }

    const candidates = await this.findProjectLanguageSpecs(scope);
    const selected = selectNearestLanguageSpec(candidates, scope);
    if (selected !== undefined || candidates.length === 0) {
      return selected;
    }

    const labels = candidates
      .slice(0, 6)
      .map((candidate) => this.displayPath(candidate, scope ?? candidate))
      .join(", ");
    const suffix = candidates.length > 6 ? ", …" : "";

    throw new Error(
      `Multiple nwscript.nss files were found and none is an unambiguous match: ${labels}${suffix}. ` +
      "Move the script beneath the appropriate game folder or remove the conflicting definition from the Home resolution list.",
    );
  }

  private async findLanguageSpecsInFolder(
    folder: vscode.WorkspaceFolder,
  ): Promise<{ matches: vscode.Uri[]; truncated: boolean }> {
    const matches: vscode.Uri[] = [];

    // Prefer a filesystem walk over findFiles(). Virtual/web hosts (and some
    // desktop search indexes) can miss newly created nested nwscript.nss files
    // or fail case-sensitive globs that a direct directory read still sees.
    const truncated = await this.collectLanguageSpecsByWalk(
      folder.uri,
      matches,
      0,
    );

    if (matches.length === 0) {
      const discovered = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/nwscript.nss"),
        NSS_EXCLUDE,
        LANGUAGE_SPEC_FIND_LIMIT,
      );
      for (const uri of discovered) {
        if (!matches.some((candidate) => this.sameUri(candidate, uri))) {
          matches.push(uri);
        }
      }
      return {
        matches: matches.sort((a, b) => a.path.localeCompare(b.path)),
        truncated: truncated || discovered.length >= LANGUAGE_SPEC_FIND_LIMIT,
      };
    }

    return {
      matches: matches.sort((a, b) => a.path.localeCompare(b.path)),
      truncated,
    };
  }

  private async collectLanguageSpecsByWalk(
    directory: vscode.Uri,
    matches: vscode.Uri[],
    depth: number,
  ): Promise<boolean> {
    if (depth > 48 || matches.length >= LANGUAGE_SPEC_FIND_LIMIT) {
      return matches.length >= LANGUAGE_SPEC_FIND_LIMIT;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch {
      return false;
    }

    let truncated = false;
    for (const [name, type] of entries) {
      if (matches.length >= LANGUAGE_SPEC_FIND_LIMIT) {
        return true;
      }

      const lower = name.toLowerCase();
      if (
        lower === ".git" ||
        lower === "node_modules" ||
        lower === "dist" ||
        lower === "out" ||
        lower === "build"
      ) {
        continue;
      }

      const uri = vscode.Uri.joinPath(directory, name);
      const isDirectory = (type & vscode.FileType.Directory) !== 0;
      const isFile = (type & vscode.FileType.File) !== 0;

      if (isFile && lower === "nwscript.nss") {
        if (!matches.some((candidate) => this.sameUri(candidate, uri))) {
          matches.push(uri);
        }
        continue;
      }

      if (isDirectory) {
        truncated =
          (await this.collectLanguageSpecsByWalk(uri, matches, depth + 1)) ||
          truncated;
      }
    }

    return truncated || matches.length >= LANGUAGE_SPEC_FIND_LIMIT;
  }

  private async buildFolderResolutionEntries(
    folder: vscode.WorkspaceFolder,
    candidates: vscode.Uri[],
    status: LanguageSpecStatus,
    scope: vscode.Uri | undefined,
    multiRoot: boolean,
  ): Promise<{ entries: LanguageSpecResolutionEntry[]; rootShadowing: boolean }> {
    const rootSpec = candidates.find((uri) => this.isWorkspaceRootLanguageSpec(folder, uri));
    const rootKey = rootSpec?.toString();
    const hasRoot = rootKey !== undefined;
    const rootShadowing = hasRoot && candidates.length > 1;
    const activeKey = status.uri?.toString();
    const scopeFolder = workspaceFolderFor(scope);
    const inScopeFolder = scopeFolder?.index === folder.index;

    const scriptUris = await this.findNssScriptsInFolder(folder);
    const coverageByUri = this.computeCoverageCounts(
      candidates,
      scriptUris,
      hasRoot,
      rootKey ?? "",
    );

    const ordered = [...candidates].sort((a, b) => {
      const aRoot = this.isWorkspaceRootLanguageSpec(folder, a) ? 0 : 1;
      const bRoot = this.isWorkspaceRootLanguageSpec(folder, b) ? 0 : 1;
      if (aRoot !== bRoot) {
        return aRoot - bRoot;
      }
      const aDepth = this.relativeFolderPath(folder, dirname(a)).split("/").filter(Boolean).length;
      const bDepth = this.relativeFolderPath(folder, dirname(b)).split("/").filter(Boolean).length;
      return aDepth - bDepth || a.path.localeCompare(b.path);
    });

    const entries: LanguageSpecResolutionEntry[] = ordered.map((uri) => {
      const key = uri.toString();
      const relative = this.relativeFolderPath(folder, uri) || basename(uri);
      const path = multiRoot ? `${folder.name}/${relative}` : relative;
      const relativeDir = this.relativeFolderPath(folder, dirname(uri));
      const coverageLabel = relativeDir ? `${relativeDir}/**` : "**";
      const scriptCount = coverageByUri.get(key) ?? 0;
      const isActive = key === activeKey;
      const isRoot = key === rootKey;

      let state: LanguageSpecResolutionEntryState;
      let detail: string;

      if (hasRoot && !isRoot) {
        state = isActive ? "active" : "shadowed";
        detail = isActive
          ? `Selected for the active resource · shadowed coverage ${coverageLabel}`
          : `Shadowed by workspace-root nwscript.nss · would cover ${coverageLabel}`;
      } else if (isActive) {
        state = "active";
        detail = `Selected for the active resource · covers ${coverageLabel} · ${scriptCount} script${scriptCount === 1 ? "" : "s"}`;
      } else if (status.kind === "ambiguous" && inScopeFolder) {
        state = "ambiguous";
        detail = `Ambiguous candidate · covers ${coverageLabel} · ${scriptCount} script${scriptCount === 1 ? "" : "s"}`;
      } else if (hasRoot && isRoot) {
        state = "available";
        detail = `Authoritative workspace-root definition · covers ${coverageLabel} · ${scriptCount} script${scriptCount === 1 ? "" : "s"}`;
      } else if (!hasRoot && candidates.length > 1) {
        state = "isolated";
        detail = `Isolated game tree · covers ${coverageLabel} · ${scriptCount} script${scriptCount === 1 ? "" : "s"}`;
      } else {
        state = "available";
        detail = `Discovered candidate · covers ${coverageLabel} · ${scriptCount} script${scriptCount === 1 ? "" : "s"}`;
      }

      return {
        uri: key,
        path,
        state,
        detail,
        removable: true,
      };
    });

    return { entries, rootShadowing };
  }

  private async findNssScriptsInFolder(
    folder: vscode.WorkspaceFolder,
  ): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*.nss"),
      NSS_EXCLUDE,
      NSS_SCRIPT_FIND_LIMIT,
    );
  }

  private computeCoverageCounts(
    candidates: vscode.Uri[],
    scriptUris: vscode.Uri[],
    hasRoot: boolean,
    rootKey: string,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      counts.set(candidate.toString(), 0);
    }

    const candidateDirs = candidates.map((uri) => ({
      key: uri.toString(),
      dir: dirname(uri).path.replace(/\/$/, ""),
    }));

    for (const script of scriptUris) {
      if (basename(script).toLowerCase() === "nwscript.nss") {
        continue;
      }

      const scriptDir = dirname(script).path.replace(/\/$/, "");

      if (hasRoot) {
        const current = counts.get(rootKey) ?? 0;
        counts.set(rootKey, current + 1);
        continue;
      }

      const ancestors = candidateDirs
        .filter(
          (candidate) =>
            scriptDir === candidate.dir ||
            scriptDir.startsWith(`${candidate.dir}/`),
        )
        .sort((a, b) => b.dir.length - a.dir.length || a.key.localeCompare(b.key));

      if (ancestors.length === 0) {
        continue;
      }

      const bestDepth = ancestors[0].dir.length;
      const equallyClose = ancestors.filter((candidate) => candidate.dir.length === bestDepth);
      if (equallyClose.length !== 1) {
        continue;
      }

      const key = equallyClose[0].key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return counts;
  }

  private isWorkspaceRootLanguageSpec(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): boolean {
    return (
      basename(uri).toLowerCase() === "nwscript.nss" &&
      this.sameUri(dirname(uri), folder.uri)
    );
  }

  private relativeFolderPath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    const folderPath = folder.uri.path.replace(/\/$/, "");
    const uriPath = uri.path.replace(/\/$/, "");
    if (uriPath === folderPath) {
      return "";
    }
    if (
      folder.uri.scheme === uri.scheme &&
      folder.uri.authority === uri.authority &&
      uriPath.startsWith(`${folderPath}/`)
    ) {
      return uriPath.slice(folderPath.length + 1);
    }
    // Fall back to path-only matching for hosts that rewrite authority/scheme
    // between workspace folder URIs and filesystem walk results.
    if (uriPath.startsWith(`${folderPath}/`)) {
      return uriPath.slice(folderPath.length + 1);
    }
    return uri.path.replace(/^\/+/, "");
  }

  private resolutionSeverity(
    status: LanguageSpecStatus,
    anyRootShadowing: boolean,
  ): "ok" | "warning" | "error" {
    if (status.kind === "ambiguous" || status.kind === "missing") {
      return "error";
    }
    if (anyRootShadowing) {
      return "warning";
    }
    return "ok";
  }

  private resolutionSummary(
    status: LanguageSpecStatus,
    candidates: vscode.Uri[],
    anyRootShadowing: boolean,
    truncated: boolean,
    folderCount: number,
  ): string {
    const truncationNote = truncated
      ? ` Discovery stopped after ${LANGUAGE_SPEC_FIND_LIMIT} matches per folder.`
      : "";

    if (status.kind === "ambiguous") {
      return `Resolution is ambiguous. No definition can be selected safely for this resource.${truncationNote}`;
    }
    if (status.kind === "missing") {
      return `${status.label}.${truncationNote}`;
    }
    if (anyRootShadowing) {
      return `A workspace-root nwscript.nss overrides nested definitions in at least one folder, including game-specific definitions.${truncationNote}`;
    }
    if (candidates.length > 1) {
      const scopeNote = folderCount > 1 ? " across workspace folders" : "";
      return `Nearest-ancestor resolution applies${scopeNote}; isolated game trees remain independent.${truncationNote}`;
    }
    if (candidates.length === 1) {
      return `Resolution is unambiguous; a single workspace definition was discovered.${truncationNote}`;
    }
    return `No nwscript.nss definitions were found in the workspace.${truncationNote}`;
  }

  private async readLanguageSpecSource(
    uri: vscode.Uri,
    kind: "configured" | "detected",
    label: string,
    availability: string,
  ): Promise<LanguageSpecSource> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return {
      kind,
      label,
      availability,
      cacheKey: await this.languageSpecCacheKey(uri, kind),
      uri,
      text: decoder.decode(bytes),
    };
  }

  private async languageSpecCacheKey(
    uri: vscode.Uri,
    source: "configured" | "detected",
  ): Promise<string> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return `${source}:${uri.toString(true)}:${stat.mtime}:${stat.size}`;
    } catch {
      return `${source}:${uri.toString(true)}`;
    }
  }

  private sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
    return (
      a.scheme === b.scheme &&
      a.authority === b.authority &&
      a.path === b.path
    );
  }

  private async getModuleOptions(): Promise<Record<string, unknown>> {
    if (!this.wasmBinary) {
      const wasmUri = vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "web",
        "nwscript-compiler.wasm",
      );
      this.wasmBinary = await vscode.workspace.fs.readFile(wasmUri);
    }

    const wasmBuffer = new ArrayBuffer(this.wasmBinary.byteLength);
    new Uint8Array(wasmBuffer).set(this.wasmBinary);

    const wasmBinary = wasmBuffer;

    return {
      // VS Code web extensions run in a worker and their extension assets use
      // VS Code URI schemes. Letting Emscripten load the sidecar WASM itself
      // falls through to its worker-side synchronous XMLHttpRequest path.
      //
      // The bytes are already available through workspace.fs, so instantiate
      // them directly and bypass Emscripten's URL/XHR loader entirely.
      instantiateWasm(
        imports: WebAssembly.Imports,
        successCallback: (
          instance: WebAssembly.Instance,
          module?: WebAssembly.Module,
        ) => void,
      ): WebAssembly.Exports {
        const module = new WebAssembly.Module(wasmBinary);
        const instance = new WebAssembly.Instance(module, imports);
        successCallback(instance, module);
        return instance.exports;
      },
    };
  }

  private async writeOutputs(
    sourceUri: vscode.Uri,
    result: NWScriptCompileResult,
  ): Promise<{ ncs: string; debug?: string }> {
    const settings = getSettings(sourceUri);
    let outputBase: vscode.Uri;

    if (settings.outputDirectory) {
      outputBase = resolveWorkspaceUri(settings.outputDirectory, sourceUri) ?? dirname(sourceUri);
      await vscode.workspace.fs.createDirectory(outputBase);
    } else {
      outputBase = dirname(sourceUri);
    }

    const stem = basenameWithoutExtension(sourceUri);
    const ncsUri = vscode.Uri.joinPath(outputBase, `${stem}.ncs`);
    await vscode.workspace.fs.writeFile(ncsUri, result.bytecode);

    let debug: string | undefined;
    if (settings.generateDebug && result.debugCode.byteLength > 0) {
      const ndbUri = vscode.Uri.joinPath(outputBase, `${stem}.ndb`);
      await vscode.workspace.fs.writeFile(ndbUri, result.debugCode);
      debug = this.displayPath(ndbUri, sourceUri);
    }

    return {
      ncs: this.displayPath(ncsUri, sourceUri),
      debug,
    };
  }

  private displayPath(uri: vscode.Uri, sourceUri: vscode.Uri): string {
    const folder = workspaceFolderFor(sourceUri);
    if (folder && uri.toString().startsWith(folder.uri.toString())) {
      const relative = uri.path.slice(folder.uri.path.length).replace(/^\//, "");
      return relative || uri.path;
    }
    return uri.path;
  }

  private augmentMissingIncludeError(
    result: NWScriptCompileResult,
    unresolved: string[],
  ): NWScriptCompileResult {
    if (
      result.ok ||
      unresolved.length === 0 ||
      !/FILE NOT FOUND/i.test(result.error) ||
      /Missing resource:/i.test(result.error)
    ) {
      return result;
    }

    return {
      ...result,
      error: `${result.error}\nUnresolved include candidates: ${unresolved.join(", ")}`,
    };
  }

  private firstErrorLine(error: string): string {
    return error
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "Unknown compiler error";
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => gate, () => gate);

    await previous;
    try {
      return await operation();
    } finally {
      resolveGate();
    }
  }
}

/**
 * Prefer a unique nearest-ancestor nwscript.nss for scope, or the sole candidate.
 * Returns undefined when zero candidates or when multiple candidates remain ambiguous.
 */
function selectNearestLanguageSpec(
  candidates: vscode.Uri[],
  scope?: vscode.Uri,
): vscode.Uri | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  if (!scope) {
    return undefined;
  }

  const sourceDir = dirname(scope).path.replace(/\/$/, "");
  const ancestors = candidates
    .filter((candidate) => {
      const candidateDir = dirname(candidate).path.replace(/\/$/, "");
      return (
        sourceDir === candidateDir ||
        sourceDir.startsWith(`${candidateDir}/`)
      );
    })
    .sort(
      (a, b) =>
        dirname(b).path.length - dirname(a).path.length ||
        a.path.localeCompare(b.path),
    );

  if (ancestors.length === 0) {
    return undefined;
  }

  const bestDepth = dirname(ancestors[0]).path.length;
  const equallyClose = ancestors.filter(
    (candidate) => dirname(candidate).path.length === bestDepth,
  );
  return equallyClose.length === 1 ? equallyClose[0] : undefined;
}
