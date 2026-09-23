import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
import path from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { WorkspaceManager } from './services/workspaceManager'
import { SERVER_PORT } from './config'

const isMac = process.platform === 'darwin'
const isDev = process.env.VITE_DEV_SERVER_URL

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

function sendMenuAction(action: string, data?: any) {
  mainWindow?.webContents.send('menu-action', action, data)
}

function loadApp(win: BrowserWindow, blank: boolean): void {
  if (isDev) {
    const base = process.env.VITE_DEV_SERVER_URL!
    win.loadURL(blank ? `${base}${base.includes('?') ? '&' : '?'}blank=1` : base)
  } else if (blank) {
    win.loadFile(path.join(app.getAppPath(), 'dist/index.html'), { query: { blank: '1' } })
  } else {
    win.loadFile(path.join(app.getAppPath(), 'dist/index.html'))
  }
}

function buildWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'AgntSpce',
    ...(isMac
      ? {
          titleBarStyle: 'hidden' as const,
          // Vertically center the 14px traffic lights in the 33px custom
          // title bar: y = 33 / 2 - 14 / 2 ≈ 10. x: 9 keeps the standard
          // AppKit left offset (verified against NSWindow button frames).
          trafficLightPosition: { x: 9, y: 10 },
        }
      : { frame: false }),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Renderer hardening: never open new windows from web content, and block
  // navigation away from the app bundle (dev server in dev, file:// in prod).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (isMac) {
    // Re-pin the traffic lights on show and every geometry change: AppKit can
    // re-layout the titlebar container (zoom, drag-resize, fullscreen exit,
    // display/scale change) and drop the custom offset, which would leave the
    // lights off-center or hanging outside the fixed 33px bar.
    const pinTrafficLights = () => {
      try {
        if (!win.isDestroyed() && !win.isFullScreen()) {
          win.setTrafficLightPosition({ x: 9, y: 10 })
        }
      } catch {}
    }
    win.once('ready-to-show', pinTrafficLights)
    win.on('resize', pinTrafficLights)
    win.on('leave-full-screen', pinTrafficLights)
    screen.on('display-metrics-changed', pinTrafficLights)
  }  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    }
  })

  win.maximize()
  return win
}

function createNewWindow() {
  const win = buildWindow()
  // Secondary windows always start blank (?blank=1); only the first window
  // of an app launch restores the last workspace.
  loadApp(win, true)
  win.on('close', () => { if (mainWindow === win) mainWindow = null })
}

