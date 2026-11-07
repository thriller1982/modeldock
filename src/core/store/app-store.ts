import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse } from 'smol-toml'
import { ProviderProfile, UnifiedMcpServer, UnifiedSkill, SessionUsageItem, SwitchMode, TargetId } from '../types'

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface AppDatabase {
  schemaVersion?: number
  proxyPort: number
  activeProviderByTarget: Partial<Record<TargetId, string>>
  modeByTarget: Partial<Record<TargetId, SwitchMode>>
  theme: ThemeSetting
  /** Strictly isolated per-target provider lists */
  providersByTarget: Record<TargetId, ProviderProfile[]>
  mcps: UnifiedMcpServer[]
  /** Path to universal skills hub (defaults to ~/.agents/skills) */
  skillsHubPath?: string
  /** Universal skills registered or synchronized */
  skills: UnifiedSkill[]
  proxyUsageLogs: SessionUsageItem[]
}

export const DATA_DIR = path.join(os.homedir(), '.ccswitch-lite')
export const DEFAULT_SKILLS_HUB = path.join(os.homedir(), '.agents', 'skills')
const DB_FILE = path.join(DATA_DIR, 'store.json')
export const BACKUP_DIR = path.join(DATA_DIR, 'backups')

export function ensureAppDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

export function createBackup(filePath: string, targetId: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    ensureAppDirs()
    const ext = path.extname(filePath)
    const base = path.basename(filePath, ext)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(BACKUP_DIR, `${targetId}-${base}-${stamp}${ext}.bak`)
    fs.copyFileSync(filePath, dest)
    return dest
  } catch {
    return null
  }
}

