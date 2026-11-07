import type {
  DashboardSnapshot,
  ProviderProfile,
  TargetId,
  TargetStatus,
  UnifiedMcpServer,
  UnifiedSkill
} from '../../core/types'
import type { AppDatabase } from '../../core/store/app-store'

declare global {
  interface Window {
    ccswitch?: {
      getDashboard: () => Promise<DashboardSnapshot>
      getTargets: () => Promise<{
        desktop: TargetStatus[]
        cli: TargetStatus[]
        store: AppDatabase
      }>
      switchProvider: (payload: {
        targetId: string
        providerId: string
        useProxy: boolean
      }) => Promise<TargetStatus>
      saveProvider: (provider: ProviderProfile) => Promise<AppDatabase>
      deleteProvider: (payload: { targetId: string; providerId: string }) => Promise<AppDatabase>
      saveMcp: (mcp: UnifiedMcpServer) => Promise<{ store: AppDatabase; syncedTargets: string[] }>
      deleteMcp: (mcpId: string) => Promise<AppDatabase>
      updateTheme: (theme: 'system' | 'light' | 'dark') => Promise<AppDatabase>
      getSkills: () => Promise<{ hubPath: string; skills: UnifiedSkill[] }>
      toggleSkillTarget: (payload: {
        skillId: string
        targetId: TargetId
        enabled: boolean
      }) => Promise<{ skills: UnifiedSkill[]; syncedTargets: TargetId[] }>
      syncAllSkills: (payload?: {
        targetId?: TargetId
      }) => Promise<{ success: boolean; syncedCount: number; syncedTargets: TargetId[] }>
      getSkillContent: (skillId: string) => Promise<string>
      saveSkill: (payload: {
        id?: string
        name: string
        description: string
        content?: string
        enabledTargets?: TargetId[]
      }) => Promise<{ skills: UnifiedSkill[]; syncedTargets: TargetId[] }>
      deleteSkill: (skillId: string) => Promise<{ skills: UnifiedSkill[] }>
      openSkillsFolder: () => Promise<string>
      getAutoLaunch: () => Promise<{ enabled: boolean; isPackaged: boolean }>
      setAutoLaunch: (payload: { enabled: boolean }) => Promise<AppDatabase>
      openBackupsFolder: () => Promise<void>
    }
  }
}

async function callApi<T>(fnName: string, payload?: any): Promise<T> {
  if (window.ccswitch && typeof (window.ccswitch as any)[fnName] === 'function') {
    return (window.ccswitch as any)[fnName](payload)
  }
  const res = await fetch(`/api/${fnName}`, {
    method: payload !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: payload !== undefined ? JSON.stringify(payload) : undefined
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'API request failed')
  }
  return res.json()
}

export const clientApi = {
  getDashboard: () => callApi<DashboardSnapshot>('getDashboard'),
  getTargets: () =>
    callApi<{ desktop: TargetStatus[]; cli: TargetStatus[]; store: AppDatabase }>('getTargets'),
  switchProvider: (payload: { targetId: string; providerId: string; useProxy: boolean }) =>
    callApi<TargetStatus>('switchProvider', payload),
  saveProvider: (provider: ProviderProfile) => callApi<AppDatabase>('saveProvider', provider),
  deleteProvider: (targetId: string, providerId: string) =>
    callApi<AppDatabase>('deleteProvider', { targetId, providerId }),
  saveMcp: (mcp: UnifiedMcpServer) =>
    callApi<{ store: AppDatabase; syncedTargets: string[] }>('saveMcp', mcp),
  deleteMcp: (mcpId: string) => callApi<AppDatabase>('deleteMcp', { mcpId }),
  updateTheme: (theme: 'system' | 'light' | 'dark') =>
    callApi<AppDatabase>('updateTheme', { theme }),
  getSkills: () => callApi<{ hubPath: string; skills: UnifiedSkill[] }>('getSkills'),
  toggleSkillTarget: (skillId: string, targetId: TargetId, enabled: boolean) =>
    callApi<{ skills: UnifiedSkill[]; syncedTargets: TargetId[] }>('toggleSkillTarget', {
      skillId,
      targetId,
      enabled
    }),
  syncAllSkills: (targetId?: TargetId) =>
    callApi<{ success: boolean; syncedCount: number; syncedTargets: TargetId[] }>('syncAllSkills', {
      targetId
    }),
  getSkillContent: (skillId: string) => callApi<string>('getSkillContent', { skillId }),
  saveSkill: (payload: {
    id?: string
    name: string
    description: string
    content?: string
    enabledTargets?: TargetId[]
  }) => callApi<{ skills: UnifiedSkill[]; syncedTargets: TargetId[] }>('saveSkill', payload),
  deleteSkill: (skillId: string) =>
    callApi<{ skills: UnifiedSkill[] }>('deleteSkill', { skillId }),
  openSkillsFolder: () => callApi<string>('openSkillsFolder'),
  getAutoLaunch: () => callApi<{ enabled: boolean; isPackaged: boolean }>('getAutoLaunch'),
  setAutoLaunch: (enabled: boolean) => callApi<AppDatabase>('setAutoLaunch', { enabled }),
  openBackupsFolder: () => callApi<void>('openBackupsFolder')
}
