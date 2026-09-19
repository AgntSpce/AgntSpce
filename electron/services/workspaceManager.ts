import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import type { Workspace, SavedSessionData, WorkspaceExport } from './types'
import {
  ensureAgntSpceDir,
  teardownAgntSpce,
  getDbPath,
  getDiscoveryPath,
} from './orchestration/bootstrap'
import { FileIndexer } from './fileIndexer'

const CONFIG_DIR = path.join(os.homedir(), '.agntspce')

export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>()
  private activeWorkspace: Workspace | null = null
  private config: any = null

  static instance: WorkspaceManager
  static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager()
    }
    return WorkspaceManager.instance
  }

  async initialize() {
    await this.ensureDirectories()
    await this.loadWorkspaces()
    await this.loadConfig()
    await this.initializeActiveWorkspace()
  }

  private async ensureDirectories() {
    for (const dir of [
      CONFIG_DIR,
      path.join(CONFIG_DIR, 'workspaces'),
      path.join(CONFIG_DIR, 'deleted-workspaces'),
      path.join(CONFIG_DIR, 'exports'),
      path.join(CONFIG_DIR, 'session-buffers'),
    ]) {
      await fs.mkdir(dir, { recursive: true })
    }
  }

  private async loadWorkspaces() {
    const wsDir = path.join(CONFIG_DIR, 'workspaces')
    let files: string[]
    try {
      files = await fs.readdir(wsDir)
    } catch { return }

    for (const file of files.filter((f: string) => f.endsWith('.json') && !f.endsWith('.sessions.json'))) {
      try {
        const content = await fs.readFile(path.join(wsDir, file), 'utf8')
        const ws = JSON.parse(content) as Workspace
        this.workspaces.set(ws.id, ws)
      } catch (e) {
        console.error('Failed to load workspace:', file, e)
      }
    }
  }

  private async loadConfig() {
    const configFile = path.join(CONFIG_DIR, 'config.json')
    try {
      const content = await fs.readFile(configFile, 'utf8')
      this.config = JSON.parse(content)
    } catch {
      this.config = {
        version: '2.0.0',
        activeWorkspace: null,
        recentWorkspaces: [],
        ui: { theme: 'dark', rememberLastWorkspace: true },
      }
      await this.saveConfig()
    }
    if (!Array.isArray(this.config.recentWorkspaces)) {
      this.config.recentWorkspaces = []
    }
  }

  private async saveConfig() {
    await fs.writeFile(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(this.config, null, 2))
  }

  private async initializeActiveWorkspace() {
    const remember = this.config?.ui?.rememberLastWorkspace !== false
    const configured = String(this.config?.activeWorkspace || '').trim()
    if (remember && configured && this.workspaces.has(configured)) {
      this.activeWorkspace = this.workspaces.get(configured)!
      this.ensureWorkspaceScaffold(this.activeWorkspace)
      return
    }
    if (this.workspaces.size > 0) {
      const sorted = Array.from(this.workspaces.values())
        .sort((a, b) => {
          const aTime = a.lastAccess ? new Date(a.lastAccess).getTime() : 0
          const bTime = b.lastAccess ? new Date(b.lastAccess).getTime() : 0
          return bTime - aTime
        })
      this.activeWorkspace = sorted[0]!
      this.ensureWorkspaceScaffold(this.activeWorkspace)
    }
  }

  getActiveWorkspace(): Workspace | null {
    return this.activeWorkspace
  }

  private getWorkspaceRepoPath(ws: Workspace): string | null {
    const repoPath = ws.repository?.path
    if (!repoPath) return null
    try {
      if (!fsSync.existsSync(repoPath) || !fsSync.statSync(repoPath).isDirectory()) return null
      return repoPath
    } catch {
      return null
    }
  }

  getOrchestrationPaths(ws: Workspace): { repoPath: string; dbPath: string; discoveryPath: string } | null {
    const repoPath = this.getWorkspaceRepoPath(ws)
    if (!repoPath) return null
    return {
      repoPath,
      dbPath: getDbPath(repoPath),
      discoveryPath: getDiscoveryPath(repoPath),
    }
  }

  private ensureWorkspaceScaffold(ws: Workspace): void {
    const repoPath = this.getWorkspaceRepoPath(ws)
    if (!repoPath) return
    try {
      ensureAgntSpceDir(repoPath)
      this.ensureFileIndex(repoPath, ws.id)
    } catch (err: any) {
      console.warn('[workspace] Failed to scaffold .agntspce for', ws.id, err?.message || err)
    }
  }

  private ensureFileIndex(repoPath: string, workspaceId: string): void {
    try {
      const indexer = new FileIndexer(repoPath)
      if (!indexer.load()) {
        const stats = indexer.scan(repoPath)
        console.log(`[workspace] Indexed ${stats.files} files, ${stats.edges} edges for workspace ${workspaceId}`)
      }
    } catch (err: any) {
      console.warn('[workspace] Failed to build file index for', workspaceId, err?.message || err)
    }
  }

  private teardownWorkspaceScaffold(ws: Workspace): void {
    const repoPath = this.getWorkspaceRepoPath(ws)
    if (!repoPath) return
    try {
      teardownAgntSpce(repoPath)
    } catch (err: any) {
      console.warn('[workspace] Failed to teardown .agntspce for', ws.id, err?.message || err)
    }
  }

  private sessionStatePath(workspaceId: string): string {
    return path.join(CONFIG_DIR, 'workspaces', `${workspaceId}.sessions.json`)
  }

  async saveSessionState(workspaceId: string, sessions: SavedSessionData[]): Promise<void> {
    try {
      await fs.writeFile(this.sessionStatePath(workspaceId), JSON.stringify(sessions, null, 2))
    } catch (e) {
      console.error('Failed to save session state:', e)
    }
  }

  async loadSessionState(workspaceId: string): Promise<SavedSessionData[]> {
    try {
      const content = await fs.readFile(this.sessionStatePath(workspaceId), 'utf8')
      return JSON.parse(content) as SavedSessionData[]
    } catch {
      return []
    }
  }

  private bufferPath(workspaceId: string, sessionId: string): string {
    return path.join(CONFIG_DIR, 'session-buffers', `${workspaceId}-${sessionId}.log`)
  }

  async saveSessionBuffer(workspaceId: string, sessionId: string, buffer: string): Promise<void> {
    try {
      const truncated = buffer.slice(-50000)
      await fs.writeFile(this.bufferPath(workspaceId, sessionId), truncated, 'utf-8')
    } catch (e) {
      console.error('Failed to save session buffer:', e)
    }
  }

  async loadSessionBuffer(workspaceId: string, sessionId: string): Promise<string> {
    try {
      return await fs.readFile(this.bufferPath(workspaceId, sessionId), 'utf-8')
    } catch {
      return ''
    }
  }

  async deleteSessionBuffer(workspaceId: string, sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.bufferPath(workspaceId, sessionId))
    } catch {}
  }

  async saveAllSessionBuffers(workspaceId: string, buffers: Map<string, string>): Promise<void> {
    // Independent files — write them concurrently.
    await Promise.all(
      Array.from(buffers)
        .filter(([, buf]) => buf)
        .map(([id, buf]) => this.saveSessionBuffer(workspaceId, id, buf))
    )
  }

  saveSessionStateSync(workspaceId: string, sessions: SavedSessionData[]): void {
    try {
      const dir = path.dirname(this.sessionStatePath(workspaceId))
      fsSync.mkdirSync(dir, { recursive: true })
      fsSync.writeFileSync(this.sessionStatePath(workspaceId), JSON.stringify(sessions, null, 2))
    } catch (e) {
      console.error('Failed to save session state:', e)
    }
  }

  saveSessionBufferSync(workspaceId: string, sessionId: string, buffer: string): void {
    try {
      const dir = path.dirname(this.bufferPath(workspaceId, sessionId))
      fsSync.mkdirSync(dir, { recursive: true })
      fsSync.writeFileSync(this.bufferPath(workspaceId, sessionId), buffer.slice(-50000), 'utf-8')
    } catch (e) {
      console.error('Failed to save session buffer:', e)
    }
  }

  saveAllSessionBuffersSync(workspaceId: string, buffers: Map<string, string>): void {
    for (const [id, buf] of buffers) {
      if (buf) this.saveSessionBufferSync(workspaceId, id, buf)
    }
  }

  async deleteAllSessionBuffers(workspaceId: string): Promise<void> {
    const dir = path.join(CONFIG_DIR, 'session-buffers')
    const prefix = `${workspaceId}-`
    try {
      const files = await fs.readdir(dir)
      for (const file of files) {
        if (file.startsWith(prefix) && file.endsWith('.log')) {
          try { await fs.unlink(path.join(dir, file)) } catch {}
        }
      }
    } catch {}
  }

  async cloneFromGitUrl(gitUrl: string, name?: string, scripts?: { setupScript?: string; teardownScript?: string }, basePath?: string): Promise<Workspace> {
    const repoName = name || path.basename(gitUrl).replace(/\.git$/, '')
    const id = repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const cloneDir = basePath ? path.join(basePath, repoName) : path.join(os.homedir(), 'AgntSpce', repoName)
    const wsDir = path.join(CONFIG_DIR, 'workspaces', `${id}.json`)

    if (this.workspaces.has(id)) throw new Error(`Workspace "${repoName}" already exists (${id})`)

    await fs.mkdir(path.dirname(cloneDir), { recursive: true })

    return new Promise((resolve, reject) => {
      const proc = spawn('git', ['clone', gitUrl, cloneDir], {
        stdio: 'pipe',
        env: { ...process.env },
        windowsHide: true,
      })
      proc.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`git clone failed with code ${code}`))
          return
        }
        const ws: Workspace = {
          id,
          name: repoName,
          workspaceType: 'single-repo',
          repository: { path: cloneDir, type: 'git', remote: gitUrl },
          worktrees: { enabled: false, count: 0, namingPattern: 'work{n}', autoCreate: false },
          lastAccess: new Date().toISOString(),
          gitUrl,
          setupScript: scripts?.setupScript,
          teardownScript: scripts?.teardownScript,
        }
        await fs.writeFile(wsDir, JSON.stringify(ws, null, 2))
        this.workspaces.set(id, ws)
        await this.addRecentWorkspace(id)
        this.ensureWorkspaceScaffold(ws)
        resolve(ws)
      })
      proc.on('error', reject)
    })
  }

  async runSetupScript(workspace: Workspace): Promise<void> {
    if (!workspace.setupScript) return
    await this.runScript(workspace, workspace.setupScript, 'setup')
  }

  async runTeardownScript(workspace: Workspace): Promise<void> {
    if (!workspace.teardownScript) return
    await this.runScript(workspace, workspace.teardownScript, 'teardown')
  }

  private async runScript(workspace: Workspace, script: string, label: string): Promise<void> {
    const cwd = workspace.repository?.path || os.homedir()
    const shell = process.env.SHELL || '/bin/bash'
    return new Promise((resolve, reject) => {
      const proc = spawn(shell, ['-c', script], {
        cwd,
        stdio: 'pipe',
        env: { ...process.env, ...workspace.envVars },
        windowsHide: true,
      })
      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error(`${label} script timed out after 30s`))
      }, 30000)
      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) resolve()
        else reject(new Error(`${label} script exited with code ${code}`))
      })
      proc.on('error', reject)
    })
  }

  async exportWorkspace(workspaceId: string, savePath: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)
    let sessions: SavedSessionData[] = []
    try {
      sessions = await this.loadSessionState(workspaceId)
    } catch {}
    const exportData: WorkspaceExport = {
      version: '1.0',
      workspace: ws,
      sessions,
    }
    await fs.writeFile(savePath, JSON.stringify(exportData, null, 2))
  }

  async importWorkspace(filePath: string): Promise<Workspace> {
    const content = await fs.readFile(filePath, 'utf8')
    const data = JSON.parse(content) as WorkspaceExport
    if (!data.workspace || !data.workspace.id) throw new Error('Invalid workspace file')

    const existing = this.workspaces.get(data.workspace.id)
    const ws: Workspace = {
      ...data.workspace,
      lastAccess: new Date().toISOString(),
    }

    if (existing) {
      await this.updateWorkspace(ws.id, ws)
    } else {
      await this.createWorkspace(ws)
    }

    if (data.sessions && data.sessions.length > 0) {
      await this.saveSessionState(ws.id, data.sessions)
    }

    return ws
  }

  async duplicateWorkspace(workspaceId: string, newName: string): Promise<Workspace> {
    const original = this.workspaces.get(workspaceId)
    if (!original) throw new Error(`Workspace not found: ${workspaceId}`)
    const newId = `${newName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
    const duplicate: Workspace = {
      ...original,
      id: newId,
      name: newName,
      lastAccess: new Date().toISOString(),
    }
    await this.createWorkspace(duplicate)

    const sessions = await this.loadSessionState(workspaceId)
    if (sessions.length > 0) {
      await this.saveSessionState(newId, sessions)
    }

    return duplicate
  }

  async addRecentWorkspace(workspaceId: string): Promise<void> {
    if (!Array.isArray(this.config.recentWorkspaces)) {
      this.config.recentWorkspaces = []
    }
    this.config.recentWorkspaces = [
      workspaceId,
      ...this.config.recentWorkspaces.filter((id: string) => id !== workspaceId),
    ].slice(0, 10)
    await this.saveConfig()
  }

  getRecentWorkspaces(): { id: string; name: string }[] {
    const ids: string[] = Array.isArray(this.config?.recentWorkspaces) ? this.config.recentWorkspaces : []
    return ids
      .map((id: string) => {
        const ws = this.workspaces.get(id)
        return ws ? { id: ws.id, name: ws.name } : null
      })
      .filter(Boolean) as { id: string; name: string }[]
  }

  async switchWorkspace(workspaceId: string): Promise<Workspace> {
    if (!this.workspaces.has(workspaceId)) throw new Error(`Workspace not found: ${workspaceId}`)
    const ws = this.workspaces.get(workspaceId)!
    this.activeWorkspace = ws
    this.config.activeWorkspace = workspaceId
    await this.saveConfig()
    await this.updateWorkspace(workspaceId, { lastAccess: new Date().toISOString() })
    await this.addRecentWorkspace(workspaceId)
    this.ensureWorkspaceScaffold(ws)
    return ws
  }

  async createWorkspace(data: Workspace): Promise<Workspace> {
    if (this.workspaces.has(data.id)) throw new Error(`Workspace ID exists: ${data.id}`)
    if (data.repository) {
      const rp = data.repository.path
      if (!rp || !fsSync.existsSync(rp) || !fsSync.statSync(rp).isDirectory()) {
        data.repository.path = os.homedir()
      }
    }
    const filePath = path.join(CONFIG_DIR, 'workspaces', `${data.id}.json`)
    await fs.writeFile(filePath, JSON.stringify(data, null, 2))
    this.workspaces.set(data.id, data)
    await this.addRecentWorkspace(data.id)
    this.ensureWorkspaceScaffold(data)
    return data
  }

  async updateWorkspace(workspaceId: string, updates: Partial<Workspace>): Promise<Workspace> {
    if (!this.workspaces.has(workspaceId)) throw new Error(`Workspace not found: ${workspaceId}`)
    const updated = { ...this.workspaces.get(workspaceId)!, ...updates }
    const filePath = path.join(CONFIG_DIR, 'workspaces', `${workspaceId}.json`)
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2))
    this.workspaces.set(workspaceId, updated)
    if (this.activeWorkspace?.id === workspaceId) this.activeWorkspace = updated
    return updated
  }

  async deleteWorkspace(workspaceId: string) {
    if (!this.workspaces.has(workspaceId)) throw new Error(`Workspace not found: ${workspaceId}`)
    const ws = this.workspaces.get(workspaceId)!
    const filePath = path.join(CONFIG_DIR, 'workspaces', `${workspaceId}.json`)
    await fs.writeFile(
      path.join(CONFIG_DIR, 'deleted-workspaces', `${workspaceId}-${Date.now()}.json`),
      JSON.stringify({ deletedAt: new Date().toISOString(), workspace: ws }, null, 2)
    )
    await fs.unlink(filePath)
    try { await fs.unlink(this.sessionStatePath(workspaceId)) } catch {}
    this.workspaces.delete(workspaceId)
    if (this.activeWorkspace?.id === workspaceId) this.activeWorkspace = null
    this.teardownWorkspaceScaffold(ws)
  }

  listWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values())
      .sort((a, b) => {
        const aTime = a.lastAccess ? new Date(a.lastAccess).getTime() : 0
        const bTime = b.lastAccess ? new Date(b.lastAccess).getTime() : 0
        return bTime - aTime
      })
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id)
  }

  async listDeletedWorkspaces(): Promise<{ id: string; name: string; deletedAt: string }[]> {
    const deletedDir = path.join(CONFIG_DIR, 'deleted-workspaces')
    let files: string[]
    try {
      files = await fs.readdir(deletedDir)
    } catch { return [] }

    const result: { id: string; name: string; deletedAt: string }[] = []
    for (const file of files.filter((f: string) => f.endsWith('.json'))) {
      try {
        const content = await fs.readFile(path.join(deletedDir, file), 'utf8')
        const data = JSON.parse(content)
        result.push({
          id: data.workspace?.id || file,
          name: data.workspace?.name || file,
          deletedAt: data.deletedAt,
        })
      } catch {}
    }
    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  async restoreWorkspace(deletedId: string): Promise<Workspace | null> {
    const deletedDir = path.join(CONFIG_DIR, 'deleted-workspaces')
    let files: string[]
    try {
      files = await fs.readdir(deletedDir)
    } catch { return null }

    for (const file of files.filter((f: string) => f.endsWith('.json'))) {
      try {
        const content = await fs.readFile(path.join(deletedDir, file), 'utf8')
        const data = JSON.parse(content)
        if (data.workspace?.id === deletedId) {
          const ws = data.workspace as Workspace
          await fs.writeFile(
            path.join(CONFIG_DIR, 'workspaces', `${ws.id}.json`),
            JSON.stringify(ws, null, 2)
          )
          this.workspaces.set(ws.id, ws)
          await fs.unlink(path.join(deletedDir, file))
          this.ensureWorkspaceScaffold(ws)
          return ws
        }
      } catch {}
    }
    return null
  }

  async permanentDeleteWorkspace(deletedId: string): Promise<boolean> {
    const deletedDir = path.join(CONFIG_DIR, 'deleted-workspaces')
    let files: string[]
    try {
      files = await fs.readdir(deletedDir)
    } catch { return false }

    for (const file of files.filter((f: string) => f.endsWith('.json'))) {
      try {
        const content = await fs.readFile(path.join(deletedDir, file), 'utf8')
        const data = JSON.parse(content)
        if (data.workspace?.id === deletedId) {
          await fs.unlink(path.join(deletedDir, file))
          return true
        }
      } catch {}
    }
    return false
  }

  getConfig() { return this.config }
}
