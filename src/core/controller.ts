import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { registry } from './adapters'
import { loadStore, saveStore, AppDatabase, DEFAULT_SKILLS_HUB, BACKUP_DIR } from './store/app-store'
import { usageProxy } from './proxy/usage-proxy'
import { calculateCost } from './pricing'
import { cacheHitRate, summarizeUsage, tokenCount } from './usage'
import {
  DailyActivityItem,
  DashboardSnapshot,
  ProviderProfile,
  SessionUsageItem,
  TargetId,
  TargetStatus,
  UnifiedMcpServer,
  UnifiedSkill
} from './types'

function parseSkillMd(filePath: string): { name: string; description: string } {
  let name = ''
  let description = ''
  if (!fs.existsSync(filePath)) return { name, description }
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (match) {
      const yaml = match[1]
      const nameMatch = yaml.match(/(?:^|\n)name:\s*([^\n\r]+)/)
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
      }
      const descMatch = yaml.match(
        /(?:^|\n)description:\s*(?:>-\s*|>\s*|\|-\s*|\|\s*)?([^\n\r]+(?:\n[ \t]+[^\n\r]+)*)/
      )
      if (descMatch) {
        description = descMatch[1]
          .trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\r?\n[ \t]+/g, ' ')
      }
    }
  } catch {
    // ignore
  }
  return { name, description }
}

function countFolderFiles(dir: string): number {
  let count = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) count += countFolderFiles(path.join(dir, e.name))
      else count++
    }
  } catch {
    // ignore
  }
  return count
}

function readGatewayUsage(item: SessionUsageItem): SessionUsageItem {
  if (item.usageVersion === 2) return item
  const inputTokens = tokenCount(item.inputTokens)
  const cachedTokens = Math.min(inputTokens, tokenCount(item.cachedTokens))
  const cacheWriteTokens = Math.min(inputTokens - cachedTokens, tokenCount(item.cacheWriteTokens))
  const generated = tokenCount(item.outputTokens)
  const reasoningTokens = Math.min(generated, tokenCount(item.reasoningTokens))
  const outputTokens = generated - reasoningTokens
  const price = calculateCost(item.model || 'unknown', inputTokens, cachedTokens, outputTokens, reasoningTokens, cacheWriteTokens)
  return {
    ...item,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + generated,
    cacheHitRate: cacheHitRate(inputTokens, cachedTokens),
    costUsd: price.costUsd,
    cacheSavingsUsd: price.savingsUsd,
    outputTokensPerSec: undefined,
    estimated: true
  }
}

export class CoreController {
  async init(): Promise<void> {
    const store = loadStore()
    await usageProxy.start(store.proxyPort || 15721)
  }

  getDashboardSnapshot(): DashboardSnapshot {
    const store = loadStore()
    const byTarget = registry.getAll().map((adapter) => {
      const native = adapter.getUsageSummary(50)
      const gateway = store.proxyUsageLogs
        .filter((item) => item?.targetId === adapter.id)
        .map(readGatewayUsage)
      if (native.sessionCount === 0) return summarizeUsage(adapter, gateway, 50)

      // The clients and older gateway logs lack a common request ID. Use one source for totals.
      const details = gateway.map((item) => ({ ...item, detailOnly: true }))
      return {
        ...native,
        recentSessions: [...native.recentSessions, ...details]
          .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50)
      }
    })

    const dailyMap = new Map<string, DailyActivityItem>()
    for (const target of byTarget) {
      for (const day of target.dailyActivities ?? []) {
        const current = dailyMap.get(day.date)
        if (!current) {
          dailyMap.set(day.date, { ...day })
          continue
        }
        current.totalTokens += day.totalTokens
        current.inputTokens += day.inputTokens
        current.cachedTokens += day.cachedTokens
        current.outputTokens += day.outputTokens
        current.reasoningTokens += day.reasoningTokens
        current.sessionCount += day.sessionCount
        current.costUsd += day.costUsd
        current.cacheSavingsUsd += day.cacheSavingsUsd
        current.unpricedCount += day.unpricedCount
      }
    }
    const sum = (key: 'inputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'outputTokens' |
      'reasoningTokens' | 'sessionCount' | 'totalCostUsd' | 'totalCacheSavingsUsd' | 'unpricedCount') =>
      byTarget.reduce((total, target) => total + (target[key] ?? 0), 0)
    const totalInputTokens = sum('inputTokens')
    const totalCachedTokens = sum('cachedTokens')

