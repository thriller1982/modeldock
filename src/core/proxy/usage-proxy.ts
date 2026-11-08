import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { calculateCost } from '../pricing'
import { cacheHitRate, tokenCount } from '../usage'
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
          let bodyBuf = Buffer.concat(chunks)

          let reqModel = provider.defaultModel
          try {
            if (bodyBuf.length > 0) {
              const reqJson = JSON.parse(bodyBuf.toString('utf8'))
              if (typeof reqJson.model === 'string') reqModel = reqJson.model
              if (provider.protocol === 'openai' && /\/chat\/completions(?:\?|$)/.test(finalPath) &&
                  reqJson.stream && reqJson.stream_options?.include_usage === undefined) {
                reqJson.stream_options = { ...reqJson.stream_options, include_usage: true }
                bodyBuf = Buffer.from(JSON.stringify(reqJson))
              }
            }
          } catch {
            // ignore
          }

          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (provider.protocol === 'anthropic') {
            headers['x-api-key'] = provider.apiKey
            headers['anthropic-version'] = String(req.headers['anthropic-version'] ?? '2023-06-01')
            if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta'])
          } else {
            headers.Authorization = 'Bearer ' + provider.apiKey
          }
          const reqStartMs = Date.now()
          const upstreamRes = await fetch(upstreamUrl, {
            method: req.method || 'POST',
            headers,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuf : undefined
          })

          res.writeHead(upstreamRes.status, {
            'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })

          const streaming = upstreamRes.headers.get('content-type')?.includes('text/event-stream')
          let buffered = ''
          let usage: Record<string, any> = {}
          let responseModel = reqModel
          const accept = (data: string) => {
            try {
              const event = JSON.parse(data)
              const payload = event.response ?? event.message ?? event
              if (typeof payload.model === 'string') responseModel = payload.model
              if (payload.usage) {
                // Anthropic streams put input usage in message_start and cumulative output in message_delta.
                usage = { ...usage, ...payload.usage }
              }
            } catch {
              // Ignore the SSE terminator and malformed events.
            }
          }

          if (upstreamRes.body) {
            const reader = upstreamRes.body.getReader()
            const decoder = new TextDecoder()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
              if (!upstreamRes.ok) continue
              buffered += decoder.decode(value, { stream: true })
              if (streaming) {
                const lines = buffered.split('\n')
                buffered = lines.pop() ?? ''
                for (const line of lines) {
                  if (line.startsWith('data:')) accept(line.slice(5))
                }
              }
            }
            buffered += decoder.decode()
          }
          res.end()
          if (!upstreamRes.ok) return
          if (streaming && buffered.startsWith('data:')) accept(buffered.slice(5))
          if (!streaming) accept(buffered)
          this.recordUsage(usage, targetMeta, provider.name, provider.protocol, responseModel,
            Math.max(1, Date.now() - reqStartMs))
        } catch (err: any) {
          if (res.writableEnded) return
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

  private recordUsage(
    usage: Record<string, any>,
    target: (typeof ROUTE_TO_TARGET)[string],
    provider: string,
    protocol: 'openai' | 'anthropic',
    model: string,
    durationMs: number
  ): void {
    const rawInput = tokenCount(usage.prompt_tokens ?? usage.input_tokens)
    const generated = tokenCount(usage.completion_tokens ?? usage.output_tokens)
    const read = tokenCount(usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ?? usage.input_token_details?.cached_tokens ??
      usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_input_tokens)
    const longWrite = tokenCount(usage.cache_creation?.ephemeral_1h_input_tokens ??
      usage.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens)
    const shortWrite = tokenCount(usage.cache_creation?.ephemeral_5m_input_tokens ??
      usage.input_tokens_details?.cache_write_tokens_details?.ttl_30m_tokens)
    const write = tokenCount(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ??
      usage.input_tokens_details?.cache_write_tokens ?? usage.prompt_tokens_details?.cache_write_tokens ??
      usage.prompt_tokens_details?.cache_creation_input_tokens ?? shortWrite + longWrite)
    const inputTokens = protocol === 'anthropic' ? rawInput + read + write : rawInput
    const cachedTokens = Math.min(inputTokens, read)
    const cacheWriteTokens = Math.min(inputTokens - cachedTokens, write)
    const reasoningTokens = Math.min(generated, tokenCount(usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ?? usage.output_token_details?.reasoning_tokens ??
      usage.reasoning_output_tokens))
    const outputTokens = generated - reasoningTokens
    const totalTokens = inputTokens + generated
    if (totalTokens <= 0) return

    const price = calculateCost(model, inputTokens, cachedTokens, outputTokens, reasoningTokens, cacheWriteTokens, longWrite)
    const item: SessionUsageItem = {
      id: 'proxy_' + randomUUID(),
      targetId: target.id,
      targetName: target.name,
      category: target.category,
      title: '[网关] ' + model,
      model,
      provider,
      inputTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      cacheHitRate: cacheHitRate(inputTokens, cachedTokens),
      outputTokensPerSec: durationMs > 100 && outputTokens > 0
        ? Number(((outputTokens / durationMs) * 1000).toFixed(1))
        : undefined,
      durationMs,
      costUsd: price.costUsd,
      cacheSavingsUsd: price.savingsUsd,
      updatedAt: Date.now(),
      source: 'local-proxy',
      usageVersion: 2
    }

    const store = loadStore()
    store.proxyUsageLogs = [item, ...store.proxyUsageLogs].slice(0, 200)
    saveStore(store)
  }

}

export const usageProxy = new LocalUsageProxy()
