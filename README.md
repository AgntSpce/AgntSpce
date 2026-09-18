<h1 align="center">
  <a href="[https://agntspce-website.vercel.app/]"><img src="public/img/logo.png" alt="AgntSpce" width="64" valign="middle" /></a> AgntSpce
</h1>

<p align="center">
  Only Multi Agent Workspace IDE focused on<br/>
  <strong>cost efficiency, productivity & power!</strong>
</p>

<p align="center">
  Harness multiple coding agents all in single workspace<br/>
  with built in token reduction tools on each layer!
</p>

<p align="center">
  <a href="https://agntspce-website.vercel.app/"><img src="https://img.shields.io/badge/Website-4493F8?style=flat-square&logo=google-chrome&logoColor=white" alt="Website" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-4493F8?style=flat-square" alt="License" /></a>
  <a href="https://github.com/AniketWathore/agntspce/releases"><img src="https://img.shields.io/github/v/release/AniketWathore/agntspce?style=flat-square&logo=github" alt="Release" /></a>
  <a href="https://discord.gg/hcwQvggVR"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://www.linkedin.com/company/agntspce"><img src="https://img.shields.io/badge/LinkedIn-0A66C2?style=flat-square&logo=linkedin&logoColor=white" alt="LinkedIn" /></a>
</p>

<h3 align="center"><a href="https://agntspce-website.vercel.app/download.html"><ins>Download</ins></a> &nbsp;&bull;&nbsp; <a href="https://agntspce-website.vercel.app/docs.html"><ins>Docs</ins></a></h3>

<p align="center">
  <img src="public/img/main.png" alt="AgntSpce desktop app running multiple AI coding agents in terminal panes" width="960" style="border-radius: 8px;" />
</p>

