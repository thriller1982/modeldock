import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { DesktopTargetAdapter } from '../base'
import { FileParseCache } from '../file-cache'
import {
  ProviderProfile,
  SessionUsageItem,
  TargetId,
  TargetStatus,
  TargetUsageSummary,
  UnifiedMcpServer,
  UnifiedSkill
} from '../../types'
import { createBackup } from '../../store/app-store'
import { calculateCost } from '../../pricing'
import { cacheHitRate, summarizeUsage, tokenCount } from '../../usage'

type WorkBuddyUsage = Pick<SessionUsageItem, 'model' | 'inputTokens' | 'cachedTokens' | 'cacheWriteTokens'
  | 'outputTokens' | 'reasoningTokens' | 'updatedAt' | 'durationMs' | 'outputTokensPerSec'>

export class WorkBuddyAdapter extends DesktopTargetAdapter {
  readonly id: TargetId = 'workbuddy'
  readonly name = 'WorkBuddy (腾讯桌面端)'
  readonly description = '腾讯 WorkBuddy / CodeBuddy 桌面端助手 (~/.workbuddy)'
  readonly processNames = ['WorkBuddy.exe', 'CodeBuddy.exe']

  private usageCache = new FileParseCache<SessionUsageItem[]>()

  private get wbDir(): string {
    return path.join(os.homedir(), '.workbuddy')
  }

  private get modelsJsonPath(): string {
    return path.join(this.wbDir, 'models.json')
  }

  private get mcpJsonPath(): string {
    return path.join(this.wbDir, 'mcp.json')
  }

  private get projectsDir(): string {
    return path.join(this.wbDir, 'projects')
  }

  private get skillsDir(): string {
    return path.join(this.wbDir, 'skills')
  }

  getStatus(proxyPort: number): TargetStatus {
    const installed = fs.existsSync(this.wbDir)
    let currentModel = '内置模型 (Hy4 / DeepSeek)'
    let currentProvider = 'Tencent Cloud'
    let proxyEnabled = false
    let activeMcps: string[] = []
    let activeSkills: string[] = []

    if (fs.existsSync(this.modelsJsonPath)) {
      try {
        const raw = fs.readFileSync(this.modelsJsonPath, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed.models) && parsed.models.length > 0) {
          const first = parsed.models[0]
          currentModel = first.name || first.id || currentModel
          currentProvider = first.vendor || 'Custom'
          if (first.url && String(first.url).includes(`:${proxyPort}`)) {
            proxyEnabled = true
          }
        }
      } catch {
        // ignore
      }
    }

    if (fs.existsSync(this.mcpJsonPath)) {
      try {
        const raw = fs.readFileSync(this.mcpJsonPath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
          activeMcps = Object.keys(parsed.mcpServers)
        }
      } catch {
        // ignore
      }
    }

