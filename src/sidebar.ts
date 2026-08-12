import * as vscode from "vscode";

type SidebarAction = {
  id: string;
  label: string;
  description: string;
  command: string;
};

const ACTIONS: SidebarAction[] = [
  {
    id: "home",
    label: "Open Home",
    description: "Language definition resolution and compiler settings",
    command: "nwscript.openHome",
  },
  {
    id: "scripts",
    label: "Browse Scripts",
    description: "Search and download KOTOR and TSL sources",
    command: "nwscript.openScriptBrowser",
  },
  {
    id: "definitions",
    label: "Browse Language Definitions",
    description: "Inspect or download canonical nwscript.nss files",
    command: "nwscript.openLanguageDefinitionBrowser",
  },
];

/**
 * Activity-bar webview: branded header plus the three workbench actions.
 * Becoming visible also spawns/reveals the Home editor panel.
 */
export function registerSidebar(
  context: vscode.ExtensionContext,
  openHome: () => Thenable<void>,
): vscode.Disposable {
  const provider = new NWScriptSidebarViewProvider(context, openHome);
  return vscode.window.registerWebviewViewProvider(
    NWScriptSidebarViewProvider.viewType,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
}

class NWScriptSidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nwscript.sidebar";

  private view?: vscode.WebviewView;
  private openingHome = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly openHome: () => Thenable<void>,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "assets")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: { type?: string; command?: string }) => {
      if (message.type === "runCommand" && typeof message.command === "string") {
        void vscode.commands.executeCommand(message.command);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible || this.openingHome) {
        return;
      }
      this.openingHome = true;
      void Promise.resolve(this.openHome()).finally(() => {
        this.openingHome = false;
      });
    });

    if (webviewView.visible) {
      this.openingHome = true;
      void Promise.resolve(this.openHome()).finally(() => {
        this.openingHome = false;
      });
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const version = String(this.context.extension.packageJSON.version ?? "");
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "assets", "logo.png"),
    ).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const actions = ACTIONS.map(
      (action) => `
      <button class="action" data-command="${escapeHtml(action.command)}" type="button">
        <strong>${escapeHtml(action.label)}</strong>
        <span>${escapeHtml(action.description)}</span>
      </button>`,
    ).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NWScript Workbench</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px 12px 18px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: 12px/1.45 var(--vscode-font-family);
    }
    button { font: inherit; cursor: pointer; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .brand {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
      padding: 4px 2px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .brand img {
      width: 48px;
      height: 48px;
      display: block;
      object-fit: contain;
      border-radius: 10px;
    }
    .brand-copy { min-width: 0; }
    .brand-copy strong {
      display: block;
      font-size: 13px;
      font-weight: 650;
      line-height: 1.25;
    }
    .brand-copy span {
      display: block;
      margin-top: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .actions { display: grid; gap: 8px; }
    .action {
      width: 100%;
      text-align: left;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      padding: 11px 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, transparent);
    }
    .action:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
    }
    .action strong, .action span { display: block; }
    .action strong { font-size: 12px; font-weight: 600; }
    .action span {
      margin-top: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <header class="brand">
    <img src="${escapeHtml(logoUri)}" alt="NWScript Workbench">
    <div class="brand-copy">
      <strong>NWScript Workbench</strong>
      <span>v${escapeHtml(version)}</span>
    </div>
  </header>
  <div class="actions">${actions}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'runCommand', command: button.dataset.command });
      });
    });
  </script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