> **Windows users:** Switch to the [`forWindows`](https://github.com/AniketWathore/agntspce/tree/forWindows) branch for Windows builds. Note that Windows builds may have issues — please [raise an issue](https://github.com/AniketWathore/agntspce/issues) if you encounter any problems.

---

## Why AgntSpce?

<table>
<tr>
<td width="33%" align="center" valign="top">

### Multi-Agent Execution

Run Claude Code, Codex, Opencode, and Gemini CLI simultaneously — each in its own isolated PTY-backed terminal. No tabs switching. No waiting.

</td>
<td width="33%" align="center" valign="top">

### Token Reduction Layers

Cut costs across every layer — command line output compression filters noise, semantic search indexes only what matters, and caveman skill strips all but essentials.

</td>
<td width="33%" align="center" valign="top">

### Worktree Orchestration

Each agent operates in its own isolated git worktree. Fan out tasks, compare results, and merge the winner — all without cross-contamination.

</td>
</tr>
</table>

---

## All Features

<table>
<tr>
<td width="50%" valign="middle">

### Parallel Agent Execution

Run Claude Code, Opencode, Codex, and Gemini CLI side-by-side. Each agent gets its own PTY-backed terminal with full session isolation.

</td>
<td width="50%">
  <img src="public/img/parallel.png" alt="Multiple AI agents running in parallel" width="100%" style="border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Workspace Management

Create, switch, and organize workspaces with persistent state. Full CRUD with trash/restore and permanent delete flows.

</td>
<td width="50%">
  <img src="public/img/readme-workspace.png" alt="Workspace sidebar with CRUD operations" width="100%" style="border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Real-Time Terminal Streaming

Live terminal output streamed via Socket.IO into xterm.js panes. Status detection (idle, busy, waiting, exited) with instant UI updates.

</td>
<td width="50%">
  <img src="public/img/readme-terminal.png" alt="Live terminal output in xterm.js panes" width="100%" style="border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### AgntSpce Output Compression

Built-in command line output compression powered by [RTK](https://github.com/rtk-ai/rtk) — filters redundant and low-information output to drastically reduce token consumption without losing context.

</td>
<td width="50%">
  <img src="public/img/agntspce output compression.png" alt="Command line output compression dashboard" width="100%" style="border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### AgntSpce Search MCP

Semantic code search via MCP protocol — index and search your entire codebase using [Semble](https://github.com/MinishLab/semble). Find relevant code instantly across any workspace.

</td>
<td width="50%">
  <img src="public/img/agntspce search mcp.png" alt="Semantic code search MCP interface" width="100%" style="border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Git & Branch Tracking

Automatic branch detection, git worktree support, and diff review — all from within the app. Review changes without context switching.

</td>
<td width="50%">
  <img src="public/img/git review.png" alt="Git diff viewer and branch tracking" width="100%" style="border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Built-in Code Editor

Monaco-powered code editor with syntax highlighting, file tree, and editor tabs. Open, edit, and save files without leaving AgntSpce.

</td>
<td width="50%">
  <img src="public/img/code editor.png" alt="Monaco code editor with file explorer" width="100%" style="border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;" />
</td>
</tr>
</table>

**Also in the box:**

- **[Shell terminals](https://docs.agntspce.dev/shell)** — Regular shell sessions alongside agent terminals in a collapsible sidebar.
- **[Dashboard & stats](https://docs.agntspce.dev/dashboard)** — Workspace/session counts, agent usage tracking, and compression metrics.
- **[Activity feed & notifications](https://docs.agntspce.dev/notifications)** — Real-time event log and unread state tracking.
- **[Commander palette](https://docs.agntspce.dev/commander)** — Cmd+K command palette for fast navigation.
- **[Caveman mode](https://docs.agntspce.dev/caveman)** — Minimalist panel for focused work.
- **And more** — we ship regularly. The [changelog](https://github.com/AniketWathore/agntspce/releases) is the real feature list.

---

## Requirements

| Requirement | Details |
|:------------|:--------|
| **OS** | macOS (primary), Windows, Linux |
| **Runtime** | Node.js 18+ |
| **Version Control** | Git 2.20+ |
| **Package Manager** | npm |

---

## Tech Stack

<p>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-191970?logo=Electron&logoColor=white" alt="Electron" /></a>
  <a href="https://reactjs.org/"><img src="https://img.shields.io/badge/React-%2320232a.svg?logo=react&logoColor=%2361DAFB" alt="React" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vitejs.dev/"><img src="https://img.shields.io/badge/Vite-%23646CFF.svg?logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://socket.io/"><img src="https://img.shields.io/badge/Socket.IO-010101?logo=socket.io&logoColor=white" alt="Socket.IO" /></a>
  <a href="https://expressjs.com/"><img src="https://img.shields.io/badge/Express-000000?logo=express&logoColor=white" alt="Express" /></a>
  <a href="https://github.com/microsoft/node-pty"><img src="https://img.shields.io/badge/node--pty-0095D5?logo=npm&logoColor=white" alt="node-pty" /></a>
  <a href="https://xtermjs.org/"><img src="https://img.shields.io/badge/xterm.js-FAB040?logo=terminal&logoColor=black" alt="xterm.js" /></a>
  <a href="https://microsoft.github.io/monaco-editor/"><img src="https://img.shields.io/badge/Monaco-FF4081?logo=visualstudiocode&logoColor=white" alt="Monaco Editor" /></a>
  <a href="https://www.npmjs.com/package/winston"><img src="https://img.shields.io/badge/Winston-231F20?logo=npm&logoColor=white" alt="Winston" /></a>
</p>

---

## Installation

### Desktop App

```bash
# Clone the repository
git clone https://github.com/AniketWathore/agntspce.git
cd agntspce

# Install dependencies
npm install

# Run in development
npm run dev

# Package for production
npm run electron:build
```

### Download Prebuilt Binaries

- **[macOS](https://github.com/AniketWathore/agntspce/releases/latest)** — Apple Silicon & Intel
- **[Windows](https://github.com/AniketWathore/agntspce/tree/forWindows)** — See the `forWindows` branch
- **[Linux](https://github.com/AniketWathore/agntspce/releases/latest)** — AppImage *(Coming soon)*

> **⚠️ Windows Note:** Windows builds are available on the [`forWindows`](https://github.com/AniketWathore/agntspce/tree/forWindows) branch but may have issues. If you run into problems, please [open an issue](https://github.com/AniketWathore/agntspce/issues).

### Acknowledgment

AgntSpce is built on the shoulders of giants. We gratefully acknowledge the following open-source projects that power core features:

- **[Caveman](https://github.com/JuliusBrussee/caveman)** — Caveman mode panel for focused, distraction-free work.
- **[RTK](https://github.com/rtk-ai/rtk)** — Powers AgntSpce command line output compression and intelligent token reduction across every layer.
- **[Semble](https://github.com/MinishLab/semble)** — Semantic code indexing and search engine behind AgntSpce Search MCP.

These projects make AgntSpce more efficient, powerful, and intelligent. We are deeply grateful to their creators and communities.

---

## Community

Join the AgntSpce community to get help, share feedback, and connect with other users:

- **[Discord](https://discord.gg/hcwQvggVR)** — Chat with the team and community
- **[LinkedIn](https://www.linkedin.com/company/agntspce)** — Follow for updates and announcements
- **[GitHub Issues](https://github.com/AniketWathore/agntspce/issues)** — Report bugs and request features
- **[GitHub Discussions](https://github.com/AniketWathore/agntspce/discussions)** — Ask questions and share ideas

### Team

[![Aniket](https://img.shields.io/badge/Aniket%20-@linkedin-0A66C2?logo=linkedin)](https://www.linkedin.com/in/aniket-wathore-99a9ba248/)
[![Rohan](https://img.shields.io/badge/Rohan%20-@linkedin-0A66C2?logo=linkedin)](https://www.linkedin.com/in/therohangaikwad/)
[![Prajwal](https://img.shields.io/badge/Prajwal%20-@linkedin-0A66C2?logo=linkedin)](https://www.linkedin.com/in/prajwal-landge-b03729421/)

---

## License

Distributed under the **Apache 2.0 License**. See [`LICENSE`](LICENSE) for more information.