import React, { useEffect, useRef, useState } from 'react'
import {
  Activity,
  ChartColumn,
  Check,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Database,
  ExternalLink,
  FileCode,
  FileText,
  FolderOpen,
  GripVertical,
  History,
  KeyRound,
  LayoutGrid,
  Monitor,
  Moon,
  MoreHorizontal,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Zap
} from 'lucide-react'
import { clientApi } from './api'
import type {
  DashboardSnapshot,
  ProviderProfile,
  SwitchMode,
  TargetId,
  TargetStatus,
  UnifiedMcpServer,
  UnifiedSkill
} from '../../core/types'
import type { AppDatabase } from '../../core/store/app-store'

type MainView = 'app' | 'mcp' | 'skills' | 'sessions' | 'usage' | 'apps' | 'settings'

function formatTokens(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '-'
  if (ms >= 60_000) {
    const mins = Math.floor(ms / 60_000)
    const secs = ((ms % 60_000) / 1000).toFixed(0)
    return `${mins}m${secs}s`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

const APP_SHORT_NAMES: Record<TargetId, string> = {
  'codex-desktop': 'Codex',
  workbuddy: 'WorkBuddy',
  antigravity: 'Antigravity',
  opencode: 'OpenCode'
}

const APP_ACCENT_COLOR: Record<TargetId, string> = {
  'codex-desktop': '#10a37f',
  workbuddy: '#0052d9',
  antigravity: '#4285f4',
  opencode: '#0f766e'
}

function AppGlyph({ appId, size = 18 }: { appId: TargetId; size?: number }) {
  const bg = APP_ACCENT_COLOR[appId] || '#f97316'
  const letter =
    appId === 'codex-desktop'
      ? 'Cx'
      : appId === 'workbuddy'
      ? 'Wb'
      : appId === 'antigravity'
      ? 'Ag'
      : 'Oc'
  return (
    <span
      style={{ width: size, height: size, backgroundColor: bg }}
      className="inline-flex shrink-0 items-center justify-center rounded-[5px] font-mono text-[10px] font-bold text-white shadow-sm"
    >
      {letter}
    </span>
  )
}

function ProviderBadge({ name }: { name: string }) {
  const ch = (name || 'P').trim().slice(0, 2).toUpperCase()
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-border bg-subtle font-mono text-xs font-bold text-fg-1">
      {ch}
    </div>
  )
}

export default function App() {
  const [view, setView] = useState<MainView>('app')
  const [activeAppId, setActiveAppId] = useState<TargetId>('codex-desktop')
  const [collapsed, setCollapsed] = useState(false)
  const [isDark, setIsDark] = useState(true)

  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null)
  const [desktopTargets, setDesktopTargets] = useState<TargetStatus[]>([])
  const [cliTargets, setCliTargets] = useState<TargetStatus[]>([])
  const [store, setStore] = useState<AppDatabase | null>(null)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [usageFilter, setUsageFilter] = useState<string>('all')

  // Skill states
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [skillsHubPath, setSkillsHubPath] = useState<string>('')
  const [skillSearch, setSkillSearch] = useState('')
  const [skillTargetFilter, setSkillTargetFilter] = useState<'all' | TargetId>('all')
  const [editingSkill, setEditingSkill] = useState<{
    id?: string
    name: string
    description: string
    content?: string
    enabledTargets: TargetId[]
  } | null>(null)
  const [viewingSkillContent, setViewingSkillContent] = useState<{
    id: string
    name: string
    content: string
  } | null>(null)

  // Dialog states
  const [editingProvider, setEditingProvider] = useState<ProviderProfile | null>(null)
  const [editingMcp, setEditingMcp] = useState<UnifiedMcpServer | null>(null)

  const toastTimerRef = useRef<any>(null)
  const notify = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(msg)
    toastTimerRef.current = setTimeout(() => setToast(null), 2400)
  }

  useEffect(() => {
    const root = document.documentElement
    if (isDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [isDark])

  const refreshAll = async () => {
    setLoading(true)
    try {
      const [dashData, targetsData, skillsData] = await Promise.all([
        clientApi.getDashboard(),
        clientApi.getTargets(),
        clientApi.getSkills()
      ])
      setDashboard(dashData)
      setDesktopTargets(targetsData.desktop)
      setCliTargets(targetsData.cli)
      setStore(targetsData.store)
      setSkills(skillsData.skills || [])
      setSkillsHubPath(skillsData.hubPath || '')
    } catch (e: any) {
      notify(`加载数据失败: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refreshAll()
  }, [])

  const allTargets = [...desktopTargets, ...cliTargets]
  const currentTarget = allTargets.find((t) => t.id === activeAppId) || allTargets[0]
  const currentSummary = dashboard?.byTarget.find((b) => b.targetId === activeAppId)
  const currentTargetProviders = store?.providersByTarget?.[activeAppId] || []
  const currentMode: SwitchMode = currentTarget?.proxyEnabled
    ? 'gateway'
    : store?.modeByTarget?.[activeAppId] || 'direct'

  const handleSwitchProvider = async (
    targetId: TargetId,
    providerId: string,
    mode: SwitchMode
  ) => {
    try {
      await clientApi.switchProvider({
        targetId,
        providerId,
        useProxy: mode === 'gateway'
      })
      notify(
        mode === 'gateway'
          ? `已切换至「路由模式」并激活供应商 (${providerId})，后续切换零重启生效`
          : `已切换至「直连模式」并将供应商 (${providerId}) 写入原配置文件`
      )
      await refreshAll()
    } catch (e: any) {
      notify(`切换失败: ${e.message}`)
    }
  }

  const handleToggleMcpTarget = async (mcp: UnifiedMcpServer, targetId: TargetId) => {
    const exists = mcp.enabledTargets.includes(targetId)
    const nextTargets = exists
      ? mcp.enabledTargets.filter((t) => t !== targetId)
      : [...mcp.enabledTargets, targetId]
    const updated: UnifiedMcpServer = { ...mcp, enabledTargets: nextTargets }

    // 1. Optimistic UI update
    if (store) {
      setStore({
        ...store,
        mcps: store.mcps.map((m) => (m.id === mcp.id ? updated : m))
      })
    }
    notify(`MCP [${mcp.name}] 挂载配置已更新`)

    // 2. Asynchronous backend sync
    try {
      await clientApi.saveMcp(updated)
    } catch (e: any) {
      notify(`MCP 同步失败: ${e.message}`)
      await refreshAll()
    }
  }

  const handleToggleSkillTarget = async (skill: UnifiedSkill, targetId: TargetId) => {
    const exists = skill.enabledTargets.includes(targetId)
    const next = !exists

    // 1. Instant optimistic update so UI is 100% responsive and continuous clicks are lightning-fast
    setSkills((prev) =>
      prev.map((s) => {
        if (s.id !== skill.id) return s
        const nextTargets = next
          ? Array.from(new Set([...s.enabledTargets, targetId]))
          : s.enabledTargets.filter((t) => t !== targetId)
        return { ...s, enabledTargets: nextTargets }
      })
    )

    notify(
      next
        ? `已将 Skill [${skill.name}] 同步分发至 ${APP_SHORT_NAMES[targetId]}`
        : `已从 ${APP_SHORT_NAMES[targetId]} 移除 Skill [${skill.name}]`
    )

    // 2. Asynchronous backend disk sync without full-app re-scanning
    try {
      const res = await clientApi.toggleSkillTarget(skill.id, targetId, next)
      if (res && Array.isArray(res.skills)) {
        setSkills(res.skills)
      }
    } catch (e: any) {
      // Revert on failure
      setSkills((prev) =>
        prev.map((s) => {
          if (s.id !== skill.id) return s
          const reverted = exists
            ? Array.from(new Set([...s.enabledTargets, targetId]))
            : s.enabledTargets.filter((t) => t !== targetId)
          return { ...s, enabledTargets: reverted }
        })
      )
      notify(`Skill 同步失败: ${e.message}`)
    }
  }

  const handleSyncAllSkills = async () => {
    try {
      const res = await clientApi.syncAllSkills()
      notify(`已完成全量同步！共 ${res.syncedCount} 个 Skill 同步至各大客户端`)
      await refreshAll()
    } catch (e: any) {
      notify(`全量同步失败: ${e.message}`)
    }
  }

  const handleOpenSkillsFolder = async () => {
    try {
      await clientApi.openSkillsFolder()
    } catch (e: any) {
      notify(`打开大本营失败: ${e.message}`)
    }
  }

  const handleViewSkillContent = async (skill: UnifiedSkill) => {
    try {
      const content = await clientApi.getSkillContent(skill.id)
      setViewingSkillContent({ id: skill.id, name: skill.name, content })
    } catch (e: any) {
      notify(`读取 Skill 内容失败: ${e.message}`)
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-app text-[13px] leading-[20px] text-fg-1 select-none">
      {/* ─── Left Sidebar (CC Switch v7 Style) ─────────────────────────────── */}
      <nav
        style={{ width: collapsed ? 68 : 210 }}
        className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-150"
      >
        {/* Top Brand Row */}
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          {!collapsed && (
            <div className="flex items-center gap-2 ps-1">
              <div className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] bg-action text-action-fg shadow-sm">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <span className="text-[14px] font-semibold tracking-tight text-fg-1">
                CC Switch
              </span>
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            className="flex h-7 w-7 items-center justify-center rounded-control text-fg-2 transition hover:bg-subtle hover:text-fg-1"
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" />
            ) : (
              <ChevronsLeft className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* App Directory (Grouped cleanly by Desktop vs CLI) */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden py-1">
          {/* Desktop Category */}
          {!collapsed && (
            <div className="px-4 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-3">
              Desktop 桌面端
            </div>
          )}
          {desktopTargets.map((t) => {
            const selected = view === 'app' && activeAppId === t.id
            const isRoute = t.proxyEnabled
            return (
              <button
                key={t.id}
                onClick={() => {
                  setActiveAppId(t.id)
                  setView('app')
                }}
                title={collapsed ? `${APP_SHORT_NAMES[t.id]} (Desktop)` : undefined}
                className={`mx-2 my-0.5 flex h-[30px] items-center gap-2.5 rounded-control px-2.5 text-start transition-colors ${
                  selected
                    ? 'bg-selected font-medium text-fg-1'
                    : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
                }`}
              >
                <AppGlyph appId={t.id} size={17} />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate">{APP_SHORT_NAMES[t.id]}</span>
                    {isRoute ? (
                      <span className="h-[18px] rounded-full bg-route-soft px-1.5 text-[11px] leading-[18px] text-route-text">
                        路由
                      </span>
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-direct" title="直连" />
                    )}
                  </>
                )}
              </button>
            )
          })}

          {/* CLI Category */}
          {!collapsed && (
            <div className="mt-3 px-4 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-fg-3">
              CLI 终端工具
            </div>
          )}
          {cliTargets.map((t) => {
            const selected = view === 'app' && activeAppId === t.id
            const isRoute = t.proxyEnabled
            return (
              <button
                key={t.id}
                onClick={() => {
                  setActiveAppId(t.id)
                  setView('app')
                }}
                title={collapsed ? `${APP_SHORT_NAMES[t.id]} (CLI)` : undefined}
                className={`mx-2 my-0.5 flex h-[30px] items-center gap-2.5 rounded-control px-2.5 text-start transition-colors ${
                  selected
                    ? 'bg-selected font-medium text-fg-1'
                    : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
                }`}
              >
                <AppGlyph appId={t.id} size={17} />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate">{APP_SHORT_NAMES[t.id]}</span>
                    {isRoute ? (
                      <span className="h-[18px] rounded-full bg-route-soft px-1.5 text-[11px] leading-[18px] text-route-text">
                        路由
                      </span>
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-direct" title="直连" />
                    )}
                  </>
                )}
              </button>
            )
          })}
        </div>

        {/* Divider */}
        <div className="mx-3 my-1.5 h-px shrink-0 bg-border" />

        {/* Global Section (Matches CC Switch v7 Bottom Global Items) */}
        <div className="flex shrink-0 flex-col gap-0.5">
          <button
            onClick={() => setView('mcp')}
            className={`mx-2 flex h-[30px] items-center gap-2.5 rounded-control px-2.5 text-start transition-colors ${
              view === 'mcp'
                ? 'bg-selected font-medium text-fg-1'
                : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
            }`}
          >
            <Server className="h-4 w-4 shrink-0 text-fg-2" />
            {!collapsed && (
              <>
                <span className="flex-1 truncate">MCP</span>
                <span className="text-[11px] tabular-nums text-fg-3">
                  {store?.mcps.length || 0}
                </span>
              </>
            )}
          </button>

          <button
            onClick={() => setView('skills')}
            className={`mx-2 flex h-[30px] items-center gap-2.5 rounded-control px-2.5 text-start transition-colors ${
              view === 'skills'
                ? 'bg-selected font-medium text-fg-1'
                : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
            }`}
          >
            <Sparkles className="h-4 w-4 shrink-0 text-action" />
            {!collapsed && (
              <>
                <span className="flex-1 truncate">Skills 技能</span>
                <span className="rounded-full bg-action/10 px-1.5 font-mono text-[11px] font-semibold tabular-nums text-action">
                  {skills.length || 0}
                </span>
              </>
            )}
          </button>

          <button
            onClick={() => setView('sessions')}
            className={`mx-2 flex h-[30px] items-center gap-2.5 rounded-control px-2.5 text-start transition-colors ${
              view === 'sessions'
                ? 'bg-selected font-medium text-fg-1'
                : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
            }`}
          >
            <History className="h-4 w-4 shrink-0 text-fg-2" />
            {!collapsed && (
              <>
                <span className="flex-1 truncate">会话明细</span>
                <span className="text-[11px] tabular-nums text-fg-3">
                  {dashboard?.totalSessions || 0}
                </span>
              </>
            )}
          </button>

          <button
            onClick={() => setView('usage')}
            className={`mx-2 flex h-[30px] items-center gap-2.5 rounded-control px-2.5 text-start transition-colors ${
              view === 'usage'
                ? 'bg-selected font-medium text-fg-1'
                : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
            }`}
          >
            <ChartColumn className="h-4 w-4 shrink-0 text-fg-2" />
            {!collapsed && (
              <>
                <span className="shrink-0 grow">用量统计</span>
                {dashboard && (
                  <span className="text-end font-mono text-[11px] leading-[13px] tabular-nums text-fg-3">
                    <span className="block">{formatTokens(dashboard.totalInputTokens)}</span>
                    <span className="block text-route-text">
                      命中 {dashboard.overallCacheHitRate}%
                    </span>
                  </span>
                )}
              </>
            )}
          </button>
        </div>

        <div className="mx-3 my-1.5 h-px shrink-0 bg-border" />

        {/* Bottom Compact Row: 应用 & 设置 + 主题切换 */}
        <div
          className={`flex shrink-0 items-center pb-2.5 ${
            collapsed ? 'flex-col gap-1' : 'gap-1 px-2'
          }`}
        >
          <button
            onClick={() => setView('apps')}
            className={`flex h-[28px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control px-2 text-xs transition-colors ${
              view === 'apps'
                ? 'bg-selected font-medium text-fg-1'
                : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
            {!collapsed && <span className="truncate">应用</span>}
          </button>

          <button
            onClick={() => setView('settings')}
            className={`flex h-[28px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control px-2 text-xs transition-colors ${
              view === 'settings'
                ? 'bg-selected font-medium text-fg-1'
                : 'text-fg-2 hover:bg-subtle hover:text-fg-1'
            }`}
          >
            <Settings className="h-3.5 w-3.5 shrink-0" />
            {!collapsed && <span className="truncate">设置</span>}
          </button>

          <button
            onClick={() => setIsDark(!isDark)}
            title={isDark ? '切换浅色外观' : '切换深色外观'}
            className="flex h-[28px] w-7 shrink-0 items-center justify-center rounded-control text-fg-2 transition hover:bg-subtle hover:text-fg-1"
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </nav>

      {/* ─── Right Main Content Area ───────────────────────────────────────── */}
      <div id="content-area" className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-app">
        {/* Floating Toast Notification (Zero layout shift, completely eliminates screen jitter) */}
        {toast && (
          <div className="pointer-events-none fixed bottom-5 right-6 z-50 flex items-center gap-2 rounded-panel border border-action/40 bg-surface/95 px-4 py-2.5 text-xs font-medium text-fg-1 shadow-v7-lg backdrop-blur">
            <ShieldCheck className="h-4 w-4 shrink-0 text-action" />
            <span>{toast}</span>
          </div>
        )}

        {/* VIEW 1: PER-APP PROVIDER SWITCHER PAGE (Original CC Switch Core View) */}
        {view === 'app' && currentTarget && (
          <>
            {/* 52px AppPageHeader */}
            <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border pe-4 ps-6">
              <div className="flex items-center gap-2.5">
                <AppGlyph appId={currentTarget.id} size={20} />
                <h1 className="text-[16px] font-semibold text-fg-1">
                  {APP_SHORT_NAMES[currentTarget.id]}
                </h1>
                <span className="text-[13px] text-fg-3">供应商</span>
                <span
                  className={`ms-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    currentTarget.category === 'desktop'
                      ? 'bg-direct-soft text-direct-text'
                      : 'bg-route-soft text-route-text'
                  }`}
                >
                  {currentTarget.category === 'desktop' ? '🖥️ Desktop 桌面端' : '⌨️ CLI 终端工具'}
                </span>
                {currentTarget.running && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] text-success-text">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                    进程运行中
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={refreshAll}
                  className="flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-xs text-fg-2 transition hover:border-border-strong hover:text-fg-1"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                  刷新
                </button>
                <button
                  onClick={() => {
                    const isCodex = currentTarget.id === 'codex-desktop'
                    setEditingProvider({
                      id: `prov_${Date.now().toString(36)}`,
                      targetId: currentTarget.id,
                      name: isCodex
                        ? 'Codex 自定义 Responses 渠道'
                        : `${APP_SHORT_NAMES[currentTarget.id]} 自定义渠道`,
                      vendor: 'Custom',
                      baseUrl: isCodex ? 'https://api.openai.com/v1' : 'https://api.deepseek.com/v1',
                      apiKey: '',
                      defaultModel: isCodex ? 'gpt-5-codex' : 'deepseek-chat',
                      models: isCodex
                        ? ['gpt-5-codex', 'gpt-5', 'o3-mini']
                        : ['deepseek-chat', 'deepseek-reasoner'],
                      protocol: 'openai'
                    })
                  }}
                  className="flex h-8 items-center gap-1.5 rounded-control bg-action px-3 text-xs font-medium text-action-fg shadow-sm transition hover:bg-action-hover"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加 {APP_SHORT_NAMES[currentTarget.id]} 专属供应商
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {/* Mode Bar (Direct vs Route Gateway) + Real-time Cache Hit Rate Strip */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-border bg-surface px-4 py-3 shadow-v7-sm">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {/* Segmented Mode Control */}
                  <div className="inline-flex shrink-0 rounded-control bg-subtle p-0.5">
                    <button
                      onClick={() => {
                        const activeProv =
                          store?.activeProviderByTarget?.[currentTarget.id] ||
                          currentTargetProviders[0]?.id
                        if (activeProv && currentTarget.capabilities.providerSwitch) {
                          handleSwitchProvider(currentTarget.id, activeProv, 'direct')
                        }
                      }}
                      className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-3 text-xs font-medium transition ${
                        currentMode === 'direct'
                          ? 'bg-surface text-direct-text shadow-v7-sm'
                          : 'text-fg-2 hover:text-fg-1'
                      }`}
                    >
                      <Plug className="h-3.5 w-3.5 shrink-0" />
                      直连模式 (Direct)
                    </button>
                    <button
                      onClick={() => {
                        const activeProv =
                          store?.activeProviderByTarget?.[currentTarget.id] ||
                          currentTargetProviders[0]?.id
                        if (activeProv && currentTarget.capabilities.providerSwitch) {
                          handleSwitchProvider(currentTarget.id, activeProv, 'gateway')
                        }
                      }}
                      className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-3 text-xs font-medium transition ${
                        currentMode === 'gateway'
                          ? 'bg-surface text-route-text shadow-v7-sm'
                          : 'text-fg-2 hover:text-fg-1'
                      }`}
                    >
                      <Route className="h-3.5 w-3.5 shrink-0" />
                      本地路由网关 (Proxy · 免重启统计缓存率)
                    </button>
                  </div>

                  <span
                    className="min-w-0 truncate text-xs text-fg-3"
                    title={
                      currentMode === 'gateway'
                        ? `已接管至 ${currentTarget.proxyEndpoint}`
                        : `直接改写 ${currentTarget.configPaths.mainConfig}`
                    }
                  >
                    {currentMode === 'gateway'
                      ? `已接管至 ${currentTarget.proxyEndpoint}`
                      : `直接改写 ${currentTarget.configPaths.mainConfig}`}
                  </span>
                </div>

                {/* Live Cache Hit & Output Speed Pill for this App */}
                {currentSummary && (
                  <div className="flex shrink-0 items-center gap-3.5 whitespace-nowrap text-xs">
                    <div>
                      <span className="text-fg-3">累计输入: </span>
                      <span className="font-mono font-semibold text-fg-1">
                        {formatTokens(currentSummary.inputTokens)}
                      </span>
                    </div>
                    <div>
                      <span className="text-fg-3">缓存命中: </span>
                      <span className="font-mono font-semibold text-success-text">
                        {formatTokens(currentSummary.cachedTokens)}
                      </span>
                    </div>
                    {currentSummary.latestOutputTokensPerSec && (
                      <div
                        className="flex items-center gap-1 rounded-full bg-direct-soft px-2.5 py-0.5 font-mono font-semibold text-direct-text"
                        title={`最近一次输出耗时 ${formatDuration(currentSummary.latestDurationMs)} · 近期平均速度 ${currentSummary.avgOutputTokensPerSec ?? '-'} tok/s`}
                      >
                        <Activity className="h-3 w-3 shrink-0" />
                        {currentSummary.latestOutputTokensPerSec} tok/s
                        {currentSummary.latestDurationMs ? (
                          <span className="text-[10px] opacity-80">
                            · {formatDuration(currentSummary.latestDurationMs)}
                          </span>
                        ) : null}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 rounded-full bg-route-soft px-2.5 py-0.5 font-mono font-semibold text-route-text">
                      <Zap className="h-3 w-3 shrink-0" />
                      缓存率 {currentSummary.cacheHitRate}%
                      {currentSummary.estimated && (
                        <span className="text-[10px] opacity-75">(估算)</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Provider Card List (CC Switch v7 ProviderCard Architecture) */}
              <div className="space-y-2.5">
                {/* Official / Native Built-in Card */}
                <div
                  className={`group relative rounded-panel border transition duration-150 ${
                    !currentTarget.proxyEnabled
                      ? 'border-direct-border bg-direct-soft'
                      : 'border-border bg-surface hover:border-border-strong hover:shadow-v7-sm'
                  }`}
                >
                  <div className="flex min-h-[58px] items-center gap-3 py-2.5 pe-3 ps-2">
                    <span className="flex w-4 shrink-0 justify-center text-fg-3 opacity-40">
                      <GripVertical className="h-4 w-4" />
                    </span>
                    <AppGlyph appId={currentTarget.id} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-[14px] font-medium text-fg-1">
                          {APP_SHORT_NAMES[currentTarget.id]} 原生当前配置 ({currentTarget.currentProvider})
                        </h3>
                        <span className="shrink-0 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-2">
                          官方 / 原生配置文件
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-xs text-fg-2">
                        <span className="min-w-0 truncate" title={currentTarget.configPaths.mainConfig}>
                          {currentTarget.configPaths.mainConfig}
                        </span>
                        <span className="shrink-0 whitespace-nowrap">
                          · 模型: {currentTarget.currentModel}
                        </span>
                      </div>
                    </div>

                    {/* Right Quota & Status Column */}
                    <div className="flex shrink-0 items-center gap-4">
                      {currentSummary && (
                        <div className="whitespace-nowrap text-end text-xs">
                          <div className="font-mono font-medium text-fg-1">
                            命中率 {currentSummary.cacheHitRate}% ·{' '}
                            {formatTokens(currentSummary.totalTokens)} tokens
                            {currentSummary.latestOutputTokensPerSec
                              ? ` · ⚡ ${currentSummary.latestOutputTokensPerSec} tok/s`
                              : ''}
                          </div>
                          <div className="text-[11px] text-fg-3">
                            近期 {currentSummary.sessionCount} 个会话
                            {currentSummary.avgOutputTokensPerSec
                              ? ` · 均速 ${currentSummary.avgOutputTokensPerSec} tok/s`
                              : ''}{' '}
                            · 已挂载 {currentTarget.mcpCount} 个 MCP
                          </div>
                        </div>
                      )}
                      <div className="flex min-w-20 shrink-0 items-center justify-end whitespace-nowrap">
                        {!currentTarget.proxyEnabled ? (
                          <span className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-fg-1">
                            <span className="h-2 w-2 rounded-full bg-direct" />
                            使用中
                          </span>
                        ) : (
                          <span className="text-xs text-fg-3">待命</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Custom / Third-party Provider Cards (Strictly Isolated to currentTarget) */}
                {currentTargetProviders.length === 0 && (
                  <div className="rounded-panel border border-dashed border-border bg-surface/40 px-4 py-6 text-center text-xs text-fg-3">
                    当前 {APP_SHORT_NAMES[currentTarget.id]} 暂无自定义第三方 API 供应商（与其他软件列表完全独立，互不干扰）。点击右上角「+ 添加 {APP_SHORT_NAMES[currentTarget.id]} 专属供应商」即可单独添加。
                  </div>
                )}
                {currentTargetProviders.map((prov) => {
                  const isCurrentForApp =
                    store?.activeProviderByTarget?.[currentTarget.id] === prov.id
                  const cardToneClass = isCurrentForApp
                    ? currentMode === 'gateway'
                      ? 'border-route-border bg-route-soft'
                      : 'border-direct-border bg-direct-soft'
                    : 'border-border bg-surface hover:border-border-strong hover:shadow-v7-sm'

                  return (
                    <div
                      key={`${currentTarget.id}-${prov.id}`}
                      className={`group relative rounded-panel border transition duration-150 ${cardToneClass}`}
                    >
                      <div className="flex min-h-[58px] items-center gap-3 py-2.5 pe-3 ps-2">
                        <span className="flex w-4 shrink-0 cursor-grab justify-center text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">
                          <GripVertical className="h-4 w-4" />
                        </span>

                        <ProviderBadge name={prov.name} />

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <h3 className="truncate text-[14px] font-medium text-fg-1">
                              {prov.name}
                            </h3>
                            <span className="rounded-full bg-subtle px-2 py-0.5 font-mono text-[11px] text-fg-2">
                              {prov.defaultModel}
                            </span>
                            {prov.models.length > 1 && (
                              <span className="text-[11px] text-fg-3">
                                +{prov.models.length - 1} 模型
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-fg-2">
                            <span className="truncate">{prov.baseUrl}</span>
                          </div>
                        </div>

                        {/* Right Action Area (Matches ProviderCardActions.tsx) */}
                        <div className="flex shrink-0 items-center gap-2">
                          <div className="flex min-w-24 items-center justify-end gap-1">
                            {isCurrentForApp ? (
                              <span className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-fg-1">
                                <span
                                  className={`h-2 w-2 rounded-full ${
                                    currentMode === 'gateway' ? 'bg-route' : 'bg-direct'
                                  }`}
                                />
                                {currentMode === 'gateway' ? '路由中' : '已激活'}
                              </span>
                            ) : (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() =>
                                    handleSwitchProvider(currentTarget.id, prov.id, 'gateway')
                                  }
                                  title="通过本地路由网关启用（免重启统计缓存率）"
                                  className="flex h-7 items-center gap-1 rounded-control bg-route px-2.5 text-xs font-medium text-white shadow-sm transition hover:opacity-90"
                                >
                                  <Route className="h-3.5 w-3.5" />
                                  路由启用
                                </button>
                                <button
                                  onClick={() =>
                                    handleSwitchProvider(currentTarget.id, prov.id, 'direct')
                                  }
                                  title="直接写入目标客户端配置文件"
                                  className="flex h-7 items-center gap-1 rounded-control border border-border bg-surface px-2.5 text-xs text-fg-1 transition hover:bg-subtle"
                                >
                                  <Play className="h-3.5 w-3.5" />
                                  直连
                                </button>
                              </div>
                            )}
                          </div>

                          <button
                            onClick={() => setEditingProvider({ ...prov, targetId: currentTarget.id })}
                            title="编辑供应商"
                            className="flex h-7 w-7 items-center justify-center rounded-control text-fg-2 transition hover:bg-subtle hover:text-fg-1"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>

                          <button
                            onClick={async () => {
                              await clientApi.deleteProvider(currentTarget.id, prov.id)
                              notify(`已从 ${APP_SHORT_NAMES[currentTarget.id]} 删除供应商 ${prov.name}`)
                              await refreshAll()
                            }}
                            title="删除供应商"
                            className="flex h-7 w-7 items-center justify-center rounded-control text-fg-2 transition hover:bg-danger-soft hover:text-danger-text"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {/* VIEW 2: USAGE & CACHE HIT RATE DASHBOARD (Matches CC Switch UsagePage) */}
        {view === 'usage' && dashboard && (
          <>
            <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border pe-4 ps-6">
              <div className="flex items-center gap-2.5">
                <ChartColumn className="h-5 w-5 text-fg-1" />
                <h1 className="text-[18px] font-semibold text-fg-1">用量统计与缓存命中率</h1>
              </div>
              <button
                onClick={refreshAll}
                className="flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-xs text-fg-2 hover:text-fg-1"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                刷新统计
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {/* Hero Metric Strip */}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-panel border border-border bg-surface p-4 shadow-v7-sm">
                  <div className="text-xs text-fg-3">总输入 Tokens (含缓存)</div>
                  <div className="mt-1.5 font-mono text-[24px] font-semibold leading-[32px] text-fg-1">
                    {formatTokens(dashboard.totalInputTokens)}
                  </div>
                  <div className="mt-1 text-xs text-fg-3">
                    未缓存新鲜输入:{' '}
                    {formatTokens(dashboard.totalInputTokens - dashboard.totalCachedTokens)}
                  </div>
                </div>

                <div className="rounded-panel border border-route-border bg-route-soft p-4">
                  <div className="text-xs font-medium text-route-text">
                    Prompt 缓存命中 (Cache Read)
                  </div>
                  <div className="mt-1.5 font-mono text-[24px] font-semibold leading-[32px] text-route-text">
                    {formatTokens(dashboard.totalCachedTokens)}
                  </div>
                  <div className="mt-1 text-xs text-route-text opacity-80">
                    命中缓存免除重复 Prefill 计算
                  </div>
                </div>

                <div className="rounded-panel border border-border bg-surface p-4 shadow-v7-sm">
                  <div className="text-xs text-fg-3">综合缓存命中率 (Hit Rate)</div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="font-mono text-[24px] font-semibold leading-[32px] text-action">
                      {dashboard.overallCacheHitRate}%
                    </span>
                    <span className="text-xs text-fg-3">({dashboard.totalSessions} 会话)</span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-subtle">
                    <div
                      className="h-full bg-action"
                      style={{ width: `${Math.min(100, dashboard.overallCacheHitRate)}%` }}
                    />
                  </div>
                </div>

                <div className="rounded-panel border border-border bg-surface p-4 shadow-v7-sm">
                  <div className="text-xs text-fg-3">总输出 / 思考推理 Tokens</div>
                  <div className="mt-1.5 font-mono text-[24px] font-semibold leading-[32px] text-fg-1">
                    {formatTokens(dashboard.totalOutputTokens + dashboard.totalReasoningTokens)}
                  </div>
                  <div className="mt-1 text-xs text-fg-3">
                    输出 {formatTokens(dashboard.totalOutputTokens)} · 推理{' '}
                    {formatTokens(dashboard.totalReasoningTokens)}
                  </div>
                </div>
              </div>

              {/* Per-App Comparison Table (Desktop vs CLI) */}
              <div className="rounded-panel border border-border bg-surface p-4 shadow-v7-sm">
                <h3 className="mb-3 text-[14px] font-semibold text-fg-1">
                  各客户端用量与缓存效率对比 (按 Desktop / CLI 分类)
                </h3>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-fg-3">
                      <th className="pb-2.5">客户端应用</th>
                      <th className="pb-2.5">分类</th>
                      <th className="pb-2.5 text-right">近期会话数</th>
                      <th className="pb-2.5 text-right">总输入 Tokens</th>
                      <th className="pb-2.5 text-right">缓存命中 Tokens</th>
                      <th className="pb-2.5 text-right">缓存命中率</th>
                      <th className="pb-2.5 text-right">输出 / 推理</th>
                      <th className="pb-2.5 text-right">最新速度 / 均速</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dashboard.byTarget.map((t) => (
                      <tr key={t.targetId} className="hover:bg-subtle/60">
                        <td className="py-3 font-medium text-fg-1">
                          <div className="flex items-center gap-2">
                            <AppGlyph appId={t.targetId} size={16} />
                            <span>{t.targetName}</span>
                            {t.estimated && (
                              <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] text-warning-text">
                                估算
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] ${
                              t.category === 'desktop'
                                ? 'bg-direct-soft text-direct-text'
                                : 'bg-route-soft text-route-text'
                            }`}
                          >
                            {t.category === 'desktop' ? 'Desktop' : 'CLI'}
                          </span>
                        </td>
                        <td className="py-3 text-right font-mono text-fg-2">{t.sessionCount}</td>
                        <td className="py-3 text-right font-mono text-fg-1">
                          {formatTokens(t.inputTokens)}
                        </td>
                        <td className="py-3 text-right font-mono text-route-text">
                          {formatTokens(t.cachedTokens)}
                        </td>
                        <td className="py-3 text-right">
                          <span className="rounded-full bg-route-soft px-2 py-0.5 font-mono font-semibold text-route-text">
                            {t.cacheHitRate}%
                          </span>
                        </td>
                        <td className="py-3 text-right font-mono text-fg-2">
                          {formatTokens(t.outputTokens)} / {formatTokens(t.reasoningTokens)}
                        </td>
                        <td className="py-3 text-right font-mono">
                          {t.latestOutputTokensPerSec ? (
                            <div className="inline-flex items-center gap-1.5">
                              <span className="rounded bg-direct-soft px-1.5 py-0.5 font-semibold text-direct-text">
                                {t.latestOutputTokensPerSec} tok/s
                              </span>
                              {t.avgOutputTokensPerSec && (
                                <span className="text-[11px] text-fg-3">
                                  (均 {t.avgOutputTokensPerSec})
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-fg-3">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* VIEW 3: SESSIONS LOG TABLE */}
        {view === 'sessions' && dashboard && (
          <>
            <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border pe-4 ps-6">
              <div className="flex items-center gap-2.5">
                <History className="h-5 w-5 text-fg-1" />
                <h1 className="text-[18px] font-semibold text-fg-1">会话级 Token 与缓存命中流水</h1>
              </div>
              <div className="flex items-center gap-1 rounded-control bg-subtle p-0.5">
                {[
                  { id: 'all', label: '全部' },
                  { id: 'codex-desktop', label: 'Codex' },
                  { id: 'workbuddy', label: 'WorkBuddy' },
                  { id: 'antigravity', label: 'Antigravity' },
                  { id: 'opencode', label: 'OpenCode' }
                ].map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setUsageFilter(f.id)}
                    className={`rounded-[5px] px-2.5 py-1 text-xs font-medium transition ${
                      usageFilter === f.id
                        ? 'bg-surface text-fg-1 shadow-v7-sm'
                        : 'text-fg-2 hover:text-fg-1'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="rounded-panel border border-border bg-surface shadow-v7-sm overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border bg-subtle/50 text-fg-3">
                      <th className="px-4 py-2.5">客户端</th>
                      <th className="px-4 py-2.5">会话标题</th>
                      <th className="px-4 py-2.5">模型</th>
                      <th className="px-4 py-2.5 text-right">总输入</th>
                      <th className="px-4 py-2.5 text-right">缓存命中</th>
                      <th className="px-4 py-2.5 text-right">命中率</th>
                      <th className="px-4 py-2.5 text-right">输出 / 思考</th>
                      <th className="px-4 py-2.5 text-right">输出速度 / 耗时</th>
                      <th className="px-4 py-2.5 text-right">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(usageFilter === 'all'
                      ? dashboard.recentStream
                      : dashboard.byTarget.find((b) => b.targetId === usageFilter)
                          ?.recentSessions || []
                    ).map((item) => (
                      <tr key={`${item.targetId}-${item.id}`} className="hover:bg-subtle/40">
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5 font-medium text-fg-1">
                              <AppGlyph appId={item.targetId} size={15} />
                              {APP_SHORT_NAMES[item.targetId]}
                            </span>
                          </td>
                          <td
                            className="max-w-xs truncate px-4 py-2.5 text-fg-1"
                            title={item.title}
                          >
                            {item.title}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-fg-2">{item.model}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-fg-1">
                            {formatTokens(item.inputTokens)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-route-text">
                            {formatTokens(item.cachedTokens)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span className="rounded-full bg-route-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-route-text">
                              {item.cacheHitRate}%
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-fg-2 whitespace-nowrap">
                            {formatTokens(item.outputTokens)} / {formatTokens(item.reasoningTokens)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap">
                            {item.outputTokensPerSec ? (
                              <span className="inline-flex items-center gap-1">
                                <span className="rounded bg-direct-soft px-1.5 py-0.5 text-[11px] font-semibold text-direct-text">
                                  {item.outputTokensPerSec} tok/s
                                </span>
                                {item.durationMs ? (
                                  <span className="text-[11px] text-fg-3">
                                    · {formatDuration(item.durationMs)}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-fg-3">-</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-fg-3 whitespace-nowrap">
                            {formatTime(item.updatedAt)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* VIEW 4: GLOBAL MCP SERVER MATRIX */}
        {view === 'mcp' && store && (
          <>
            <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border pe-4 ps-6">
              <div className="flex items-center gap-2.5">
                <Server className="h-5 w-5 text-fg-1" />
                <h1 className="text-[18px] font-semibold text-fg-1">MCP 服务器统一管理</h1>
                <span className="text-xs text-fg-3">一次配置，勾选即可同步至四大客户端</span>
              </div>
              <button
                onClick={() =>
                  setEditingMcp({
                    id: `mcp_${Date.now().toString(36)}`,
                    name: 'context7',
                    type: 'stdio',
                    command: 'npx',
                    args: ['-y', '@upstash/context7-mcp@latest'],
                    enabledTargets: ['codex-desktop', 'workbuddy', 'opencode']
                  })
                }
                className="flex h-8 items-center gap-1.5 rounded-control bg-action px-3 text-xs font-medium text-action-fg hover:bg-action-hover"
              >
                <Plus className="h-3.5 w-3.5" />
                添加 MCP
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-2.5">
              {store.mcps.map((m) => (
                <div
                  key={m.id}
                  className="flex min-h-[58px] items-center justify-between gap-4 rounded-panel border border-border bg-surface px-4 py-3 shadow-v7-sm"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold text-fg-1">{m.name}</span>
                      <span className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] uppercase text-fg-2">
                        {m.type}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-fg-3">
                      {m.type === 'remote' ? m.url : `${m.command} ${(m.args || []).join(' ')}`}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {(
                      ['codex-desktop', 'workbuddy', 'antigravity', 'opencode'] as TargetId[]
                    ).map((tid) => {
                      const active = m.enabledTargets.includes(tid)
                      return (
                        <button
                          key={tid}
                          onClick={() => handleToggleMcpTarget(m, tid)}
                          className={`flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-xs font-medium transition ${
                            active
                              ? 'border-route-border bg-route-soft text-route-text'
                              : 'border-border bg-subtle/40 text-fg-3 hover:text-fg-1'
                          }`}
                        >
                          <AppGlyph appId={tid} size={13} />
                          {APP_SHORT_NAMES[tid]}
                        </button>
                      )
                    })}
                    <button
                      onClick={async () => {
                        await clientApi.deleteMcp(m.id)
                        notify(`已移除 MCP ${m.name}`)
                        await refreshAll()
                      }}
                      className="ms-1 flex h-7 w-7 items-center justify-center rounded-control text-fg-3 hover:bg-danger-soft hover:text-danger-text"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* VIEW: UNIVERSAL SKILLS MATRIX */}
        {view === 'skills' && (
          <>
            <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border pe-4 ps-6">
              <div className="flex items-center gap-3">
                <Sparkles className="h-5 w-5 text-action" />
                <h1 className="text-[18px] font-semibold text-fg-1">Skill 技能统一管理</h1>
                <button
                  onClick={handleOpenSkillsFolder}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-subtle px-2.5 py-0.5 text-xs text-fg-2 hover:bg-surface hover:text-fg-1 transition"
                  title="点击在 Windows 资源管理器中打开大本营"
                >
                  <FolderOpen className="h-3 w-3 text-action" />
                  <span>
                    大本营: <span className="font-mono">{skillsHubPath || '~/.agents/skills'}</span>
                  </span>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleOpenSkillsFolder}
                  className="flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-xs text-fg-2 hover:text-fg-1"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  打开大本营
                </button>
                <button
                  onClick={handleSyncAllSkills}
                  className="flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-xs text-fg-2 hover:text-fg-1"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  一键全量同步
                </button>
                <button
                  onClick={() =>
                    setEditingSkill({
                      name: '',
                      description: '',
                      content: '',
                      enabledTargets: ['codex-desktop', 'workbuddy', 'antigravity', 'opencode']
                    })
                  }
                  className="flex h-8 items-center gap-1.5 rounded-control bg-action px-3 text-xs font-medium text-action-fg hover:bg-action-hover"
                >
                  <Plus className="h-3.5 w-3.5" />
                  新建 Skill
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {/* Filter and Search Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1 rounded-control bg-subtle p-0.5">
                  {(
                    [
                      { id: 'all', label: `全部 (${skills.length})` },
                      {
                        id: 'codex-desktop',
                        label: `Codex (${skills.filter((s) => s.enabledTargets.includes('codex-desktop')).length})`
                      },
                      {
                        id: 'workbuddy',
                        label: `WorkBuddy (${skills.filter((s) => s.enabledTargets.includes('workbuddy')).length})`
                      },
                      {
                        id: 'antigravity',
                        label: `Antigravity (${skills.filter((s) => s.enabledTargets.includes('antigravity')).length})`
                      },
                      {
                        id: 'opencode',
                        label: `OpenCode (${skills.filter((s) => s.enabledTargets.includes('opencode')).length})`
                      }
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setSkillTargetFilter(f.id)}
                      className={`rounded-[5px] px-2.5 py-1 text-xs font-medium transition ${
                        skillTargetFilter === f.id
                          ? 'bg-surface text-fg-1 shadow-v7-sm'
                          : 'text-fg-2 hover:text-fg-1'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                <div className="relative min-w-64">
                  <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
                  <input
                    type="text"
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="搜索 Skill 名称或描述..."
                    className="h-8 w-full rounded-control border border-border bg-surface ps-8 pe-3 text-xs text-fg-1 placeholder:text-fg-3 focus:border-border-strong focus:outline-none"
                  />
                </div>
              </div>

              {/* Skills List */}
              <div className="space-y-2.5">
                {skills
                  .filter((s) => {
                    const matchText =
                      !skillSearch ||
                      s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
                      s.description.toLowerCase().includes(skillSearch.toLowerCase())
                    const matchTarget =
                      skillTargetFilter === 'all' || s.enabledTargets.includes(skillTargetFilter)
                    return matchText && matchTarget
                  })
                  .map((s) => (
                    <div
                      key={s.id}
                      className="group flex min-h-[60px] items-center justify-between gap-4 rounded-panel border border-border bg-surface px-4 py-3 shadow-v7-sm hover:border-border-strong transition"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[14px] font-semibold text-fg-1">
                            {s.name}
                          </span>
                          {s.fileCount !== undefined && (
                            <span className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-fg-3">
                              {s.fileCount} 文件
                            </span>
                          )}
                          <span className="text-[11px] text-fg-3">
                            {formatTime(s.updatedAt || 0)}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-fg-2" title={s.description}>
                          {s.description || '暂无说明'}
                        </p>
                      </div>

                      {/* Right: Target Matrix Toggles */}
                      <div className="flex shrink-0 items-center gap-2">
                        {(
                          ['codex-desktop', 'workbuddy', 'antigravity', 'opencode'] as TargetId[]
                        ).map((tid) => {
                          const active = s.enabledTargets.includes(tid)
                          return (
                            <button
                              key={tid}
                              onClick={() => handleToggleSkillTarget(s, tid)}
                              title={
                                active
                                  ? `已同步至 ${APP_SHORT_NAMES[tid]} (点击取消并移除)`
                                  : `点击同步分发至 ${APP_SHORT_NAMES[tid]}`
                              }
                              className={`flex h-7 items-center gap-1.5 whitespace-nowrap rounded-control border px-2.5 text-xs font-medium transition ${
                                active
                                  ? 'border-route-border bg-route-soft text-route-text shadow-sm'
                                  : 'border-border bg-subtle/40 text-fg-3 hover:text-fg-1 hover:bg-subtle'
                              }`}
                            >
                              <AppGlyph appId={tid} size={13} />
                              <span>{APP_SHORT_NAMES[tid]}</span>
                              <span className="flex w-3.5 items-center justify-center">
                                {active ? (
                                  <Check className="h-3 w-3 stroke-[2.5]" />
                                ) : (
                                  <span className="h-1 w-1 rounded-full bg-fg-3/30" />
                                )}
                              </span>
                            </button>
                          )
                        })}

                        <button
                          onClick={() => handleViewSkillContent(s)}
                          title="查看并编辑 SKILL.md"
                          className="ms-1 flex h-7 w-7 items-center justify-center rounded-control text-fg-3 hover:bg-subtle hover:text-fg-1 transition"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>

                        <button
                          onClick={async () => {
                            if (
                              confirm(
                                `确定要从大本营删除 Skill [${s.name}] 吗？这也会从所有已同步客户端中清除。`
                              )
                            ) {
                              const res = await clientApi.deleteSkill(s.id)
                              setSkills(res.skills)
                              notify(`已删除 Skill [${s.name}]`)
                              await refreshAll()
                            }
                          }}
                          title="删除 Skill"
                          className="flex h-7 w-7 items-center justify-center rounded-control text-fg-3 hover:bg-danger-soft hover:text-danger-text transition"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}

                {skills.filter((s) => {
                  const matchText =
                    !skillSearch ||
                    s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
                    s.description.toLowerCase().includes(skillSearch.toLowerCase())
                  const matchTarget =
                    skillTargetFilter === 'all' || s.enabledTargets.includes(skillTargetFilter)
                  return matchText && matchTarget
                }).length === 0 && (
                  <div className="rounded-panel border border-dashed border-border bg-surface/40 p-8 text-center text-xs text-fg-3">
                    没有找到匹配的 Skill。大本营位于 {skillsHubPath || '~/.agents/skills'}
                    ，点击上方「新建 Skill」或直接在目录放入 Skill 文件夹即可自动识别。
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* VIEW 5: APPS OVERVIEW (Grouped by Desktop vs CLI) */}
        {view === 'apps' && (
          <>
            <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border pe-4 ps-6">
              <div className="flex items-center gap-2.5">
                <LayoutGrid className="h-5 w-5 text-fg-1" />
                <h1 className="text-[18px] font-semibold text-fg-1">应用分类管理 (Desktop & CLI)</h1>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <div>
                <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-fg-1">
                  <Monitor className="h-4 w-4 text-direct" />
                  Desktop 桌面应用 ({desktopTargets.length})
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {desktopTargets.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => {
                        setActiveAppId(t.id)
                        setView('app')
                      }}
                      className="cursor-pointer rounded-panel border border-border bg-surface p-4 shadow-v7-sm transition hover:border-border-strong"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <AppGlyph appId={t.id} size={24} />
                          <span className="font-semibold text-fg-1">{t.name}</span>
                        </div>
                        <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] text-success-text">
                          已识别
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-fg-3">{t.description}</p>
                      <div className="mt-3 truncate font-mono text-[11px] text-fg-2">
                        {t.configPaths.mainConfig}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-fg-1">
                  <Terminal className="h-4 w-4 text-route" />
                  CLI 终端工具 ({cliTargets.length})
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {cliTargets.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => {
                        setActiveAppId(t.id)
                        setView('app')
                      }}
                      className="cursor-pointer rounded-panel border border-border bg-surface p-4 shadow-v7-sm transition hover:border-border-strong"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <AppGlyph appId={t.id} size={24} />
                          <span className="font-semibold text-fg-1">{t.name}</span>
                        </div>
                        <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] text-success-text">
                          已识别
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-fg-3">{t.description}</p>
                      <div className="mt-3 truncate font-mono text-[11px] text-fg-2">
                        {t.configPaths.mainConfig}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {/* VIEW 6: SETTINGS */}
        {view === 'settings' && (
          <>
            <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border pe-4 ps-6">
              <div className="flex items-center gap-2.5">
                <Settings className="h-5 w-5 text-fg-1" />
                <h1 className="text-[18px] font-semibold text-fg-1">设置与本地网关状态</h1>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="rounded-panel border border-border bg-surface p-5 shadow-v7-sm space-y-3">
                <h3 className="text-[14px] font-semibold text-fg-1">本地透明路由与用量统计网关</h3>
                <p className="text-xs text-fg-2">
                  网关在后台监听本地端口，支持为 Codex、WorkBuddy、OpenCode 实时拦截计算 Prompt 缓存命中率，并在切换供应商时无需重启客户端。
                </p>
                <div className="grid grid-cols-1 gap-2 font-mono text-xs text-fg-2 sm:grid-cols-2">
                  <div className="rounded-control bg-subtle p-2.5">
                    Codex 端点: http://127.0.0.1:{dashboard?.proxyPort || 15721}/codex/v1
                  </div>
                  <div className="rounded-control bg-subtle p-2.5">
                    WorkBuddy 端点: http://127.0.0.1:{dashboard?.proxyPort || 15721}/workbuddy/v1/chat/completions
                  </div>
                  <div className="rounded-control bg-subtle p-2.5">
                    OpenCode 端点: http://127.0.0.1:{dashboard?.proxyPort || 15721}/opencode/v1
                  </div>
                  <div className="rounded-control bg-subtle p-2.5">
                    自动配置备份目录: ~/.ccswitch-lite/backups
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ─── Modal: Add / Edit Provider ───────────────────────────────────── */}
      {editingProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-dialog border border-border bg-surface p-6 shadow-v7-lg">
            <div className="flex items-center gap-2">
              <AppGlyph appId={editingProvider.targetId} size={20} />
              <h3 className="text-[16px] font-semibold text-fg-1">
                配置 {APP_SHORT_NAMES[editingProvider.targetId]} 专属供应商
              </h3>
            </div>
            <p className="mt-1 text-xs text-fg-3">
              该供应商仅归属于 {APP_SHORT_NAMES[editingProvider.targetId]}，不会影响其他软件的供应商列表
            </p>
            {editingProvider.targetId === 'codex-desktop' && (
              <div className="mt-2.5 rounded-control border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-accent">
                ⚡ <strong>Codex Responses 模式已自动接管</strong>：系统将自动配置 <code>wire_api = &quot;responses&quot;</code>，并把您输入的 API Key 自动同步注入为 Windows 用户环境变量与 <code>~/.codex/.env</code>，无需手动处理 <code>env_key</code>。
              </div>
            )}
            <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label className="text-xs text-fg-2">标识 ID</label>
                <input
                  value={editingProvider.id}
                  onChange={(e) => setEditingProvider({ ...editingProvider, id: e.target.value })}
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 text-xs text-fg-1"
                />
              </div>
              <div>
                <label className="text-xs text-fg-2">供应商名称</label>
                <input
                  value={editingProvider.name}
                  onChange={(e) => setEditingProvider({ ...editingProvider, name: e.target.value })}
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 text-xs text-fg-1"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-fg-2">请求地址 (Base URL)</label>
                <input
                  value={editingProvider.baseUrl}
                  onChange={(e) =>
                    setEditingProvider({ ...editingProvider, baseUrl: e.target.value })
                  }
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-fg-2">API Key</label>
                <input
                  type="password"
                  value={editingProvider.apiKey}
                  onChange={(e) =>
                    setEditingProvider({ ...editingProvider, apiKey: e.target.value })
                  }
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-fg-2">模型列表 (逗号分隔，首个为默认模型)</label>
                <input
                  value={editingProvider.models.join(', ')}
                  onChange={(e) => {
                    const list = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    setEditingProvider({
                      ...editingProvider,
                      models: list,
                      defaultModel: list[0] || ''
                    })
                  }}
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setEditingProvider(null)}
                className="h-8 rounded-control border border-border px-3.5 text-xs text-fg-2 hover:bg-subtle"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  await clientApi.saveProvider(editingProvider)
                  setEditingProvider(null)
                  notify('供应商已保存')
                  await refreshAll()
                }}
                className="h-8 rounded-control bg-action px-4 text-xs font-medium text-action-fg hover:bg-action-hover"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: Add / Edit MCP ────────────────────────────────────────── */}
      {editingMcp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-dialog border border-border bg-surface p-6 shadow-v7-lg">
            <h3 className="text-[16px] font-semibold text-fg-1">添加 MCP Server</h3>
            <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label className="text-xs text-fg-2">名称</label>
                <input
                  value={editingMcp.name}
                  onChange={(e) =>
                    setEditingMcp({ ...editingMcp, id: e.target.value, name: e.target.value })
                  }
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                />
              </div>
              <div>
                <label className="text-xs text-fg-2">类型</label>
                <select
                  value={editingMcp.type}
                  onChange={(e) =>
                    setEditingMcp({ ...editingMcp, type: e.target.value as 'stdio' | 'remote' })
                  }
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 text-xs text-fg-1"
                >
                  <option value="stdio">STDIO 本地命令</option>
                  <option value="remote">Remote HTTP 端点</option>
                </select>
              </div>
              {editingMcp.type === 'stdio' ? (
                <>
                  <div>
                    <label className="text-xs text-fg-2">命令 (Command)</label>
                    <input
                      value={editingMcp.command || ''}
                      onChange={(e) => setEditingMcp({ ...editingMcp, command: e.target.value })}
                      className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-fg-2">参数 (空格分隔)</label>
                    <input
                      value={(editingMcp.args || []).join(' ')}
                      onChange={(e) =>
                        setEditingMcp({
                          ...editingMcp,
                          args: e.target.value.split(/\s+/).filter(Boolean)
                        })
                      }
                      className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                    />
                  </div>
                </>
              ) : (
                <div className="sm:col-span-2">
                  <label className="text-xs text-fg-2">URL</label>
                  <input
                    value={editingMcp.url || ''}
                    onChange={(e) => setEditingMcp({ ...editingMcp, url: e.target.value })}
                    className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                  />
                </div>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setEditingMcp(null)}
                className="h-8 rounded-control border border-border px-3.5 text-xs text-fg-2 hover:bg-subtle"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  await clientApi.saveMcp(editingMcp)
                  setEditingMcp(null)
                  notify('MCP 已保存并同步至勾选客户端')
                  await refreshAll()
                }}
                className="h-8 rounded-control bg-action px-4 text-xs font-medium text-action-fg hover:bg-action-hover"
              >
                保存并同步
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: Add / Edit Skill ───────────────────────────────────────── */}
      {editingSkill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-dialog border border-border bg-surface p-6 shadow-v7-lg">
            <h3 className="text-[16px] font-semibold text-fg-1">
              {editingSkill.id ? '编辑 Skill' : '新建 Skill (写入大本营)'}
            </h3>
            <div className="mt-4 space-y-3.5">
              <div>
                <label className="text-xs text-fg-2">Skill 名称 / 目录名 (小写字母与连字符)</label>
                <input
                  value={editingSkill.name}
                  onChange={(e) => setEditingSkill({ ...editingSkill, name: e.target.value })}
                  placeholder="e.g. data-analysis"
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 font-mono text-xs text-fg-1"
                />
              </div>

              <div>
                <label className="text-xs text-fg-2">说明描述 (Prompt Trigger Description)</label>
                <input
                  value={editingSkill.description}
                  onChange={(e) =>
                    setEditingSkill({ ...editingSkill, description: e.target.value })
                  }
                  placeholder="简述该 Skill 的作用与在什么提问场景下激活..."
                  className="mt-1 w-full rounded-control border border-border bg-app px-3 py-1.5 text-xs text-fg-1"
                />
              </div>

              <div>
                <label className="text-xs text-fg-2">默认分发同步至客户端</label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {(['codex-desktop', 'workbuddy', 'antigravity', 'opencode'] as TargetId[]).map(
                    (tid) => {
                      const active = editingSkill.enabledTargets.includes(tid)
                      return (
                        <button
                          key={tid}
                          type="button"
                          onClick={() => {
                            const next = active
                              ? editingSkill.enabledTargets.filter((t) => t !== tid)
                              : [...editingSkill.enabledTargets, tid]
                            setEditingSkill({ ...editingSkill, enabledTargets: next })
                          }}
                          className={`flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-xs font-medium transition ${
                            active
                              ? 'border-route-border bg-route-soft text-route-text shadow-sm'
                              : 'border-border bg-subtle/40 text-fg-3 hover:text-fg-1'
                          }`}
                        >
                          <AppGlyph appId={tid} size={13} />
                          {APP_SHORT_NAMES[tid]}
                          {active && <Check className="h-3 w-3 stroke-[2.5]" />}
                        </button>
                      )
                    }
                  )}
                </div>
              </div>

              <div>
                <label className="text-xs text-fg-2">SKILL.md 正文内容</label>
                <textarea
                  rows={6}
                  value={editingSkill.content || ''}
                  onChange={(e) => setEditingSkill({ ...editingSkill, content: e.target.value })}
                  placeholder="# 指南与具体步骤..."
                  className="mt-1 w-full rounded-control border border-border bg-app p-2.5 font-mono text-xs text-fg-1 placeholder:text-fg-3 focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setEditingSkill(null)}
                className="h-8 rounded-control border border-border px-3.5 text-xs text-fg-2 hover:bg-subtle"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  try {
                    await clientApi.saveSkill(editingSkill)
                    setEditingSkill(null)
                    notify(`Skill [${editingSkill.name}] 已保存并同步`)
                    await refreshAll()
                  } catch (e: any) {
                    notify(`保存失败: ${e.message}`)
                  }
                }}
                className="h-8 rounded-control bg-action px-4 text-xs font-medium text-action-fg hover:bg-action-hover"
              >
                保存并同步
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: View / Edit SKILL.md Content ────────────────────────────── */}
      {viewingSkillContent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="flex h-[80vh] w-full max-w-2xl flex-col rounded-dialog border border-border bg-surface shadow-v7-lg">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-action" />
                <span className="font-semibold text-fg-1">{viewingSkillContent.name} / SKILL.md</span>
              </div>
              <button
                onClick={() => setViewingSkillContent(null)}
                className="rounded-control p-1 text-fg-3 hover:bg-subtle hover:text-fg-1"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              <textarea
                value={viewingSkillContent.content}
                onChange={(e) =>
                  setViewingSkillContent({ ...viewingSkillContent, content: e.target.value })
                }
                className="h-full w-full resize-none rounded-control border border-border bg-app p-3 font-mono text-xs leading-relaxed text-fg-1 focus:outline-none"
              />
            </div>

            <div className="flex h-12 shrink-0 items-center justify-between border-t border-border px-5">
              <span className="text-[11px] text-fg-3">
                保存后将自动更新至大本营及已勾选同步的各大客户端
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setViewingSkillContent(null)}
                  className="h-8 rounded-control border border-border px-3.5 text-xs text-fg-2 hover:bg-subtle"
                >
                  关闭
                </button>
                <button
                  onClick={async () => {
                    try {
                      await clientApi.saveSkill({
                        id: viewingSkillContent.id,
                        name: viewingSkillContent.name,
                        description: '',
                        content: viewingSkillContent.content
                      })
                      setViewingSkillContent(null)
                      notify(`Skill [${viewingSkillContent.name}] 修改已保存并分发`)
                      await refreshAll()
                    } catch (e: any) {
                      notify(`保存失败: ${e.message}`)
                    }
                  }}
                  className="h-8 rounded-control bg-action px-4 text-xs font-medium text-action-fg hover:bg-action-hover"
                >
                  保存并同步分发
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
