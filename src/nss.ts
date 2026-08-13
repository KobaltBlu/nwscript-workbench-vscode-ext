import * as vscode from "vscode";
import { basename } from "./uri";

export const NSS_EXCLUDE = "**/{node_modules,.git,dist,out,build}/**";
export const NSS_SCRIPT_FIND_LIMIT = 10_000;

export function isLanguageSpecFile(uri: vscode.Uri): boolean {
  return basename(uri).toLowerCase() === "nwscript.nss";
}

export function isEntryScriptSource(text: string): boolean {
  return /\bvoid\s+main\s*\(/.test(text) || /\bint\s+StartingConditional\s*\(/.test(text);
}

export function isNssUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith(".nss");
}
