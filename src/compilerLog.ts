import * as vscode from "vscode";

/**
 * Writes NWScript compiler lifecycle messages to the VS Code Output panel.
 */
export class CompilerLog implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel("NWScript Compiler");
  }

  dispose(): void {
    this.channel.dispose();
  }

  info(message: string): void {
    this.channel.appendLine(`${this.timestamp()} ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`${this.timestamp()} ERROR ${message}`);
  }

  section(title: string): void {
    this.channel.appendLine("");
    this.channel.appendLine(`${this.timestamp()} === ${title} ===`);
  }

  /**
   * Reveal the Output panel on the compiler channel.
   * @param preserveFocus When true (default), keep editor focus.
   */
  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  private timestamp(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `[${hh}:${mm}:${ss}]`;
  }
}
