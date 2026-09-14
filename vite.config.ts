import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { copyFileSync, mkdirSync, existsSync, readdirSync, chmodSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function copyPreload(): void {
  const src = join(__dirname, 'electron', 'preload.cjs')
  const dest = join(__dirname, 'dist-electron', 'preload.js')
  try {
    mkdirSync(join(__dirname, 'dist-electron'), { recursive: true })
    copyFileSync(src, dest)
    console.log('[post-build] Copied preload.cjs → dist-electron/preload.js')
  } catch (e) {
    console.error('[post-build] Failed to copy preload:', e)
  }
}

function postBuildPlugin(): Plugin {
  const isDev = () => !!process.env.VITE_DEV_SERVER_URL
  return {
    name: 'post-build-copy',
    closeBundle() {
      try {
        if (isDev()) {
          // Dev mode: only copy the essential preload script.
          // Heavy copies (search/, node-pty prebuilds, RTK binaries) are
          // skipped because they're already resolved from their source
          // directories. Copying them to dist-electron/ triggers Vite's
          // file watcher, causing unnecessary rebuilds and double init.
          copyPreload()
          return
        }
        // Production build: copy everything for packaging
        // Copy node-pty native prebuilds to dist-electron/
        const src = join(__dirname, 'node_modules', 'node-pty', 'prebuilds')
        const dest = join(__dirname, 'dist-electron', 'prebuilds')
        if (existsSync(src)) {
          mkdirSync(dest, { recursive: true })
          for (const entry of readdirSync(src, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const srcDir = join(src, entry.name)
            const destDir = join(dest, entry.name)
            mkdirSync(destDir, { recursive: true })
            for (const file of readdirSync(srcDir, { withFileTypes: true })) {
              if (file.isFile()) {
                copyFileSync(join(srcDir, file.name), join(destDir, file.name))
                if (file.name === 'spawn-helper') {
                  try { chmodSync(join(destDir, file.name), 0o755) } catch {}
                }
              }
            }
          }
        } else {
          console.warn('[post-build] node-pty prebuilds not found at', src)
        }
        // Copy RTK binary + wrapper scripts to dist-electron/rtk/
        const rtkDir = join(__dirname, 'dist-electron', 'rtk')
        mkdirSync(rtkDir, { recursive: true })
        const isWin = process.platform === 'win32'
        const rtkFiles = isWin ? ['rtk.exe'] : ['rtk']
        const agentWrappers = isWin
          ? [
              'claude.cmd', 'codex.cmd', 'opencode.cmd', 'gemini.cmd', 'cursor-agent.cmd', 'copilot.cmd',
              'mastracode.cmd', 'droid.cmd', 'amp.cmd', 'pi.cmd', 'kilocode.cmd', 'windsurf.cmd',
            ]
          : [
              'claude', 'claude.cmd', 'codex', 'codex.cmd', 'opencode', 'opencode.cmd',
              'gemini', 'gemini.cmd', 'cursor-agent', 'cursor-agent.cmd', 'copilot', 'copilot.cmd',
              'mastracode', 'mastracode.cmd', 'droid', 'droid.cmd', 'amp', 'amp.cmd',
              'pi', 'pi.cmd', 'kilocode', 'kilocode.cmd', 'windsurf', 'windsurf.cmd',
            ]
        const commandWrappers = isWin
          ? ['git.cmd', 'ls.cmd', 'npm.cmd', 'cargo.cmd', 'docker.cmd', 'pip.cmd', 'pytest.cmd', 'make.cmd', 'kubectl.cmd', 'terraform.cmd']
          : ['git', 'ls', 'npm', 'cargo', 'docker', 'pip', 'pytest', 'make', 'kubectl', 'terraform', 'agntspce', 'agntspce.mjs']
        const filesToCopy = [...rtkFiles, ...agentWrappers, ...commandWrappers]
        if (isWin) {
          filesToCopy.push('agntspce.cmd')
        }
        for (const file of filesToCopy) {
          const srcFile = join(__dirname, 'bin', file)
          if (existsSync(srcFile)) {
            copyFileSync(srcFile, join(rtkDir, file))
            try { chmodSync(join(rtkDir, file), 0o755) } catch {}
            console.log(`[post-build] Copied bin/${file} → dist-electron/rtk/${file}`)
          }
        }
        // Windows: remove stale bash wrappers that were copied by previous builds
        // (they shadow .cmd shims via where.exe and cause 'exec' errors).
        if (isWin) {
          for (const stale of ['claude','codex','opencode','gemini','cursor-agent','copilot','mastracode','droid','amp','pi','kilocode','windsurf']) {
            const stalePath = join(rtkDir, stale)
            if (existsSync(stalePath)) {
              try { rmSync(stalePath) } catch {}
              console.log(`[post-build] Removed stale bash wrapper dist-electron/rtk/${stale}`)
            }
          }
        }
        // Copy search distribution to dist-electron/search/ for production.
        // Stale bytecode is stripped from the copy: dev runs regenerate
        // __pycache__ from local sources, and shipping it would let a stale
        // .pyc shadow the rewritten MCP server name on other PCs.
        // macOS resource-fork files (._*) and .DS_Store are excluded too.
        const searchDir = join(__dirname, 'search')
        const searchDest = join(__dirname, 'dist-electron', 'search')
        if (existsSync(searchDir)) {
          rmSync(searchDest, { recursive: true, force: true })
          cpSync(searchDir, searchDest, {
            recursive: true,
            filter: (src) => {
              const base = src.split(/[\\/]/).pop() || ''
              if (base.startsWith('._') || base === '.DS_Store') return false
              return !src.endsWith('__pycache__') && !src.endsWith('.pyc') && !src.endsWith('.pyo')
            },
          })
          // Create PYTHONHOME-aware wrapper in the built copy
          const binPath = join(searchDest, 'python', 'bin', 'agntspce-search')
          const pythonBin = join(searchDest, 'python', 'bin', 'python3')
          if (existsSync(binPath) && existsSync(pythonBin) && process.platform !== 'win32') {
            const pyPath = binPath + '.py'
            try {
              const content = readFileSync(binPath, 'utf-8')
              if (content.startsWith('#!')) {
                writeFileSync(pyPath, content, 'utf-8')
                chmodSync(pyPath, 0o755)
              }
            } catch {}
            const wrapper = `#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="$SCRIPT_DIR/.."
exec "$SCRIPT_DIR/python3" "${pyPath}" "$@"
`
            writeFileSync(binPath, wrapper, 'utf-8')
            chmodSync(binPath, 0o755)
          }
          console.log('[post-build] Copied search/ → dist-electron/search/')
        } else {
          console.warn('[post-build] search/ not found — skipping copy')
        }

        copyPreload()
      } catch (e) {
        console.error('[post-build] Error in closeBundle:', e)
      }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(args) {
          args.startup()
        },
        vite: {
          plugins: [postBuildPlugin()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['node-pty', 'better-sqlite3'],
            } as any,
          },
        },
      },
      {
        entry: 'electron/services/orchestration/proxy/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            lib: {
              entry: 'electron/services/orchestration/proxy/index.ts',
              formats: ['es'],
              fileName: () => 'proxy.js',
            },
            rollupOptions: {
              external: ['better-sqlite3', '@modelcontextprotocol/sdk'],
            } as any,
          },
        },
      },
    ]),
    renderer(),
  ],
})
