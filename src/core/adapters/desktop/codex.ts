import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
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
import { calculateCost } from '../../pricing'
import { cacheHitRate, summarizeUsage, tokenCount } from '../../usage'

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
    fallbackModel: string,
    threadId: string
  ): CodexModelTurnUsage[] | null {
    try {
      const cleanPath = rolloutPath.replace(/^\\\\\?\\/, '')
      const name = path.basename(cleanPath)
      const date = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/)
      const alternatives = [path.join(this.codexDir, 'archived_sessions', name)]
      if (date) alternatives.push(path.join(this.codexDir, 'sessions', date[1], date[2], date[3], name))
      const filePath = fs.existsSync(cleanPath) ? cleanPath : alternatives.find((file) => fs.existsSync(file))
      if (!filePath) return null
      return this.rolloutCache.get(filePath, (content) => {
        const lines = content.split('\n')
        const hasUsageRecords = /"type"\s*:\s*"token_usage_record"/.test(content)
        const responseIds = new Set<string>()
        let previousTotal: number | undefined
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
            if (!/(token_usage_record|token_count|turn_context|session_meta|task_started|response_item)/.test(line)) continue
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
            } else {
              const payload = obj.payload
              let usage
              let outputIncludesReasoning = true
              if (obj.type === 'token_usage_record' && payload?.usage) {
                if (payload.thread_id && payload.thread_id !== threadId) continue
                if (payload.response_id) {
                  if (responseIds.has(payload.response_id)) continue
                  responseIds.add(payload.response_id)
                }
                usage = payload.usage
              } else if (!hasUsageRecords && pType === 'token_count' && payload.info?.last_token_usage) {
                const total = payload.info.total_token_usage?.total_tokens
                if (total !== undefined && total === previousTotal) continue
                previousTotal = total
                usage = payload.info.last_token_usage
                outputIncludesReasoning = payload.info.last_usage_includes_reasoning !== false
              }
              if (!usage) continue
              const input = tokenCount(usage.input_tokens)
              const output = tokenCount(usage.output_tokens)
              const rawReasoning = tokenCount(usage.reasoning_output_tokens)
              const reasoning = outputIncludesReasoning ? Math.min(output, rawReasoning) : rawReasoning
              const stepOut = outputIncludesReasoning ? output - reasoning : output
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

              b.inputTokens += input
              const cached = Math.min(input, tokenCount(usage.cached_input_tokens))
              b.cachedTokens += cached
              b.cacheWriteTokens += Math.min(input - cached, tokenCount(usage.cache_write_input_tokens))
              b.outputTokens += stepOut
              b.reasoningTokens += reasoning
              b.totalTokens += input + stepOut + reasoning

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
      }, threadId + '/' + fallbackModel)
    } catch {
      return null
    }
  }

  getUsageSummary(limit = 30): TargetUsageSummary {
    const items: SessionUsageItem[] = []

    if (fs.existsSync(this.stateSqlitePath)) {
      try {
        const db = new DatabaseSync(this.stateSqlitePath, { readOnly: true })
        try {
          const rows = db.prepare(
            'SELECT id, title, model, model_provider, tokens_used, rollout_path, updated_at, updated_at_ms FROM threads'
          ).all() as {
            id: string; title: string; model: string | null; model_provider: string | null
            tokens_used: number; rollout_path: string; updated_at: number; updated_at_ms: number | null
          }[]
          for (const row of rows) {
            const model = row.model || 'unknown'
            const details = this.parseRolloutJsonlUsage(row.rollout_path, model, row.id)
              ?.filter((usage) => usage.totalTokens > 0) ?? []
            const buckets: CodexModelTurnUsage[] = details.length ? details : row.tokens_used > 0 ? [{
              model, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
              reasoningTokens: 0, totalTokens: row.tokens_used
            }] : []
            for (const usage of buckets) {
              const priced = details.length ? calculateCost(
                usage.model, usage.inputTokens, usage.cachedTokens, usage.outputTokens,
                usage.reasoningTokens, usage.cacheWriteTokens
              ) : {}
              const title = row.title || 'Codex Session'
              items.push({
                ...usage,
                id: buckets.length > 1 ? row.id + '_' + usage.model : row.id,
                sessionId: row.id,
                targetId: this.id,
                targetName: this.name,
                category: this.category,
                title: buckets.length > 1 ? title + ' (' + usage.model + ')' : title,
                provider: row.model_provider || 'openai',
                cacheHitRate: cacheHitRate(usage.inputTokens, usage.cachedTokens),
                costUsd: priced.costUsd,
                cacheSavingsUsd: priced.savingsUsd,
                updatedAt: row.updated_at_ms || row.updated_at * 1000,
                source: 'native-log'
              })
            }
          }
        } finally {
          db.close()
        }
      } catch {
        // The client database can be temporarily unavailable.
      }
    }

    return summarizeUsage(this, items, limit)
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
