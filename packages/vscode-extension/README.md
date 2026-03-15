# CodeVis VS Code Extension

Visualize your codebase dependency graph directly in VS Code.

## Features

- **Sidebar graph panel** — mini dependency graph of your repo, always visible
- **Auto-highlight** — switches focus to the current file in the graph as you navigate
- **Impact analysis** — right-click any file → "Show Impact" to see what breaks if you change it
- **File stats** — LOC, cyclomatic complexity, fan-in, fan-out in the sidebar tree

## Requirements

The CodeVis API server must be running locally:

```bash
git clone https://github.com/taeezx44/Live-codebase
cd Live-codebase
bash infra/scripts/dev-setup.sh
pnpm dev
```

Then import a repo from http://localhost:3000 and the graph will appear in the sidebar.

## Setup

1. Install the extension (or run it in Extension Development Host via F5)
2. Open a workspace that has been analyzed by CodeVis
3. The sidebar panel activates automatically

If the extension can't reach the server, it will prompt you to configure the URL:

```
CodeVis: Configure Server URL → http://localhost:4000
```

## Commands

| Command | Shortcut | Description |
|---|---|---|
| Show Current File in Graph | Editor title button | Highlights active file in sidebar graph |
| Show Impact of Current File | Right-click menu | Shows affected files in orange |
| Open Full Dashboard | — | Opens the web dashboard in browser |
| Configure Server URL | — | Set a custom API server URL |

## Settings

| Setting | Default | Description |
|---|---|---|
| `codevis.serverUrl` | `http://localhost:4000` | API server URL |
| `codevis.autoReveal` | `true` | Auto-highlight on editor switch |
| `codevis.repoId` | `""` | Active repo ID (set automatically) |

## Development

```bash
cd packages/vscode-extension
pnpm install
pnpm compile

# Open in Extension Development Host
code .
# Press F5
```
