import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { coreController } from '../core/controller'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'CC-Switch Lite · AI 研发工具配置与缓存率监控中心',
    backgroundColor: '#090d16',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
}

app.whenReady().then(async () => {
  await coreController.init()
  registerIpcHandlers()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