export function rebuildMenu() {
  const workspaceManager = WorkspaceManager.getInstance()
  const recent = workspaceManager.getRecentWorkspaces()
  const recentItems: Electron.MenuItemConstructorOptions[] = recent.length > 0
    ? [
        { type: 'separator' as const },
        { label: 'Recent Workspaces', enabled: false },
        ...recent.map(r => ({
          label: r.name,
          click: () => sendMenuAction('switch-workspace', r.id),
        })),
      ]
    : []

  const template: Electron.MenuItemConstructorOptions[] = isMac
    ? [
        // ── App Menu (macOS only) ──────────────────────────────────────
        {
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { label: 'Hide AgntSpce', role: 'hide' as const },
            { label: 'Hide Others', role: 'hideOthers' as const },
            { label: 'Show All', role: 'unhide' as const },
            { type: 'separator' as const },
            { label: 'Quit AgntSpce', role: 'quit' as const },
          ],
        },
        // ── File Menu (macOS) ──────────────────────────────────────────
        {
          label: 'File',
          submenu: [
            { label: 'New Window', accelerator: 'Cmd+T', click: () => createNewWindow() },
            { label: 'New Workspace', accelerator: 'Cmd+N', click: () => sendMenuAction('new-workspace') },
            { label: 'New Agent', accelerator: 'Cmd+A', click: () => sendMenuAction('new-agent') },
            { label: 'Toggle Shell Panel', accelerator: 'Cmd+S', click: () => sendMenuAction('new-shell') },
            { type: 'separator' as const },
            { label: 'Duplicate Workspace', click: () => sendMenuAction('duplicate-workspace') },
            { label: 'Load Workspace', accelerator: 'Cmd+O', click: () => sendMenuAction('load-workspace') },
            ...recentItems,
            { type: 'separator' as const },
            { label: 'Save', click: () => sendMenuAction('save-workspace') },
            { label: 'Save As...', accelerator: 'Cmd+Shift+S', click: () => sendMenuAction('save-workspace-as') },
            { type: 'separator' as const },
            { label: 'Close Window', accelerator: 'Cmd+W', role: 'close' as const },
          ],
        },
        // ── Edit Menu (macOS native) ───────────────────────────────────
        {
          label: 'Edit',
          submenu: [
            { label: 'Undo', accelerator: 'Cmd+Z', role: 'undo' as const },
            { label: 'Redo', accelerator: 'Cmd+Shift+Z', role: 'redo' as const },
            { type: 'separator' as const },
            { label: 'Cut', accelerator: 'Cmd+X', role: 'cut' as const },
            { label: 'Copy', accelerator: 'Cmd+C', role: 'copy' as const },
            { label: 'Paste', accelerator: 'Cmd+V', role: 'paste' as const },
            { label: 'Select All', click: (item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.selectAll() },
            { type: 'separator' as const },
            { label: 'Auto Fill', click: () => {} },
          ],
        },
        // ── View Menu (macOS) ──────────────────────────────────────────
        {
          label: 'View',
          submenu: [
            { label: 'Zoom In', accelerator: 'Cmd+=', role: 'zoomIn' as const },
            { label: 'Zoom Out', accelerator: 'Cmd+-', role: 'zoomOut' as const },
            { label: 'Actual Size', accelerator: 'Cmd+0', role: 'resetZoom' as const },
            { type: 'separator' as const },
            {
              label: 'Toggle Chat Sidebar',
              accelerator: 'Cmd+B',
              click: () => sendMenuAction('toggle-chat-sidebar'),
            },
            {
              label: 'Toggle Workspace Sidebar',
              accelerator: 'Cmd+E',
              click: () => sendMenuAction('toggle-workspace-sidebar'),
            },
            { type: 'separator' as const },
            {
              label: 'Focus Active Terminal',
              accelerator: 'Cmd+F',
              click: () => sendMenuAction('toggle-focus'),
            },
            { type: 'separator' as const },
            {
              label: 'Dashboard',
              accelerator: 'Cmd+D',
              click: () => sendMenuAction('show-dashboard'),
            },
            {
              label: 'Git Review',
              accelerator: 'Cmd+G',
              click: () => sendMenuAction('show-git-review'),
            },
            {
              label: 'Settings',
              accelerator: 'Cmd+J',
              click: () => sendMenuAction('show-settings'),
            },
            { type: 'separator' as const },
            {
              label: 'Layout',
              submenu: [
                { label: 'Auto', click: () => sendMenuAction('set-layout', 'auto') },
                { label: '1×1', click: () => sendMenuAction('set-layout', '1x1') },
                { label: '2×2', click: () => sendMenuAction('set-layout', '2x2') },
                { label: '1+2', click: () => sendMenuAction('set-layout', '1+2') },
                { label: '3×3', click: () => sendMenuAction('set-layout', '3x3') },
              ],
            },
          ],
        },
        // ── Window Menu (macOS) ────────────────────────────────────────
        {
          label: 'Window',
          submenu: [
            { label: 'Minimize', accelerator: 'Cmd+M', role: 'minimize' as const },
            { label: 'Zoom', role: 'zoom' as const },
            {
              label: 'Fill',
              click: () => {
                if (!mainWindow) return
                const { width, height } = screen.getPrimaryDisplay().workAreaSize
                mainWindow.setBounds({ x: 0, y: 0, width, height })
              },
            },
            {
              label: 'Center',
              click: () => mainWindow?.center(),
            },
            { type: 'separator' as const },
            {
              label: 'Tile to Left',
              click: () => {
                if (!mainWindow) return
                const { width, height } = screen.getPrimaryDisplay().workAreaSize
                mainWindow.setBounds({ x: 0, y: 0, width: Math.floor(width / 2), height })
              },
            },
            {
              label: 'Tile to Right',
              click: () => {
                if (!mainWindow) return
                const { width, height } = screen.getPrimaryDisplay().workAreaSize
                mainWindow.setBounds({ x: Math.floor(width / 2), y: 0, width: Math.floor(width / 2), height })
              },
            },
            { type: 'separator' as const },
            { label: 'Toggle Full Screen', accelerator: 'Cmd+Ctrl+F', role: 'togglefullscreen' as const },
            { type: 'separator' as const },
            { label: 'Bring All to Front', role: 'front' as const },
          ],
        },
        // ── Help Menu (macOS) ──────────────────────────────────────────
        {
          label: 'Help',
          submenu: [
            { label: 'Search', click: () => {} },
            { type: 'separator' as const },
            {
              label: 'Keyboard Shortcuts',
              accelerator: 'Cmd+/',
              click: () => sendMenuAction('show-shortcuts'),
            },
            { type: 'separator' as const },
            {
              label: 'About AgntSpce',
              click: () => sendMenuAction('show-about'),
            },
          ],
        },
      ]
    // ── Windows Menu (unchanged) ──────────────────────────────────────
    : [
        {
          label: 'File',
          submenu: [
            { label: 'New Window', accelerator: 'CmdOrCtrl+T', click: () => createNewWindow() },
            { label: 'New Workspace', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-workspace') },
            { label: 'New Agent', accelerator: 'CmdOrCtrl+A', click: () => sendMenuAction('new-agent') },
            { label: 'Toggle Shell Panel', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('new-shell') },
            { type: 'separator' as const },
            { label: 'Duplicate Workspace', click: () => sendMenuAction('duplicate-workspace') },
            { label: 'Load Workspace', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('load-workspace') },
            ...recentItems,
            { type: 'separator' as const },
            { label: 'Save', click: () => sendMenuAction('save-workspace') },
            { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('save-workspace-as') },
            { type: 'separator' as const },
            { label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' as const },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' as const },
            { role: 'redo' as const },
            { type: 'separator' as const },
            // No accelerators on clipboard items — the implicit accelerators
            // from role would intercept Ctrl+C/V/A before xterm.js's textarea
            // can handle them, breaking terminal copy/paste.
            { label: 'Cut', click: (item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.cut() },
            { label: 'Copy', click: (item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.copy() },
            { label: 'Paste', click: (item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.paste() },
            { label: 'Select All', click: (item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.selectAll() },
            { type: 'separator' as const },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'zoomIn' as const },
            { role: 'zoomOut' as const },
            { role: 'resetZoom' as const },
            { type: 'separator' as const },
            {
              label: 'Toggle Chat Sidebar',
              accelerator: 'CmdOrCtrl+B',
              click: () => sendMenuAction('toggle-chat-sidebar'),
            },
            {
              label: 'Toggle Workspace Sidebar',
              accelerator: 'CmdOrCtrl+E',
              click: () => sendMenuAction('toggle-workspace-sidebar'),
            },
            { type: 'separator' as const },
            {
              label: 'Focus Active Terminal',
              accelerator: 'CmdOrCtrl+F',
              click: () => sendMenuAction('toggle-focus'),
            },
            { type: 'separator' as const },
            {
              label: 'Dashboard',
              accelerator: 'CmdOrCtrl+D',
              click: () => sendMenuAction('show-dashboard'),
            },
            {
              label: 'Git Review',
              accelerator: 'CmdOrCtrl+G',
              click: () => sendMenuAction('show-git-review'),
            },
            {
              label: 'Settings',
              accelerator: 'CmdOrCtrl+J',
              click: () => sendMenuAction('show-settings'),
            },
            { type: 'separator' as const },
            {
              label: 'Layout',
              submenu: [
                { label: 'Auto', click: () => sendMenuAction('set-layout', 'auto') },
                { label: '1×1', click: () => sendMenuAction('set-layout', '1x1') },
                { label: '2×2', click: () => sendMenuAction('set-layout', '2x2') },
                { label: '1+2', click: () => sendMenuAction('set-layout', '1+2') },
                { label: '3×3', click: () => sendMenuAction('set-layout', '3x3') },
              ],
            },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' as const },
            { role: 'zoom' as const },
            {
              label: 'Fill',
              click: () => {
                if (!mainWindow) return
                const { width, height } = screen.getPrimaryDisplay().workAreaSize
                mainWindow.setBounds({ x: 0, y: 0, width, height })
              },
            },
            {
              label: 'Center',
              click: () => mainWindow?.center(),
            },
            { type: 'separator' as const },
            {
              label: 'Tile to Left',
              click: () => {
                if (!mainWindow) return
                const { width, height } = screen.getPrimaryDisplay().workAreaSize
                mainWindow.setBounds({ x: 0, y: 0, width: Math.floor(width / 2), height })
              },
            },
            {
              label: 'Tile to Right',
              click: () => {
                if (!mainWindow) return
                const { width, height } = screen.getPrimaryDisplay().workAreaSize
                mainWindow.setBounds({ x: Math.floor(width / 2), y: 0, width: Math.floor(width / 2), height })
              },
            },
            { type: 'separator' as const },
            { role: 'togglefullscreen' as const },
          ],
        },
        {
          label: 'Help',
          submenu: [
            {
              label: 'Keyboard Shortcuts',
              accelerator: 'CmdOrCtrl+/',
              click: () => sendMenuAction('show-shortcuts'),
            },
            { type: 'separator' as const },
            {
              label: 'About AgntSpce',
              click: () => sendMenuAction('show-about'),
            },
          ],
        },
      ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

export function createWindow() {
  rebuildMenu()
  mainWindow = buildWindow()
  loadApp(mainWindow, false)

  let feedbackShown = false
  mainWindow.on('close', (e) => {
    if (feedbackShown) return
    const feedbackFlag = path.join(app.getPath('userData'), '.feedback-shown')
    if (existsSync(feedbackFlag)) return
    feedbackShown = true
    writeFileSync(feedbackFlag, '1', 'utf-8')
    e.preventDefault()
    const result = dialog.showMessageBoxSync(mainWindow!, {
      type: 'info',
      title: 'Help us improve',
      message: 'Help us improve AgntSpce!',
      detail: 'https://forms.gle/bnfov2CitpWQTpoJ6',
      buttons: ['Open Form', 'Close'],
      defaultId: 0,
      cancelId: 1,
    })
    if (result === 0) {
      shell.openExternal('https://forms.gle/bnfov2CitpWQTpoJ6')
    }
    mainWindow?.close()
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

export function registerIpcHandlers(rebuildMenuFn: () => void, serverAuthToken?: string) {
  ipcMain.handle('new-window', () => createNewWindow())
  ipcMain.handle('get-server-auth-token', () => serverAuthToken ?? '')
  ipcMain.handle('window-minimize', () => mainWindow?.minimize())
  ipcMain.handle('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.handle('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized())

  ipcMain.handle('popup-menu', (event, menuName: string, x: number, y: number) => {
    const menu = Menu.getApplicationMenu()
    const item = menu?.items.find(i => i.label === menuName)
    if (item?.submenu) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const items = item.submenu.items.map(i => {
        const opts: Electron.MenuItemConstructorOptions = {
          label: i.label,
          type: i.type,
          accelerator: i.accelerator ?? undefined,
          enabled: i.enabled,
          visible: i.visible,
          checked: i.checked,
          role: i.role,
          submenu: i.submenu,
        }
        if (i.click) {
          opts.click = (mi, bw, ev) => i.click!(mi, bw, ev)
        }
        return opts
      })
      const popupMenu = Menu.buildFromTemplate(items)
      popupMenu.popup({ window: win || undefined, x: Math.round(x), y: Math.round(y) })
    }
  })

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      ...(mainWindow ? { parent: mainWindow } : {}),
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      ...(mainWindow ? { parent: mainWindow } : {}),
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('get-default-path', () => os.homedir())

  ipcMain.handle('get-server-port', () => SERVER_PORT)

  ipcMain.handle('export-workspace', async () => {
    const workspaceManager = WorkspaceManager.getInstance()
    const activeId = workspaceManager.getActiveWorkspace()?.id
    if (!activeId) throw new Error('No active workspace')
    const ws = workspaceManager.getWorkspace(activeId)
    if (!ws) throw new Error('Workspace not found')
    const result = await dialog.showSaveDialog({
      defaultPath: `${ws.name}.workspace`,
      filters: [{ name: 'Workspace Files', extensions: ['workspace'] }],
    })
    if (result.canceled || !result.filePath) return null
    await workspaceManager.exportWorkspace(activeId, result.filePath)
    return result.filePath
  })

  ipcMain.handle('import-workspace', async () => {
    const workspaceManager = WorkspaceManager.getInstance()
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'Workspace Files', extensions: ['workspace'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const ws = await workspaceManager.importWorkspace(result.filePaths[0])
    rebuildMenuFn()
    return { workspace: ws, path: result.filePaths[0] }
  })

  ipcMain.handle('duplicate-workspace', async (_event, newName: string) => {
    const workspaceManager = WorkspaceManager.getInstance()
    const activeId = workspaceManager.getActiveWorkspace()?.id
    if (!activeId) throw new Error('No active workspace')
    const dup = await workspaceManager.duplicateWorkspace(activeId, newName)
    rebuildMenuFn()
    return dup
  })
}