    return {
      totalInputTokens,
      totalCachedTokens,
      totalCacheWriteTokens: sum('cacheWriteTokens'),
      totalOutputTokens: sum('outputTokens'),
      totalReasoningTokens: sum('reasoningTokens'),
      overallCacheHitRate: cacheHitRate(totalInputTokens, totalCachedTokens),
      totalSessions: sum('sessionCount'),
      totalCostUsd: sum('totalCostUsd'),
      totalSavingsUsd: sum('totalCacheSavingsUsd'),
      unpricedCount: sum('unpricedCount'),
      allDailyActivities: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      proxyRunning: usageProxy.isRunning(),
      proxyPort: usageProxy.getPort(),
      byTarget,
      recentStream: byTarget.flatMap((target) => target.recentSessions)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
    }
  }

  getAllTargetsStatus(): {
    desktop: TargetStatus[]
    cli: TargetStatus[]
    store: AppDatabase
  } {
    const store = loadStore()
    const port = usageProxy.getPort()
    const desktop = registry.getByCategory('desktop').map((a) => a.getStatus(port))
    const cli = registry.getByCategory('cli').map((a) => a.getStatus(port))
    return { desktop, cli, store }
  }

  switchTargetProvider(targetId: TargetId, providerId: string, useProxy: boolean): TargetStatus {
    const store = loadStore()
    const targetList = store.providersByTarget[targetId] || []
    const provider = targetList.find((p) => p.id === providerId)
    if (!provider) throw new Error(`未在 ${targetId} 下找到供应商: ${providerId}`)

    const adapter = registry.getById(targetId)
    if (!adapter) throw new Error(`未找到目标工具适配器: ${targetId}`)

    store.activeProviderByTarget[targetId] = providerId
    store.modeByTarget[targetId] = useProxy ? 'gateway' : 'direct'
    saveStore(store)

    adapter.applyProvider(provider, useProxy, usageProxy.getPort())
    return adapter.getStatus(usageProxy.getPort())
  }

  updateTheme(theme: 'system' | 'light' | 'dark'): AppDatabase {
    const store = loadStore()
    store.theme = theme
    saveStore(store)
    return store
  }

  saveProvider(provider: ProviderProfile): AppDatabase {
    const store = loadStore()
    const targetId = provider.targetId
    if (!store.providersByTarget[targetId]) {
      store.providersByTarget[targetId] = []
    }
    const list = store.providersByTarget[targetId]
    const idx = list.findIndex((p) => p.id === provider.id)
    if (idx >= 0) {
      list[idx] = provider
    } else {
      list.push(provider)
    }
    saveStore(store)

    // If this provider is currently the active one, immediately apply to config and env
    if (store.activeProviderByTarget[targetId] === provider.id) {
      const useProxy = store.modeByTarget[targetId] === 'gateway'
      const adapter = registry.getById(targetId)
      if (adapter) {
        adapter.applyProvider(provider, useProxy, usageProxy.getPort())
      }
    }

    return store
  }

  deleteProvider(targetId: TargetId, providerId: string): AppDatabase {
    const store = loadStore()
    const list = store.providersByTarget[targetId] || []
    store.providersByTarget[targetId] = list.filter((p) => p.id !== providerId)

    if (store.activeProviderByTarget[targetId] === providerId) {
      store.activeProviderByTarget[targetId] = store.providersByTarget[targetId][0]?.id
    }

    const adapter = registry.getById(targetId) as any
    if (adapter && typeof adapter.removeProviderFromConfig === 'function') {
      adapter.removeProviderFromConfig(providerId)
    }

    saveStore(store)
    return store
  }

  saveAndSyncMcp(mcp: UnifiedMcpServer): { store: AppDatabase; syncedTargets: TargetId[] } {
    const store = loadStore()
    const idx = store.mcps.findIndex((m) => m.id === mcp.id)
    if (idx >= 0) {
      store.mcps[idx] = mcp
    } else {
      store.mcps.push(mcp)
    }
    saveStore(store)

    const syncedTargets: TargetId[] = []
    for (const adapter of registry.getAll()) {
      try {
        adapter.syncMcps(store.mcps)
        syncedTargets.push(adapter.id)
      } catch {
        // ignore protected target error
      }
    }
    return { store, syncedTargets }
  }

  deleteMcp(mcpId: string): AppDatabase {
    const store = loadStore()
    store.mcps = store.mcps.filter((m) => m.id !== mcpId)
    saveStore(store)
    for (const adapter of registry.getAll()) {
      try {
        adapter.syncMcps(store.mcps)
      } catch {
        // ignore
      }
    }
    return store
  }

  getSkillsHubPath(): string {
    const store = loadStore()
    return store.skillsHubPath || DEFAULT_SKILLS_HUB
  }

  getSkills(): { hubPath: string; skills: UnifiedSkill[] } {
    const hubPath = this.getSkillsHubPath()
    if (!fs.existsSync(hubPath)) {
      try {
        fs.mkdirSync(hubPath, { recursive: true })
      } catch {
        // ignore
      }
    }

    const store = loadStore()
    const savedSkillMap = new Map<string, UnifiedSkill>()
    for (const s of store.skills || []) {
      savedSkillMap.set(s.id, s)
    }

    const scannedSkills: UnifiedSkill[] = []
    if (fs.existsSync(hubPath)) {
      try {
        const entries = fs.readdirSync(hubPath, { withFileTypes: true })
        for (const e of entries) {
          if (!e.isDirectory()) continue
          const skillDir = path.join(hubPath, e.name)
          const skillMd = path.join(skillDir, 'SKILL.md')
          const { name, description } = parseSkillMd(skillMd)
          const st = fs.statSync(skillDir)
          const fileCount = countFolderFiles(skillDir)

          const saved = savedSkillMap.get(e.name)
          let enabledTargets = saved ? saved.enabledTargets : []
          if (!saved) {
            const detectedTargets: TargetId[] = []
            if (fs.existsSync(path.join(os.homedir(), '.codex', 'skills', e.name))) {
              detectedTargets.push('codex-desktop')
            }
            if (fs.existsSync(path.join(os.homedir(), '.workbuddy', 'skills', e.name))) {
              detectedTargets.push('workbuddy')
            }
            if (fs.existsSync(path.join(os.homedir(), '.gemini', 'config', 'skills', e.name))) {
              detectedTargets.push('antigravity')
            }
            if (fs.existsSync(path.join(os.homedir(), '.config', 'opencode', 'skills', e.name))) {
              detectedTargets.push('opencode')
            }
            enabledTargets = detectedTargets
          }

          scannedSkills.push({
            id: e.name,
            name: name || e.name,
            description: description || '通用技能',
            path: skillDir,
            enabledTargets,
            fileCount,
            updatedAt: st.mtimeMs
          })
        }
      } catch {
        // ignore
      }
    }

    scannedSkills.sort((a, b) => a.id.localeCompare(b.id))
    store.skills = scannedSkills
    saveStore(store)

    return { hubPath, skills: scannedSkills }
  }

  toggleSkillTarget(
    skillId: string,
    targetId: TargetId,
    enabled: boolean
  ): { skills: UnifiedSkill[]; syncedTargets: TargetId[] } {
    const { hubPath, skills } = this.getSkills()
    const targetSkill = skills.find((s) => s.id === skillId)
    if (!targetSkill) {
      throw new Error(`未找到 Skill: ${skillId}`)
    }

    if (enabled && !targetSkill.enabledTargets.includes(targetId)) {
      targetSkill.enabledTargets.push(targetId)
    } else if (!enabled && targetSkill.enabledTargets.includes(targetId)) {
      targetSkill.enabledTargets = targetSkill.enabledTargets.filter((t) => t !== targetId)
    }

    const store = loadStore()
    store.skills = skills
    saveStore(store)

    const adapter = registry.getById(targetId)
    if (adapter) {
      try {
        adapter.syncSkills([targetSkill], hubPath)
      } catch {
        // ignore
      }
    }

    return { skills, syncedTargets: [targetId] }
  }

  syncAllSkills(targetId?: TargetId): {
    success: boolean
    syncedCount: number
    syncedTargets: TargetId[]
  } {
    const { hubPath, skills } = this.getSkills()
    const targetsToSync = targetId
      ? [registry.getById(targetId)].filter(Boolean)
      : registry.getAll()
    const syncedTargets: TargetId[] = []

    for (const adapter of targetsToSync) {
      if (!adapter) continue
      try {
        adapter.syncSkills(skills, hubPath)
        syncedTargets.push(adapter.id)
      } catch {
        // ignore
      }
    }

    return { success: true, syncedCount: skills.length, syncedTargets }
  }

  getSkillContent(skillId: string): string {
    const hubPath = this.getSkillsHubPath()
    const skillMd = path.join(hubPath, skillId, 'SKILL.md')
    if (fs.existsSync(skillMd)) {
      return fs.readFileSync(skillMd, 'utf8')
    }
    return ''
  }

  saveSkill(payload: {
    id?: string
    name: string
    description: string
    content?: string
    enabledTargets?: TargetId[]
  }): { skills: UnifiedSkill[]; syncedTargets: TargetId[] } {
    const hubPath = this.getSkillsHubPath()
    const cleanId = (payload.id || payload.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/--+/g, '-')
    if (!cleanId) throw new Error('Skill 名称不能为空')

    const skillDir = path.join(hubPath, cleanId)
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true })
    }

    const skillMd = path.join(skillDir, 'SKILL.md')
    let fullContent = payload.content?.trim()
    if (!fullContent) {
      fullContent = `---
name: ${cleanId}
description: ${payload.description || '通用技能'}
---

# ${payload.name || cleanId}

${payload.description || ''}
`
    } else if (!fullContent.startsWith('---')) {
      fullContent = `---
name: ${cleanId}
description: ${payload.description || '通用技能'}
---

${fullContent}
`
    }

    fs.writeFileSync(skillMd, fullContent, 'utf8')

    const store = loadStore()
    const existing = (store.skills || []).find((s) => s.id === cleanId)
    const targets = payload.enabledTargets || existing?.enabledTargets || []

    const updatedSkill: UnifiedSkill = {
      id: cleanId,
      name: payload.name || cleanId,
      description: payload.description || '',
      path: skillDir,
      enabledTargets: targets,
      fileCount: countFolderFiles(skillDir),
      updatedAt: Date.now()
    }

    const idx = (store.skills || []).findIndex((s) => s.id === cleanId)
    if (idx >= 0) store.skills[idx] = updatedSkill
    else store.skills.push(updatedSkill)
    saveStore(store)

    // Sync to all targets
    const syncedTargets: TargetId[] = []
    for (const adapter of registry.getAll()) {
      try {
        adapter.syncSkills([updatedSkill], hubPath)
        syncedTargets.push(adapter.id)
      } catch {
        // ignore
      }
    }

    return { skills: this.getSkills().skills, syncedTargets }
  }

  deleteSkill(skillId: string): { skills: UnifiedSkill[] } {
    const hubPath = this.getSkillsHubPath()
    const targetSkill = (loadStore().skills || []).find((s) => s.id === skillId)

    // First unsync from all targets
    if (targetSkill) {
      targetSkill.enabledTargets = []
      for (const adapter of registry.getAll()) {
        try {
          adapter.syncSkills([targetSkill], hubPath)
        } catch {
          // ignore
        }
      }
    }

    // Remove from hub folder
    const skillDir = path.join(hubPath, skillId)
    if (fs.existsSync(skillDir)) {
      try {
        fs.rmSync(skillDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }

    const store = loadStore()
    store.skills = (store.skills || []).filter((s) => s.id !== skillId)
    saveStore(store)

    return { skills: this.getSkills().skills }
  }

  getStore(): AppDatabase {
    return loadStore()
  }

  getBackupsPath(): string {
    return BACKUP_DIR
  }

  setAutoLaunch(enabled: boolean): AppDatabase {
    const store = loadStore()
    store.autoLaunch = enabled
    saveStore(store)
    return store
  }
}

export const coreController = new CoreController()
