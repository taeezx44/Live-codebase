// ============================================================
// providers/fileInfo.ts  —  File Info TreeView
//
// Shows stats for the currently active file in a VS Code tree:
//
//   📄 src/app.ts
//   ├── Language        TypeScript
//   ├── Lines of code   310
//   ├── Complexity      12 (high)
//   ├── Imported by     8 files
//   └── Imports         4 files
// ============================================================

import * as vscode from "vscode";
import type { CodeVisClient, FileStats } from "../client.js";

type TreeItem = vscode.TreeItem & { children?: TreeItem[] };

export class FileInfoProvider
  implements vscode.TreeDataProvider<TreeItem>
{
  private _onDidChangeTreeData =
    new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentStats: FileStats | null = null;
  private currentPath: string | null     = null;

  constructor(private readonly client: CodeVisClient) {}

  async refresh(filePath: string): Promise<void> {
    this.currentPath = filePath;
    const config  = vscode.workspace.getConfiguration("codevis");
    const repoId: string = config.get("repoId") ?? "";

    if (!repoId) {
      this.currentStats = null;
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    this.currentStats = await this.client.getFileStats(repoId, filePath);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (element) return element.children ?? [];

    if (!this.currentStats) {
      const hint = this.makeItem(
        "Open a source file to see stats",
        "$(info)",
        vscode.TreeItemCollapsibleState.None
      );
      return [hint];
    }

    const s = this.currentStats;
    const filename = s.path.split("/").at(-1) ?? s.path;
    const ccLabel  = complexityLabel(s.complexity);

    const root = this.makeItem(
      filename,
      "$(file-code)",
      vscode.TreeItemCollapsibleState.Expanded
    );

    root.children = [
      this.stat("Language",      s.language,             "$(symbol-interface)"),
      this.stat("Lines of code", s.loc.toLocaleString(),  "$(list-ordered)"),
      this.stat("Complexity",    `${s.complexity} (${ccLabel})`, this.ccIcon(s.complexity)),
      this.stat("Imported by",   `${s.fanIn} file${s.fanIn !== 1 ? "s" : ""}`, "$(references)"),
      this.stat("Imports",       `${s.fanOut} file${s.fanOut !== 1 ? "s" : ""}`, "$(arrow-right)"),
    ];

    return [root];
  }

  // ── Helpers ─────────────────────────────────────────────────

  private makeItem(
    label: string,
    iconId: string,
    collapsible: vscode.TreeItemCollapsibleState
  ): TreeItem {
    const item = new vscode.TreeItem(label, collapsible) as TreeItem;
    item.iconPath = new vscode.ThemeIcon(iconId.replace("$(", "").replace(")", ""));
    return item;
  }

  private stat(label: string, value: string, icon: string): TreeItem {
    const item = new vscode.TreeItem(
      `${label}`,
      vscode.TreeItemCollapsibleState.None
    ) as TreeItem;
    item.description = value;
    item.iconPath    = new vscode.ThemeIcon(icon.replace("$(", "").replace(")", ""));
    return item;
  }

  private ccIcon(cc: number): string {
    if (cc <= 5)  return "$(check)";
    if (cc <= 10) return "$(warning)";
    return "$(error)";
  }
}

function complexityLabel(cc: number): string {
  if (cc <= 5)  return "low";
  if (cc <= 10) return "medium";
  if (cc <= 20) return "high";
  return "critical";
}
