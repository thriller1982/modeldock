import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getDashboard: () => ipcRenderer.invoke('ccswitch:getDashboard'),
  getTargets: () => ipcRenderer.invoke('ccswitch:getTargets'),
  switchProvider: (payload: { targetId: string; providerId: string; useProxy: boolean }) =>
    ipcRenderer.invoke('ccswitch:switchProvider', payload),
  saveProvider: (provider: any) => ipcRenderer.invoke('ccswitch:saveProvider', provider),
  deleteProvider: (payload: { targetId: string; providerId: string }) =>
    ipcRenderer.invoke('ccswitch:deleteProvider', payload),
  saveMcp: (mcp: any) => ipcRenderer.invoke('ccswitch:saveMcp', mcp),
  deleteMcp: (arg: string | { mcpId: string }) =>
    ipcRenderer.invoke('ccswitch:deleteMcp', typeof arg === 'string' ? arg : arg.mcpId),
  updateTheme: (arg: 'system' | 'light' | 'dark' | { theme: 'system' | 'light' | 'dark' }) =>
    ipcRenderer.invoke('ccswitch:updateTheme', typeof arg === 'string' ? arg : arg.theme),
  getSkills: () => ipcRenderer.invoke('ccswitch:getSkills'),
  toggleSkillTarget: (payload: { skillId: string; targetId: string; enabled: boolean }) =>
    ipcRenderer.invoke('ccswitch:toggleSkillTarget', payload),
  syncAllSkills: (payload?: { targetId?: string }) =>
    ipcRenderer.invoke('ccswitch:syncAllSkills', payload),
  getSkillContent: (skillId: string) => ipcRenderer.invoke('ccswitch:getSkillContent', skillId),
  saveSkill: (payload: any) => ipcRenderer.invoke('ccswitch:saveSkill', payload),
  deleteSkill: (skillId: string) => ipcRenderer.invoke('ccswitch:deleteSkill', skillId),
  openSkillsFolder: () => ipcRenderer.invoke('ccswitch:openSkillsFolder'),
  getAutoLaunch: () => ipcRenderer.invoke('ccswitch:getAutoLaunch'),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('ccswitch:setAutoLaunch', { enabled }),
  openBackupsFolder: () => ipcRenderer.invoke('ccswitch:openBackupsFolder')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('ccswitch', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.ccswitch = api
}
