import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { resolveAgent } from './agentResolver'

// ── Constants ────────────────────────────────────────────────────
// Must match EMBEDDED_SECRET in the RTK binary's activation.rs
const HMAC_SECRET = 'agntspce-rtk-integration-v1-do-not-rely-on-this-for-security'
const TOKEN_TTL_SECS = 86400 // 24 hours — covers realistic session lifetimes

// Cached active RTK binary path after installation
let _activeRtkPath: string | null = null
let _rtkBinaryDir: string | null = null

// ── Path Resolution ──────────────────────────────────────────────

function getBundledRtkPath(): string | null {
  const binName = process.platform === 'win32' ? 'rtk.exe' : 'rtk'
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  const candidates = [
    // Production: extraResources → Resources/rtk/
    path.join(process.resourcesPath || '', 'rtk', binName),
    // Dev build: closeBundle copies to dist-electron/rtk/
    path.join(__dirname, 'rtk', binName),
    // Dev: project bin/ directory
    path.resolve(__dirname, '..', '..', 'bin', binName),
    // Legacy: ~/.local/share/agntspce/rtk/
    path.join(os.homedir(), '.local', 'share', 'agntspce', 'rtk', binName),
  ]

  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function getInstalledRtkPath(): string {
  const binName = process.platform === 'win32' ? 'rtk.exe' : 'rtk'
  return path.join(app.getPath('userData'), 'rtk', binName)
}

// ── Version Management ───────────────────────────────────────────

function getBinaryVersion(binaryPath: string): string | null {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })
    if (result.status === 0 && result.stdout) {
      const v = result.stdout.trim().split(/\s+/)[1]
      return v || null
    }
  } catch {}
  return null
}

function getBundledVersion(): string | null {
  const p = getBundledRtkPath()
  return p ? getBinaryVersion(p) : null
}

function getInstalledVersion(): string | null {
  const p = getInstalledRtkPath()
  return fs.existsSync(p) ? getBinaryVersion(p) : null
}

// ── Installation ─────────────────────────────────────────────────

function installRtk(): string | null {
  const bundled = getBundledRtkPath()
  if (!bundled) {
    console.warn('[agntspce] RTK binary not found in app bundle — skipping install')
    return null
  }

  const installed = getInstalledRtkPath()
  const installDir = path.dirname(installed)
  const bundledVersion = getBundledVersion()
  const installedVersion = getInstalledVersion()

  // Already up to date
  if (bundledVersion && installedVersion === bundledVersion && fs.existsSync(installed)) {
    console.log(`[agntspce] RTK v${bundledVersion} already installed at ${installed}`)
    return installed
  }

  // Install or upgrade
  try {
    fs.mkdirSync(installDir, { recursive: true })

    // Preserve old binary as backup for rollback
    const backupPath = installed + '.prev'
    if (fs.existsSync(installed)) {
      try { fs.copyFileSync(installed, backupPath) } catch {}
    }

    fs.copyFileSync(bundled, installed)
    if (process.platform !== 'win32') {
      fs.chmodSync(installed, 0o755)
    }

    // Remove old backup on success
    try { fs.rmSync(backupPath, { force: true }) } catch {}

    console.log(`[agntspce] RTK v${bundledVersion || '?'} installed → ${installed}`)
    return installed
  } catch (e) {
    console.error('[agntspce] RTK installation failed:', e)

    // Attempt rollback
    const backupPath = installed + '.prev'
    if (fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, installed)
        fs.chmodSync(installed, 0o755)
        console.log('[agntspce] Rolled back to previous RTK version')
      } catch {}
    }

    return installedVersion ? installed : null
  }
}

// ── Agent Detection ──────────────────────────────────────────────

type AgentInfo = {
  id: string
  cliFlag: string
  installCheck: () => boolean
}

