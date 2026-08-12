import * as vscode from "vscode";

export class NWScriptStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  constructor() {
    this.item.command = "nwscript.openHome";
    this.update();
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  update(scope?: vscode.Uri): void {
    void scope;
    this.item.text = "$(search) NWScript Workbench: Auto";
    this.item.tooltip = "Resolving nwscript.nss from the active script. Click to open the resolution list.";
  }
}
