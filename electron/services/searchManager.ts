import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'node:crypto'

import { fileURLToPath } from 'node:url'

// Must match the HMAC secret compiled into the prebuilt agntspce-search
// distribution (activation.py verifies session tokens against it). The search
// bundle ships as a prebuilt binary — changing this secret requires shipping a
// new distribution, not just an app-side change.
const HMAC_SECRET = 'agntspce-search-integration-v1-do-not-rely-on-this-for-security'
const TOKEN_TTL_SECS = 86400
const SEARCH_VERSION = '0.1.1'

let _activeSearchPath: string | null = null
let _activeSearchDir: string | null = null

function writeWithBackup(filePath: string, content: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak')
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
    return true
  } catch (e) {
    console.error(`[agntspce] Failed to write ${filePath}:`, e)
    const backup = filePath + '.bak'
    if (fs.existsSync(backup)) {
      try { fs.copyFileSync(backup, filePath); fs.rmSync(backup) } catch {}
    }
    return false
  }
}

const AGENT_CHECKS = [
  {
    id: 'claude',
    configDir: () => path.join(os.homedir(), '.claude'),
    check: () => fs.existsSync(path.join(os.homedir(), '.claude', 'settings.json')),
  },
  {
    id: 'opencode',
    configDir: () => path.join(os.homedir(), '.config', 'opencode'),
    check: () => fs.existsSync(path.join(os.homedir(), '.config', 'opencode', 'config.json')),
  },
]

type AgentCheck = (typeof AGENT_CHECKS)[number]

