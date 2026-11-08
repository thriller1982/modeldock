import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { CliTargetAdapter } from '../base'
import {
  DailyActivityItem,
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
    let dailyActivities: DailyActivityItem[] = []

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

          const byModel = new Map<
            string,
            {
              modelId: string
              providerId: string
              freshIn: number
              cacheRead: number
              cacheWrite: number
              sOutput: number
              sReasoning: number
              sTotal: number
              durationMs: number
              lastTurnDurMs: number
              lastTurnTokens: number
              measuredTokens: number
              count: number
            }
          >()

          try {
            const msgRows = msgStmt.all(r.id) as { type: string; data: string }[]
            for (const m of msgRows) {
              if (m.type === 'assistant') {
                const d = JSON.parse(m.data)
                if (d.role && d.role !== 'assistant') continue
                const curModel = d.model?.id || d.modelID || modelId
                const curProvider = d.model?.providerID || providerId

                let b = byModel.get(curModel)
                if (!b) {
                  b = {
                    modelId: curModel,
                    providerId: curProvider,
                    freshIn: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    sOutput: 0,
                    sReasoning: 0,
                    sTotal: 0,
                    durationMs: 0,
                    lastTurnDurMs: 0,
                    lastTurnTokens: 0,
                    measuredTokens: 0,
                    count: 0
                  }
                  byModel.set(curModel, b)
                }

                b.count++
                const inTok = Number(d.tokens?.input || 0)
                const cRead = Number(d.tokens?.cache?.read ?? d.tokens?.cache_read ?? 0)
                const cWrite = Number(d.tokens?.cache?.write ?? d.tokens?.cache_write ?? 0)
                const outTok = Number(d.tokens?.output || 0)
                const reasonTok = Number(d.tokens?.reasoning || 0)

                b.freshIn += inTok
                b.cacheRead += cRead
                b.cacheWrite += cWrite
                b.sOutput += outTok
                b.sReasoning += reasonTok
                b.sTotal += inTok + cRead + cWrite + outTok + reasonTok

                const start = Number(d.time?.created || 0)
                const end = Number(d.time?.streamed || d.time?.completed || 0)
                const msgTok = outTok + reasonTok
                if (start > 0 && end > start && end - start < 600_000) {
                  const delta = end - start
                  b.durationMs += delta
                  if (msgTok > 0) {
                    b.measuredTokens += msgTok
                    b.lastTurnDurMs = delta
                    b.lastTurnTokens = msgTok
                  }
                }
              }
            }
          } catch {
            // ignore
          }

          if (byModel.size === 0) {
            const freshIn = Number(r.tokens_input || 0)
            const cacheRead = Number(r.tokens_cache_read || 0)
            const cacheWrite = Number(r.tokens_cache_write || 0)
            const sInputTotal = freshIn + cacheRead + cacheWrite
            const sOutput = Number(r.tokens_output || 0)
            const sReasoning = Number(r.tokens_reasoning || 0)
            const sTotal = sInputTotal + sOutput + sReasoning

            inputTokens += sInputTotal
            cachedTokens += cacheRead
            cacheWriteTokens += cacheWrite
            outputTokens += sOutput
            reasoningTokens += sReasoning
            totalTokens += sTotal

            const hitRate =
              sInputTotal > 0 ? Number(((cacheRead / sInputTotal) * 100).toFixed(1)) : 0
            const { costUsd, savingsUsd } = calculateCost(
              modelId,
              sInputTotal,
              cacheRead,
              sOutput,
              sReasoning
            )

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
              outputTokensPerSec: undefined,
              durationMs: undefined,
              costUsd,
              cacheSavingsUsd: savingsUsd,
              updatedAt: Number(r.time_updated || Date.now()),
              source: 'native-log'
            })
          } else {
            const multiModel = byModel.size > 1
            for (const b of byModel.values()) {
              const sInputTotal = b.freshIn + b.cacheRead + b.cacheWrite
              const sTotal = sInputTotal + b.sOutput + b.sReasoning
              if (sTotal <= 0) continue

              inputTokens += sInputTotal
              cachedTokens += b.cacheRead
              cacheWriteTokens += b.cacheWrite
              outputTokens += b.sOutput
              reasoningTokens += b.sReasoning
              totalTokens += sTotal

              const hitRate =
                sInputTotal > 0 ? Number(((b.cacheRead / sInputTotal) * 100).toFixed(1)) : 0
              const outputTokensPerSec =
                b.lastTurnDurMs > 200 && b.lastTurnTokens > 0
                  ? Number(((b.lastTurnTokens / b.lastTurnDurMs) * 1000).toFixed(1))
                  : b.durationMs > 200 && b.measuredTokens > 0
                  ? Number(((b.measuredTokens / b.durationMs) * 1000).toFixed(1))
                  : undefined

              const { costUsd, savingsUsd } = calculateCost(
                b.modelId,
                sInputTotal,
                b.cacheRead,
                b.sOutput,
                b.sReasoning
              )

              const baseTitle = r.title || 'OpenCode Session'
              const title = multiModel ? `${baseTitle} (${b.modelId})` : baseTitle

              recentSessions.push({
                id: multiModel ? `${r.id}_${b.modelId}` : r.id,
                targetId: this.id,
                targetName: this.name,
                category: this.category,
                title,
                model: b.modelId,
                provider: b.providerId,
                inputTokens: sInputTotal,
                cachedTokens: b.cacheRead,
                cacheWriteTokens: b.cacheWrite,
                outputTokens: b.sOutput,
                reasoningTokens: b.sReasoning,
                totalTokens: sTotal,
                cacheHitRate: hitRate,
                outputTokensPerSec,
                durationMs: b.lastTurnDurMs > 0 ? b.lastTurnDurMs : b.durationMs || undefined,
                costUsd,
                cacheSavingsUsd: savingsUsd,
                updatedAt: Number(r.time_updated || Date.now()),
                source: 'native-log'
              })
            }
          }
        }

        // Daily activity aggregation from real session database
        try {
          const dailyMap = new Map<string, DailyActivityItem>()

          // 1. Group recentSessions by date
          for (const s of recentSessions) {
            const dateStr = new Date(s.updatedAt).toISOString().slice(0, 10)
            if (!dailyMap.has(dateStr)) {
              dailyMap.set(dateStr, {
                date: dateStr,
                totalTokens: 0,
                inputTokens: 0,
                cachedTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                sessionCount: 0,
                costUsd: 0,
                cacheSavingsUsd: 0
              })
            }
            const item = dailyMap.get(dateStr)!
            item.totalTokens += s.totalTokens
            item.inputTokens += s.inputTokens
            item.cachedTokens += s.cachedTokens
            item.outputTokens += s.outputTokens
            item.reasoningTokens += s.reasoningTokens
            item.sessionCount += 1
            item.costUsd = Number(((item.costUsd || 0) + (s.costUsd || 0)).toFixed(4))
            item.cacheSavingsUsd = Number(
              ((item.cacheSavingsUsd || 0) + (s.cacheSavingsUsd || 0)).toFixed(4)
            )
          }

          // 2. Aggregate all historical days with actual models from session table
          const dailyRows = db
            .prepare(
              `SELECT strftime('%Y-%m-%d', datetime(time_created / 1000, 'unixepoch', 'localtime')) as day,
                      model,
                      COUNT(*) as sessionCount,
                      SUM(tokens_input) as inTok,
                      SUM(tokens_cache_read) as cacheTok,
                      SUM(tokens_output) as outTok,
                      SUM(tokens_reasoning) as reasonTok
               FROM session
               WHERE (tokens_input > 0 OR tokens_cache_read > 0 OR tokens_output > 0)
               GROUP BY day, model
               ORDER BY day ASC`
            )
            .all() as any[]

          for (const dr of dailyRows) {
            const day = String(dr.day)
            if (!dailyMap.has(day)) {
              dailyMap.set(day, {
                date: day,
                totalTokens: 0,
                inputTokens: 0,
                cachedTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                sessionCount: 0,
                costUsd: 0,
                cacheSavingsUsd: 0
              })
            }

            let mId = 'deepseek-v4.1-flash'
            if (dr.model) {
              try {
                const mObj = JSON.parse(dr.model)
                mId = mObj.id || mId
              } catch {
                mId = String(dr.model)
              }
            }

            const rawIn = Number(dr.inTok || 0)
            const cRead = Number(dr.cacheTok || 0)
            const inTotal = rawIn + cRead
            const outTok = Number(dr.outTok || 0)
            const reasonTok = Number(dr.reasonTok || 0)
            const tot = inTotal + outTok + reasonTok

            const { costUsd, savingsUsd } = calculateCost(
              mId,
              inTotal,
              cRead,
              outTok,
              reasonTok
            )

            const dayItem = dailyMap.get(day)!
            dayItem.sessionCount += Number(dr.sessionCount || 0)
            // If this day was not already populated by recent sessions, add its tokens
            if (!recentSessions.some((s) => new Date(s.updatedAt).toISOString().slice(0, 10) === day)) {
              dayItem.totalTokens += tot
              dayItem.inputTokens += inTotal
              dayItem.cachedTokens += cRead
              dayItem.outputTokens += outTok
              dayItem.reasoningTokens += reasonTok
              dayItem.costUsd = Number(((dayItem.costUsd || 0) + costUsd).toFixed(4))
              dayItem.cacheSavingsUsd = Number(((dayItem.cacheSavingsUsd || 0) + savingsUsd).toFixed(4))
            }
          }

          dailyActivities = Array.from(dailyMap.values()).sort((a, b) =>
            a.date.localeCompare(b.date)
          )
        } catch {
          // ignore
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

    const totalCostUsd = Number(
      recentSessions.reduce((acc, s) => acc + (s.costUsd || 0), 0).toFixed(2)
    )
    const totalCacheSavingsUsd = Number(
      recentSessions.reduce((acc, s) => acc + (s.cacheSavingsUsd || 0), 0).toFixed(2)
    )

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
      totalCostUsd,
      totalCacheSavingsUsd,
      dailyActivities,
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
