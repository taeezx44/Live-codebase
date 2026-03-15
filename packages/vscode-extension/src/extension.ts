// ============================================================
// extension.ts  —  CodeVis VS Code Extension
//
// Entry point. Registers:
//   - Sidebar webview panel (dependency graph mini-view)
//   - FileInfo tree view (current file stats)
//   - Commands: showInGraph, showImpact, openDashboard, configure
//   - Active editor listener → auto-highlight in graph
// ============================================================

import * as vscode from "vscode";
import { GraphPanelProvider } from "./providers/graphPanel.js";
import { FileInfoProvider }   from "./providers/fileInfo.js";
import { CodeVisClient }      from "./client.js";

let client: CodeVisClient;

export function activate(ctx: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("codevis");
  const serverUrl: string = config.get("serverUrl") ?? "http://localhost:4000";

  client = new CodeVisClient(serverUrl);

  // ── Sidebar providers ───────────────────────────────────────

  const graphProvider = new GraphPanelProvider(ctx.extensionUri, client);
  const fileInfoProvider = new FileInfoProvider(client);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codevis.graphPanel",
      graphProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.createTreeView("codevis.fileInfo", {
      treeDataProvider: fileInfoProvider,
      showCollapseAll: false,
    })
  );

  // ── Commands ────────────────────────────────────────────────

  ctx.subscriptions.push(
    vscode.commands.registerCommand("codevis.showInGraph", () => {
      const filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!filePath) return;
      graphProvider.highlightFile(filePath);
      vscode.commands.executeCommand("codevis.graphPanel.focus");
    }),

    vscode.commands.registerCommand("codevis.showImpact", async () => {
      const filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!filePath) {
        vscode.window.showWarningMessage("Open a source file first.");
        return;
      }
      graphProvider.showImpact(filePath);
      vscode.commands.executeCommand("codevis.graphPanel.focus");
    }),

    vscode.commands.registerCommand("codevis.openDashboard", () => {
      const repoId: string = config.get("repoId") ?? "";
      const url = repoId
        ? `${serverUrl}?repoId=${repoId}`
        : serverUrl.replace(":4000", ":3000");
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand("codevis.configure", async () => {
      const url = await vscode.window.showInputBox({
        prompt:       "CodeVis API server URL",
        value:        serverUrl,
        placeHolder:  "http://localhost:4000",
        validateInput: (v) =>
          v.startsWith("http") ? null : "Must start with http:// or https://",
      });
      if (url) {
        await vscode.workspace
          .getConfiguration("codevis")
          .update("serverUrl", url, vscode.ConfigurationTarget.Global);
        client.setBaseUrl(url);
        vscode.window.showInformationMessage(`CodeVis: server set to ${url}`);
      }
    })
  );

  // ── Active editor listener → auto-reveal ───────────────────

  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const autoReveal: boolean = config.get("autoReveal") ?? true;
      if (!autoReveal) return;

      const fsPath = editor.document.uri.fsPath;
      if (/\.(ts|tsx|js|jsx|py|go)$/.test(fsPath)) {
        graphProvider.highlightFile(fsPath);
        fileInfoProvider.refresh(fsPath);
      }
    })
  );

  // ── Server health check ─────────────────────────────────────

  client.health().then((ok) => {
    if (!ok) {
      vscode.window.showWarningMessage(
        `CodeVis: cannot reach ${serverUrl}. ` +
        "Run 'pnpm dev' in the project root, or update the server URL.",
        "Configure"
      ).then((choice) => {
        if (choice === "Configure") {
          vscode.commands.executeCommand("codevis.configure");
        }
      });
    }
  });
}

export function deactivate(): void {
  // nothing to clean up — webview provider disposes itself
}