function getBundledSearchDir(): string | null {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // Production: extraResources → <app>/Resources/search/
    path.join(process.resourcesPath || '', 'search'),
    // Dev (Vite-bundled): dist-electron/  →  <project>/search/
    path.join(__dirname, '..', 'search'),
    // Dev (tsc-compiled): dist-electron/services/  →  <project>/search/
    path.join(__dirname, '..', '..', 'search'),
    // Dev fallback: project root via electron API
    path.join(app.getAppPath(), 'search'),
    // Dev fallback: <project>/bin/search/
    path.resolve(__dirname, '..', '..', 'bin', 'search'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function getInstalledSearchDir(): string {
  return path.join(app.getPath('userData'), 'search')
}

// Bootstrap executed by the bundled interpreter to start the MCP stdio server.
// The portable bundle ships no native executable entry point, so on Windows the
// server is launched as: <bundle>/python/python.exe -c <bootstrap>.
// The search code is exposed as `agntspce_search` (copied from the bundled
// package at install time so the import below works). The fallback import
// keeps very old installs working until the copy exists; both copies announce
// themselves as `agntspce-search` (see patchMcpServerName).
const MCP_BOOTSTRAP =
  'import asyncio\n' +
  'try:\n' +
  ' from agntspce_search.mcp import serve\n' +
  'except ImportError:\n' +
  '  from semble.mcp import serve\n' +
  'asyncio.run(serve())'

function getInstalledBinaryPath(): string {
  const searchDir = getInstalledSearchDir()
  if (process.platform === 'win32') {
    // No .exe exists in the cross-built bundle — the launchable binary is the
    // bundled interpreter itself (see resolveMcpLaunch for the full command).
    return path.join(searchDir, 'python', 'python.exe')
  }
  return path.join(searchDir, 'python', 'bin', 'agntspce-search')
}

// Full stdio launch specification for the agntspce-search MCP server.
// Returns null when the installed bundle cannot launch the server.
function resolveMcpLaunch(): { command: string; args?: string[] } | null {
  if (process.platform === 'win32') {
    const pyExe = path.join(getInstalledSearchDir(), 'python', 'python.exe')
    if (!fs.existsSync(pyExe)) return null
    return { command: pyExe, args: ['-c', MCP_BOOTSTRAP] }
  }
  const binPath = getInstalledBinaryPath()
  if (!fs.existsSync(binPath)) return null
  return { command: binPath }
}

function findInstalledBinary(candidates: string[]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function getBundledVersion(): string | null {
  const dir = getBundledSearchDir()
  if (!dir) return null
  const vFile = path.join(dir, 'VERSION')
  try {
    return fs.readFileSync(vFile, 'utf-8').trim()
  } catch {
    return null
  }
}

function getInstalledVersion(): string | null {
  const vFile = path.join(getInstalledSearchDir(), 'VERSION')
  try {
    return fs.readFileSync(vFile, 'utf-8').trim()
  } catch {
    return null
  }
}

function getInstalledBinaryCandidates(): string[] {
  const searchDir = getInstalledSearchDir()
  if (process.platform === 'win32') {
    return [
      path.join(searchDir, 'python', 'python.exe'),
      path.join(searchDir, 'python', 'Scripts', 'agntspce-search.exe'),
      path.join(searchDir, 'python', 'Scripts', 'agntspce-search.cmd'),
      path.join(searchDir, 'python', 'bin', 'agntspce-search'),
    ]
  }
  return [path.join(searchDir, 'python', 'bin', 'agntspce-search')]
}

function fixSearchBinary(binPath: string, searchDir: string): void {
  if (process.platform === 'win32') return
  const pythonBin = path.join(searchDir, 'python', 'bin', 'python3')
  if (!fs.existsSync(pythonBin)) return
  try {
    const content = fs.readFileSync(binPath, 'utf-8')
    if (!content.startsWith('#!')) return
    const shebang = content.split('\n')[0]
    const interpreterPath = shebang.slice(2).trim().split(' ')[0]
    const pyPath = binPath + '.py'
    if (interpreterPath && fs.existsSync(interpreterPath)) {
      if (content.startsWith('#!/bin/sh') && fs.existsSync(pyPath)) return
      fs.writeFileSync(pyPath, content, 'utf-8')
      fs.chmodSync(pyPath, 0o755)
    } else {
      const _name = path.basename(binPath)
      const lines = content.split('\n')
      lines[0] = `#!${pythonBin}`
      fs.writeFileSync(pyPath, lines.join('\n'), 'utf-8')
      fs.chmodSync(pyPath, 0o755)
    }
    const wrapper = `#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="$SCRIPT_DIR/.."
exec "$SCRIPT_DIR/python3" "${pyPath}" "$@"
`
    fs.writeFileSync(binPath, wrapper, 'utf-8')
    fs.chmodSync(binPath, 0o755)
  } catch (e) {
    console.warn('[agntspce] Failed to fix search binary:', e)
  }
}

// Windows portable CPython uses <bundle>/python/Lib/site-packages; the POSIX
// bundle nests it under lib/python3.x/.
function getSitePackagesDir(searchDir: string): string {
  if (process.platform === 'win32') {
    return path.join(searchDir, 'python', 'Lib', 'site-packages')
  }
  return path.join(searchDir, 'python', 'lib', 'python3.13', 'site-packages')
}

function cleanupStaleSitePackages(searchDir: string): void {
  const sitePkgs = getSitePackagesDir(searchDir)
  if (!fs.existsSync(sitePkgs)) return
  try {
    for (const entry of fs.readdirSync(sitePkgs)) {
      if (!entry.endsWith('.pth')) continue
      const pthPath = path.join(sitePkgs, entry)
      const content = fs.readFileSync(pthPath, 'utf-8').trim()
      if (!content) continue
      if (content.startsWith('/') || content.startsWith('file://')) {
        const dirToCheck = content.startsWith('file://') ? content.slice(7) : content
        if (!fs.existsSync(decodeURIComponent(dirToCheck))) {
          fs.rmSync(pthPath)
          console.log(`[agntspce] Removed stale .pth: ${entry} → ${content}`)
        }
      }
    }
  } catch {}
}

function isPackageBroken(searchDir: string): boolean {
  const sitePkgs = getSitePackagesDir(searchDir)
  // The distribution installs the server under both the original package
  // name and `agntspce_search` — broken only when neither is present.
  const hasAgntspce = fs.existsSync(path.join(sitePkgs, 'agntspce_search'))
  const hasSemble = fs.existsSync(path.join(sitePkgs, 'semble'))
  return !hasAgntspce && !hasSemble
}

// Display name announced by the search MCP server (FastMCP name + config keys).
// The portable bundle is built from the upstream `semble` pip package — that
// dependency name (and its `semble.*` imports) must stay intact for pip and
// Python imports to work. Only user-visible names are rewritten.
const MCP_SERVER_NAME = 'agntspce-search'

// Upstream ships the server name on one line (`FastMCP("semble")`) in older
// releases and across lines (`FastMCP(\n    "semble",`) in newer ones, so the
// match must tolerate any whitespace/quoting (and an optional `name=` kwarg).
const FASTMCP_NAME_RES = [
  /FastMCP\(\s*name\s*=\s*["']semble["']/g,
  /FastMCP\(\s*["']semble["']/g,
]

// User-visible installer strings rewritten to the AgntSpce display name.
// Functional identifiers (Python imports, `files("semble")` resource refs,
// `semble[mcp]` pip specs, env vars, cache folders, dist-info dirs) are
// intentionally left untouched — renaming those would break pip and imports.
// Doc-section markers are renamed as *values* (constant names stay so
// imports keep working); legacy values are still honoured via _LEGACY_*
// constants injected below, so old installs migrate instead of orphaning.
const INSTALLER_RENAMES: Array<[RegExp, string]> = [
  [/mcp__semble__/g, 'mcp__agntspce-search__'],
  [/## Semble Code Search/g, '## AgntSpce Search'],
  [/A `semble` MCP server/g, 'A `agntspce-search` MCP server'],
  [/After semble returns/g, 'After agntspce-search returns'],
  [/\[mcp_servers\.semble\]/g, '[mcp_servers.agntspce-search]'],
  [/mcp_servers\.semble/g, 'mcp_servers.agntspce-search'],
  [/one of semble's/g, "one of agntspce-search's"],
  [/semble MCP entry/g, 'agntspce-search MCP entry'],
  [/call semble directly as a tool/g, 'call agntspce-search directly as a tool'],
  [/Install or uninstall semble across coding agents\./g, 'Install or uninstall AgntSpce Search across coding agents.'],
  [/Semble Uninstaller/g, 'AgntSpce Search Uninstaller'],
  [/Semble Installer/g, 'AgntSpce Search Installer'],
  [/Remove semble configuration\?/g, 'Remove AgntSpce Search configuration?'],
  [/marked semble section/g, 'marked AgntSpce Search section'],
  [/the semble \[mcp_servers\./g, 'the agntspce-search [mcp_servers.'],
  // (HTML-comment markers below are spelled with unicode escapes because
  // `<!--` is not allowed literally in a module.)
  [/\u003C!-- SEMBLE_START --\u003E/g, '<!-- AGNTSPCE_START -->'],
  [/\u003C!-- SEMBLE_END --\u003E/g, '<!-- AGNTSPCE_END -->'],
  [/semble-search/g, 'agntspce-search'],
  [/semble\.md/g, 'agntspce-search.md'],
  // The old fallback taught agents to `uvx` the upstream package, which
  // installed a global `semble` MCP entry on fresh PCs. Point at the bundle.
  [/If `agntspce-search` is not on `\$PATH`, use `uvx --from "semble\[mcp\]" semble`\./g, 'If `agntspce-search` is not on `$PATH`, reinstall or restart AgntSpce to restore the bundled server.'],
]

function rewriteMcpServerName(content: string): string {
  let out = content
  for (const re of FASTMCP_NAME_RES) {
    re.lastIndex = 0
    out = out.replace(re, (m) => (/name\s*=/.test(m) ? 'FastMCP(name="agntspce-search"' : 'FastMCP("agntspce-search"'))
  }
  return out
}

function rewriteInstallerText(content: string): string {
  let out = content
  for (const [re, replacement] of INSTALLER_RENAMES) {
    re.lastIndex = 0
    out = out.replace(re, replacement)
  }
  return out
}

// installer/agents.py: inject legacy doc-marker constants derived from the
// (renamed) values so no literal old marker is left for a re-run to clobber.
function rewriteInstallerAgentsPy(content: string): string {
  let out = rewriteInstallerText(content)
  if (!out.includes('_LEGACY_START')) {
    const lines = out.split('\n')
    const idx = lines.findIndex((l) => l.startsWith('SEMBLE_END = '))
    if (idx !== -1) {
      lines.splice(
        idx + 1,
        0,
        '# Markers written by older installs — consulted when replacing/removing docs.',
        '_LEGACY_START = SEMBLE_START.replace("AGNTSPCE", "SEMBLE")',
        '_LEGACY_END = SEMBLE_END.replace("AGNTSPCE", "SEMBLE")',
      )
      out = lines.join('\n')
    }
  }
  return out
}

// installer/config.py: honour legacy markers and the legacy Codex table so
// docs/configs written by older installs migrate instead of orphaning.
// All anchors are exact — a shape change skips the step (with a warning)
// instead of half-applying. Re-runs are no-ops.
function rewriteInstallerConfigPy(content: string): { text: string; skipped: string[] } {
  let out = rewriteInstallerText(content)
  const skipped: string[] = []
  const legacyImportFrom = 'from semble.installer.agents import SEMBLE_END, SEMBLE_START, Action'
  if (!out.includes('_LEGACY_START') && out.includes(legacyImportFrom)) {
    out = out.replace(
      legacyImportFrom,
      'from semble.installer.agents import SEMBLE_END, SEMBLE_START, Action, _LEGACY_END, _LEGACY_START',
    )
  }
  const hasLegacy = out.includes('_LEGACY_START')
  const migrationLine =
    '    existing = existing.replace(_LEGACY_START, SEMBLE_START).replace(_LEGACY_END, SEMBLE_END)'
  if (hasLegacy && !out.includes(migrationLine)) {
    const replaceAnchor = '    existing = path.read_text(encoding="utf-8") if existed else ""'
    if (out.includes(replaceAnchor)) {
      out = out.replace(replaceAnchor, `${replaceAnchor}\n${migrationLine}`)
    } else {
      skipped.push('replace_or_append_marked anchor')
    }
    const removeAnchor = '    existing = path.read_text(encoding="utf-8")\n'
    if (out.includes(removeAnchor)) {
      out = out.replace(removeAnchor, `${removeAnchor}${migrationLine}\n`)
    } else {
      skipped.push('remove_marked anchor')
    }
  }
  if (!out.includes('_CODEX_MCP_HEADER_LEGACY')) {
    const lines = out.split('\n')
    const idx = lines.findIndex((l) => l.startsWith('_CODEX_MCP_HEADER = '))
    if (idx !== -1) {
      lines.splice(
        idx + 1,
        0,
        '_CODEX_MCP_HEADER_LEGACY = _CODEX_MCP_HEADER.replace("agntspce-search", "semble")',
      )
      out = lines.join('\n')
    } else {
      skipped.push('_CODEX_MCP_HEADER anchor')
    }
  }
  if (out.includes('_CODEX_MCP_HEADER_LEGACY')) {
    const mergeAnchor = '    base = _strip_toml_section(existing, _CODEX_MCP_HEADER).rstrip("\\n")'
    if (out.includes(mergeAnchor) && !out.includes('_CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER)')) {
      out = out.replace(
        mergeAnchor,
        '    base = _strip_toml_section(_strip_toml_section(existing, _CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).rstrip("\\n")',
      )
    }
    const removeCondAnchor = '    if _CODEX_MCP_HEADER not in existing:'
    if (out.includes(removeCondAnchor) && !out.includes('_CODEX_MCP_HEADER_LEGACY not in existing')) {
      out = out.replace(
        removeCondAnchor,
        '    if _CODEX_MCP_HEADER not in existing and _CODEX_MCP_HEADER_LEGACY not in existing:',
      )
    }
    const removeStripAnchor = '    remaining = _strip_toml_section(existing, _CODEX_MCP_HEADER).strip("\\n")'
    if (out.includes(removeStripAnchor) && !out.includes('_CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).strip')) {
      out = out.replace(
        removeStripAnchor,
        '    remaining = _strip_toml_section(_strip_toml_section(existing, _CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).strip("\\n")',
      )
    }
  }
  return { text: out, skipped }
}

// Sub-agent templates (agents/*.md|*.toml) are pure docs with no imports:
// every remaining standalone `semble` word is a CLI/prose reference. The uvx
// fallback sentence is removed first so its `semble[mcp]` pip spec is dropped,
// not rewritten.
const TEMPLATE_RENAMES: Array<[RegExp, string]> = [
  [/If `semble` is not on `\$PATH`, use `uvx --from "semble\[mcp\]" semble` in its place\./g, 'If `agntspce-search` is not on `$PATH`, reinstall or restart AgntSpce to restore the bundled server.'],
  [/\bsemble\b/g, 'agntspce-search'],
]

function rewriteAgentTemplate(content: string): string {
  let out = rewriteInstallerText(content)
  for (const [re, replacement] of TEMPLATE_RENAMES) {
    re.lastIndex = 0
    out = out.replace(re, replacement)
  }
  return out
}

// cli.py display strings (`--help` text, argparse prog). Exact anchors —
// skipped with a warning when upstream changes shape. Imports, package
// extras and the `pip install 'semble[mcp]'` hint stay intact (functional).
function rewriteCliPy(content: string): { text: string; skipped: string[] } {
  let out = content
  const skipped: string[] = []
  const pairs: Array<[string, string]> = [
    ['prog="semble"', 'prog="agntspce-search"'],
    ['"""Entry point for the semble command-line tool."""', '"""Entry point for the agntspce-search command-line tool."""'],
    ['"Configure semble across coding agents."', '"Configure AgntSpce Search across coding agents."'],
    ['"Remove semble configuration from coding agents."', '"Remove AgntSpce Search configuration from coding agents."'],
  ]
  for (const [from, to] of pairs) {
    if (out.includes(from)) {
      out = out.split(from).join(to)
    } else if (!out.includes(to)) {
      skipped.push(from.slice(0, 48))
    }
  }
  return { text: out, skipped }
}

// stats.py savings-report title shown by the CLI.
function rewriteStatsPy(content: string): { text: string; skipped: string[] } {
  const from = '"Semble Token Savings"'
  const to = '"AgntSpce Search Token Savings"'
  if (content.includes(from)) return { text: content.split(from).join(to), skipped: [] }
  if (content.includes(to)) return { text: content, skipped: [] }
  return { text: content, skipped: ['"Semble Token Savings" anchor'] }
}

// installer/installer.py: the global MCP entry key. Install writes our key
// (dropping the legacy one first); uninstall removes both. Exact anchors —
// skipped with a warning when upstream changes shape.
function rewriteInstallerMainPy(content: string): { text: string; skipped: string[] } {  let out = rewriteInstallerText(content)
  const skipped: string[] = []
  const mergeAnchor =
    'return WriteResult(path, merge_json_member(path, agent.mcp.key, "semble", agent.mcp.entry))'
  if (out.includes(mergeAnchor)) {
    out = out.replace(
      mergeAnchor,
      'remove_json_member(path, agent.mcp.key, "semble")\n    return WriteResult(path, merge_json_member(path, agent.mcp.key, "agntspce-search", agent.mcp.entry))',
    )
  } else if (!out.includes('"agntspce-search", agent.mcp.entry')) {
    skipped.push('merge_mcp anchor')
  }
  const removeAnchor = 'return WriteResult(path, remove_json_member(path, agent.mcp.key, "semble"))'
  if (out.includes(removeAnchor)) {
    out = out.replace(
      removeAnchor,
      'remove_json_member(path, agent.mcp.key, "semble")\n    return WriteResult(path, remove_json_member(path, agent.mcp.key, "agntspce-search"))',
    )
  } else if (!out.includes('remove_json_member(path, agent.mcp.key, "agntspce-search")')) {
    skipped.push('remove_mcp anchor')
  }
  return { text: out, skipped }
}

// Recursively delete all bytecode so a stale .pyc can never shadow patched
// sources. Previously only `mcp.*.pyc` was removed, and the `semble` copy was
// never patched when upstream split `FastMCP(` and the name across lines —
// that combination kept announcing the old name on fresh PCs.
function purgeBytecode(dir: string): void {
  if (!fs.existsSync(dir)) return
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') {
          try { fs.rmSync(full, { recursive: true, force: true }) } catch {}
        } else {
          purgeBytecode(full)
        }
      } else if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
        try { fs.rmSync(full) } catch {}
      }
    }
  } catch {}
}

// The upstream pip package ships the MCP server under its own display name,
// which makes tools appear as `mcp__semble__search`. AgntSpce exposes it as
// `agntspce-search`. The portable bundle is built from that package but we
// expose it as `agntspce_search` by copying the package and rewriting the
// FastMCP name. Patch both the installed and bundled distributions on the
// fly so a tarball that still contains the old name is corrected.
function patchMcpServerName(searchDir: string): void {
  const sitePkgs = getSitePackagesDir(searchDir)
  const semblePath = path.join(sitePkgs, 'semble')
  const agntspcePath = path.join(sitePkgs, 'agntspce_search')

  // Ensure agntspce_search package exists (copy from the bundled package if
  // needed). This makes `from agntspce_search.mcp import serve` work.
  // Bytecode is excluded from the copy so stale caches never propagate.
  if (fs.existsSync(semblePath) && !fs.existsSync(agntspcePath)) {
    try {
      fs.cpSync(semblePath, agntspcePath, {
        recursive: true,
        filter: (src) => !src.endsWith('__pycache__') && !src.endsWith('.pyc') && !src.endsWith('.pyo'),
      })
      console.log(`[agntspce] Created agntspce_search package at ${agntspcePath}`)
    } catch (e) {
      console.warn('[agntspce] Failed to copy search package → agntspce_search:', e)
    }
  }

  // Rewrite the display name in both packages (bundled copy is primary,
  // original name kept working for backwards compat).
  for (const pkg of ['semble', 'agntspce_search']) {
    const mcpPath = path.join(sitePkgs, pkg, 'mcp.py')
    if (!fs.existsSync(mcpPath)) continue
    try {
      const before = fs.readFileSync(mcpPath, 'utf-8')
      const after = rewriteMcpServerName(before)
      if (after !== before) {
        fs.writeFileSync(mcpPath, after, 'utf-8')
        console.log(`[agntspce] Rewrote MCP server name in ${mcpPath}`)
      }
      const verify = fs.readFileSync(mcpPath, 'utf-8')
      if (/FastMCP\(\s*(?:name\s*=\s*)?["']semble["']/.test(verify)) {
        console.warn(`[agntspce] MCP server name rewrite did not apply in ${mcpPath}`)
      }
    } catch (e) {
      console.warn(`[agntspce] Failed to rewrite mcp.py (${pkg}):`, e)
    }

    const rewriteFile = (
      rel: string,
      rewrite: (before: string) => string,
      label: string,
    ): void => {
      const filePath = path.join(sitePkgs, pkg, rel)
      if (!fs.existsSync(filePath)) return
      try {
        const before = fs.readFileSync(filePath, 'utf-8')
        const after = rewrite(before)
        if (after !== before) {
          fs.writeFileSync(filePath, after, 'utf-8')
          console.log(`[agntspce] Rewrote ${label} in ${filePath}`)
        }
      } catch (e) {
        console.warn(`[agntspce] Failed to rewrite ${label} (${pkg}/${rel}):`, e)
      }
    }

    rewriteFile(path.join('installer', 'agents.py'), rewriteInstallerAgentsPy, 'installer display strings')
    rewriteFile(
      path.join('installer', 'config.py'),
      (before) => {
        const { text, skipped } = rewriteInstallerConfigPy(before)
        if (skipped.length > 0) {
          console.warn(`[agntspce] Skipped installer/config.py steps (upstream shape changed): ${skipped.join(', ')}`)
        }
        return text
      },
      'installer display strings',
    )
    rewriteFile(
      path.join('installer', 'installer.py'),
      (before) => {
        const { text, skipped } = rewriteInstallerMainPy(before)
        if (skipped.length > 0) {
          console.warn(`[agntspce] Skipped installer/installer.py steps (upstream shape changed): ${skipped.join(', ')}`)
        }
        return text
      },
      'installer MCP key',
    )

    // Sub-agent templates ship CLI/prose references (`semble search`, …) that
    // are visible in agent `/agents` lists and sub-agent prompts when
    // installed. Rename the display/CLI name (pure docs, no imports).
    try {
      const agentsDir = path.join(sitePkgs, pkg, 'agents')
      if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir)) {
          if (!entry.endsWith('.md') && !entry.endsWith('.toml')) continue
          rewriteFile(path.join('agents', entry), rewriteAgentTemplate, 'sub-agent display name')
        }
      }
    } catch (e) {
      console.warn(`[agntspce] Failed to rewrite sub-agent templates (${pkg}):`, e)
    }

    // CLI display strings (`--help` text, argparse prog) and the
    // savings-report title. Exact anchors, fail-safe.
    rewriteFile(
      'cli.py',
      (before) => {
        const { text, skipped } = rewriteCliPy(before)
        if (skipped.length > 0) {
          console.warn(`[agntspce] Skipped cli.py steps (upstream shape changed): ${skipped.join(', ')}`)
        }
        return text
      },
      'CLI display strings',
    )
    rewriteFile(
      'stats.py',
      (before) => {
        const { text, skipped } = rewriteStatsPy(before)
        if (skipped.length > 0) {
          console.warn(`[agntspce] Skipped stats.py steps (upstream shape changed): ${skipped.join(', ')}`)
        }
        return text
      },
      'savings-report title',
    )

    // Delete all stale bytecode under the package so the rewritten sources
    // are recompiled on next launch.
    purgeBytecode(path.join(sitePkgs, pkg))
  }
}

function installSearch(): string | null {
  const bundled = getBundledSearchDir()
  if (!bundled) {
    const installedBinary = findInstalledBinary(getInstalledBinaryCandidates())
    if (installedBinary) {
      const installedVersion = getInstalledVersion()
      console.log(`[agntspce] Search v${installedVersion || '?'} already installed (no bundle)`)
      fixSearchBinary(installedBinary, getInstalledSearchDir())
      patchMcpServerName(getInstalledSearchDir())
      return installedBinary
    }
    console.warn('[agntspce] Search bundle not found — skipping install')
    return null
  }

  const installed = getInstalledSearchDir()
  const bundledVersion = getBundledVersion()
  const installedVersion = getInstalledVersion()

  const currentBinary = findInstalledBinary(getInstalledBinaryCandidates())
  if (bundledVersion && installedVersion === bundledVersion && currentBinary) {
    cleanupStaleSitePackages(installed)
    if (!isPackageBroken(installed)) {
      console.log(`[agntspce] Search v${bundledVersion} already installed at ${installed}`)
      fixSearchBinary(currentBinary, installed)
      // Re-apply the display-name rewrite on every start so an install that
      // still carries the old server name is corrected without a version bump.
      patchMcpServerName(installed)
      return currentBinary
    }
    console.warn(`[agntspce] Search v${bundledVersion} is broken — reinstalling`)
  }

  try {
    if (fs.existsSync(installed)) {
      const backup = installed + '.prev'
      try { fs.rmSync(backup, { recursive: true, force: true }) } catch {}
      try { fs.renameSync(installed, backup) } catch {}
    }

    fs.cpSync(bundled, installed, { recursive: true })
    // Rewrite the freshly copied bundle: prebuilt tarballs may still ship
    // the old server display name, which would surface the wrong MCP name.
    patchMcpServerName(installed)

    const binPath = findInstalledBinary(getInstalledBinaryCandidates())
    if (binPath) {
      try { fs.chmodSync(binPath, 0o755) } catch {}
      fixSearchBinary(binPath, installed)
    }

    const backup = installed + '.prev'
    try { fs.rmSync(backup, { recursive: true, force: true }) } catch {}

    console.log(`[agntspce] Search v${bundledVersion || '?'} installed → ${installed}`)
    return binPath
  } catch (e) {
    console.error('[agntspce] Search installation failed:', e)
    const backup = installed + '.prev'
    if (fs.existsSync(backup)) {
      try {
        fs.rmSync(installed, { recursive: true, force: true })
        fs.renameSync(backup, installed)
        console.log('[agntspce] Rolled back to previous search version')
      } catch {}
    }
    return null
  }
}

function detectInstalledAgents(): AgentCheck[] {
  return AGENT_CHECKS.filter((a) => a.check())
}

function generateSessionToken(pid?: number): string {
  const now = Math.floor(Date.now() / 1000)
  const expiry = now + TOKEN_TTL_SECS
  const nonce = crypto.randomBytes(8).toString('hex')
  const effectivePid = pid ?? process.pid
  const payload = `${effectivePid}:${expiry}:${nonce}`
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest()
  const combined = Buffer.concat([Buffer.from(payload, 'utf-8'), sig])
  return combined.toString('base64url')
}

type InjectResult = { agent: string; action: 'created' | 'updated' | 'unchanged' | 'error' }

function injectClaudeCodeConfig(projectPath: string): InjectResult {
  const mcpPath = path.resolve(projectPath, '.mcp.json')
  const launch = resolveMcpLaunch()
  if (!launch) {
    try { if (fs.existsSync(mcpPath)) fs.rmSync(mcpPath) } catch {}
    return { agent: 'claude', action: 'error' }
  }

  const serverEntry: Record<string, unknown> = {
    command: launch.command,
    type: 'stdio',
  }
  if (launch.args) serverEntry.args = launch.args

  // Merge with any existing project config: preserve the user's other
  // servers, drop a stale legacy entry under the old display name, and
  // (re)point our entry at the installed bundle. Overwriting the whole file
  // used to delete unrelated servers, and a legacy entry travelling with the
  // project folder kept surfacing the old name on other PCs.
  let config: { mcpServers?: Record<string, unknown> } = {}
  let hadFile = false
  if (fs.existsSync(mcpPath)) {
    hadFile = true
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as { mcpServers?: Record<string, unknown> }
      }
    } catch {
      config = {}
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {}
  }

  let removedLegacy = false
  if (config.mcpServers['semble']) {
    delete config.mcpServers['semble']
    removedLegacy = true
  }

  const existing = JSON.stringify(config.mcpServers[MCP_SERVER_NAME])
  const wanted = JSON.stringify(serverEntry)
  if (existing === wanted && !removedLegacy) return { agent: 'claude', action: 'unchanged' }

  config.mcpServers[MCP_SERVER_NAME] = serverEntry
  if (writeWithBackup(mcpPath, JSON.stringify(config, null, 2) + '\n')) {
    return { agent: 'claude', action: hadFile ? 'updated' : 'created' }
  }
  return { agent: 'claude', action: 'error' }
}

function injectOpenCodeConfig(): InjectResult {
  const launch = resolveMcpLaunch()
  if (!launch) {
    removeOpenCodeConfig()
    return { agent: 'opencode', action: 'error' }
  }

  const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc')
  const mcpKey = 'agntspce-search'
  // OpenCode local MCP servers take the command as an argv array.
  const entryValue = {
    command: launch.args ? [launch.command, ...launch.args] : [launch.command],
    type: 'local',
    enabled: true,
  }

  if (!fs.existsSync(configPath)) {
    const newConfig = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        [mcpKey]: entryValue,
      },
    }
    if (writeWithBackup(configPath, JSON.stringify(newConfig, null, 2) + '\n')) {
      return { agent: 'opencode', action: 'created' }
    }
    return { agent: 'opencode', action: 'error' }
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const jsonc = stripJsoncComments(raw)
    let config: any
    try {
      config = JSON.parse(jsonc)
    } catch {
      console.warn('[agntspce] Failed to parse OpenCode config — injecting new mcp section via text')
      return injectOpenCodeConfigTextFallback(configPath, entryValue.command)
    }

    if (!config.mcp) config.mcp = {}

    // Remove any legacy `semble` entry so only `agntspce-search` shows.
    let removedSemble = false
    if (config.mcp['semble']) {
      delete config.mcp['semble']
      removedSemble = true
    }

    const existing = JSON.stringify(config.mcp[mcpKey])
    const newValue = JSON.stringify(entryValue)
    if (existing === newValue && !removedSemble) return { agent: 'opencode', action: 'unchanged' }

    config.mcp[mcpKey] = entryValue
    if (!writeWithBackup(configPath, JSON.stringify(config, null, 2) + '\n')) {
      return { agent: 'opencode', action: 'error' }
    }
    return { agent: 'opencode', action: 'updated' }
  } catch (e) {
    console.error('[agntspce] Failed to merge OpenCode config:', e)
    return { agent: 'opencode', action: 'error' }
  }
}

function injectOpenCodeConfigTextFallback(configPath: string, command: string[]): InjectResult {
  const entryText = `"agntspce-search": ${JSON.stringify({ command, type: 'local', enabled: true }, null, 2)}`

  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return { agent: 'opencode', action: 'error' }
  }

  const mcpSectionRegex = /"mcp"\s*:/;
  const hasMcp = mcpSectionRegex.test(raw)

  // Strip any legacy `semble` entry so only `agntspce-search` shows.
  raw = raw.replace(/,\s*"semble"\s*:\s*\{[^}]*}/g, '').replace(/"semble"\s*:\s*\{[^}]*},\s*/g, '')

  let newRaw: string
  if (hasMcp) {
    if (raw.includes('"agntspce-search"')) {
      // agntspce-search already present (and semble stripped above) — persist cleanup if changed
      try {
        const orig = fs.readFileSync(configPath, 'utf-8')
        if (orig !== raw && writeWithBackup(configPath, raw)) return { agent: 'opencode', action: 'updated' }
      } catch {}
      return { agent: 'opencode', action: 'unchanged' }
    }
    newRaw = raw.replace(/"mcp"\s*:\s*\{/, `"mcp": {\n    ${entryText},`)
  } else {
    const lastBrace = raw.lastIndexOf('}')
    if (lastBrace === -1) return { agent: 'opencode', action: 'error' }
    const before = raw.slice(0, lastBrace).trimEnd()
    const after = raw.slice(lastBrace)
    newRaw = `${before},\n  "mcp": {\n    ${entryText}\n  }\n${after}`
  }

  if (writeWithBackup(configPath, newRaw)) {
    return { agent: 'opencode', action: 'updated' }
  }
  return { agent: 'opencode', action: 'error' }
}

