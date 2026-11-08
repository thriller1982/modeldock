import type { DailyActivityItem, SessionUsageItem, TargetUsageSummary } from './types'

type UsageTarget = { id: SessionUsageItem['targetId']; name: string; category: SessionUsageItem['category'] }
type UsageDay = DailyActivityItem & { sessions: Set<string> }

export function tokenCount(value: unknown): number {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? count : 0
}

export function cacheHitRate(input: number, cached: number): number {
  return input > 0 ? Number(((Math.min(cached, input) / input) * 100).toFixed(1)) : 0
}

export function localUsageDay(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function summarizeUsage(
  target: UsageTarget,
  items: SessionUsageItem[],
  limit: number
): TargetUsageSummary {
  const sessions = new Set<string>()
  const days = new Map<string, UsageDay>()
  let cacheWriteTokens = 0
  let estimated = false
  for (const item of items) {
    const id = item.sessionId ?? item.id
    sessions.add(id)
    cacheWriteTokens += item.cacheWriteTokens
    estimated ||= !!item.estimated
    const date = localUsageDay(item.updatedAt)
    let day = days.get(date)
    if (!day) {
      day = {
        date, sessions: new Set(), totalTokens: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
        reasoningTokens: 0, sessionCount: 0, costUsd: 0, cacheSavingsUsd: 0, unpricedCount: 0
      }
      days.set(date, day)
    }
    day.sessions.add(id)
    day.totalTokens += item.totalTokens
    day.inputTokens += item.inputTokens
    day.cachedTokens += item.cachedTokens
    day.outputTokens += item.outputTokens
    day.reasoningTokens += item.reasoningTokens
    day.costUsd += item.costUsd ?? 0
    day.cacheSavingsUsd += item.cacheSavingsUsd ?? 0
    if (item.costUsd === undefined) day.unpricedCount++
  }
  const dailyActivities = Array.from(days.values(), ({ sessions, ...day }) => ({
    ...day, sessionCount: sessions.size
  })).sort((a, b) => a.date.localeCompare(b.date))
  const recentSessions = items.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  const measured = recentSessions.filter((item) => (item.outputTokensPerSec ?? 0) > 0)
  const latest = measured[0]
  const sum = (key: keyof Omit<DailyActivityItem, 'date'>) =>
    dailyActivities.reduce((total, day) => total + day[key], 0)
  const inputTokens = sum('inputTokens')
  const cachedTokens = sum('cachedTokens')

  return {
    targetId: target.id,
    targetName: target.name,
    category: target.category,
    sessionCount: sessions.size,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens: sum('outputTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    cacheHitRate: cacheHitRate(inputTokens, cachedTokens),
    latestOutputTokensPerSec: latest?.outputTokensPerSec,
    latestDurationMs: latest?.durationMs,
    avgOutputTokensPerSec: measured.length
      ? Number((measured.reduce((total, item) => total + (item.outputTokensPerSec ?? 0), 0) / measured.length).toFixed(1))
      : undefined,
    totalCostUsd: sum('costUsd'),
    totalCacheSavingsUsd: sum('cacheSavingsUsd'),
    unpricedCount: sum('unpricedCount'),
    dailyActivities,
    recentSessions,
    estimated
  }
}