const AGENT_CHECKS: AgentInfo[] = [
  {
    id: 'claude',
    cliFlag: '--agent claude',
    installCheck: () => {
      const home = os.homedir()
      return fs.existsSync(path.join(home, '.claude', 'settings.json'))
    },
  },
  {
    id: 'cursor',
    cliFlag: '--agent cursor',
    installCheck: () => {
      const home = os.homedir()
      return (
        fs.existsSync(path.join(home, '.cursor', 'settings.json')) ||
        fs.existsSync(path.join(home, '.cursor', 'config', 'settings.json'))
      )
    },
  },
  {
    id: 'opencode',
    // opencode uses --opencode flag instead of --agent opencode
    cliFlag: '--opencode',
    installCheck: () => {
      const home = os.homedir()
      const configDir = path.join(home, '.config', 'opencode')
      return (
        fs.existsSync(path.join(configDir, 'opencode.jsonc')) ||
        fs.existsSync(path.join(configDir, 'opencode.json')) ||
        fs.existsSync(path.join(configDir, 'config.json'))
      )
    },
  },
  {
    id: 'gemini',
    // gemini uses --gemini flag instead of --agent gemini
    cliFlag: '--gemini',
    installCheck: () => {
      const home = os.homedir()
      return fs.existsSync(path.join(home, '.config', 'gemini'))
    },
  },
  {
    id: 'codex',
    cliFlag: '--agent codex',
    installCheck: () => {
      const home = os.homedir()
      return fs.existsSync(path.join(home, '.codex')) && !!resolveAgent('codex')
    },
  },
]

function detectInstalledAgents(): AgentInfo[] {
  return AGENT_CHECKS.filter(a => a.installCheck())
}

// ── Hook Registration ────────────────────────────────────────────

function registerHooks(rtkBinaryPath: string): { registered: string[]; failed: string[] } {
  const agents = detectInstalledAgents()
  const registered: string[] = []
  const failed: string[] = []

  if (agents.length === 0) {
    console.log('[agntspce] No supported AI coding agents detected — skipping hook registration')
    return { registered, failed }
  }

  for (const agent of agents) {
    try {
      // Parse the CLI flag string into args array
      const args = ['init', '-g', ...agent.cliFlag.split(' '), '--auto-patch']
      const result = spawnSync(rtkBinaryPath, args, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      })

      if (result.status === 0) {
        console.log(`[agntspce] Hook registered for ${agent.id}`)
        registered.push(agent.id)
      } else {
        const err = (result.stderr || result.stdout || '').trim().slice(0, 200)
        console.warn(`[agntspce] Hook registration failed for ${agent.id}: ${err}`)
        failed.push(agent.id)
      }
    } catch (e: any) {
      console.warn(`[agntspce] Hook registration error for ${agent.id}:`, e.message)
      failed.push(agent.id)
    }
  }

  return { registered, failed }
}

// ── Token Generation ─────────────────────────────────────────────

// ── Hook Command Patching ────────────────────────────────────────
//
// `rtk init -g` registers hooks using a bare `rtk` command name. Claude Code
// executes PreToolUse hooks through the Bash tool's environment, which is a
// clean login shell — so `rtk` may resolve to a DIFFERENT binary than ours
// (e.g. a homebrew-installed upstream rtk). That upstream binary rewrites
// commands to `rtk git status` (its own engine) instead of `agntspce git
// status`, silently breaking token stats.
//
// To guarantee the app's RTK fork runs, every registered hook command must use
// the ABSOLUTE path of the active RTK binary.
//
// We also collapse duplicates. `rtk init -g --auto-patch` APPENDS a fresh
// PreToolUse entry on every launch and never removes the old ones, so without
// dedup the settings file grows by one identical hook per app start (hundreds
// of them in practice). Collapsing to a single entry fixes both the unbounded
// growth and the possibility that a competing upstream `rtk` hook wins the
// rewrite.

type HookPatchResult = { patched: string[] }

// Detect an RTK PreToolUse rewrite hook for Claude, anchored at the START of the
// command so unrelated user hooks that merely mention "rtk hook claude" are not
// touched. Handles every form `rtk init -g --auto-patch` can write:
//   rtk hook claude
//   /abs/path/rtk hook claude
//   "/abs/path/rtk" hook claude      ← quoted (paths with spaces, e.g. userData)
//   /abs/path/rtk.exe hook claude    ← Windows
// Returns the trailing args after `claude` (usually empty), or null when the
// command is not the RTK claude rewrite hook.
function parseRtkClaudeHook(command: unknown): string[] | null {
  if (typeof command !== 'string') return null
  const m = command.trim().match(/^(?:"([^"]*)"|(\S+))\s+hook\s+claude\b(.*)$/i)
  if (!m) return null
  const exe = m[1] ?? m[2] ?? ''
  const base = path.basename(exe).toLowerCase()
  if (base !== 'rtk' && base !== 'rtk.exe') return null
  return (m[3] || '').split(/\s+/).filter(Boolean)
}