function removeOpenCodeConfig(): InjectResult {
  const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc')
  if (!fs.existsSync(configPath)) return { agent: 'opencode', action: 'unchanged' }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const jsonc = stripJsoncComments(raw)
    let config: any
    try {
      config = JSON.parse(jsonc)
    } catch {
      return removeOpenCodeConfigTextFallback(configPath, raw)
    }

    if (!config.mcp?.['agntspce-search'] && !config.mcp?.['semble']) {
      return { agent: 'opencode', action: 'unchanged' }
    }

    delete config.mcp['agntspce-search']
    delete config.mcp['semble']
    if (Object.keys(config.mcp).length === 0) {
      delete config.mcp
    }

    if (!writeWithBackup(configPath, JSON.stringify(config, null, 2) + '\n')) {
      return { agent: 'opencode', action: 'error' }
    }
    return { agent: 'opencode', action: 'updated' }
  } catch {
    return { agent: 'opencode', action: 'error' }
  }
}

function removeOpenCodeConfigTextFallback(configPath: string, raw: string): InjectResult {
  if (!raw.includes('"agntspce-search"')) return { agent: 'opencode', action: 'unchanged' }

  const sectionRegex = /,\s*"agntspce-search"\s*:\s*\{[^}]*}/g
  const removed = raw.replace(sectionRegex, '').replace(/"agntspce-search"\s*:\s*\{[^}]*},\s*/g, '')
  if (writeWithBackup(configPath, removed)) {
    return { agent: 'opencode', action: 'updated' }
  }
  return { agent: 'opencode', action: 'error' }
}

