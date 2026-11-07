import http from 'node:http'
import { loadStore, saveStore } from '../store/app-store'
import { SessionUsageItem, TargetCategory, TargetId } from '../types'

const ROUTE_TO_TARGET: Record<string, { id: TargetId; name: string; category: TargetCategory }> = {
  codex: { id: 'codex-desktop', name: 'Codex 桌面版', category: 'desktop' },
  workbuddy: { id: 'workbuddy', name: 'WorkBuddy', category: 'desktop' },
  antigravity: { id: 'antigravity', name: 'Google Antigravity', category: 'desktop' },
  opencode: { id: 'opencode', name: 'OpenCode', category: 'cli' }
}

export class LocalUsageProxy {
  private server: http.Server | null = null
  private running = false
  private currentPort = 15721

  isRunning(): boolean {
    return this.running
  }

  getPort(): number {
    return this.currentPort
  }

  start(port = 15721): Promise<boolean> {
    if (this.running) return Promise.resolve(true)
    this.currentPort = port

    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        try {
          const urlStr = req.url || '/'
          if (urlStr === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok', port: this.currentPort }))
            return
          }

          // Match /:route/v1/...
          const match = urlStr.match(/^\/(codex|workbuddy|antigravity|opencode)(\/.*)$/)
          const routeKey = match ? match[1] : 'opencode'
          const subPath = match ? match[2] : urlStr
          const targetMeta = ROUTE_TO_TARGET[routeKey] || ROUTE_TO_TARGET.opencode

          const store = loadStore()
          const targetProviders = store.providersByTarget?.[targetMeta.id] || []
          const activeProvId =
            store.activeProviderByTarget[targetMeta.id] || targetProviders[0]?.id
          const provider =
            targetProviders.find((p) => p.id === activeProvId) || targetProviders[0]

          if (!provider || !provider.baseUrl) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'No active upstream provider configured in CCSwitch' }))
            return
          }

          // Build upstream URL
          const base = provider.baseUrl.replace(/\/$/, '')
          const baseEndsWithV1 = /\/v1$/i.test(base)
          const subStartsWithV1 = /^\/v1/i.test(subPath)

          let finalPath = subPath
          if (baseEndsWithV1 && subStartsWithV1) {
            finalPath = subPath.replace(/^\/v1/i, '')
          }
          const upstreamUrl = `${base}${finalPath}`

          const chunks: Buffer[] = []
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk))
          }
          const bodyBuf = Buffer.concat(chunks)

          let reqModel = provider.defaultModel
          try {
            if (bodyBuf.length > 0) {
              const reqJson = JSON.parse(bodyBuf.toString('utf8'))
              if (reqJson.model) reqModel = reqJson.model
              // Inject stream_options.include_usage if streaming so SSE emits usage chunk
              if (reqJson.stream && !reqJson.stream_options) {
                reqJson.stream_options = { include_usage: true }
              }
            }
          } catch {
            // ignore
          }

          const reqStartMs = Date.now()
          const upstreamRes = await fetch(upstreamUrl, {
            method: req.method || 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${provider.apiKey}`
            },
            body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuf : undefined
          })

          res.writeHead(upstreamRes.status, {
            'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })

          let fullResponseText = ''
          if (upstreamRes.body) {
            const reader = upstreamRes.body.getReader()
            const decoder = new TextDecoder()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                res.write(value)
                fullResponseText += decoder.decode(value, { stream: true })
              }
            }
          }
          res.end()
          const durationMs = Math.max(1, Date.now() - reqStartMs)

          this.extractAndRecordUsage(
            fullResponseText,
            targetMeta,
            provider.name,
            reqModel,
            durationMs
          )
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
          }
          res.end(JSON.stringify({ error: err?.message || 'Proxy error' }))
        }
      })

      this.server.on('error', () => {
        this.running = false
        resolve(false)
      })

      this.server.listen(port, '127.0.0.1', () => {
        this.running = true
        resolve(true)
      })
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.running = false
  }

  private extractAndRecordUsage(
    rawText: string,
    targetMeta: { id: TargetId; name: string; category: TargetCategory },
    providerName: string,
    model: string,
    durationMs?: number
  ): void {
    try {
      let inputTokens = 0
      let cachedTokens = 0
      let cacheWriteTokens = 0
      let outputTokens = 0
      let reasoningTokens = 0

      // Handle both SSE (`data: {...}`) and standard JSON response
      const lines = rawText.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
        if (!jsonStr || jsonStr === '[DONE]' || !jsonStr.includes('usage')) continue
        try {
          const obj = JSON.parse(jsonStr)
          const u = obj.usage || obj.response?.usage || obj.message?.usage
          if (u) {
            const pIn = Number(u.prompt_tokens || u.input_tokens || 0)
            const cOut = Number(u.completion_tokens || u.output_tokens || 0)
            const cRead = Number(
              u.prompt_tokens_details?.cached_tokens ??
                u.input_token_details?.cached_tokens ??
                u.cache_read_input_tokens ??
                u.cached_input_tokens ??
                0
            )
            const cWrite = Number(u.cache_creation_input_tokens || u.cache_write_input_tokens || 0)
            const rTok = Number(
              u.completion_tokens_details?.reasoning_tokens ||
                u.output_token_details?.reasoning_tokens ||
                u.reasoning_output_tokens ||
                0
            )

            // In Anthropic format, input_tokens is only fresh input; in OpenAI format, prompt_tokens includes cached_tokens
            const isAnthropicStyle = u.cache_read_input_tokens !== undefined
            inputTokens = isAnthropicStyle ? pIn + cRead + cWrite : Math.max(pIn, cRead)
            cachedTokens = cRead
            cacheWriteTokens = cWrite
            outputTokens = cOut
            reasoningTokens = rTok
          }
        } catch {
          // continue
        }
      }

      const totalTokens = inputTokens + outputTokens + reasoningTokens
      if (totalTokens <= 0) return

      const hitRate = inputTokens > 0 ? Number(((cachedTokens / inputTokens) * 100).toFixed(1)) : 0
      const genTokens = outputTokens + reasoningTokens
      const outputTokensPerSec =
        durationMs && durationMs > 100 && genTokens > 0
          ? Number(((genTokens / durationMs) * 1000).toFixed(1))
          : undefined

      const item: SessionUsageItem = {
        id: `proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        targetId: targetMeta.id,
        targetName: targetMeta.name,
        category: targetMeta.category,
        title: `[网关实时拦截] ${model}`,
        model,
        provider: providerName,
        inputTokens,
        cachedTokens,
        cacheWriteTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        cacheHitRate: hitRate,
        outputTokensPerSec,
        durationMs,
        updatedAt: Date.now(),
        source: 'local-proxy'
      }

      const store = loadStore()
      store.proxyUsageLogs = [item, ...(store.proxyUsageLogs || [])].slice(0, 200)
      saveStore(store)
    } catch {
      // ignore
    }
  }
}

export const usageProxy = new LocalUsageProxy()
