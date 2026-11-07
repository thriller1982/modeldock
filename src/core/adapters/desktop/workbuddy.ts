import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { DesktopTargetAdapter } from '../base'
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

export class WorkBuddyAdapter extends DesktopTargetAdapter {
  readonly id: TargetId = 'workbuddy'
  readonly name = 'WorkBuddy (腾讯桌面端)'
  readonly description = '腾讯 WorkBuddy / CodeBuddy 桌面端助手 (~/.workbuddy)'
  readonly processNames = ['WorkBuddy.exe', 'CodeBuddy.exe']

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
    const recentSessions: SessionUsageItem[] = []
    let inputTokens = 0
    let cachedTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let totalTokens = 0

    // Read real session titles from ~/.workbuddy/workbuddy.db if available
    const titleMap = new Map<string, string>()
    const wbDbPath = path.join(this.wbDir, 'workbuddy.db')
    if (fs.existsSync(wbDbPath)) {
      try {
        const db = new DatabaseSync(wbDbPath, { open: true, readOnly: true })
        const rows = db
          .prepare(`SELECT id, title, custom_title FROM sessions`)
          .all() as { id: string; title?: string; custom_title?: string }[]
        db.close()
        for (const r of rows) {
          const t = (r.custom_title || r.title || '').trim()
          if (t) titleMap.set(r.id, t)
        }
      } catch {
        // ignore
      }
    }

    if (fs.existsSync(this.projectsDir)) {
      try {
        const projFolders = fs.readdirSync(this.projectsDir)
        const jsonlFiles: { filePath: string; mtimeMs: number; projName: string }[] = []

        for (const folder of projFolders) {
          const pPath = path.join(this.projectsDir, folder)
          if (!fs.statSync(pPath).isDirectory()) continue
          const files = fs.readdirSync(pPath)
          for (const f of files) {
            if (f.endsWith('.jsonl') && !f.endsWith('.ndjson')) {
              const full = path.join(pPath, f)
              const st = fs.statSync(full)
              jsonlFiles.push({ filePath: full, mtimeMs: st.mtimeMs, projName: folder })
            }
          }
        }

        jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

        for (const item of jsonlFiles.slice(0, limit)) {
          try {
            const sid = path.basename(item.filePath, '.jsonl')
            let sTitle = titleMap.get(sid) || item.projName
            const lines = fs.readFileSync(item.filePath, 'utf8').split('\n').filter(Boolean)

            // Group by model within the session so multi-model sessions (e.g. hy4-free + deepseek-v4.1-flash + kimi-k3.1-pro)
            // surface every model's usage and speed instead of overwriting earlier models
            const byModel = new Map<
              string,
              {
                sInput: number
                sCached: number
                sOutput: number
                sReasoning: number
                sTotal: number
                sDurationMs: number
                genTokSum: number
                lastTurnDurMs: number
                lastTurnTok: number
                updatedAt: number
              }
            >()

            let reqStartTs = 0

            for (const line of lines) {
              const obj = JSON.parse(line)
              const lineTs = Number(obj.timestamp || 0)
              if (obj.type === 'ai-title' && obj.title && !titleMap.has(sid)) {
                sTitle = obj.title
              } else if (obj.type === 'message' && obj.role === 'user') {
                if (lineTs > 0) reqStartTs = lineTs
                if (sTitle === item.projName && !titleMap.has(sid)) {
                  const rawTxt = Array.isArray(obj.content)
                    ? obj.content.map((c: any) => c.text || '').join(' ')
                    : String(obj.content || '')
                  const cleaned = rawTxt
                    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
                    .replace(/<[^>]+>/g, '')
                    .trim()
                  if (cleaned) sTitle = cleaned.slice(0, 40)
                }
              } else if (obj.type === 'function_call_result' && lineTs > 0) {
                reqStartTs = lineTs
              }

              const rawUsage = obj.providerData?.rawUsage
              if (rawUsage) {
                const modelName = String(obj.providerData?.model || obj.model || 'hy4-free')
                let bucket = byModel.get(modelName)
                if (!bucket) {
                  bucket = {
                    sInput: 0,
                    sCached: 0,
                    sOutput: 0,
                    sReasoning: 0,
                    sTotal: 0,
                    sDurationMs: 0,
                    genTokSum: 0,
                    lastTurnDurMs: 0,
                    lastTurnTok: 0,
                    updatedAt: lineTs || item.mtimeMs
                  }
                  byModel.set(modelName, bucket)
                }

                const pTokens = Number(rawUsage.prompt_tokens || 0)
                // In WorkBuddy rawUsage, completion_tokens ALREADY includes reasoning_tokens
                const cTokens = Number(rawUsage.completion_tokens || 0)
                const hitTokens = Number(
                  rawUsage.prompt_tokens_details?.cached_tokens ??
                    rawUsage.prompt_cache_hit_tokens ??
                    0
                )
                const rTokens = Number(rawUsage.completion_tokens_details?.reasoning_tokens || 0)

                bucket.sInput += pTokens
                bucket.sCached += hitTokens
                bucket.sOutput += cTokens
                bucket.sReasoning += rTokens
                bucket.sTotal += Number(rawUsage.total_tokens || pTokens + cTokens)

                if (lineTs > 0) {
                  bucket.updatedAt = lineTs
                  if (reqStartTs > 0 && lineTs > reqStartTs) {
                    const dur = lineTs - reqStartTs
                    if (dur >= 300 && dur < 120_000 && cTokens > 0) {
                      bucket.sDurationMs += dur
                      bucket.genTokSum += cTokens
                      bucket.lastTurnDurMs = dur
                      bucket.lastTurnTok = cTokens
                    }
                  }
                  reqStartTs = lineTs
                }
              }
            }

            const multiModel = byModel.size > 1
            for (const [modelName, b] of byModel.entries()) {
              if (b.sTotal <= 0) continue
              inputTokens += b.sInput
              cachedTokens += b.sCached
              outputTokens += b.sOutput
              reasoningTokens += b.sReasoning
              totalTokens += b.sTotal

              const hitRate =
                b.sInput > 0 ? Number(((b.sCached / b.sInput) * 100).toFixed(1)) : 0
              const outputTokensPerSec =
                b.lastTurnDurMs >= 300 && b.lastTurnTok > 0
                  ? Number(((b.lastTurnTok / b.lastTurnDurMs) * 1000).toFixed(1))
                  : b.sDurationMs > 300 && b.genTokSum > 0
                  ? Number(((b.genTokSum / b.sDurationMs) * 1000).toFixed(1))
                  : undefined

              const { costUsd, savingsUsd } = calculateCost(
                modelName,
                b.sInput,
                b.sCached,
                b.sOutput,
                b.sReasoning
              )

              recentSessions.push({
                id: multiModel ? `${sid}_${modelName}` : sid,
                targetId: this.id,
                targetName: this.name,
                category: this.category,
                title: sTitle,
                model: modelName,
                provider: 'WorkBuddy',
                inputTokens: b.sInput,
                cachedTokens: b.sCached,
                cacheWriteTokens: 0,
                outputTokens: b.sOutput,
                reasoningTokens: b.sReasoning,
                totalTokens: b.sTotal,
                cacheHitRate: hitRate,
                outputTokensPerSec,
                durationMs: b.lastTurnDurMs > 0 ? b.lastTurnDurMs : undefined,
                costUsd,
                cacheSavingsUsd: savingsUsd,
                updatedAt: b.updatedAt,
                source: 'native-log'
              })
            }
          } catch {
            // skip malformed file
          }
        }
      } catch {
        // ignore
      }
    }

