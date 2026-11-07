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
      currentModel: 'Gemini 4 Argon',
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

          let estInput = 0
          let estCached = 0
          let estOutput = 0
          let estReasoning = 0
          let sDurationMs = 0
          let lastTurnDurMs = 0
          let lastTurnTok = 0

          if (fs.existsSync(transcriptPath)) {
            try {
              const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
              let cumulativeContextChars = 0
              let prevStepTs = 0
              for (const line of lines) {
                const step = JSON.parse(line)
                const stepTs = step.created_at ? new Date(step.created_at).getTime() : 0
                const contentLen = String(step.content || '').length
                const thinkingLen = String(step.thinking || '').length
                const toolLen = JSON.stringify(step.tool_calls || []).length

                if (step.type === 'PLANNER_RESPONSE') {
                  const stepOut = Math.ceil((contentLen + toolLen) / 3.5)
                  const stepReason = Math.ceil(thinkingLen / 3.5)
                  // Every planner turn re-reads cumulative context (mostly cached after step 1)
                  const stepIn = Math.max(2500, Math.ceil(cumulativeContextChars / 3.5))
                  const stepCache = cumulativeContextChars > 4000 ? Math.floor(stepIn * 0.86) : 0

                  estInput += stepIn
                  estCached += stepCache
                  estOutput += stepOut
                  estReasoning += stepReason

                  if (stepTs > 0 && prevStepTs > 0) {
                    const delta = stepTs - prevStepTs
                    if (delta >= 300 && delta < 120_000) {
                      sDurationMs += delta
                      lastTurnDurMs = delta
                      lastTurnTok = stepOut + stepReason
                    }
                  }
                }
                if (stepTs > 0) prevStepTs = stepTs
                cumulativeContextChars += contentLen + thinkingLen + toolLen + 400
              }
            } catch {
              // fallback to step_count estimation
            }
          }

          if (estInput === 0 && Number(r.step_count) > 0) {
            const steps = Number(r.step_count)
            estInput = steps * 6400
            estCached = Math.floor(estInput * 0.82)
            estOutput = steps * 380
            estReasoning = steps * 210
          }

          const sTotal = estInput + estOutput + estReasoning
          if (sTotal > 0) {
            inputTokens += estInput
            cachedTokens += estCached
            outputTokens += estOutput
            reasoningTokens += estReasoning
            totalTokens += sTotal

            const hitRate = estInput > 0 ? Number(((estCached / estInput) * 100).toFixed(1)) : 0
            const genTokens = estOutput + estReasoning
            const outputTokensPerSec =
              lastTurnDurMs >= 300 && lastTurnTok > 0
                ? Number(((lastTurnTok / lastTurnDurMs) * 1000).toFixed(1))
                : sDurationMs > 300 && genTokens > 0
                ? Number(((genTokens / sDurationMs) * 1000).toFixed(1))
                : undefined

            const { costUsd, savingsUsd } = calculateCost(
              'Gemini 4 Argon',
              estInput,
              estCached,
              estOutput,
              estReasoning
            )

            recentSessions.push({
              id: convId,
              targetId: this.id,
              targetName: this.name,
              category: this.category,
              title: r.title || `Conversation ${convId.slice(0, 8)}`,
              model: 'Gemini 4 Argon',
              provider: 'Google DeepMind',
              inputTokens: estInput,
              cachedTokens: estCached,
              cacheWriteTokens: 0,
              outputTokens: estOutput,
              reasoningTokens: estReasoning,
              totalTokens: sTotal,
              cacheHitRate: hitRate,
              outputTokensPerSec,
              durationMs: lastTurnDurMs > 0 ? lastTurnDurMs : undefined,
              costUsd,
              cacheSavingsUsd: savingsUsd,
              updatedAt: new Date(r.last_modified_time || Date.now()).getTime(),
              source: 'native-log',
              estimated: true
            })
          }
        }

        // Daily activity aggregation
        try {
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

          dailyActivities = dailyRows.map((dr) => {
            const steps = Number(dr.totalSteps || 0)
            const inTok = steps * 6400
            const cacheTok = Math.floor(inTok * 0.82)
            const outTok = steps * 380
            const reasonTok = steps * 210
            const tot = inTok + outTok + reasonTok
            const { costUsd, savingsUsd } = calculateCost(
              'Gemini 4 Argon',
              inTok,
              cacheTok,
              outTok,
              reasonTok
            )
            return {
              date: String(dr.day),
              totalTokens: tot,
              inputTokens: inTok,
              cachedTokens: cacheTok,
              outputTokens: outTok,
              reasoningTokens: reasonTok,
              sessionCount: Number(dr.sessionCount || 0),
              costUsd,
              cacheSavingsUsd: savingsUsd
            }
          })
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
