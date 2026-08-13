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

export function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return (
    a.scheme === b.scheme &&
    a.authority === b.authority &&
    a.path.replace(/\/+$/, "") === b.path.replace(/\/+$/, "")
  );
}

/**
 * Create a directory and any missing parents, without touching the workspace
 * or filesystem root. vscode.dev's File System Access provider throws
 * "No file system handle registered (\)" if createDirectory is called on the
 * registered folder root.
 */
export async function ensureDirectory(uri: vscode.Uri): Promise<void> {
  if (isFilesystemRoot(uri)) {
    return;
  }

  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? workspaceFolderFor(uri);
  if (folder && sameUri(uri, folder.uri)) {
    return;
  }

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      return;
    }
    throw new Error(`${uri.toString(true)} exists and is not a directory.`);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const parent = dirname(uri);
  if (!sameUri(parent, uri)) {
    await ensureDirectory(parent);
  }

  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch (error) {
    if (isMissingHandleError(error)) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        return;
      }
    } catch {
      // Keep the original createDirectory failure.
    }
    throw error;
  }
}

export async function writeFileCreatingParents(
  uri: vscode.Uri,
  data: Uint8Array,
): Promise<void> {
  await ensureDirectory(dirname(uri));
  await vscode.workspace.fs.writeFile(uri, data);
}

function isFilesystemRoot(uri: vscode.Uri): boolean {
  const path = uri.path.replace(/\/+$/, "") || "/";
  return path === "/" || path === "" || /^\/[A-Za-z]:$/.test(path);
}

function isMissingFileError(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /FileNotFound|ENOENT|not found|does not exist/i.test(message);
}

function isMissingHandleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No file system handle registered/i.test(message);
}
