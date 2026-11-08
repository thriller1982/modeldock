import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { CliTargetAdapter } from '../base'
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

type OpenCodeUsage = Pick<SessionUsageItem, 'model' | 'provider' | 'inputTokens' | 'cachedTokens'
  | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens' | 'durationMs' | 'outputTokensPerSec'>

function readSessionModel(value: unknown): Pick<OpenCodeUsage, 'model' | 'provider'> {
  if (typeof value !== 'string' || !value) return { model: 'unknown', provider: 'opencode' }
  try {
    const data = JSON.parse(value)
    return { model: data?.id || 'unknown', provider: data?.providerID || 'opencode' }
  } catch {
    return { model: value, provider: 'opencode' }
  }
}

export class OpenCodeAdapter extends CliTargetAdapter {
  readonly id: TargetId = 'opencode'
  readonly name = 'OpenCode (CLI 终端助手)'
  readonly description = 'OpenCode 终端编程助手 (~/.config/opencode/opencode.json & opencode.db)'
  readonly binaryName = 'opencode'

  private usageCache = new Map<string, { key: string; items: SessionUsageItem[] }>()

  private get configDir(): string {
    return path.join(os.homedir(), '.config', 'opencode')
  }

  private get configJsonPath(): string {
    return path.join(this.configDir, 'opencode.json')
  }

  private get dbPath(): string {
    return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  }

  private get skillsDir(): string {
    return path.join(this.configDir, 'skills')
  }

  getStatus(proxyPort: number): TargetStatus {
    const installed = fs.existsSync(this.configJsonPath) || fs.existsSync(this.dbPath)
    let currentModel = 'default'
    let currentProvider = 'default'
    let proxyEnabled = false
    let activeMcps: string[] = []
    let activeSkills: string[] = []

    if (fs.existsSync(this.configJsonPath)) {
      try {
        const raw = fs.readFileSync(this.configJsonPath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed.providers && typeof parsed.providers === 'object') {
          const provKeys = Object.keys(parsed.providers)
          if (provKeys.length > 0) {
            const pKey = provKeys[provKeys.length - 1]
            const prov = parsed.providers[pKey]
            currentProvider = prov.name || pKey
            const mKeys = Object.keys(prov.models || {})
            if (mKeys.length > 0) currentModel = mKeys[0]
            if (prov.settings?.baseURL && String(prov.settings.baseURL).includes(`:${proxyPort}`)) {
              proxyEnabled = true
            }
          }
        }
        if (parsed.mcp?.servers && typeof parsed.mcp.servers === 'object') {
          activeMcps = Object.keys(parsed.mcp.servers).filter(
            (k) => !parsed.mcp.servers[k].disabled
          )
        }
      } catch {
        // ignore
      }
    }

    try {
      if (fs.existsSync(this.skillsDir)) {
        activeSkills = fs
          .readdirSync(this.skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      }
    } catch {
      // ignore
    }

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      description: this.description,
      installed,
      configPaths: {
        mainConfig: this.configJsonPath,
        mcpConfig: this.configJsonPath,
        skillsDir: this.skillsDir,
        usageDbOrDir: this.dbPath
      },
      capabilities: {
        providerSwitch: true,
        mcpSync: true,
        skillSync: true,
        usageMonitor: true,
        proxyGateway: true,
        processControl: false
      },
      currentModel,
      currentProvider,
      proxyEnabled,
      proxyEndpoint: `http://127.0.0.1:${proxyPort}/opencode/v1`,
      mcpCount: activeMcps.length,
      activeMcps,
      skillCount: activeSkills.length,
      activeSkills
    }
  }

