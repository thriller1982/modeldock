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

export class OpenCodeAdapter extends CliTargetAdapter {
  readonly id: TargetId = 'opencode'
  readonly name = 'OpenCode (CLI 终端助手)'
  readonly description = 'OpenCode 终端编程助手 (~/.config/opencode/opencode.json & opencode.db)'
  readonly binaryName = 'opencode'

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
    const recentSessions: SessionUsageItem[] = []
    let inputTokens = 0
    let cachedTokens = 0
    let cacheWriteTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let totalTokens = 0

    if (fs.existsSync(this.dbPath)) {
      try {
        const db = new DatabaseSync(this.dbPath, { open: true, readOnly: true })
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
        const hasV2 = tables.some((t) => t.name === 'session_v2')
        const sql = hasV2
          ? `SELECT id, title, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated
             FROM session_v2
             WHERE (tokens_input > 0 OR tokens_cache_read > 0 OR tokens_output > 0)
             UNION ALL
             SELECT id, title, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated
             FROM session
             WHERE id NOT IN (SELECT id FROM session_v2)
               AND (tokens_input > 0 OR tokens_cache_read > 0 OR tokens_output > 0)
             ORDER BY time_updated DESC
             LIMIT ?`
          : `SELECT id, title, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated
             FROM session
             WHERE (tokens_input > 0 OR tokens_cache_read > 0 OR tokens_output > 0)
             ORDER BY time_updated DESC
             LIMIT ?`
        const rows = db.prepare(sql).all(limit) as any[]

        // Pre-prepare speed lookup statement from session_message / message
        const hasSessionMsg = tables.some((t) => t.name === 'session_message')
        const msgStmt = hasSessionMsg
          ? db.prepare(
              `SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq ASC`
            )
          : db.prepare(`SELECT 'assistant' as type, data FROM message WHERE session_id = ?`)

        for (const r of rows) {
          let modelId = 'opencode'
          let providerId = 'opencode'
          if (r.model) {
            try {
              const mObj = JSON.parse(r.model)
              modelId = mObj.id || modelId
              providerId = mObj.providerID || providerId
            } catch {
              modelId = String(r.model)
            }
          }

          const freshIn = Number(r.tokens_input || 0)
          const cacheRead = Number(r.tokens_cache_read || 0)
          const cacheWrite = Number(r.tokens_cache_write || 0)
          // Total input context = fresh input + cache read + cache write
          const sInputTotal = freshIn + cacheRead + cacheWrite
          const sOutput = Number(r.tokens_output || 0)
          const sReasoning = Number(r.tokens_reasoning || 0)
          const sTotal = sInputTotal + sOutput + sReasoning

          // Calculate active generation duration & tok/s from assistant messages
          let durationMs = 0
          let measuredTokens = 0
          let lastTurnDurMs = 0
          let lastTurnTokens = 0
          try {
            const msgRows = msgStmt.all(r.id) as { type: string; data: string }[]
            let curTurnDur = 0
            let curTurnTok = 0
            for (const m of msgRows) {
              if (m.type === 'user') {
                if (curTurnDur > 0 && curTurnTok > 0) {
                  lastTurnDurMs = curTurnDur
                  lastTurnTokens = curTurnTok
                }
                curTurnDur = 0
                curTurnTok = 0
                continue
              }
              const d = JSON.parse(m.data)
              if (d.role && d.role !== 'assistant') continue
              const start = Number(d.time?.created || 0)
              // Prefer d.time.streamed so tool execution wait time after token streaming is excluded
              const end = Number(d.time?.streamed || d.time?.completed || 0)
              const msgTok =
                Number(d.tokens?.output || 0) + Number(d.tokens?.reasoning || 0)
              if (start > 0 && end > start && end - start < 600_000) {
                const delta = end - start
                durationMs += delta
                curTurnDur += delta
                if (msgTok > 0) {
                  measuredTokens += msgTok
                  curTurnTok += msgTok
                }
              }
            }
            if (curTurnDur > 0 && curTurnTok > 0) {
              lastTurnDurMs = curTurnDur
              lastTurnTokens = curTurnTok
            }
          } catch {
            // ignore
          }

          const displayDurMs = lastTurnDurMs > 0 ? lastTurnDurMs : durationMs
          const displayTokens =
            lastTurnTokens > 0
              ? lastTurnTokens
              : measuredTokens > 0
              ? measuredTokens
              : sOutput + sReasoning
          const outputTokensPerSec =
            displayDurMs > 200 && displayTokens > 0
              ? Number(((displayTokens / displayDurMs) * 1000).toFixed(1))
              : undefined

          inputTokens += sInputTotal
          cachedTokens += cacheRead
          cacheWriteTokens += cacheWrite
          outputTokens += sOutput
          reasoningTokens += sReasoning
          totalTokens += sTotal

          const hitRate =
            sInputTotal > 0 ? Number(((cacheRead / sInputTotal) * 100).toFixed(1)) : 0

          recentSessions.push({
            id: r.id,
            targetId: this.id,
            targetName: this.name,
            category: this.category,
            title: r.title || 'OpenCode Session',
            model: modelId,
            provider: providerId,
            inputTokens: sInputTotal,
            cachedTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            outputTokens: sOutput,
            reasoningTokens: sReasoning,
            totalTokens: sTotal,
            cacheHitRate: hitRate,
            outputTokensPerSec,
            durationMs: displayDurMs > 0 ? displayDurMs : undefined,
            updatedAt: Number(r.time_updated || Date.now()),
            source: 'native-log'
          })
        }
        db.close()
      } catch {
        // ignore
      }
    }

    const cacheHitRate = inputTokens > 0 ? Number(((cachedTokens / inputTokens) * 100).toFixed(1)) : 0
    const withSpeed = recentSessions.filter((s) => s.outputTokensPerSec && s.outputTokensPerSec > 0)
    const latestWithSpeed = withSpeed[0]
    const avgOutputTokensPerSec =
      withSpeed.length > 0
        ? Number(
            (
              withSpeed.reduce((acc, s) => acc + (s.outputTokensPerSec || 0), 0) / withSpeed.length
            ).toFixed(1)
          )
        : undefined

    return {
      targetId: this.id,
      targetName: this.name,
      category: this.category,
      sessionCount: recentSessions.length,
      inputTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      cacheHitRate,
      latestOutputTokensPerSec: latestWithSpeed?.outputTokensPerSec,
      latestDurationMs: latestWithSpeed?.durationMs,
      avgOutputTokensPerSec,
      recentSessions
    }
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
