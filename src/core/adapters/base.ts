import { execSync } from 'node:child_process'
import {
  ProviderProfile,
  TargetCategory,
  TargetId,
  TargetStatus,
  TargetUsageSummary,
  UnifiedMcpServer,
  UnifiedSkill
} from '../types'

export abstract class BaseTargetAdapter {
  abstract readonly id: TargetId
  abstract readonly name: string
  abstract readonly category: TargetCategory
  abstract readonly description: string

  abstract getStatus(proxyPort: number): TargetStatus
  abstract getUsageSummary(limit?: number): TargetUsageSummary
  abstract applyProvider(provider: ProviderProfile, useProxy: boolean, proxyPort: number): void
  abstract syncMcps(mcps: UnifiedMcpServer[]): void
  abstract syncSkills(skills: UnifiedSkill[], hubDir: string): void
}

export abstract class DesktopTargetAdapter extends BaseTargetAdapter {
  readonly category: TargetCategory = 'desktop'
  abstract readonly processNames: string[]

  private static taskListCache: { at: number; text: string } | null = null

  /** Shared, 5s-cached `tasklist` snapshot so four adapters don't each spawn a process per refresh. */
  private static taskList(): string {
    const now = Date.now()
    const c = DesktopTargetAdapter.taskListCache
    if (c && now - c.at < 5000) return c.text
    let text = ''
    try {
      text = execSync('tasklist /NH /FO CSV', { encoding: 'utf8', timeout: 3000 }).toLowerCase()
    } catch {
      text = ''
    }
    DesktopTargetAdapter.taskListCache = { at: now, text }
    return text
  }

  isProcessRunning(): boolean {
    if (process.platform !== 'win32') return false
    const out = DesktopTargetAdapter.taskList()
    return this.processNames.some((p) => out.includes(`"${p.toLowerCase()}"`))
  }
}

export abstract class CliTargetAdapter extends BaseTargetAdapter {
  readonly category: TargetCategory = 'cli'
  abstract readonly binaryName: string
}