    if (fs.existsSync(this.skillsDir)) {
      try {
        activeSkills = fs
          .readdirSync(this.skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        // ignore
      }
    }

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      description: this.description,
      installed,
      running: this.isProcessRunning(),
      configPaths: {
        mainConfig: this.modelsJsonPath,
        mcpConfig: this.mcpJsonPath,
        skillsDir: this.skillsDir,
        usageDbOrDir: this.projectsDir
      },
      capabilities: {
        providerSwitch: true,
        mcpSync: true,
        skillSync: true,
        usageMonitor: true,
        proxyGateway: true,
        processControl: true
      },
      currentModel,
      currentProvider,
      proxyEnabled,
      proxyEndpoint: `http://127.0.0.1:${proxyPort}/workbuddy/v1/chat/completions`,
      mcpCount: activeMcps.length,
      activeMcps,
      skillCount: activeSkills.length,
      activeSkills
    }
  }

  getUsageSummary(limit = 30): TargetUsageSummary {
    const items: SessionUsageItem[] = []
    const titles = new Map<string, string>()
    const dbPath = path.join(this.wbDir, 'workbuddy.db')
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
          const rows = db.prepare('SELECT id, title, custom_title FROM sessions').all()
          for (const row of rows) {
            const title = String(row.custom_title || row.title || '').trim()
            if (title) titles.set(String(row.id), title)
          }
        } finally {
          db.close()
        }
      } catch {
        // The transcript still provides a title when the database is unavailable.
      }
    }

    if (!fs.existsSync(this.projectsDir)) return summarizeUsage(this, items, limit)
    for (const project of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const dir = path.join(this.projectsDir, project.name)
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
        const filePath = path.join(dir, file.name)
        const id = path.basename(file.name, '.jsonl')
        const entries = this.usageCache.get(filePath, (content, mtime) =>
          this.readSessionUsage(content, id, project.name, mtime)) ?? []
        for (const entry of entries) {
          const title = titles.get(id)
          items.push(title
            ? { ...entry, title: entries.length > 1 ? title + ' (' + entry.model + ')' : title }
            : entry)
        }
      }
    }
    return summarizeUsage(this, items, limit)
  }

  private readSessionUsage(content: string, id: string, project: string, mtime: number): SessionUsageItem[] {
    let title = project
    let requestStartedAt = 0
    const usage = new Map<string, WorkBuddyUsage>()
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const timestamp = tokenCount(entry?.timestamp)
      if (entry?.type === 'ai-title' && entry.title) {
        title = entry.title
      } else if (entry?.type === 'message' && entry.role === 'user') {
        if (timestamp) requestStartedAt = timestamp
        if (title === project) {
          const text = Array.isArray(entry.content)
            ? entry.content.map((part: { text?: string }) => part?.text || '').join(' ')
            : String(entry.content || '')
          const cleaned = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
            .replace(/<[^>]+>/g, '').trim()
          if (cleaned) title = cleaned.slice(0, 40)
        }
      } else if (entry?.type === 'function_call_result' && timestamp) {
        requestStartedAt = timestamp
      }

      const raw = entry?.providerData?.rawUsage
      if (!raw) continue
      const input = tokenCount(raw.prompt_tokens)
      const generated = tokenCount(raw.completion_tokens)
      if (input + generated === 0) continue
      const model = String(entry.providerData?.model || entry.model || 'unknown')
      const cached = Math.min(input, tokenCount(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens))
      const write = Math.min(input - cached, tokenCount(raw.prompt_tokens_details?.cache_write_tokens ??
        raw.prompt_tokens_details?.cache_creation_input_tokens ?? raw.cache_write_input_tokens))
      const reasoning = Math.min(generated, tokenCount(raw.completion_tokens_details?.reasoning_tokens))
      const output = generated - reasoning
      let bucket = usage.get(model)
      if (!bucket) {
        bucket = {
          model, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
          reasoningTokens: 0, updatedAt: timestamp || mtime
        }
        usage.set(model, bucket)
      }
      bucket.inputTokens += input
      bucket.cachedTokens += cached
      bucket.cacheWriteTokens += write
      bucket.outputTokens += output
      bucket.reasoningTokens += reasoning
      if (timestamp) {
        bucket.updatedAt = timestamp
        const duration = timestamp - requestStartedAt
        if (requestStartedAt && duration >= 300 && duration < 120_000 && output > 0) {
          bucket.durationMs = duration
          bucket.outputTokensPerSec = Number(((output / duration) * 1000).toFixed(1))
        }
        requestStartedAt = timestamp
      }
    }

    return Array.from(usage.values(), (bucket) => {
      const { costUsd, savingsUsd } = calculateCost(
        bucket.model, bucket.inputTokens, bucket.cachedTokens, bucket.outputTokens,
        bucket.reasoningTokens, bucket.cacheWriteTokens
      )
      return {
        ...bucket,
        id: usage.size > 1 ? id + '_' + bucket.model : id,
        sessionId: id,
        targetId: this.id,
        targetName: this.name,
        category: this.category,
        title: usage.size > 1 ? title + ' (' + bucket.model + ')' : title,
        provider: 'WorkBuddy',
        totalTokens: bucket.inputTokens + bucket.outputTokens + bucket.reasoningTokens,
        cacheHitRate: cacheHitRate(bucket.inputTokens, bucket.cachedTokens),
        costUsd,
        cacheSavingsUsd: savingsUsd,
        source: 'native-log'
      }
    })
  }

  applyProvider(provider: ProviderProfile, useProxy: boolean, proxyPort: number): void {
    createBackup(this.modelsJsonPath, this.id)

    const targetUrl = useProxy
      ? `http://127.0.0.1:${proxyPort}/workbuddy/v1/chat/completions`
      : `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`

    const modelList = provider.models.length > 0 ? provider.models : [provider.defaultModel]
    const payload = {
      models: modelList.map((mId) => ({
        id: mId,
        name: `${provider.name} - ${mId}`,
        vendor: provider.vendor || provider.name,
        apiKey: provider.apiKey,
        maxInputTokens: 200000,
        maxOutputTokens: 16384,
        url: targetUrl,
        supportsToolCall: true,
        supportsImages: true
      })),
      availableModels: modelList
    }

    fs.writeFileSync(this.modelsJsonPath, JSON.stringify(payload, null, 2), 'utf8')
  }

  removeProviderFromConfig(providerId: string): void {
    if (!fs.existsSync(this.modelsJsonPath)) return
    try {
      const raw = fs.readFileSync(this.modelsJsonPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.models)) {
        createBackup(this.modelsJsonPath, this.id)
        parsed.models = parsed.models.filter(
          (m: any) => m.id !== providerId && m.vendor !== providerId
        )
        fs.writeFileSync(this.modelsJsonPath, JSON.stringify(parsed, null, 2), 'utf8')
      }
    } catch {
      // ignore
    }
  }

  syncMcps(mcps: UnifiedMcpServer[]): void {
    createBackup(this.mcpJsonPath, this.id)
    let current: Record<string, any> = { mcpServers: {} }
    if (fs.existsSync(this.mcpJsonPath)) {
      try {
        current = JSON.parse(fs.readFileSync(this.mcpJsonPath, 'utf8'))
        if (!current.mcpServers) current.mcpServers = {}
      } catch {
        current = { mcpServers: {} }
      }
    }

    const enabled = mcps.filter((m) => m.enabledTargets.includes(this.id))
    const nextServers: Record<string, any> = {}
    for (const m of enabled) {
      if (m.type === 'remote' && m.url) {
        nextServers[m.name] = { url: m.url, ...(m.headers ? { headers: m.headers } : {}) }
      } else if (m.command) {
        nextServers[m.name] = {
          command: m.command,
          args: m.args || [],
          ...(m.env && Object.keys(m.env).length > 0 ? { env: m.env } : {})
        }
      }
    }

    current.mcpServers = nextServers
    fs.writeFileSync(this.mcpJsonPath, JSON.stringify(current, null, 2), 'utf8')
  }

  syncSkills(skills: UnifiedSkill[], hubDir: string): void {
    if (!fs.existsSync(this.skillsDir)) {
      try {
        fs.mkdirSync(this.skillsDir, { recursive: true })
      } catch {
        return
      }
    }

    for (const skill of skills) {
      const src = path.join(hubDir, skill.id)
      const dest = path.join(this.skillsDir, skill.id)
      const isEnabled = skill.enabledTargets.includes(this.id)
      const markerPath = path.join(dest, '_ccswitch_synced.json')

      if (isEnabled) {
        if (fs.existsSync(src)) {
          try {
            fs.cpSync(src, dest, { recursive: true, force: true })
            // Tag with synced marker so we know this skill came from the universal hub
            fs.writeFileSync(
              markerPath,
              JSON.stringify({ syncedAt: Date.now(), source: src }, null, 2),
              'utf8'
            )
          } catch {
            // ignore
          }
        }
      } else {
        // Only remove if this was synced from CCSwitch or matches the hub skill id
        if (fs.existsSync(dest) && fs.existsSync(markerPath)) {
          try {
            fs.rmSync(dest, { recursive: true, force: true })
          } catch {
            // ignore
          }
        }
      }
    }
  }
}
