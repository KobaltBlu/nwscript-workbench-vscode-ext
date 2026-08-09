import * as vscode from "vscode";
import { OptimizationFlags } from "@neverwinter/nwscript-wasm";

export type OptimizationLevel = "O0" | "O1" | "O2" | "O3";

export interface NWScriptSettings {
  gameTarget: string;
  languageSpec: string;
  autoDetectLanguageSpec: boolean;
  includePaths: string[];
  outputDirectory: string;
  compileOnSave: boolean;
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
    gameTarget: config.get<string>("gameTarget", "").trim(),
    languageSpec: config.get<string>("languageSpec", "").trim(),
    autoDetectLanguageSpec: config.get<boolean>("autoDetectLanguageSpec", true),
    includePaths: config.get<string[]>("includePaths", []),
    outputDirectory: config.get<string>("outputDirectory", "").trim(),
    compileOnSave: config.get<boolean>("compileOnSave", false),
    optimizationLevel,
    optimizationFlags: OptimizationFlags[optimizationLevel],
    generateDebug: config.get<boolean>("generateDebug", false),
    maxIncludeDepth: config.get<number>("maxIncludeDepth", 32),
    maxResolveAttempts: config.get<number>("maxResolveAttempts", 64),
  };
}

export function compilerSettingsKey(settings: NWScriptSettings): string {
  return JSON.stringify({
    gameTarget: settings.gameTarget,
    languageSpec: settings.languageSpec,
    autoDetectLanguageSpec: settings.autoDetectLanguageSpec,
    optimizationFlags: settings.optimizationFlags,
    generateDebug: settings.generateDebug,
    maxIncludeDepth: settings.maxIncludeDepth,
  });
}