  getUsageSummary(limit = 30): TargetUsageSummary {
    const items: SessionUsageItem[] = []
    if (!fs.existsSync(this.dbPath)) return summarizeUsage(this, items, limit)

    try {
      const db = new DatabaseSync(this.dbPath, { readOnly: true })
      try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
          .map((row) => row.name))
        const hasV2 = tables.has('session_v2')
        const hasLegacy = tables.has('session')
        const rows = hasV2 ? db.prepare('SELECT * FROM session_v2').all() : []
        if (hasLegacy) {
          const legacy = hasV2 ? ' WHERE id NOT IN (SELECT id FROM session_v2)' : ''
          rows.push(...db.prepare('SELECT * FROM session' + legacy).all())
        }

        const messages = tables.has('session_message')
          ? db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq")
          : undefined
        const legacyMessages = tables.has('message')
          ? db.prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created')
          : undefined
        const activeIds = new Set<string>()

        for (const row of rows) {
          const id = String(row.id)
          activeIds.add(id)
          const key = [
            row.time_updated, row.title, row.model, row.tokens_input, row.tokens_cache_read,
            row.tokens_cache_write, row.tokens_output, row.tokens_reasoning, !!messages, !!legacyMessages
          ].join('\0')
          const hit = this.usageCache.get(id)
          if (hit?.key === key) {
            items.push(...hit.items)
            continue
          }

          const fallback = readSessionModel(row.model)
          const byModel = new Map<string, OpenCodeUsage>()
          const collect = (entries: { data: unknown }[]) => {
            for (const { data } of entries) {
              let message
              try {
                message = JSON.parse(String(data))
              } catch {
                continue
              }
              if (message?.role && message.role !== 'assistant') continue
              const tokens = message?.tokens
              const input = tokenCount(tokens?.input)
              const cached = tokenCount(tokens?.cache?.read ?? tokens?.cache_read)
              const write = tokenCount(tokens?.cache?.write ?? tokens?.cache_write)
              const output = tokenCount(tokens?.output)
              const reasoning = tokenCount(tokens?.reasoning)
              if (input + cached + write + output + reasoning === 0) continue

              const model = String(message.model?.id ?? message.modelID ?? fallback.model)
              const provider = String(message.model?.providerID ?? message.providerID ?? fallback.provider)
              const bucketKey = provider + '/' + model
              let bucket = byModel.get(bucketKey)
              if (!bucket) {
                bucket = {
                  model, provider, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
                  outputTokens: 0, reasoningTokens: 0
                }
                byModel.set(bucketKey, bucket)
              }
              bucket.inputTokens += input + cached + write
              bucket.cachedTokens += cached
              bucket.cacheWriteTokens += write
              bucket.outputTokens += output
              bucket.reasoningTokens += reasoning
              const start = Number(message.time?.created)
              const duration = Number(message.time?.streamed ?? message.time?.completed) - start
              if (start > 0 && duration >= 200 && duration < 600_000 && output > 0) {
                bucket.durationMs = duration
                bucket.outputTokensPerSec = Number(((output / duration) * 1000).toFixed(1))
              }
            }
          }
          if (messages) collect(messages.all(id) as { data: unknown }[])
          if (byModel.size === 0 && legacyMessages) collect(legacyMessages.all(id) as { data: unknown }[])
          if (byModel.size === 0) {
            const cachedTokens = tokenCount(row.tokens_cache_read)
            const cacheWriteTokens = tokenCount(row.tokens_cache_write)
            byModel.set(id, {
              ...fallback,
              inputTokens: tokenCount(row.tokens_input) + cachedTokens + cacheWriteTokens,
              cachedTokens,
              cacheWriteTokens,
              outputTokens: tokenCount(row.tokens_output),
              reasoningTokens: tokenCount(row.tokens_reasoning)
            })
          }

          const sessionItems: SessionUsageItem[] = []
          for (const usage of byModel.values()) {
            const totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens
            if (totalTokens <= 0) continue
            const { costUsd, savingsUsd } = calculateCost(
              usage.model, usage.inputTokens, usage.cachedTokens, usage.outputTokens,
              usage.reasoningTokens, usage.cacheWriteTokens
            )
            const title = String(row.title || 'OpenCode Session')
            sessionItems.push({
              ...usage,
              id: byModel.size > 1 ? id + '_' + usage.provider + '/' + usage.model : id,
              sessionId: id,
              targetId: this.id,
              targetName: this.name,
              category: this.category,
              title: byModel.size > 1 ? title + ' (' + usage.model + ')' : title,
              totalTokens,
              cacheHitRate: cacheHitRate(usage.inputTokens, usage.cachedTokens),
              costUsd,
              cacheSavingsUsd: savingsUsd,
              updatedAt: Number(row.time_updated || row.time_created),
              source: 'native-log'
            })
          }
          this.usageCache.set(id, { key, items: sessionItems })
          items.push(...sessionItems)
        }
        for (const id of this.usageCache.keys()) {
          if (!activeIds.has(id)) this.usageCache.delete(id)
        }
      } finally {
        db.close()
      }
    } catch {
      // The client database can be temporarily unavailable.
    }
    return summarizeUsage(this, items, limit)
  }

  applyProvider(provider: ProviderProfile, useProxy: boolean, proxyPort: number): void {
    if (!fs.existsSync(this.configJsonPath)) return
    createBackup(this.configJsonPath, this.id)

    const raw = fs.readFileSync(this.configJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed.providers || typeof parsed.providers !== 'object') {
      parsed.providers = {}
    }

    const baseURL = useProxy ? `http://127.0.0.1:${proxyPort}/opencode/v1` : provider.baseUrl
    const modelMap: Record<string, any> = {}
    const models = provider.models.length > 0 ? provider.models : [provider.defaultModel]

    for (const m of models) {
      modelMap[m] = parsed.providers[provider.id]?.models?.[m] || {
        name: m,
        limit: { context: 200000, output: 32768 },
        capabilities: {
          tools: true,
          input: ['text', 'image'],
          output: ['text'],
          reasoning: { supported: true, toggle: true }
        }
      }
    }

    parsed.providers[provider.id] = {
      ...(parsed.providers[provider.id] || {}),
      name: useProxy ? `${provider.name} (Proxy)` : provider.name,
      package: '@opencode/ai/providers/openai-compatible',
      settings: {
        apiKey: provider.apiKey,
        baseURL
      },
      compatibility: {
        supportsPromptCacheKey: true
      },
      models: modelMap
    }

    fs.writeFileSync(this.configJsonPath, JSON.stringify(parsed, null, 2), 'utf8')
  }

  removeProviderFromConfig(providerId: string): void {
    if (!fs.existsSync(this.configJsonPath)) return
    try {
      const raw = fs.readFileSync(this.configJsonPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed.providers && parsed.providers[providerId]) {
        createBackup(this.configJsonPath, this.id)
        delete parsed.providers[providerId]
        fs.writeFileSync(this.configJsonPath, JSON.stringify(parsed, null, 2), 'utf8')
      }
    } catch {
      // ignore
    }
  }

  syncMcps(mcps: UnifiedMcpServer[]): void {
    if (!fs.existsSync(this.configJsonPath)) return
    createBackup(this.configJsonPath, this.id)

    const raw = fs.readFileSync(this.configJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed.mcp) parsed.mcp = {}
    if (!parsed.mcp.servers) parsed.mcp.servers = {}

    const enabled = mcps.filter((m) => m.enabledTargets.includes(this.id))
    const nextServers: Record<string, any> = {}

    for (const m of enabled) {
      if (m.type === 'remote' && m.url) {
        nextServers[m.name] = {
          type: 'remote',
          url: m.url,
          disabled: false,
          ...(m.headers ? { headers: m.headers } : {}),
          timeout: { startup: 15000, catalog: 15000, execution: 15000 }
        }
      } else if (m.command) {
        nextServers[m.name] = {
          type: 'local',
          command: [m.command, ...(m.args || [])],
          disabled: false,
          ...(m.env && Object.keys(m.env).length > 0 ? { environment: m.env } : {}),
          timeout: { startup: 60000, catalog: 60000, execution: 60000 }
        }
      }
    }

    parsed.mcp.servers = nextServers
    fs.writeFileSync(this.configJsonPath, JSON.stringify(parsed, null, 2), 'utf8')
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

      if (isEnabled) {
        if (fs.existsSync(src)) {
          try {
            fs.cpSync(src, dest, { recursive: true, force: true })
          } catch {
            // ignore
          }
        }
      } else {
        if (fs.existsSync(dest)) {
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
