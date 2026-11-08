import { app, shell, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'

function log(msg: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'startup.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // ignore
  }
}

import { coreController } from '../core/controller'
import { APP_ICON_DATA_URL } from './icons-data'
import { initTray, notifyMinimizedToTray, updateTrayMenu } from './tray'

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let isQuitting = false

function createWindow(): BrowserWindow {
  const store = coreController.getStore()
  const isLight = store.theme === 'light'
  const appIcon = nativeImage.createFromDataURL(APP_ICON_DATA_URL)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    icon: appIcon,
    title: 'ModelDock · AI 研发工具配置与缓存率监控中心',
    backgroundColor: isLight ? '#f8fafc' : '#090d16',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => log(`did-fail-load ${code} ${desc}`))
  mainWindow.webContents.on('render-process-gone', (_e, d) => log(`render-process-gone ${d.reason}`))
  mainWindow.webContents.on('console-message', (_e, level, message) => { if (level >= 2) log(`renderer: ${message}`) })
  const isHidden = process.argv.includes('--hidden') || process.argv.includes('--minimized')
  const revealWindow = (reason: string): void => {
    log(`reveal: ${reason}`)
    if (!isHidden && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  }
  mainWindow.once('ready-to-show', () => revealWindow('ready-to-show'))
  mainWindow.webContents.once('did-finish-load', () => revealWindow('did-finish-load'))
  setTimeout(() => revealWindow('timeout'), 3000)

  // Intercept window close (X button): minimize to tray if enabled
  mainWindow.on('close', (event) => {
    const currentStore = coreController.getStore()
    const minimizeToTray = currentStore.minimizeToTray !== false

    if (!isQuitting && minimizeToTray) {
      event.preventDefault()
      mainWindow?.hide()
      notifyMinimizedToTray()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    const devUrl = process.env['ELECTRON_RENDERER_URL'].replace('localhost', '127.0.0.1')
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function registerIpcHandlers(): void {
  ipcMain.handle('ccswitch:getDashboard', () => coreController.getDashboardSnapshot())
  ipcMain.handle('ccswitch:getTargets', () => coreController.getAllTargetsStatus())
  ipcMain.handle('ccswitch:switchProvider', (_e, { targetId, providerId, useProxy }) =>
    coreController.switchTargetProvider(targetId, providerId, useProxy)
  )
  ipcMain.handle('ccswitch:saveProvider', (_e, provider) => coreController.saveProvider(provider))
  ipcMain.handle('ccswitch:deleteProvider', (_e, arg) =>
    coreController.deleteProvider(arg?.targetId, arg?.providerId)
  )
  ipcMain.handle('ccswitch:saveMcp', (_e, mcp) => coreController.saveAndSyncMcp(mcp))
  ipcMain.handle('ccswitch:deleteMcp', (_e, arg) =>
    coreController.deleteMcp(typeof arg === 'string' ? arg : arg?.mcpId)
  )
  ipcMain.handle('ccswitch:updateTheme', (_e, arg) =>
    coreController.updateTheme(typeof arg === 'string' ? arg : arg?.theme)
  )
  ipcMain.handle('ccswitch:getSkills', () => coreController.getSkills())
  ipcMain.handle('ccswitch:toggleSkillTarget', (_e, arg) =>
    coreController.toggleSkillTarget(arg.skillId, arg.targetId, arg.enabled)
  )
  ipcMain.handle('ccswitch:syncAllSkills', (_e, arg) =>
    coreController.syncAllSkills(arg?.targetId)
  )
  ipcMain.handle('ccswitch:getSkillContent', (_e, arg) =>
    coreController.getSkillContent(typeof arg === 'string' ? arg : arg?.skillId)
  )
  ipcMain.handle('ccswitch:saveSkill', (_e, payload) => coreController.saveSkill(payload))
  ipcMain.handle('ccswitch:deleteSkill', (_e, arg) =>
    coreController.deleteSkill(typeof arg === 'string' ? arg : arg?.skillId)
  )
  ipcMain.handle('ccswitch:openSkillsFolder', () =>
    shell.openPath(coreController.getSkillsHubPath())
  )
  ipcMain.handle('ccswitch:getAutoLaunch', () => {
    const store = coreController.getStore()
    let openAtLogin = false
    try {
      openAtLogin = app.getLoginItemSettings().openAtLogin
    } catch {
      // ignore
    }
    return {
      enabled: store.autoLaunch !== undefined ? store.autoLaunch : openAtLogin,
      isPackaged: app.isPackaged
    }
  })
  ipcMain.handle('ccswitch:setAutoLaunch', (_e, { enabled }) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        path: process.execPath,
        args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
      })
    } catch (err) {
      console.error('Failed to setLoginItemSettings:', err)
    }
    const updated = coreController.setAutoLaunch(!!enabled)
    if (mainWindow) {
      updateTrayMenu(mainWindow, () => {
        isQuitting = true
        app.quit()
      })
    }
    return updated
  })
  ipcMain.handle('ccswitch:getMinimizeToTray', () => {
    const store = coreController.getStore()
    return { enabled: store.minimizeToTray !== false }
  })
  ipcMain.handle('ccswitch:setMinimizeToTray', (_e, { enabled }) => {
    const updated = coreController.setMinimizeToTray(!!enabled)
    if (mainWindow) {
      updateTrayMenu(mainWindow, () => {
        isQuitting = true
        app.quit()
      })
    }
    return updated
  })
  ipcMain.handle('ccswitch:openBackupsFolder', () =>
    shell.openPath(coreController.getBackupsPath())
  )
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  log('app ready')
  try {
    await coreController.init()
  } catch (err) {
    log(`controller init failed: ${String(err)}`)
  }
  registerIpcHandlers()
  const win = createWindow()
  log('window created')

  try {
    initTray(win, () => {
      isQuitting = true
      app.quit()
    })
    log('tray created')
  } catch (err) {
    log(`tray failed: ${String(err)}`)
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow()
      initTray(newWin, () => {
        isQuitting = true
        app.quit()
      })
    } else if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('window-all-closed', () => {
  if (isQuitting || process.platform === 'darwin') {
    app.quit()
  }
})