function stripJsoncComments(text: string): string {
  const lines: string[] = []
  let inString = false
  let stringChar = ''
  let inBlockComment = false
  let current = ''

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1] || ''

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }

    if (inString) {
      current += ch
      if (ch === '\\' && next) {
        current += next
        i++
      } else if (ch === stringChar) {
        inString = false
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      current += ch
      inString = true
      stringChar = ch
      continue
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      lines.push(current)
      current = ''
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }

    if (ch === '\n') {
      lines.push(current)
      current = ''
      continue
    }

    current += ch
  }

  if (current.trim()) lines.push(current)
  return lines.filter(l => l.trim()).join('\n')
}

// A manual (or agent-triggered, via the old uvx fallback instruction)
// upstream `install` writes a global `semble` MCP entry to ~/.claude.json.
// Claude Code merges it with the project .mcp.json, so the old brand kept
// surfacing as `mcp__semble__*` on machines where it was never cleaned.
// Drop the legacy key (with backup); our own entry lives in the project
// .mcp.json and is left alone. Unparsable files are never touched.
function cleanupLegacyGlobalClaudeConfig(): void {
  const globalPath = path.join(os.homedir(), '.claude.json')
  if (!fs.existsSync(globalPath)) return
  let raw: string
  try {
    raw = fs.readFileSync(globalPath, 'utf-8')
  } catch {
    return
  }
  let config: any
  try {
    config = JSON.parse(raw)
  } catch {
    return
  }
  const servers = config?.mcpServers
  if (!servers || typeof servers !== 'object' || !servers['semble']) return
  delete servers['semble']
  if (writeWithBackup(globalPath, JSON.stringify(config, null, 2) + '\n')) {
    console.log('[agntspce] Removed legacy `semble` MCP entry from ~/.claude.json')
  }
}

function initialize(): string | null {
  const installedPath = installSearch()
  _activeSearchPath = installedPath
  if (installedPath) {
    _activeSearchDir = path.dirname(path.dirname(installedPath))
  }
  try {
    cleanupLegacyGlobalClaudeConfig()
  } catch (e) {
    console.warn('[agntspce] Failed to clean legacy global search config:', e)
  }
  return _activeSearchPath
}

function getActiveSearchPath(): string | null {
  return _activeSearchPath
}

function getActiveSearchDir(): string | null {
  return _activeSearchDir
}

export {
  initialize,
  getActiveSearchPath,
  getActiveSearchDir,
  generateSessionToken,
  injectClaudeCodeConfig,
  injectOpenCodeConfig,
  removeOpenCodeConfig,
  detectInstalledAgents,
  HMAC_SECRET,
  TOKEN_TTL_SECS,
  SEARCH_VERSION,
}
