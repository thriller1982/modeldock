import { app, shell, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { TRAY_ICON_DATA_URL, APP_ICON_DATA_URL } from './icons-data'
import { coreController } from '../core/controller'

let trayInstance: Tray | null = null

export function getTrayInstance(): Tray | null {
  return trayInstance
}

export function buildTrayContextMenu(mainWindow: BrowserWindow, onQuit: () => void): Menu {
  const store = coreController.getStore()
  let isAutoLaunch = false
  try {
    isAutoLaunch = store.autoLaunch !== undefined ? store.autoLaunch : app.getLoginItemSettings().openAtLogin
  } catch {
    isAutoLaunch = !!store.autoLaunch
  }
  const minimizeToTray = store.minimizeToTray !== false

  return Menu.buildFromTemplate([
    {
      label: '显示 ModelDock',
      click: (): void => {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: isAutoLaunch,
      click: (menuItem): void => {
        try {
          app.setLoginItemSettings({
            openAtLogin: menuItem.checked,
            path: process.execPath,
            args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
          })
        } catch (err) {
          console.error('Failed to update loginItemSettings from tray:', err)
        }
        coreController.setAutoLaunch(menuItem.checked)
        updateTrayMenu(mainWindow, onQuit)
      }
    },
    {
      label: '关闭时最小化到系统托盘',
      type: 'checkbox',
      checked: minimizeToTray,
      click: (menuItem): void => {
        coreController.setMinimizeToTray(menuItem.checked)
        updateTrayMenu(mainWindow, onQuit)
      }
    },
    {
      label: '打开通用 Skills 目录',
      click: (): void => {
        shell.openPath(coreController.getSkillsHubPath())
      }
    },
    {
      label: '打开数据与备份目录',
      click: (): void => {
        shell.openPath(coreController.getBackupsPath())
      }
    },
    { type: 'separator' },
    {
      label: 'GitHub 项目主页',
      click: (): void => {
        shell.openExternal('https://github.com/thriller1982/modeldock')
      }
    },
    {
      label: '退出 ModelDock',
      click: (): void => {
        onQuit()
      }
    }
  ])
}

export function updateTrayMenu(mainWindow: BrowserWindow, onQuit: () => void): void {
  if (!trayInstance || trayInstance.isDestroyed()) return
  const menu = buildTrayContextMenu(mainWindow, onQuit)
  trayInstance.setContextMenu(menu)
}

export function initTray(mainWindow: BrowserWindow, onQuit: () => void): Tray {
  if (trayInstance && !trayInstance.isDestroyed()) {
    return trayInstance
  }

  let icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(APP_ICON_DATA_URL)
  }
  icon = icon.resize({ width: 16, height: 16 })
  trayInstance = new Tray(icon)

  trayInstance.setToolTip('ModelDock · AI 研发工具配置与缓存率监控中心')

  const contextMenu = buildTrayContextMenu(mainWindow, onQuit)
  trayInstance.setContextMenu(contextMenu)

  // Left click on tray: toggle show / hide
  trayInstance.on('click', () => {
    if (mainWindow.isDestroyed()) return

    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide()
      } else {
        mainWindow.focus()
      }
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // Double click: always show and focus
  trayInstance.on('double-click', () => {
    if (mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // On right-click, rebuild menu so checkmarks reflect newest store state
  trayInstance.on('right-click', () => {
    updateTrayMenu(mainWindow, onQuit)
  })

  return trayInstance
}

let hasShownMinimizeTip = false

export function notifyMinimizedToTray(): void {
  if (hasShownMinimizeTip || !trayInstance || trayInstance.isDestroyed()) return
  hasShownMinimizeTip = true
  try {
    trayInstance.displayBalloon({
      title: 'ModelDock 已最小化到托盘',
      content: 'ModelDock 仍在后台运行，点击托盘图标可随时唤醒。',
      iconType: 'info'
    })
  } catch {
    // ignore
  }
}