function discoverIsolatedProviders(): Record<TargetId, ProviderProfile[]> {
  const result: Record<TargetId, ProviderProfile[]> = {
    'codex-desktop': [],
    workbuddy: [],
    antigravity: [],
    opencode: []
  }

  // 1. Discover OpenCode's own providers from ~/.config/opencode/opencode.json
  try {
    const ocPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
    if (fs.existsSync(ocPath)) {
      const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'))
      if (oc.providers && typeof oc.providers === 'object') {
        for (const [key, val] of Object.entries<any>(oc.providers)) {
          const modelKeys = Object.keys(val.models || {})
          result.opencode.push({
            id: key,
            targetId: 'opencode',
            name: val.name || key.toUpperCase(),
            vendor: key,
            baseUrl: val.settings?.baseURL || '',
            apiKey: val.settings?.apiKey || '',
            defaultModel: modelKeys[0] || 'gpt-4o',
            models: modelKeys,
            protocol: 'openai'
          })
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. Discover Codex's own model_providers from ~/.codex/config.toml
  try {
    const codexPath = path.join(os.homedir(), '.codex', 'config.toml')
    if (fs.existsSync(codexPath)) {
      const parsed = parse(fs.readFileSync(codexPath, 'utf8')) as Record<string, any>
      const defaultModel = String(parsed.model || 'gpt-5-codex')
      if (parsed.model_providers && typeof parsed.model_providers === 'object') {
        for (const [key, val] of Object.entries<any>(parsed.model_providers)) {
          if (key === 'ccswitch_proxy') continue
          result['codex-desktop'].push({
            id: key,
            targetId: 'codex-desktop',
            name: val.name || key,
            vendor: key,
            baseUrl: val.base_url || '',
            apiKey: val.env_key || '',
            defaultModel,
            models: [defaultModel],
            protocol: 'openai'
          })
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Discover WorkBuddy's own models from ~/.workbuddy/models.json
  try {
    const wbModelsPath = path.join(os.homedir(), '.workbuddy', 'models.json')
    if (fs.existsSync(wbModelsPath)) {
      const parsed = JSON.parse(fs.readFileSync(wbModelsPath, 'utf8'))
      if (Array.isArray(parsed.models)) {
        for (const m of parsed.models) {
          const id = String(m.id || m.name || 'custom')
          result.workbuddy.push({
            id,
            targetId: 'workbuddy',
            name: m.name || id,
            vendor: m.vendor || 'Custom',
            baseUrl: String(m.url || '').replace(/\/chat\/completions$/, ''),
            apiKey: m.apiKey || '',
            defaultModel: id,
            models: [id],
            protocol: 'openai'
          })
        }
      }
    }
  } catch {
    // ignore
  }

  return result
}

function discoverInitialMcps(): UnifiedMcpServer[] {
  const mcps: UnifiedMcpServer[] = []
  try {
    const ocPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
    if (fs.existsSync(ocPath)) {
      const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'))
      if (oc.mcp?.servers) {
        for (const [name, srv] of Object.entries<any>(oc.mcp.servers)) {
          const isRemote = srv.type === 'remote' || !!srv.url
          mcps.push({
            id: name,
            name,
            type: isRemote ? 'remote' : 'stdio',
            command: Array.isArray(srv.command) ? srv.command[0] : srv.command,
            args: Array.isArray(srv.command) ? srv.command.slice(1) : srv.args || [],
            url: srv.url,
            headers: srv.headers,
            enabledTargets: ['opencode']
          })
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const wbMcpPath = path.join(os.homedir(), '.workbuddy', 'mcp.json')
    if (fs.existsSync(wbMcpPath)) {
      const wb = JSON.parse(fs.readFileSync(wbMcpPath, 'utf8'))
      if (wb.mcpServers) {
        for (const [name, srv] of Object.entries<any>(wb.mcpServers)) {
          const existing = mcps.find((m) => m.name === name)
          if (existing) {
            if (!existing.enabledTargets.includes('workbuddy')) {
              existing.enabledTargets.push('workbuddy')
            }
          } else {
            mcps.push({
              id: name,
              name,
              type: srv.url ? 'remote' : 'stdio',
              command: srv.command,
              args: srv.args || [],
              env: srv.env,
              url: srv.url,
              enabledTargets: ['workbuddy']
            })
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return mcps
}

function getInitialStore(): AppDatabase {
  const providersByTarget = discoverIsolatedProviders()
  const mcps = discoverInitialMcps()

  return {
    schemaVersion: 2,
    proxyPort: 15721,
    activeProviderByTarget: {
      'codex-desktop': providersByTarget['codex-desktop'][0]?.id,
      workbuddy: providersByTarget.workbuddy[0]?.id,
      antigravity: providersByTarget.antigravity[0]?.id,
      opencode: providersByTarget.opencode[0]?.id
    },
    modeByTarget: {},
    theme: 'system',
    providersByTarget,
    mcps,
    skillsHubPath: DEFAULT_SKILLS_HUB,
    skills: [],
    proxyUsageLogs: []
  }
}

function migrate(raw: any): AppDatabase {
  // If old v1 store had a flat shared `providers` array, re-initialize per-target isolated lists from disk
  if (!raw || raw.schemaVersion !== 2 || !raw.providersByTarget) {
    const fresh = getInitialStore()
    return {
      ...fresh,
      proxyPort: raw?.proxyPort || 15721,
      theme: raw?.theme || 'system',
      mcps: Array.isArray(raw?.mcps) && raw.mcps.length > 0 ? raw.mcps : fresh.mcps,
      skillsHubPath: raw?.skillsHubPath || DEFAULT_SKILLS_HUB,
      skills: Array.isArray(raw?.skills) ? raw.skills : [],
      proxyUsageLogs: Array.isArray(raw?.proxyUsageLogs) ? raw.proxyUsageLogs : []
    }
  }

  return {
    schemaVersion: 2,
    proxyPort: raw.proxyPort || 15721,
    activeProviderByTarget: raw.activeProviderByTarget || {},
    modeByTarget: raw.modeByTarget || {},
    theme: raw.theme || 'system',
    providersByTarget: {
      'codex-desktop': raw.providersByTarget['codex-desktop'] || [],
      workbuddy: raw.providersByTarget.workbuddy || [],
      antigravity: raw.providersByTarget.antigravity || [],
      opencode: raw.providersByTarget.opencode || []
    },
    mcps: raw.mcps || [],
    skillsHubPath: raw.skillsHubPath || DEFAULT_SKILLS_HUB,
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    proxyUsageLogs: raw.proxyUsageLogs || []
  }
}

export function loadStore(): AppDatabase {
  ensureAppDirs()
  if (!fs.existsSync(DB_FILE)) {
    const init = getInitialStore()
    saveStore(init)
    return init
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    const migrated = migrate(raw)
    if (raw.schemaVersion !== 2) {
      saveStore(migrated)
    }
    return migrated
  } catch {
    return getInitialStore()
  }
}

export function saveStore(data: AppDatabase): void {
  ensureAppDirs()
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8')
}
