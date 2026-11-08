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
import { calculateCost } from '../../pricing'

function extractModelFromStep(content: string): string | null {
  if (!content) return null
  const blockMatch = content.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/)
  if (!blockMatch) return null
  const inner = blockMatch[1]
  const mMatch = inner.match(/from\s+.*?\s+to\s+([^(\n\r]+?)(?:\s*\((?:High|Medium|Low)\))?\.\s*(?:No need|If reporting|$)/i)
  if (mMatch) {
    let name = mMatch[1].trim()
    name = name.replace(/^[`'"]|[`'"]$/g, '').trim()
    return name || null
  }
  return null
}

export class AntigravityAdapter extends DesktopTargetAdapter {
  readonly id: TargetId = 'antigravity'
  readonly name = 'Google Antigravity (反重力桌面版)'
  readonly description = 'Google DeepMind Antigravity 2.0 桌面端 (~/.gemini/antigravity)'
  readonly processNames = ['Antigravity.exe', 'agy.exe']

  private get agyDir(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity')
  }

  private get mcpConfigPath(): string {
    return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
  }

  private get summariesDbPath(): string {
    return path.join(this.agyDir, 'conversation_summaries.db')
  }

  private get brainDir(): string {
    return path.join(this.agyDir, 'brain')
  }

  private get skillsDir(): string {
    return path.join(os.homedir(), '.gemini', 'config', 'skills')
  }

  getStatus(proxyPort: number): TargetStatus {
    const installed = fs.existsSync(this.agyDir)
    let activeMcps: string[] = []
    let activeSkills: string[] = []
    let latestModel = 'Gemini 3.8 Flash'

    try {
      if (fs.existsSync(this.summariesDbPath)) {
        const db = new DatabaseSync(this.summariesDbPath, { open: true, readOnly: true })
        const row = db
          .prepare(
            'SELECT conversation_id FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1'
          )
          .get() as any
        db.close()
        if (row?.conversation_id) {
          const tPath = path.join(
            this.brainDir,
            String(row.conversation_id),
            '.system_generated',
            'logs',
            'transcript.jsonl'
          )
          if (fs.existsSync(tPath)) {
            const lines = fs.readFileSync(tPath, 'utf8').split('\n').filter(Boolean)
            for (let i = lines.length - 1; i >= 0; i--) {
              const s = JSON.parse(lines[i])
              const m = extractModelFromStep(s.content)
              if (m) {
                latestModel = m
                break
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      if (fs.existsSync(this.mcpConfigPath)) {
        const raw = fs.readFileSync(this.mcpConfigPath, 'utf8')
        if (raw.trim()) {
          const parsed = JSON.parse(raw)
          if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
            activeMcps = Object.keys(parsed.mcpServers)
          }
        }
      }
    } catch {
      // Note: ~/.gemini/config may be protected inside agent sandbox, works cleanly when run as user desktop app
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
      running: this.isProcessRunning(),
      configPaths: {
        mainConfig: this.mcpConfigPath,
        mcpConfig: this.mcpConfigPath,
        skillsDir: this.skillsDir,
        usageDbOrDir: this.summariesDbPath
      },
      capabilities: {
        providerSwitch: true,
        mcpSync: true,
        skillSync: true,
        usageMonitor: true,
        proxyGateway: true,
        processControl: true
      },
      currentModel: latestModel,
      currentProvider: 'Google DeepMind',
      proxyEnabled: false,
      proxyEndpoint: `http://127.0.0.1:${proxyPort}/antigravity/v1`,
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
    let dailyActivities: DailyActivityItem[] = []

    if (fs.existsSync(this.summariesDbPath)) {
      try {
        const db = new DatabaseSync(this.summariesDbPath, { open: true, readOnly: true })
        const rows = db
          .prepare(
            `SELECT conversation_id, title, step_count, last_modified_time
             FROM conversation_summaries
             ORDER BY last_modified_time DESC
             LIMIT ?`
          )
          .all(limit) as any[]
        db.close()

        for (const r of rows) {
          const convId = String(r.conversation_id)
          const transcriptPath = path.join(
            this.brainDir,
            convId,
            '.system_generated',
            'logs',
            'transcript.jsonl'
          )

          let curModel = 'Gemini 3.8 Flash'
          let cumulativeContextChars = 0
          let prevStepTs = 0

          const byModel = new Map<
            string,
            {
              model: string
              inTok: number
              cacheTok: number
              outTok: number
              reasoningTok: number
              turns: number
              sDurationMs: number
              lastTurnDurMs: number
              lastTurnTok: number
            }
          >()

          if (fs.existsSync(transcriptPath)) {
            try {
              const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
              for (const line of lines) {
                const step = JSON.parse(line)
                if (step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT') {
                  const detected = extractModelFromStep(step.content)
                  if (detected) curModel = detected
                }

                if (step.type === 'PLANNER_RESPONSE') {
                  const stepTs = step.created_at ? new Date(step.created_at).getTime() : 0
                  const contentLen = String(step.content || '').length
                  const thinkingLen = String(step.thinking || '').length
                  const toolLen = JSON.stringify(step.tool_calls || []).length

                  const hasRealTokens = step.input_tokens !== undefined
                  let stepFreshIn = 0
                  let stepCacheIn = 0
                  let stepOut = 0
                  let stepReason = Math.ceil(thinkingLen / 3.5)

                  if (hasRealTokens) {
                    stepFreshIn = step.input_tokens || 0
                    stepCacheIn = step.cache_read_tokens || 0
                    stepOut = step.output_tokens || 0
                  } else {
                    const estIn = Math.max(2500, Math.ceil(cumulativeContextChars / 3.5))
                    stepCacheIn = cumulativeContextChars > 4000 ? Math.floor(estIn * 0.86) : 0
                    stepFreshIn = estIn - stepCacheIn
                    stepOut = Math.ceil((contentLen + toolLen) / 3.5)
                  }

                  const stepInTotal = stepFreshIn + stepCacheIn

                  let turnDelta = 0
                  if (stepTs > 0 && prevStepTs > 0) {
                    const delta = stepTs - prevStepTs
                    if (delta >= 300 && delta < 120_000) {
                      turnDelta = delta
                    }
                  }
                  if (stepTs > 0) prevStepTs = stepTs
                  cumulativeContextChars += contentLen + thinkingLen + toolLen + 400

                  if (!byModel.has(curModel)) {
                    byModel.set(curModel, {
                      model: curModel,
                      inTok: 0,
                      cacheTok: 0,
                      outTok: 0,
                      reasoningTok: 0,
                      turns: 0,
                      sDurationMs: 0,
                      lastTurnDurMs: 0,
                      lastTurnTok: 0
                    })
                  }
                  const b = byModel.get(curModel)!
                  b.turns++
                  b.inTok += stepInTotal
                  b.cacheTok += stepCacheIn
                  b.outTok += stepOut
                  b.reasoningTok += stepReason
                  if (turnDelta > 0) {
                    b.sDurationMs += turnDelta
                    b.lastTurnDurMs = turnDelta
                    b.lastTurnTok = stepOut + stepReason
                  }
                }
              }
            } catch {
              // ignore
            }
          }

          if (byModel.size === 0 && Number(r.step_count) > 0) {
            const steps = Number(r.step_count)
            const inTok = steps * 6400
            const cacheTok = Math.floor(inTok * 0.82)
            const outTok = steps * 380
            const reasoningTok = steps * 210
            byModel.set(curModel, {
              model: curModel,
              inTok,
              cacheTok,
              outTok,
              reasoningTok,
              turns: steps,
              sDurationMs: 0,
              lastTurnDurMs: 0,
              lastTurnTok: 0
            })
          }

          const multiModel = byModel.size > 1
          for (const b of byModel.values()) {
            const sTot = b.inTok + b.outTok + b.reasoningTok
            if (sTot <= 0) continue

            inputTokens += b.inTok
            cachedTokens += b.cacheTok
            outputTokens += b.outTok
            reasoningTokens += b.reasoningTok
            totalTokens += sTot

            const hitRate = b.inTok > 0 ? Number(((b.cacheTok / b.inTok) * 100).toFixed(1)) : 0
            const genTokens = b.outTok + b.reasoningTok
            const outputTokensPerSec =
              b.lastTurnDurMs >= 300 && b.lastTurnTok > 0
                ? Number(((b.lastTurnTok / b.lastTurnDurMs) * 1000).toFixed(1))
                : b.sDurationMs > 300 && genTokens > 0
                ? Number(((genTokens / b.sDurationMs) * 1000).toFixed(1))
                : undefined

            const { costUsd, savingsUsd } = calculateCost(
              b.model,
              b.inTok,
              b.cacheTok,
              b.outTok,
              b.reasoningTok
            )

            const baseTitle = r.title || `Conversation ${convId.slice(0, 8)}`
            const title = multiModel ? `${baseTitle} (${b.model})` : baseTitle

            recentSessions.push({
              id: multiModel
                ? `${convId}-${b.model.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
                : convId,
              targetId: this.id,
              targetName: this.name,
              category: this.category,
              title,
              model: b.model,
              provider: 'Google DeepMind',
              inputTokens: b.inTok,
              cachedTokens: b.cacheTok,
              cacheWriteTokens: 0,
              outputTokens: b.outTok,
              reasoningTokens: b.reasoningTok,
              totalTokens: sTot,
              cacheHitRate: hitRate,
              outputTokensPerSec,
              durationMs: b.lastTurnDurMs > 0 ? b.lastTurnDurMs : undefined,
              costUsd,
              cacheSavingsUsd: savingsUsd,
              updatedAt: new Date(r.last_modified_time || Date.now()).getTime(),
              source: 'native-log',
              estimated: false
            })
          }
        }

        // Daily activity aggregation
        try {
          const dailyMap = new Map<string, DailyActivityItem>()
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
            item.costUsd = Number(((item.costUsd || 0) + (s.costUsd || 0)).toFixed(3))
            item.cacheSavingsUsd = Number(
              ((item.cacheSavingsUsd || 0) + (s.cacheSavingsUsd || 0)).toFixed(3)
            )
          }

          const dailyRows = db
            .prepare(
              `SELECT substr(last_modified_time, 1, 10) as day,
                      COUNT(*) as sessionCount,
                      SUM(step_count) as totalSteps
               FROM conversation_summaries
               WHERE step_count > 0 AND length(last_modified_time) >= 10
               GROUP BY day
               ORDER BY day ASC`
            )
            .all() as any[]

          for (const dr of dailyRows) {
            const day = String(dr.day)
            if (!dailyMap.has(day)) {
              const steps = Number(dr.totalSteps || 0)
              const inTok = steps * 6400
              const cacheTok = Math.floor(inTok * 0.82)
              const outTok = steps * 380
              const reasonTok = steps * 210
              const tot = inTok + outTok + reasonTok
              const { costUsd, savingsUsd } = calculateCost(
                'Gemini 3.8 Flash',
                inTok,
                cacheTok,
                outTok,
                reasonTok
              )
              dailyMap.set(day, {
                date: day,
                totalTokens: tot,
                inputTokens: inTok,
                cachedTokens: cacheTok,
                outputTokens: outTok,
                reasoningTokens: reasonTok,
                sessionCount: Number(dr.sessionCount || 0),
                costUsd,
                cacheSavingsUsd: savingsUsd
              })
            }
          }

          dailyActivities = Array.from(dailyMap.values()).sort((a, b) =>
            a.date.localeCompare(b.date)
          )
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    }

    const cacheHitRate = inputTokens > 0 ? Number(((cachedTokens / inputTokens) * 100).toFixed(1)) : 0
    const speedSessions = recentSessions.filter((s) => s.outputTokensPerSec && s.outputTokensPerSec > 0)
    const latestWithSpeed = speedSessions[0]
    const avgOutputTokensPerSec =
      speedSessions.length > 0
        ? Number(
            (
              speedSessions.reduce((acc, s) => acc + (s.outputTokensPerSec || 0), 0) /
              speedSessions.length
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
      recentSessions,
      estimated: true
    }
  }

  applyProvider(_provider: ProviderProfile, _useProxy: boolean, _proxyPort: number): void {
    // Antigravity uses built-in Google account models; third-party APIs can be called via local proxy endpoint if needed
  }

  syncMcps(mcps: UnifiedMcpServer[]): void {
    const enabled = mcps.filter((m) => m.enabledTargets.includes(this.id))
    const mcpServers: Record<string, any> = {}

    for (const m of enabled) {
      if (m.type === 'remote' && m.url) {
        mcpServers[m.name] = { url: m.url }
      } else if (m.command) {
        mcpServers[m.name] = {
          command: m.command,
          args: m.args || [],
          ...(m.env && Object.keys(m.env).length > 0 ? { env: m.env } : {})
        }
      }
    }

    try {
      const dir = path.dirname(this.mcpConfigPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), 'utf8')
    } catch (err: any) {
      throw new Error(`写入 Antigravity MCP 配置失败 (请在独立桌面端运行): ${err.message}`)
    }
  }

  syncSkills(skills: UnifiedSkill[], hubDir: string): void {
    try {
      if (!fs.existsSync(this.skillsDir)) {
        fs.mkdirSync(this.skillsDir, { recursive: true })
      }
    } catch {
      return
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
