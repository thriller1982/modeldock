import { app, shell, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { join } from 'path'
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

  mainWindow.on('ready-to-show', () => {
    const isHidden = process.argv.includes('--hidden') || process.argv.includes('--minimized')
    if (!isHidden && mainWindow) {
      mainWindow.show()
    }
  })

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
  await coreController.init()
  registerIpcHandlers()
  const win = createWindow()

  initTray(win, () => {
    isQuitting = true
    app.quit()
  })

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
