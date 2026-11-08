import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { DesktopTargetAdapter } from '../base'
import {
  ProviderProfile,
  SessionUsageItem,
  TargetId,
  TargetStatus,
  TargetUsageSummary,
  UnifiedMcpServer,
  UnifiedSkill
} from '../../types'
import { calculateCost } from '../../pricing'
import { cacheHitRate, summarizeUsage, tokenCount } from '../../usage'
import { FileParseCache } from '../file-cache'

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

interface TranscriptUsage {
  model: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  estimated: boolean
  durationMs?: number
  outputTokensPerSec?: number
}

export class AntigravityAdapter extends DesktopTargetAdapter {
  readonly id: TargetId = 'antigravity'
  readonly name = 'Google Antigravity (反重力桌面版)'
  readonly description = 'Google DeepMind Antigravity 2.0 桌面端 (~/.gemini/antigravity)'
  readonly processNames = ['Antigravity.exe', 'agy.exe']

  private usageCache = new FileParseCache<TranscriptUsage[]>()

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

  private readTranscriptUsage(transcript: string): TranscriptUsage[] {
    let model = 'Gemini 3.8 Flash'
    let contextLength = 0
    let previousResponseAt = 0
    const usage = new Map<string, TranscriptUsage>()

    for (const line of transcript.split('\n')) {
      if (!line.trim()) continue
      let step
      try {
        step = JSON.parse(line)
      } catch {
        continue
      }
      if (step?.source === 'USER_EXPLICIT' || step?.type === 'USER_INPUT') {
        const content = String(step.content || '')
        model = extractModelFromStep(content) ?? model
        contextLength += content.length
      }
      if (step?.type !== 'PLANNER_RESPONSE') continue

      model = typeof step.model === 'string' && step.model ? step.model : model
      const responseAt = new Date(step.created_at).getTime()
      const outputLength = String(step.content || '').length + JSON.stringify(step.tool_calls || []).length
      const reasoningLength = String(step.thinking || '').length
      const reportedInput = step.input_tokens != null
      const reportedOutput = step.output_tokens != null
      const estimatedInput = Math.max(2500, Math.ceil(contextLength / 3.5))
      const cached = reportedInput ? tokenCount(step.cache_read_tokens)
        : contextLength > 4000 ? Math.floor(estimatedInput * 0.86) : 0
      const input = reportedInput ? tokenCount(step.input_tokens) + cached : estimatedInput
      const rawReasoning = step.reasoning_tokens != null
        ? tokenCount(step.reasoning_tokens)
        : Math.ceil(reasoningLength / 3.5)
      // Antigravity reports output inclusive of reasoning.
      const rawOutput = reportedOutput ? tokenCount(step.output_tokens) : Math.ceil(outputLength / 3.5)
      const reasoning = reportedOutput ? Math.min(rawReasoning, rawOutput) : rawReasoning
      const output = reportedOutput ? rawOutput - reasoning : rawOutput

      let bucket = usage.get(model)
      if (!bucket) {
        bucket = { model, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, estimated: false }
        usage.set(model, bucket)
      }
      bucket.inputTokens += input
      bucket.cachedTokens += cached
      bucket.outputTokens += output
      bucket.reasoningTokens += reasoning
      bucket.estimated ||= !reportedInput || !reportedOutput || (step.reasoning_tokens == null && reasoningLength > 0)
      const duration = responseAt - previousResponseAt
      if (previousResponseAt > 0 && duration >= 300 && duration < 120_000 && output > 0) {
        bucket.durationMs = duration
        bucket.outputTokensPerSec = Number(((output / duration) * 1000).toFixed(1))
      }
      if (responseAt > 0) previousResponseAt = responseAt
      contextLength += outputLength + reasoningLength + 400
    }

    return Array.from(usage.values())
  }

  getUsageSummary(limit = 30): TargetUsageSummary {
    const items: SessionUsageItem[] = []
    if (!fs.existsSync(this.summariesDbPath)) return summarizeUsage(this, items, limit)

    try {
      const db = new DatabaseSync(this.summariesDbPath, { readOnly: true })
      try {
        const rows = db.prepare(
          'SELECT conversation_id, title, step_count, last_modified_time FROM conversation_summaries'
        ).all() as { conversation_id: string; title: string; step_count: number; last_modified_time: string }[]
        for (const row of rows) {
          const id = row.conversation_id
          const transcriptPath = path.join(this.brainDir, id, '.system_generated', 'logs', 'transcript.jsonl')
          const parsed = this.usageCache.get(transcriptPath, (content) => this.readTranscriptUsage(content))
          const steps = tokenCount(row.step_count)
          const buckets = parsed?.length ? parsed : steps > 0 ? [{
            model: 'Gemini 3.8 Flash',
            inputTokens: steps * 6400,
            cachedTokens: Math.floor(steps * 6400 * 0.82),
            outputTokens: steps * 380,
            reasoningTokens: steps * 210,
            estimated: true
          }] : []
          for (const usage of buckets) {
            const totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens
            if (totalTokens <= 0) continue
            const { costUsd, savingsUsd } = calculateCost(
              usage.model, usage.inputTokens, usage.cachedTokens, usage.outputTokens, usage.reasoningTokens
            )
            const title = row.title || 'Antigravity Session'
            items.push({
              ...usage,
              id: buckets.length > 1 ? id + '_' + usage.model : id,
              sessionId: id,
              targetId: this.id,
              targetName: this.name,
              category: this.category,
              title: buckets.length > 1 ? title + ' (' + usage.model + ')' : title,
              provider: 'Google DeepMind',
              cacheWriteTokens: 0,
              totalTokens,
              cacheHitRate: cacheHitRate(usage.inputTokens, usage.cachedTokens),
              costUsd,
              cacheSavingsUsd: savingsUsd,
              updatedAt: new Date(row.last_modified_time).getTime(),
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
    return summarizeUsage(this, items, limit)
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
