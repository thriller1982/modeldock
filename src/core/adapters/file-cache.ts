import fs from 'node:fs'

/**
 * Caches the result of parsing a file, keyed by path and invalidated when mtime or size changes.
 * Session logs (Codex rollout jsonl, WorkBuddy project jsonl) can be many MB, so re-parsing them
 * on every dashboard refresh would block the main process.
 */
export class FileParseCache<T> {
  private entries = new Map<string, { mtimeMs: number; size: number; value: T }>()

  get(filePath: string, parse: (content: string, mtimeMs: number) => T, context = ''): T | null {
    let st: fs.Stats
    try {
      st = fs.statSync(filePath)
    } catch {
      return null
    }
    const key = filePath + '\0' + context
    const hit = this.entries.get(key)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      return null
    }
    const value = parse(content, st.mtimeMs)
    this.entries.set(key, { mtimeMs: st.mtimeMs, size: st.size, value })
    return value
  }
}
