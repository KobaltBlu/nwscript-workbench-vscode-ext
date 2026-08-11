import * as vscode from "vscode";
import {
  NWScriptCompiler,
  type NWScriptCompileResult,
} from "@neverwinter/nwscript-wasm";
import { compilerSettingsKey, getSettings } from "./config";
import { CompilerDiagnostics } from "./diagnostics";
import { ResourceResolver, type ResolvedSource } from "./resourceResolver";
import {
  basenameWithoutExtension,
  dirname,
  resolveWorkspaceUri,
  withExtension,
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

const decoder = new TextDecoder();

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

    // Do not rely on glob-provider semantics for the most common case.
    // Some virtual/web file-system providers do not return a root-level file
    // for a "**/nwscript.nss" search even though the pattern normally implies
    // zero or more path segments.
    const rootSpec = vscode.Uri.joinPath(folder.uri, "nwscript.nss");
    const matches: vscode.Uri[] = [];

    try {
      const stat = await vscode.workspace.fs.stat(rootSpec);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        matches.push(rootSpec);
      }
    } catch {
      // No root-level nwscript.nss. Continue with recursive discovery.
    }

    const discovered = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/nwscript.nss"),
      "**/{.git,node_modules,dist,out,build}/**",
      64,
    );

    for (const uri of discovered) {
      if (!matches.some((candidate) => this.sameUri(candidate, uri))) {
        matches.push(uri);
      }
    }

    return matches.sort((a, b) => a.path.localeCompare(b.path));
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
    if (candidates.length === 0) {
      return undefined;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    if (scope) {
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

      if (ancestors.length > 0) {
        const bestDepth = dirname(ancestors[0]).path.length;
        const equallyClose = ancestors.filter(
          (candidate) => dirname(candidate).path.length === bestDepth,
        );
        if (equallyClose.length === 1) {
          return equallyClose[0];
        }
      }
    }

    const labels = candidates
      .slice(0, 6)
      .map((candidate) => this.displayPath(candidate, scope ?? candidate))
      .join(", ");
    const suffix = candidates.length > 6 ? ", …" : "";

    throw new Error(
      `Multiple nwscript.nss files were found and none is an unambiguous match: ${labels}${suffix}. ` +
      "Move the script beneath the appropriate game folder or remove the conflicting definition from the Home resolution preview.",
    );
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
