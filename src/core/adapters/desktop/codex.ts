import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { parse, stringify } from 'smol-toml'
import { DesktopTargetAdapter } from '../base'
import { FileParseCache } from '../file-cache'
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

export interface CodexModelTurnUsage {
  model: string
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  outputTokensPerSec?: number
  durationMs?: number
}

export class CodexDesktopAdapter extends DesktopTargetAdapter {
  readonly id: TargetId = 'codex-desktop'
  readonly name = 'Codex 桌面版 (ChatGPT App)'
  readonly description = 'OpenAI Codex Desktop / ChatGPT 桌面端环境 (~/.codex)'
  readonly processNames = ['Codex.exe', 'ChatGPT.exe', 'codex-computer-use.exe']
  private rolloutCache = new FileParseCache<CodexModelTurnUsage[] | null>()

  private get codexDir(): string {
    return path.join(os.homedir(), '.codex')
  }

  private get configTomlPath(): string {
    return path.join(this.codexDir, 'config.toml')
  }

  private get stateSqlitePath(): string {
    return path.join(this.codexDir, 'state_5.sqlite')
  }

  private get skillsDir(): string {
    return path.join(this.codexDir, 'skills')
  }

  getStatus(proxyPort: number): TargetStatus {
    const installed = fs.existsSync(this.codexDir)
    let currentModel = 'gpt-4o'
    let currentProvider = 'openai'
    let proxyEnabled = false
    let activeMcps: string[] = []
    let activeSkills: string[] = []

    if (fs.existsSync(this.configTomlPath)) {
      try {
        const raw = fs.readFileSync(this.configTomlPath, 'utf8')
        const parsed = parse(raw) as Record<string, any>
        currentModel = String(parsed.model || 'default')
        currentProvider = String(parsed.model_provider || 'openai')
        if (parsed.mcp_servers && typeof parsed.mcp_servers === 'object') {
          activeMcps = Object.keys(parsed.mcp_servers)
        }
        const provSection = parsed.model_providers?.[currentProvider]
        if (provSection?.base_url && String(provSection.base_url).includes(`:${proxyPort}`)) {
          proxyEnabled = true
        }
      } catch {
        // ignore parse error
      }
    }

    if (fs.existsSync(this.skillsDir)) {
      try {
        activeSkills = fs
          .readdirSync(this.skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== '.system')
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
        mainConfig: this.configTomlPath,
        mcpConfig: this.configTomlPath,
        skillsDir: this.skillsDir,
        usageDbOrDir: this.stateSqlitePath
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
      proxyEndpoint: `http://127.0.0.1:${proxyPort}/codex/v1`,
      mcpCount: activeMcps.length,
      activeMcps,
      skillCount: activeSkills.length,
      activeSkills
    }
  }

  private parseRolloutJsonlUsage(
    rolloutPath: string,
    fallbackModel = 'gpt-6.1-sol'
  ): CodexModelTurnUsage[] | null {
    try {
      const cleanPath = rolloutPath.replace(/^\\\\\?\\/, '')
      return this.rolloutCache.get(cleanPath, (content) => {
        const lines = content.split('\n')
        const byModel = new Map<
          string,
          {
            model: string
            inputTokens: number
            cachedTokens: number
            cacheWriteTokens: number
            outputTokens: number
            reasoningTokens: number
            totalTokens: number
            activeGenMs: number
            genOutputSum: number
            lastTurnDurMs: number
            lastTurnTok: number
          }
        >()

        let currentModel = fallbackModel
        let reqStartTs = 0

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const obj = JSON.parse(line)
            const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
            const pType = obj.payload?.type
            const pRole = obj.payload?.role

            if (obj.payload?.thread_settings?.model) {
              currentModel = String(obj.payload.thread_settings.model)
            } else if (obj.payload?.model) {
              currentModel = String(obj.payload.model)
            }

            // LLM generation starts right after user message or tool output is appended
            if (
              ts > 0 &&
              ((obj.type === 'response_item' &&
                (pRole === 'user' ||
                  pType === 'function_call_output' ||
                  pType === 'custom_tool_call_output')) ||
                (obj.type === 'event_msg' && pType === 'task_started'))
            ) {
              reqStartTs = ts
            } else if (obj.type === 'token_usage_record' && obj.payload?.usage) {
              const u = obj.payload.usage
              const stepOut = Number(u.output_tokens || 0)
              let dur = 0
              if (reqStartTs > 0 && ts > reqStartTs) {
                dur = ts - reqStartTs
              }
              reqStartTs = 0

              let b = byModel.get(currentModel)
              if (!b) {
                b = {
                  model: currentModel,
                  inputTokens: 0,
                  cachedTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 0,
                  reasoningTokens: 0,
                  totalTokens: 0,
                  activeGenMs: 0,
                  genOutputSum: 0,
                  lastTurnDurMs: 0,
                  lastTurnTok: 0
                }
                byModel.set(currentModel, b)
              }

              b.inputTokens += Number(u.input_tokens || 0)
              b.cachedTokens += Number(u.cached_input_tokens || 0)
              b.cacheWriteTokens += Number(u.cache_write_input_tokens || 0)
              b.outputTokens += stepOut
              b.reasoningTokens += Number(u.reasoning_output_tokens || 0)
              b.totalTokens += Number(u.total_tokens || 0)

              if (dur >= 300 && dur < 180_000 && stepOut > 0) {
                b.activeGenMs += dur
                b.genOutputSum += stepOut
                b.lastTurnDurMs = dur
                b.lastTurnTok = stepOut
              }
            }
          } catch {
            // continue
          }
        }

        if (byModel.size === 0) return null

        const results: CodexModelTurnUsage[] = []
        for (const [m, b] of byModel.entries()) {
          const speed =
            b.lastTurnDurMs > 300 && b.lastTurnTok > 0
              ? Number(((b.lastTurnTok / b.lastTurnDurMs) * 1000).toFixed(1))
              : b.activeGenMs > 300 && b.genOutputSum > 0
              ? Number(((b.genOutputSum / b.activeGenMs) * 1000).toFixed(1))
              : undefined

          results.push({
            model: m,
            inputTokens: b.inputTokens,
            cachedTokens: b.cachedTokens,
            cacheWriteTokens: b.cacheWriteTokens,
            outputTokens: b.outputTokens,
            reasoningTokens: b.reasoningTokens,
            totalTokens: b.totalTokens,
            outputTokensPerSec: speed,
            durationMs: b.lastTurnDurMs > 0 ? b.lastTurnDurMs : b.activeGenMs || undefined
          })
        }

        return results
      })
    } catch {
      return null
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

    if (fs.existsSync(this.stateSqlitePath)) {
      try {
        const db = new DatabaseSync(this.stateSqlitePath, { open: true, readOnly: true })
        const rows = db
          .prepare(
            `SELECT id, title, model, model_provider, tokens_used, rollout_path, updated_at, updated_at_ms
             FROM threads
             WHERE tokens_used > 0
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(limit) as any[]

        // Historical daily activity aggregation
        let rawDailyRows: any[] = []
        try {
          rawDailyRows = db
            .prepare(
              `SELECT strftime('%Y-%m-%d', datetime(updated_at, 'unixepoch', 'localtime')) as day,
                      model,
                      COUNT(*) as sessionCount,
                      SUM(tokens_used) as totalTokens
               FROM threads
               WHERE tokens_used > 0
               GROUP BY day, model
               ORDER BY day ASC`
            )
            .all() as any[]
        } catch {
          // ignore
        }

        db.close()

        for (const r of rows) {
          const detailList = this.parseRolloutJsonlUsage(r.rollout_path, r.model || 'gpt-6.1-sol')

          if (detailList && detailList.length > 1) {
            // Multi-model session split into distinct entries
            for (const b of detailList) {
              if (b.totalTokens <= 0) continue
              inputTokens += b.inputTokens
              cachedTokens += b.cachedTokens
              cacheWriteTokens += b.cacheWriteTokens
              outputTokens += b.outputTokens
              reasoningTokens += b.reasoningTokens
              totalTokens += b.totalTokens

              const hitRate =
                b.inputTokens > 0 ? Number(((b.cachedTokens / b.inputTokens) * 100).toFixed(1)) : 0
              const { costUsd, savingsUsd } = calculateCost(
                b.model,
                b.inputTokens,
                b.cachedTokens,
                b.outputTokens,
                b.reasoningTokens
              )

              recentSessions.push({
                id: `${r.id}_${b.model}`,
                targetId: this.id,
                targetName: this.name,
                category: this.category,
                title: `${r.title || 'Codex Session'} (${b.model})`,
                model: b.model,
                provider: r.model_provider || 'openai',
                inputTokens: b.inputTokens,
                cachedTokens: b.cachedTokens,
                cacheWriteTokens: b.cacheWriteTokens,
                outputTokens: b.outputTokens,
                reasoningTokens: b.reasoningTokens,
                totalTokens: b.totalTokens,
                cacheHitRate: hitRate,
                outputTokensPerSec: b.outputTokensPerSec,
                durationMs: b.durationMs,
                costUsd,
                cacheSavingsUsd: savingsUsd,
                updatedAt: r.updated_at_ms || r.updated_at * 1000,
                source: 'native-log'
              })
            }
          } else {
            // Single model session
            const detail = detailList?.[0]
            const sModel = detail?.model || r.model || 'gpt-codex'
            const sInput = detail ? detail.inputTokens : Number(r.tokens_used || 0)
            const sCached = detail ? detail.cachedTokens : 0
            const sCacheWrite = detail ? detail.cacheWriteTokens : 0
            const sOutput = detail ? detail.outputTokens : 0
            const sReasoning = detail ? detail.reasoningTokens : 0
            const sTotal = detail ? detail.totalTokens : Number(r.tokens_used || 0)

            inputTokens += sInput
            cachedTokens += sCached
            cacheWriteTokens += sCacheWrite
            outputTokens += sOutput
            reasoningTokens += sReasoning
            totalTokens += sTotal

            const hitRate = sInput > 0 ? Number(((sCached / sInput) * 100).toFixed(1)) : 0
            const { costUsd, savingsUsd } = calculateCost(
              sModel,
              sInput,
              sCached,
              sOutput,
              sReasoning
            )

            recentSessions.push({
              id: r.id,
              targetId: this.id,
              targetName: this.name,
              category: this.category,
              title: r.title || 'Codex Session',
              model: sModel,
              provider: r.model_provider || 'openai',
              inputTokens: sInput,
              cachedTokens: sCached,
              cacheWriteTokens: sCacheWrite,
              outputTokens: sOutput,
              reasoningTokens: sReasoning,
              totalTokens: sTotal,
              cacheHitRate: hitRate,
              outputTokensPerSec: detail?.outputTokensPerSec,
              durationMs: detail?.durationMs,
              costUsd,
              cacheSavingsUsd: savingsUsd,
              updatedAt: r.updated_at_ms || r.updated_at * 1000,
              source: 'native-log'
            })
          }
        }

        // Build daily activities accurately by merging recentSessions and model-specific historical rows
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
            item.costUsd = Number(((item.costUsd || 0) + (s.costUsd || 0)).toFixed(3))
            item.cacheSavingsUsd = Number(
              ((item.cacheSavingsUsd || 0) + (s.cacheSavingsUsd || 0)).toFixed(3)
            )
          }

          // 2. Add other historical days from rawDailyRows using each thread's actual model
          for (const dr of rawDailyRows) {
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

            const m = dr.model || 'gpt-6.1-terra'
            const tot = Number(dr.totalTokens || 0)
            const inTok = Math.round(tot * 0.92)
            const cacheTok = Math.round(inTok * 0.88)
            const outTok = Math.round(tot * 0.08)
            const { costUsd, savingsUsd } = calculateCost(m, inTok, cacheTok, outTok, 0)

            const dayItem = dailyMap.get(day)!
            dayItem.sessionCount += Number(dr.sessionCount || 0)

            if (!recentSessions.some((s) => new Date(s.updatedAt).toISOString().slice(0, 10) === day)) {
              dayItem.totalTokens += tot
              dayItem.inputTokens += inTok
              dayItem.cachedTokens += cacheTok
              dayItem.outputTokens += outTok
              dayItem.costUsd = Number(((dayItem.costUsd || 0) + costUsd).toFixed(3))
              dayItem.cacheSavingsUsd = Number(((dayItem.cacheSavingsUsd || 0) + savingsUsd).toFixed(3))
            }
          }

          dailyActivities = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date))
        } catch {
          // ignore
        }
      } catch {
        // ignore sqlite lock/read error
      }
    }

    const cacheHitRate =
      inputTokens > 0 ? Number(((cachedTokens / inputTokens) * 100).toFixed(1)) : 0

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
    if (!fs.existsSync(this.configTomlPath)) return
    createBackup(this.configTomlPath, this.id)

    const raw = fs.readFileSync(this.configTomlPath, 'utf8')
    const parsed = parse(raw) as Record<string, any>

    const providerKey = useProxy ? 'ccswitch_proxy' : provider.id
    parsed.model = provider.defaultModel
    parsed.model_provider = providerKey

    if (!parsed.model_providers || typeof parsed.model_providers !== 'object') {
      parsed.model_providers = {}
    }

    const sanitizedId = provider.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
    const envKeyName = useProxy
      ? 'CODEX_CCSWITCH_PROXY_KEY'
      : `CODEX_${sanitizedId}_KEY`

    parsed.model_providers[providerKey] = {
      name: useProxy ? `CCSwitch Proxy (${provider.name})` : provider.name,
      base_url: useProxy ? `http://127.0.0.1:${proxyPort}/codex/v1` : provider.baseUrl,
      wire_api: 'responses',
      env_key: envKeyName
    }

    // Automatically manage secret key in environment variable and ~/.codex/.env
    const effectiveKey = useProxy ? (provider.apiKey || 'ccswitch-local-token') : provider.apiKey
    this.syncEnvironmentVariable(envKeyName, effectiveKey)

    fs.writeFileSync(this.configTomlPath, stringify(parsed), 'utf8')
  }

  removeProviderFromConfig(providerId: string): void {
    if (!fs.existsSync(this.configTomlPath)) return
    try {
      const raw = fs.readFileSync(this.configTomlPath, 'utf8')
      const parsed = parse(raw) as Record<string, any>
      if (parsed.model_providers && parsed.model_providers[providerId]) {
        const provBlock = parsed.model_providers[providerId]
        if (provBlock.env_key) {
          this.removeEnvironmentVariable(provBlock.env_key)
        }
        createBackup(this.configTomlPath, this.id)
        delete parsed.model_providers[providerId]
        fs.writeFileSync(this.configTomlPath, stringify(parsed), 'utf8')
      }
    } catch {
      // ignore
    }
  }

  private syncEnvironmentVariable(varName: string, value: string): void {
    // 1. Current in-memory process
    process.env[varName] = value

    // 2. ~/.codex/.env file (standard for Codex dotenv loader)
    try {
      const envFilePath = path.join(this.codexDir, '.env')
      let lines: string[] = []
      if (fs.existsSync(envFilePath)) {
        lines = fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)
      }
      const keyPrefix = `${varName}=`
      let replaced = false
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(keyPrefix) || lines[i].startsWith(`export ${keyPrefix}`)) {
          lines[i] = `${varName}="${value.replace(/"/g, '\\"')}"`
          replaced = true
          break
        }
      }
      if (!replaced) {
        lines.push(`${varName}="${value.replace(/"/g, '\\"')}"`)
      }
      fs.writeFileSync(
        envFilePath,
        lines
          .filter(
            (l, idx) =>
              idx === 0 || l.trim().length > 0 || (lines[idx - 1] && lines[idx - 1].trim().length > 0)
          )
          .join('\n') + '\n',
        'utf8'
      )
    } catch (e) {
      console.warn('[CodexAdapter] Failed to write ~/.codex/.env:', e)
    }

