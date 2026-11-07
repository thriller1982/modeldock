import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parse, stringify } from 'smol-toml'
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

export class CodexDesktopAdapter extends DesktopTargetAdapter {
  readonly id: TargetId = 'codex-desktop'
  readonly name = 'Codex 桌面版 (ChatGPT App)'
  readonly description = 'OpenAI Codex Desktop / ChatGPT 桌面端环境 (~/.codex)'
  readonly processNames = ['Codex.exe', 'ChatGPT.exe', 'codex-computer-use.exe']
  private rolloutCache = new FileParseCache<{
    inputTokens: number
    cachedTokens: number
    cacheWriteTokens: number
    outputTokens: number
    reasoningTokens: number
    totalTokens: number
    outputTokensPerSec?: number
    durationMs?: number
  } | null>()

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

  private parseRolloutJsonlUsage(rolloutPath: string): {
    inputTokens: number
    cachedTokens: number
    cacheWriteTokens: number
    outputTokens: number
    reasoningTokens: number
    totalTokens: number
    outputTokensPerSec?: number
    durationMs?: number
  } | null {
    try {
      const cleanPath = rolloutPath.replace(/^\\\\\?\\/, '')
      return this.rolloutCache.get(cleanPath, (content) => {
        const lines = content.split('\n')
        let result: {
          inputTokens: number
          cachedTokens: number
          cacheWriteTokens: number
          outputTokens: number
          reasoningTokens: number
          totalTokens: number
          outputTokensPerSec?: number
          durationMs?: number
        } | null = null

        let reqStartTs = 0
        let activeGenMs = 0
        let genOutputSum = 0
        let lastTurnDurMs = 0
        let lastTurnTok = 0

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const obj = JSON.parse(line)
            const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
            const pType = obj.payload?.type
            const pRole = obj.payload?.role

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
              // In Codex rollout logs, u.output_tokens ALREADY includes reasoning_output_tokens
              const stepOut = Number(u.output_tokens || 0)
              if (reqStartTs > 0 && ts > reqStartTs) {
                const dur = ts - reqStartTs
                if (dur >= 300 && dur < 180_000 && stepOut > 0) {
                  activeGenMs += dur
                  genOutputSum += stepOut
                  lastTurnDurMs = dur
                  lastTurnTok = stepOut
                }
              }
              reqStartTs = 0
              if (obj.payload.thread_token_usage) {
                const tu = obj.payload.thread_token_usage
                result = {
                  inputTokens: tu.input_tokens || 0,
                  cachedTokens: tu.cached_input_tokens || 0,
                  cacheWriteTokens: tu.cache_write_input_tokens || 0,
                  outputTokens: tu.output_tokens || 0,
                  reasoningTokens: tu.reasoning_output_tokens || 0,
                  totalTokens: tu.total_tokens || 0
                }
              }
            } else if (
              obj.type === 'event_msg' &&
              obj.payload?.type === 'token_count' &&
              obj.payload.info?.total_token_usage
            ) {
              const u = obj.payload.info.total_token_usage
              result = {
                inputTokens: u.input_tokens || 0,
                cachedTokens: u.cached_input_tokens || 0,
                cacheWriteTokens: u.cache_write_input_tokens || 0,
                outputTokens: u.output_tokens || 0,
                reasoningTokens: u.reasoning_output_tokens || 0,
                totalTokens: u.total_tokens || 0
              }
            }
          } catch {
            // continue
          }
        }

        if (result && activeGenMs > 300 && genOutputSum > 0) {
          result.durationMs = lastTurnDurMs > 0 ? lastTurnDurMs : activeGenMs
          result.outputTokensPerSec =
            lastTurnDurMs > 300 && lastTurnTok > 0
              ? Number(((lastTurnTok / lastTurnDurMs) * 1000).toFixed(1))
              : Number(((genOutputSum / activeGenMs) * 1000).toFixed(1))
        }
        return result
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
        db.close()

        for (const r of rows) {
          const detail = this.parseRolloutJsonlUsage(r.rollout_path)
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

          recentSessions.push({
            id: r.id,
            targetId: this.id,
            targetName: this.name,
            category: this.category,
            title: r.title || 'Codex Session',
            model: r.model || 'gpt-codex',
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
            updatedAt: r.updated_at_ms || r.updated_at * 1000,
            source: 'native-log'
          })
        }
      } catch {
        // ignore sqlite lock/read error
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

    parsed.model_providers[providerKey] = {
      name: useProxy ? `CCSwitch Proxy (${provider.name})` : provider.name,
      base_url: useProxy ? `http://127.0.0.1:${proxyPort}/codex/v1` : provider.baseUrl,
      wire_api: 'chat'
    }

    fs.writeFileSync(this.configTomlPath, stringify(parsed), 'utf8')
  }

  removeProviderFromConfig(providerId: string): void {
    if (!fs.existsSync(this.configTomlPath)) return
    try {
      const raw = fs.readFileSync(this.configTomlPath, 'utf8')
      const parsed = parse(raw) as Record<string, any>
      if (parsed.model_providers && parsed.model_providers[providerId]) {
        createBackup(this.configTomlPath, this.id)
        delete parsed.model_providers[providerId]
        fs.writeFileSync(this.configTomlPath, stringify(parsed), 'utf8')
      }
    } catch {
      // ignore
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
