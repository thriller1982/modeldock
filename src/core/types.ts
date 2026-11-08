export type TargetCategory = 'desktop' | 'cli'
export type TargetId = 'codex-desktop' | 'workbuddy' | 'antigravity' | 'opencode'
/** direct = write upstream URL into the tool's config; gateway = point the tool at the local proxy */
export type SwitchMode = 'direct' | 'gateway'

export interface ProviderProfile {
  id: string
  targetId: TargetId
  name: string
  vendor: string
  baseUrl: string
  apiKey: string
  defaultModel: string
  models: string[]
  protocol: 'openai' | 'anthropic'
}

export interface UnifiedMcpServer {
  id: string
  name: string
  type: 'stdio' | 'remote'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabledTargets: TargetId[]
}

export interface UnifiedSkill {
  id: string // Directory name in ~/.agents/skills, e.g. "frontend-design"
  name: string
  description: string
  path: string // Absolute path in ~/.agents/skills/<id>
  enabledTargets: TargetId[]
  fileCount?: number
  updatedAt?: number
}

export interface DailyActivityItem {
  date: string // "YYYY-MM-DD"
  totalTokens: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  sessionCount: number
  costUsd: number
  cacheSavingsUsd: number
  unpricedCount: number
}

export interface SessionUsageItem {
  id: string
  sessionId?: string
  targetId: TargetId
  targetName: string
  category: TargetCategory
  title: string
  model: string
  provider: string
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  /** Output excluding the separately tracked reasoning tokens. */
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate: number // 0 ~ 100 (%)
  /** Output generation speed in tokens per second (tok/s) */
  outputTokensPerSec?: number
  /** Active generation duration in milliseconds */
  durationMs?: number
  /** Estimated cost in USD based on official model pricing */
  costUsd?: number
  /** Estimated cost saved by prompt caching in USD */
  cacheSavingsUsd?: number
  updatedAt: number
  source: 'native-log' | 'local-proxy'
  /** Native session coverage takes precedence over gateway details in totals. */
  detailOnly?: boolean
  /** Gateway records with separately counted output and reasoning. */
  usageVersion?: 2
  /** true when token numbers are estimated (e.g. from transcript length) rather than reported by the API */
  estimated?: boolean
}

export interface TargetUsageSummary {
  targetId: TargetId
  targetName: string
  category: TargetCategory
  sessionCount: number
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate: number // 0 ~ 100 (%)
  /** Most recent session's output speed (tok/s) */
  latestOutputTokensPerSec?: number
  /** Most recent session's duration (ms) */
  latestDurationMs?: number
  /** Average output speed across recent sessions (tok/s) */
  avgOutputTokensPerSec?: number
  /** Total estimated cost in USD */
  totalCostUsd?: number
  /** Total savings from prompt caching in USD */
  totalCacheSavingsUsd?: number
  unpricedCount: number
  /** Daily activity aggregation for heatmap/calendar */
  dailyActivities?: DailyActivityItem[]
  recentSessions: SessionUsageItem[]
  estimated?: boolean
}

export interface TargetStatus {
  id: TargetId
  name: string
  category: TargetCategory
  description: string
  installed: boolean
  running?: boolean
  configPaths: {
    mainConfig: string
    mcpConfig?: string
    skillsDir?: string
    usageDbOrDir?: string
  }
  capabilities: {
    providerSwitch: boolean
    mcpSync: boolean
    skillSync: boolean
    usageMonitor: boolean
    proxyGateway: boolean
    processControl: boolean
  }
  currentModel?: string
  currentProvider?: string
  proxyEnabled: boolean
  proxyEndpoint: string
  mcpCount: number
  activeMcps: string[]
  skillCount?: number
  activeSkills?: string[]
}

export interface DashboardSnapshot {
  totalInputTokens: number
  totalCachedTokens: number
  totalCacheWriteTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  overallCacheHitRate: number
  totalSessions: number
  /** Total estimated cost in USD across all targets */
  totalCostUsd?: number
  /** Total cache savings in USD across all targets */
  totalSavingsUsd?: number
  unpricedCount: number
  /** Daily activity aggregation across all AI tools combined */
  allDailyActivities?: DailyActivityItem[]
  proxyRunning: boolean
  proxyPort: number
  byTarget: TargetUsageSummary[]
  recentStream: SessionUsageItem[]
}