    // 3. Persistent Windows User Environment Variable (accessible by Codex.exe & terminal)
    if (process.platform === 'win32' && value) {
      try {
        const safeName = varName.replace(/[^A-Za-z0-9_]/g, '')
        const b64Val = Buffer.from(value, 'utf8').toString('base64')
        const psCmd = `[System.Environment]::SetEnvironmentVariable('${safeName}', [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Val}')), 'User')`
        exec(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, (err) => {
          if (err) console.warn('[CodexAdapter] Failed to set Windows user env var:', err.message)
        })
      } catch (e) {
        console.warn('[CodexAdapter] Error setting Windows User environment variable:', e)
      }
    }
  }

  private removeEnvironmentVariable(varName: string): void {
    delete process.env[varName]

    try {
      const envFilePath = path.join(this.codexDir, '.env')
      if (fs.existsSync(envFilePath)) {
        const lines = fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)
        const keyPrefix = `${varName}=`
        const filtered = lines.filter(
          (l) => !l.startsWith(keyPrefix) && !l.startsWith(`export ${keyPrefix}`)
        )
        fs.writeFileSync(envFilePath, filtered.join('\n'), 'utf8')
      }
    } catch {
      // ignore
    }

    if (process.platform === 'win32') {
      try {
        const safeName = varName.replace(/[^A-Za-z0-9_]/g, '')
        const psCmd = `[System.Environment]::SetEnvironmentVariable('${safeName}', [string]::Empty, 'User')`
        exec(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, () => {})
      } catch {
        // ignore
      }
    }
  }

  syncMcps(mcps: UnifiedMcpServer[]): void {
    if (!fs.existsSync(this.configTomlPath)) return
    createBackup(this.configTomlPath, this.id)

    const raw = fs.readFileSync(this.configTomlPath, 'utf8')
    const parsed = parse(raw) as Record<string, any>

    if (!parsed.mcp_servers || typeof parsed.mcp_servers !== 'object') {
      parsed.mcp_servers = {}
    }

    // Preserve built-in Codex system MCPs such as node_repl
    const enabledForCodex = mcps.filter((m) => m.enabledTargets.includes(this.id))
    for (const m of enabledForCodex) {
      if (m.type === 'stdio' && m.command) {
        parsed.mcp_servers[m.name] = {
          ...(parsed.mcp_servers[m.name] || {}),
          command: m.command,
          args: m.args || [],
          ...(m.env && Object.keys(m.env).length > 0 ? { env: m.env } : {})
        }
      }
    }

    fs.writeFileSync(this.configTomlPath, stringify(parsed), 'utf8')
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
            // ignore copy error
          }
        }
      } else {
        // Never delete .system internal Codex skills
        if (skill.id !== '.system' && fs.existsSync(dest)) {
          try {
            fs.rmSync(dest, { recursive: true, force: true })
          } catch {
            // ignore remove error
          }
        }
      }
    }
  }
}
