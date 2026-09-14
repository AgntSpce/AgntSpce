#!/usr/bin/env node

/**
 * download-search.js
 *
 * Downloads a prebuilt agntspce-search portable distribution for the
 * current platform from GitHub Releases and extracts it to <project>/search/.
 *
 * Falls back gracefully if no release URL is configured yet.
 *
 * Usage:  node scripts/download-search.js
 * Env:    SEARCH_VERSION=0.1.0     (default: 0.1.0)
 *         SEARCH_BASE_URL=...      (default: GitHub releases URL)
 */

import { existsSync, mkdirSync, createWriteStream, readFileSync, copyFileSync, writeFileSync, cpSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = join(__dirname, '..')
const SEARCH_DIR = join(PROJECT_DIR, 'search')
const PACKAGES_DIR = join(PROJECT_DIR, 'packages')

// ── Config ───────────────────────────────────────────────────────
const VERSION = process.env.SEARCH_VERSION || '0.1.1'

// Platform mapping: Node process.arch/process.platform → archive suffix
const ARCH_MAP = {
  'darwin:arm64': 'darwin-arm64',
  'darwin:x64':   'darwin-x64',
  'linux:x64':    'linux-x86_64',
  'linux:arm64':  'linux-aarch64',
  'win32:x64':    'win32-x86_64',
}

const platformKey = `${process.platform}:${process.arch}`
const archSuffix = ARCH_MAP[platformKey]
if (!archSuffix) {
  console.log(`[agntspce] No prebuilt search for ${platformKey} — run scripts/build-search.sh`)
  process.exit(0)
}

const ARCHIVE_NAME = `agntspce-search-${archSuffix}-${VERSION}.tar.gz`
const LOCAL_PACKAGE = join(PACKAGES_DIR, ARCHIVE_NAME)
const BASE_URL = process.env.SEARCH_BASE_URL ||
  `https://github.com/AniketWathore/agntspce/releases/download/search-v${VERSION}`
const FULL_URL = `${BASE_URL}/${ARCHIVE_NAME}`



// ── Main ─────────────────────────────────────────────────────────
function binaryExists(dir) {
  if (existsSync(join(dir, 'python', 'bin', 'agntspce-search'))) return true
  if (process.platform === 'win32') {
    if (existsSync(join(dir, 'python', 'Scripts', 'agntspce-search.exe'))) return true
    if (existsSync(join(dir, 'python', 'Scripts', 'agntspce-search'))) return true
  }
  return false
}

function patchDownloadedMcp(searchDir) {
  // The search bundle is built from an upstream package that announces the
  // MCP server under its own display name. We expose it as agntspce-search:
  // rewrite the FastMCP name (upstream formats it across lines in newer
  // releases, so the match tolerates any whitespace/quoting) and create an
  // `agntspce_search` package copy so `from agntspce_search.mcp import serve`
  // works. Bytecode is excluded from the copy and purged afterwards so a
  // stale .pyc can never shadow the rewritten sources on another PC.
  const siteCandidates = [
    join(searchDir, 'python', 'Lib', 'site-packages'),
    join(searchDir, 'python', 'lib', 'python3.13', 'site-packages'),
    join(searchDir, 'python', 'lib', 'python3.12', 'site-packages'),
  ]
  const nameRes = [
    [/FastMCP\(\s*name\s*=\s*["']semble["']/g, 'FastMCP(name="agntspce-search"'],
    [/FastMCP\(\s*["']semble["']/g, 'FastMCP("agntspce-search"'],
  ]
  const installerRenames = [
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
    [/<!-- SEMBLE_START -->/g, '<!-- AGNTSPCE_START -->'],
    [/<!-- SEMBLE_END -->/g, '<!-- AGNTSPCE_END -->'],
    [/semble-search/g, 'agntspce-search'],
    [/semble\.md/g, 'agntspce-search.md'],
    // The old fallback taught agents to uvx-install the upstream package,
    // which created a global `semble` MCP entry on fresh PCs.
    [/If `agntspce-search` is not on `\$PATH`, use `uvx --from "semble\[mcp\]" semble`\./g, 'If `agntspce-search` is not on `$PATH`, reinstall or restart AgntSpce to restore the bundled server.'],
  ]
  const applyRenames = (content) => {
    let out = content
    for (const [re, repl] of installerRenames) {
      re.lastIndex = 0
      out = out.replace(re, repl)
    }
    return out
  }
  // installer/agents.py: legacy doc-marker constants derived from the renamed
  // values, so no literal old marker is left for a re-run to clobber.
  const rewriteAgentsPy = (content) => {
    let out = applyRenames(content)
    if (!out.includes('_LEGACY_START')) {
      const lines = out.split('\n')
      const idx = lines.findIndex((l) => l.startsWith('SEMBLE_END = '))
      if (idx !== -1) {
        lines.splice(
          idx + 1,
          0,
          '# Markers written by older installs - consulted when replacing/removing docs.',
          '_LEGACY_START = SEMBLE_START.replace("AGNTSPCE", "SEMBLE")',
          '_LEGACY_END = SEMBLE_END.replace("AGNTSPCE", "SEMBLE")',
        )
        out = lines.join('\n')
      }
    }
    return out
  }
  // installer/config.py: honour legacy markers + legacy Codex table.
  // Exact anchors — skipped with a warning when upstream changes shape.
  const rewriteConfigPy = (content) => {
    let out = applyRenames(content)
    const skipped = []
    const legacyImport = 'from semble.installer.agents import SEMBLE_END, SEMBLE_START, Action'
    if (!out.includes('_LEGACY_START') && out.includes(legacyImport)) {
      out = out.replace(legacyImport, 'from semble.installer.agents import SEMBLE_END, SEMBLE_START, Action, _LEGACY_END, _LEGACY_START')
    }
    const hasLegacy = out.includes('_LEGACY_START')
    const migration = '    existing = existing.replace(_LEGACY_START, SEMBLE_START).replace(_LEGACY_END, SEMBLE_END)'
    if (hasLegacy && !out.includes(migration)) {
      const replaceAnchor = '    existing = path.read_text(encoding="utf-8") if existed else ""'
      if (out.includes(replaceAnchor)) out = out.replace(replaceAnchor, `${replaceAnchor}\n${migration}`)
      else skipped.push('replace_or_append_marked anchor')
      const removeAnchor = '    existing = path.read_text(encoding="utf-8")\n'
      if (out.includes(removeAnchor)) out = out.replace(removeAnchor, `${removeAnchor}${migration}\n`)
      else skipped.push('remove_marked anchor')
    }
    if (!out.includes('_CODEX_MCP_HEADER_LEGACY')) {
      const lines = out.split('\n')
      const idx = lines.findIndex((l) => l.startsWith('_CODEX_MCP_HEADER = '))
      if (idx !== -1) {
        lines.splice(idx + 1, 0, '_CODEX_MCP_HEADER_LEGACY = _CODEX_MCP_HEADER.replace("agntspce-search", "semble")')
        out = lines.join('\n')
      } else skipped.push('_CODEX_MCP_HEADER anchor')
    }
    if (out.includes('_CODEX_MCP_HEADER_LEGACY')) {
      const mergeAnchor = '    base = _strip_toml_section(existing, _CODEX_MCP_HEADER).rstrip("\\n")'
      if (out.includes(mergeAnchor) && !out.includes('_CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER)')) {
        out = out.replace(mergeAnchor, '    base = _strip_toml_section(_strip_toml_section(existing, _CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).rstrip("\\n")')
      }
      const condAnchor = '    if _CODEX_MCP_HEADER not in existing:'
      if (out.includes(condAnchor) && !out.includes('_CODEX_MCP_HEADER_LEGACY not in existing')) {
        out = out.replace(condAnchor, '    if _CODEX_MCP_HEADER not in existing and _CODEX_MCP_HEADER_LEGACY not in existing:')
      }
      const stripAnchor = '    remaining = _strip_toml_section(existing, _CODEX_MCP_HEADER).strip("\\n")'
      if (out.includes(stripAnchor) && !out.includes('_CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).strip')) {
        out = out.replace(stripAnchor, '    remaining = _strip_toml_section(_strip_toml_section(existing, _CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).strip("\\n")')
      }
    }
    return { text: out, skipped }
  }
  // Sub-agent templates (agents/*.md|*.toml) are pure docs with no imports.
  // The uvx fallback sentence goes first so its `semble[mcp]` pip spec is
  // dropped, not rewritten.
  const rewriteAgentTemplate = (content) => {
    let out = applyRenames(content)
    const templateRenames = [
      [/If `semble` is not on `\$PATH`, use `uvx --from "semble\[mcp\]" semble` in its place\./g, 'If `agntspce-search` is not on `$PATH`, reinstall or restart AgntSpce to restore the bundled server.'],
      [/\bsemble\b/g, 'agntspce-search'],
    ]
    for (const [re, repl] of templateRenames) {
      re.lastIndex = 0
      out = out.replace(re, repl)
    }
    return out
  }
  // cli.py display strings + stats.py report title. Exact anchors, fail-safe.
  const rewriteCliPy = (content) => {
    let out = content
    const skipped = []
    const pairs = [
      ['prog="semble"', 'prog="agntspce-search"'],
      ['"""Entry point for the semble command-line tool."""', '"""Entry point for the agntspce-search command-line tool."""'],
      ['"Configure semble across coding agents."', '"Configure AgntSpce Search across coding agents."'],
      ['"Remove semble configuration from coding agents."', '"Remove AgntSpce Search configuration from coding agents."'],
    ]
    for (const [from, to] of pairs) {
      if (out.includes(from)) out = out.split(from).join(to)
      else if (!out.includes(to)) skipped.push(from.slice(0, 48))
    }
    return { text: out, skipped }
  }
  const rewriteStatsPy = (content) => {
    const from = '"Semble Token Savings"'
    const to = '"AgntSpce Search Token Savings"'
    if (content.includes(from)) return { text: content.split(from).join(to), skipped: [] }
    if (content.includes(to)) return { text: content, skipped: [] }
    return { text: content, skipped: ['"Semble Token Savings" anchor'] }
  }
  // installer/installer.py: migrate the global MCP entry key, removing legacy.
  const rewriteInstallerPy = (content) => {    let out = applyRenames(content)
    const skipped = []
    const mergeAnchor = 'return WriteResult(path, merge_json_member(path, agent.mcp.key, "semble", agent.mcp.entry))'
    if (out.includes(mergeAnchor)) {
      out = out.replace(mergeAnchor, 'remove_json_member(path, agent.mcp.key, "semble")\n    return WriteResult(path, merge_json_member(path, agent.mcp.key, "agntspce-search", agent.mcp.entry))')
    } else if (!out.includes('"agntspce-search", agent.mcp.entry')) skipped.push('merge_mcp anchor')
    const removeAnchor = 'return WriteResult(path, remove_json_member(path, agent.mcp.key, "semble"))'
    if (out.includes(removeAnchor)) {
      out = out.replace(removeAnchor, 'remove_json_member(path, agent.mcp.key, "semble")\n    return WriteResult(path, remove_json_member(path, agent.mcp.key, "agntspce-search"))')
    } else if (!out.includes('remove_json_member(path, agent.mcp.key, "agntspce-search")')) skipped.push('remove_mcp anchor')
    return { text: out, skipped }
  }
  const purgeBytecode = (dir) => {
    if (!existsSync(dir)) return
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry)
      let stat = null
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        if (entry === '__pycache__') {
          try { rmSync(full, { recursive: true, force: true }) } catch {}
        } else {
          purgeBytecode(full)
        }
      } else if (entry.endsWith('.pyc') || entry.endsWith('.pyo')) {
        try { rmSync(full) } catch {}
      }
    }
  }
  for (const sitePkgs of siteCandidates) {
    const semblePath = join(sitePkgs, 'semble')
    const agntspcePath = join(sitePkgs, 'agntspce_search')
    if (existsSync(semblePath) && !existsSync(agntspcePath)) {
      try {
        cpSync(semblePath, agntspcePath, {
          recursive: true,
          filter: (src) => !src.endsWith('__pycache__') && !src.endsWith('.pyc') && !src.endsWith('.pyo'),
        })
        console.log(`  Created agntspce_search package at ${agntspcePath}`)
      } catch {}
    }
    for (const pkg of ['semble', 'agntspce_search']) {
      const mcpPath = join(sitePkgs, pkg, 'mcp.py')
      if (!existsSync(mcpPath)) continue
      try {
        let content = readFileSync(mcpPath, 'utf-8')
        const before = content
        for (const [re, repl] of nameRes) {
          re.lastIndex = 0
          content = content.replace(re, repl)
        }
        if (content !== before) {
          writeFileSync(mcpPath, content, 'utf-8')
          console.log(`  Rewrote MCP server name in ${mcpPath}`)
        }
        if (/FastMCP\(\s*(?:name\s*=\s*)?["']semble["']/.test(readFileSync(mcpPath, 'utf-8'))) {
          console.warn(`  [warn] Old server name still present in ${mcpPath}`)
        }
      } catch {}
      for (const rel of [join('installer', 'agents.py'), join('installer', 'config.py'), join('installer', 'installer.py')]) {
        const installerPath = join(sitePkgs, pkg, rel)
        if (!existsSync(installerPath)) continue
        try {
          const before = readFileSync(installerPath, 'utf-8')
          let after = before
          let skipped = []
          if (rel.endsWith('agents.py')) after = rewriteAgentsPy(before)
          else if (rel.endsWith('config.py')) ({ text: after, skipped } = rewriteConfigPy(before))
          else ({ text: after, skipped } = rewriteInstallerPy(before))
          if (skipped.length > 0) console.warn(`  [warn] Skipped steps in ${installerPath}: ${skipped.join(', ')}`)
          if (after !== before) {
            writeFileSync(installerPath, after, 'utf-8')
            console.log(`  Rewrote installer strings in ${installerPath}`)
          }
        } catch {}
      }
      try {
        const agentsDir = join(sitePkgs, pkg, 'agents')
        if (existsSync(agentsDir)) {
          for (const entry of readdirSync(agentsDir)) {
            if (!entry.endsWith('.md') && !entry.endsWith('.toml')) continue
            const mdPath = join(agentsDir, entry)
            try {
              const before = readFileSync(mdPath, 'utf-8')
              const after = rewriteAgentTemplate(before)
              if (after !== before) {
                writeFileSync(mdPath, after, 'utf-8')
                console.log(`  Rewrote sub-agent display name in ${mdPath}`)
              }
            } catch {}
          }
        }
      } catch {}
      for (const [rel, rewriter, label] of [
        ['cli.py', (c) => rewriteCliPy(c), 'CLI display strings'],
        ['stats.py', (c) => rewriteStatsPy(c), 'savings-report title'],
      ]) {
        const filePath = join(sitePkgs, pkg, rel)
        if (!existsSync(filePath)) continue
        try {
          const before = readFileSync(filePath, 'utf-8')
          const { text: after, skipped } = rewriter(before)
          if (skipped.length > 0) console.warn(`  [warn] Skipped steps in ${filePath}: ${skipped.join(', ')}`)
          if (after !== before) {
            writeFileSync(filePath, after, 'utf-8')
            console.log(`  Rewrote ${label} in ${filePath}`)
          }
        } catch {}
      }
      purgeBytecode(join(sitePkgs, pkg))
    }
  }
}

async function main() {
  if (existsSync(join(SEARCH_DIR, 'VERSION'))) {
    const current = readFileSync(join(SEARCH_DIR, 'VERSION'), 'utf-8').trim()
    if (current === VERSION && binaryExists(SEARCH_DIR)) {
      console.log(`[agntspce] Search v${current} already present — skipping download`)
      return
    }
  }

  const scratch = join(PROJECT_DIR, `search-download-${Date.now()}`)
  const archivePath = join(scratch, ARCHIVE_NAME)

  try {
    mkdirSync(scratch, { recursive: true })

    // Check if the bundle exists locally in packages/ first
    if (existsSync(LOCAL_PACKAGE)) {
      console.log(`[agntspce] Installing search v${VERSION} from packages/${ARCHIVE_NAME}...`)
      await copyFileSync(LOCAL_PACKAGE, archivePath)
    } else {
      console.log(`[agntspce] Downloading search v${VERSION} (${ARCHIVE_NAME})...`)
      console.log(`  URL: ${FULL_URL}`)

      const response = await fetch(FULL_URL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText} (URL: ${FULL_URL})`)
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength) {
        console.log(`  Archive size: ${(Number(contentLength) / 1e6).toFixed(0)}MB`)
      }

      // Stream download
      const fileStream = createWriteStream(archivePath)
      await pipeline(response.body, fileStream)
    }
    console.log('  Extracting...')

    // Extract in-place via cwd instead of `-C <abs-path>`: GNU tar on Windows
    // interprets a drive-letter argument like "E:\..." as a remote host spec
    // ("Cannot connect to E: resolve failed"). The bare archive name contains
    // no colon, and cwd pins both input and output to the scratch dir.
    const result = spawnSync('tar', ['xzf', ARCHIVE_NAME], {
      stdio: 'inherit',
      encoding: 'utf-8',
      timeout: 120000,
      cwd: scratch,
      windowsHide: true,
    })

    if (result.status !== 0) {
      throw new Error(`tar extract failed (exit ${result.status})`)
    }

    // Find extracted directory (might have different name)
    const extracted = join(scratch, `agntspce-search-${archSuffix}-${VERSION}`)
    const extractedAlt = join(scratch, 'agntspce-search-dist')
    const extractedSearch = join(scratch, 'search')
    let srcDir = ''
    if (existsSync(extracted)) srcDir = extracted
    else if (existsSync(extractedAlt)) srcDir = extractedAlt
    else if (existsSync(extractedSearch)) srcDir = extractedSearch
    else {
      // Scan for a directory with the search binary
      const { readdirSync } = await import('node:fs')
      for (const entry of readdirSync(scratch)) {
        const candidate = join(scratch, entry)
        if (binaryExists(candidate)) {
          srcDir = candidate
          break
        }
      }
    }

    if (!srcDir) {
      throw new Error('Could not find extracted search directory')
    }

    // Remove old and move new (sequential — never in parallel, same path)
    const fsP = await import('node:fs/promises')
    await fsP.rm(SEARCH_DIR, { recursive: true, force: true }).catch(() => {})
    await fsP.rename(srcDir, SEARCH_DIR)

    // Patch the downloaded bundle to the agntspce-search display name
    try { patchDownloadedMcp(SEARCH_DIR) } catch {}

    // Fix permissions and create PYTHONHOME-aware wrapper
    const pythonDir = join(SEARCH_DIR, 'python')
    const fsPromises = await import('node:fs/promises')

    if (process.platform === 'win32') {
      // Windows: locate the console-script entry point (the cross-built bundle
      // ships it under bin/, pip-style installs use Scripts/) and create a
      // .cmd/.bat wrapper pair next to python.exe.
      const scriptsDir = join(pythonDir, 'Scripts')
      const binDir = join(pythonDir, 'bin')
      const pythonExe = join(pythonDir, 'python.exe')
      const entryPoints = [
        join(scriptsDir, 'agntspce-search'),
        join(scriptsDir, 'agntspce-search.exe'),
        join(binDir, 'agntspce-search'),
      ]
      for (const epPath of entryPoints) {
        if (existsSync(epPath) && existsSync(pythonExe)) {
          const pyPath = join(scriptsDir, 'agntspce-search.py')
          try {
            await fsPromises.copyFile(epPath, pyPath).catch(() => {})
          } catch {}
          const batWrapper = `@echo off
set PYTHONHOME=%~dp0..
"%~dp0python.exe" "%~dp0agntspce-search.py" %*
`
          await fsPromises.writeFile(join(scriptsDir, 'agntspce-search.cmd'), batWrapper, 'utf-8')
          // Also write a .bat for legacy compat
          await fsPromises.writeFile(join(scriptsDir, 'agntspce-search.bat'), batWrapper, 'utf-8')
          console.log('  Created Windows .bat wrapper')
          break
        }
      }

      // The MCP SDK declares pywin32 only for native builds; the portable
      // bundle is assembled on macOS so the dependency is missing. Without it,
      // importing mcp fails on Windows (`No module named 'pywintypes'`).
      if (existsSync(pythonExe)) {
        const probe = spawnSync(pythonExe, ['-c', 'import pywintypes'], { encoding: 'utf-8' })
        if (probe.status !== 0) {
          console.log('  Installing pywin32 (required by the MCP SDK on Windows)...')
          const pipResult = spawnSync(
            pythonExe,
            ['-m', 'pip', 'install', '--no-warn-script-location', '--quiet', 'pywin32'],
            { stdio: 'inherit', timeout: 300000, windowsHide: true },
          )
          if (pipResult.status !== 0) {
            console.warn('  [warn] pywin32 install failed — agntspce-search MCP may not start')
          }
        }
      }
    } else {
      // Unix: create PYTHONHOME-aware shell wrapper
      const binPath = join(pythonDir, 'bin', 'agntspce-search')
      const pythonBin = join(pythonDir, 'bin', 'python3')
      if (existsSync(binPath) && existsSync(pythonBin)) {
        await fsPromises.chmod(binPath, 0o755)
        const pyPath = binPath + '.py'
        try {
          const content = await fsPromises.readFile(binPath, 'utf-8')
          const shebang = content.split('\n')[0]
          if (shebang.startsWith('#!')) {
            const interpreterPath = shebang.slice(2).trim().split(' ')[0]
            if (!interpreterPath || !existsSync(interpreterPath)) {
              // Fix shebang to local python3 instead of build-machine path
              const lines = content.split('\n')
              lines[0] = `#!${pythonBin}`
              await fsPromises.writeFile(pyPath, lines.join('\n'), 'utf-8')
            } else if (content.startsWith('#!/bin/sh') && existsSync(pyPath)) {
              // Already has a wrapper, skip
            } else {
              // Shebang already valid — still write .py copy for the wrapper
              await fsPromises.copyFile(binPath, pyPath)
            }
            await fsPromises.chmod(pyPath, 0o755)
          }
        } catch {}
        // Write shell wrapper that sets PYTHONHOME
        const wrapper = `#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="$SCRIPT_DIR/.."
exec "$SCRIPT_DIR/python3" "${pyPath}" "$@"
`
        await fsPromises.writeFile(binPath, wrapper, 'utf-8')
        await fsPromises.chmod(binPath, 0o755)
      }
    }

    console.log(`[agntspce] Search v${VERSION} installed → ${SEARCH_DIR}`)
  } catch (err) {
      if (err.message.includes('HTTP 404')) {
        console.log('[agntspce] No prebuilt search binary for this platform — skipping download')
      } else {
        console.warn(`[agntspce] Search download failed: ${err.message}`)
      }
    console.log('[agntspce] Run "bash scripts/build-search.sh" to build search from source')
  } finally {
    await import('node:fs/promises').then(fs =>
      fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
    )
  }
}

export { patchDownloadedMcp }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => process.exit(1))
}