function patchHookCommands(rtkBinaryPath: string): HookPatchResult {
  const patched: string[] = []
  if (!rtkBinaryPath) return { patched }
  // JSON-escaped absolute path. Spaces in userData dirs require shell quoting.
  const absCommand = `"${rtkBinaryPath.replace(/"/g, '\\"')}"`

  const candidates: { label: string; file: string }[] = [
    { label: 'claude', file: path.join(os.homedir(), '.claude', 'settings.json') },
    { label: 'cursor', file: path.join(os.homedir(), '.cursor', 'settings.json') },
    { label: 'opencode', file: path.join(os.homedir(), '.config', 'opencode', 'opencode.json') },
  ]

  for (const c of candidates) {
    if (!fs.existsSync(c.file)) continue
    try {
      const raw = fs.readFileSync(c.file, 'utf-8')
      const data = JSON.parse(raw)
      const pre = data?.hooks?.PreToolUse
      if (!Array.isArray(pre)) continue

      // Collect the RTK claude-rewrite hooks (bare `rtk`, unquoted absolute, or
      // quoted absolute) across every entry and drop them all. The first one
      // is kept as the template for the single canonical entry.
      let canonical: { entry: any; hook: any; args: string[] } | null = null
      let removed = 0
      const rebuilt: any[] = []

      for (const entry of pre) {
        if (!entry || !Array.isArray(entry.hooks)) { rebuilt.push(entry); continue }
        const keep: any[] = []
        for (const h of entry.hooks) {
          const args = parseRtkClaudeHook(h?.command)
          if (args) {
            if (!canonical) canonical = { entry, hook: h, args }
            removed++
          } else {
            keep.push(h)
          }
        }
        // Keep the entry only if it still holds non-RTK hooks; otherwise drop it.
        if (keep.length > 0) rebuilt.push({ ...entry, hooks: keep })
      }

      if (removed === 0) continue

      // Re-add exactly one RTK hook, pinned to the app's absolute binary so a
      // clean login shell can never resolve a different `rtk` (e.g. homebrew's,
      // which would rewrite to `rtk <cmd>` instead of `agntspce <cmd>`).
      const tail = canonical!.args.length > 0 ? ' ' + canonical!.args.join(' ') : ''
      rebuilt.push({
        ...canonical!.entry,
        hooks: [{ ...canonical!.hook, command: `${absCommand} hook claude${tail}` }],
      })

      data.hooks.PreToolUse = rebuilt
      fs.writeFileSync(c.file, JSON.stringify(data, null, 2), 'utf-8')
      patched.push(c.label)
      console.log(`[agntspce] Collapsed ${removed} ${c.label} RTK hook(s) → single absolute-path entry`)
    } catch (e: any) {
      console.warn(`[agntspce] Failed to patch hook command for ${c.label}:`, e.message)
    }
  }
  return { patched }
}

function generateRtkToken(): string {
  const now = Math.floor(Date.now() / 1000)
  const expiry = now + TOKEN_TTL_SECS
  const nonce = crypto.randomBytes(8).toString('hex')
  const payload = `${process.pid}:${expiry}:${nonce}`
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest()
  const combined = Buffer.concat([Buffer.from(payload, 'utf-8'), sig])
  return combined.toString('base64url')
}

// ── Public API ───────────────────────────────────────────────────

function initialize(): string | null {
  const installedPath = installRtk()
  _activeRtkPath = installedPath

  // Derive the binary directory from the found RTK binary
  if (installedPath) {
    _rtkBinaryDir = path.dirname(installedPath)
  }

  if (!installedPath) {
    // Fall back to the bundled path (e.g., if userData is unavailable)
    const bundled = getBundledRtkPath()
    if (bundled) {
      _activeRtkPath = bundled
      _rtkBinaryDir = path.dirname(bundled)
      console.warn('[agntspce] Using bundled RTK path (no userData copy)')
    }
  }

  if (_activeRtkPath) {
    const { failed } = registerHooks(_activeRtkPath)
    if (failed.length > 0) {
      console.warn(`[agntspce] Hook registration had failures: ${failed.join(', ')}`)
    }
    // Force registered hooks to use the app's absolute RTK binary path so that
    // agent Bash tools (clean login shell env) can't resolve a different `rtk`.
    patchHookCommands(_activeRtkPath)
  }

  return _activeRtkPath
}

function getActiveRtkPath(): string | null {
  return _activeRtkPath
}

function getRtkBinaryDir(): string | null {
  return _rtkBinaryDir
}

export {
  initialize,
  getActiveRtkPath,
  getRtkBinaryDir,
  getBundledRtkPath,
  getInstalledRtkPath,
  detectInstalledAgents,
  registerHooks,
  patchHookCommands,
  generateRtkToken,
  HMAC_SECRET,
  TOKEN_TTL_SECS,
}
