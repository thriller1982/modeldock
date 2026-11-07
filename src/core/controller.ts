import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { registry } from './adapters'
import { loadStore, saveStore, AppDatabase, DEFAULT_SKILLS_HUB } from './store/app-store'
import { usageProxy } from './proxy/usage-proxy'
import {
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

export class CoreController {
  async init(): Promise<void> {
    const store = loadStore()
    await usageProxy.start(store.proxyPort || 15721)
  }

  getDashboardSnapshot(): DashboardSnapshot {
    const store = loadStore()
    const adapters = registry.getAll()
    const byTarget = adapters.map((adapter) => {
      const summary = adapter.getUsageSummary(50)
      // Merge proxy usage logs belonging to this target
      const proxyLogs = (store.proxyUsageLogs || []).filter((l) => l.targetId === adapter.id)
      for (const pl of proxyLogs) {
        summary.inputTokens += pl.inputTokens
        summary.cachedTokens += pl.cachedTokens
        summary.cacheWriteTokens += pl.cacheWriteTokens
        summary.outputTokens += pl.outputTokens
        summary.reasoningTokens += pl.reasoningTokens
        summary.totalTokens += pl.totalTokens
        summary.sessionCount += 1
      }
      summary.recentSessions = [...proxyLogs, ...summary.recentSessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50)
      summary.cacheHitRate =
        summary.inputTokens > 0
          ? Number(((summary.cachedTokens / summary.inputTokens) * 100).toFixed(1))
          : 0
      const speedSessions = summary.recentSessions.filter(
        (s) => s.outputTokensPerSec && s.outputTokensPerSec > 0
      )
      if (speedSessions.length > 0) {
        summary.latestOutputTokensPerSec = speedSessions[0].outputTokensPerSec
        summary.latestDurationMs = speedSessions[0].durationMs
        summary.avgOutputTokensPerSec = Number(
          (
            speedSessions.reduce((acc, s) => acc + (s.outputTokensPerSec || 0), 0) /
            speedSessions.length
          ).toFixed(1)
        )
      }
      return summary
    })

    let totalInputTokens = 0
    let totalCachedTokens = 0
    let totalOutputTokens = 0
    let totalReasoningTokens = 0
    let totalSessions = 0
    const allStream: SessionUsageItem[] = []

    for (const t of byTarget) {
      totalInputTokens += t.inputTokens
      totalCachedTokens += t.cachedTokens
      totalOutputTokens += t.outputTokens
      totalReasoningTokens += t.reasoningTokens
      totalSessions += t.sessionCount
      allStream.push(...t.recentSessions)
    }

    allStream.sort((a, b) => b.updatedAt - a.updatedAt)

    const overallCacheHitRate =
      totalInputTokens > 0
        ? Number(((totalCachedTokens / totalInputTokens) * 100).toFixed(1))
        : 0

    return {
      totalInputTokens,
      totalCachedTokens,
      totalOutputTokens,
      totalReasoningTokens,
      overallCacheHitRate,
      totalSessions,
      proxyRunning: usageProxy.isRunning(),
      proxyPort: usageProxy.getPort(),
      byTarget,
      recentStream: allStream.slice(0, 200)
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
}

export const coreController = new CoreController()
