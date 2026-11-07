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

export interface SessionUsageItem {
  id: string
  targetId: TargetId
  targetName: string
  category: TargetCategory
  title: string
  model: string
  provider: string
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate: number // 0 ~ 100 (%)
  /** Output generation speed in tokens per second (tok/s) */
  outputTokensPerSec?: number
  /** Active generation duration in milliseconds */
  durationMs?: number
  updatedAt: number
  source: 'native-log' | 'local-proxy'
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
  totalOutputTokens: number
  totalReasoningTokens: number
  overallCacheHitRate: number
  totalSessions: number
  proxyRunning: boolean
  proxyPort: number
  byTarget: TargetUsageSummary[]
  recentStream: SessionUsageItem[]
}
