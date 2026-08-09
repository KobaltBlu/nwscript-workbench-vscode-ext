import * as vscode from "vscode";

export function basename(uri: vscode.Uri): string {
  const path = uri.path.replace(/\/+$/, "");
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

export function dirname(uri: vscode.Uri): vscode.Uri {
  const path = uri.path.replace(/\/+$/, "");
  const index = path.lastIndexOf("/");
  const parent = index <= 0 ? "/" : path.slice(0, index);
  return uri.with({ path: parent });
}

export function extname(uri: vscode.Uri): string {
  const name = basename(uri);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

export function basenameWithoutExtension(uri: vscode.Uri): string {
  const name = basename(uri);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

export function normalizeResRef(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  let name = slash >= 0 ? value.slice(slash + 1) : value;
  if (name.toLowerCase().endsWith(".nss")) {
    name = name.slice(0, -4);
  }
  return name.toLowerCase();
}

export function withExtension(uri: vscode.Uri, extension: string): vscode.Uri {
  const dir = dirname(uri);
  return vscode.Uri.joinPath(dir, `${basenameWithoutExtension(uri)}${extension}`);
}

export function workspaceFolderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (uri) {
    const exact = vscode.workspace.getWorkspaceFolder(uri);
    if (exact) {
      return exact;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function resolveWorkspaceUri(value: string, anchor?: vscode.Uri): vscode.Uri | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  // Explicit URIs work in desktop and browser hosts. Plain paths are treated
  // as workspace-relative so virtual workspaces remain supported.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return vscode.Uri.parse(trimmed, true);
  }

  const folder = workspaceFolderFor(anchor);
  if (!folder) {
    return undefined;
  }

  const expanded = trimmed.replace(/^\$\{workspaceFolder\}[\\/]?/, "");
  const parts = expanded.split(/[\\/]+/).filter(Boolean);
  return vscode.Uri.joinPath(folder.uri, ...parts);
}

export function toWorkspacePathOrUri(uri: vscode.Uri, anchor?: vscode.Uri): string {
  const folder = workspaceFolderFor(anchor ?? uri);
  if (
    folder &&
    uri.scheme === folder.uri.scheme &&
    uri.authority === folder.uri.authority &&
    (uri.path === folder.uri.path || uri.path.startsWith(`${folder.uri.path.replace(/\/$/, "")}/`))
  ) {
    const relative = uri.path.slice(folder.uri.path.length).replace(/^\/+/, "");
    return relative ? `\${workspaceFolder}/${relative}` : "\${workspaceFolder}";
  }

  return uri.toString(true);
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
