import * as vscode from "vscode";
import { OptimizationFlags } from "@neverwinter/nwscript-wasm";

export type OptimizationLevel = "O0" | "O1" | "O2" | "O3";

export interface NWScriptSettings {
  includePaths: string[];
  outputDirectory: string;
  compileOnSave: boolean;
  liveDiagnostics: boolean;
  compileDependentsOnSave: boolean;
  inlayHints: boolean;
  semanticTokens: boolean;
  formatting: boolean;
  folding: boolean;
  codeActions: boolean;
  includeGraph: boolean;
  actionCompat: boolean;
  ncsReloadOnChange: boolean;
  ncsActionSignatures: boolean;
  ncsNdbOverlay: boolean;
  autoOpenHome: boolean;
  optimizationLevel: OptimizationLevel;
  optimizationFlags: number;
  generateDebug: boolean;
  maxIncludeDepth: number;
  maxResolveAttempts: number;
}

export function getSettings(scope?: vscode.Uri): NWScriptSettings {
  const config = vscode.workspace.getConfiguration("nwscript", scope);
  const optimizationLevel = config.get<OptimizationLevel>("optimizationLevel", "O1");

  return {
    includePaths: config.get<string[]>("includePaths", []),
    outputDirectory: config.get<string>("outputDirectory", "").trim(),
    compileOnSave: config.get<boolean>("compileOnSave", false),
    liveDiagnostics: config.get<boolean>("liveDiagnostics", true),
    compileDependentsOnSave: config.get<boolean>("compileDependentsOnSave", true),
    inlayHints: config.get<boolean>("inlayHints", true),
    semanticTokens: config.get<boolean>("semanticTokens", true),
    formatting: config.get<boolean>("formatting", true),
    folding: config.get<boolean>("folding", true),
    codeActions: config.get<boolean>("codeActions", true),
    includeGraph: config.get<boolean>("includeGraph", true),
    actionCompat: config.get<boolean>("actionCompat", true),
    ncsReloadOnChange: config.get<boolean>("ncsReloadOnChange", true),
    ncsActionSignatures: config.get<boolean>("ncsActionSignatures", true),
    ncsNdbOverlay: config.get<boolean>("ncsNdbOverlay", true),
    autoOpenHome: config.get<boolean>("autoOpenHome", true),
    optimizationLevel,
    optimizationFlags: OptimizationFlags[optimizationLevel],
    generateDebug: config.get<boolean>("generateDebug", false),
    maxIncludeDepth: config.get<number>("maxIncludeDepth", 32),
    maxResolveAttempts: config.get<number>("maxResolveAttempts", 64),
  };
}

export function compilerSettingsKey(settings: NWScriptSettings): string {
  return JSON.stringify({
    optimizationFlags: settings.optimizationFlags,
    generateDebug: settings.generateDebug,
    maxIncludeDepth: settings.maxIncludeDepth,
  });
}