    recentSessions.sort((a, b) => b.updatedAt - a.updatedAt)

    // Daily activity aggregation from workbuddy.db
    let dailyActivities: DailyActivityItem[] = []
    if (fs.existsSync(wbDbPath)) {
      try {
        const db = new DatabaseSync(wbDbPath, { open: true, readOnly: true })
        const dailyRows = db
          .prepare(
            `SELECT strftime('%Y-%m-%d', datetime(updated_at / 1000, 'unixepoch', 'localtime')) as day,
                    COUNT(*) as sessionCount,
                    SUM(used) as totalTokens
             FROM session_usage
             WHERE used > 0
             GROUP BY day
             ORDER BY day ASC`
          )
          .all() as any[]
        db.close()

        dailyActivities = dailyRows.map((dr) => {
          const tot = Number(dr.totalTokens || 0)
          const inTok = Math.round(tot * 0.9)
          const cacheTok = Math.round(inTok * 0.8)
          const outTok = Math.round(tot * 0.1)
          const { costUsd, savingsUsd } = calculateCost('hy4-free', inTok, cacheTok, outTok, 0)
          return {
            date: String(dr.day),
            totalTokens: tot,
            inputTokens: inTok,
            cachedTokens: cacheTok,
            outputTokens: outTok,
            reasoningTokens: 0,
            sessionCount: Number(dr.sessionCount || 0),
            costUsd,
            cacheSavingsUsd: savingsUsd
          }
        })
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
      cacheWriteTokens: 0,
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
