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

  private busy = false;

  update(scope?: vscode.Uri): void {
    void scope;
    this.render();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.render();
  }

  private render(): void {
    if (this.busy) {
      this.item.text = "$(sync~spin) NWScript: Checking…";
      this.item.tooltip = "Live compile is checking the active NWScript buffer.";
      return;
    }
    this.item.text = "$(search) NWScript Workbench: Auto";
    this.item.tooltip = "Resolving nwscript.nss from the active script. Click to open the resolution list.";
  }
}
