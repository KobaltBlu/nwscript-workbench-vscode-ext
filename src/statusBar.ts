import * as vscode from "vscode";
import { getSettings } from "./config";

export class NWScriptStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  constructor() {
    this.item.command = "nwscript.selectCompilerTarget";
    this.update();
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  update(scope?: vscode.Uri): void {
    const settings = getSettings(scope);

    if (settings.languageSpec) {
      this.item.text = "$(file-code) NWScript: BYO";
      this.item.tooltip = `NWScript.nss language specification: ${settings.languageSpec}`;
      return;
    }

    if (settings.gameTarget) {
      this.item.text = `$(package) NWScript: ${settings.gameTarget}`;
      this.item.tooltip = `Embedded NWScript target: ${settings.gameTarget}`;
      return;
    }

    if (settings.autoDetectLanguageSpec) {
      this.item.text = "$(search) NWScript: Auto";
      this.item.tooltip =
        "Auto-detecting nwscript.nss in the active workspace folder. Click to choose an explicit specification.";
      return;
    }

    this.item.text = "$(file-code) NWScript: Select spec";
    this.item.tooltip = "Select a NWScript.nss file or embedded compiler target";
  }
}
