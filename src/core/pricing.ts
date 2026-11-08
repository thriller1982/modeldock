export interface ModelPricing {
  inputPerM: number // USD per 1M tokens (fresh input)
  cachePerM: number // USD per 1M tokens (prompt cache read)
  outputPerM: number // USD per 1M tokens (generation & reasoning)
}

/**
 * Standard public API pricing catalog (USD per 1 Million Tokens)
 * Reflects latest official rates for OpenAI, DeepSeek, Anthropic, Gemini, Kimi, etc.
 */
const PRICING_CATALOG: Record<string, ModelPricing> = {
  // --- OpenAI / Codex ---
  'gpt-6.1-sol': { inputPerM: 15.0, cachePerM: 7.5, outputPerM: 60.0 },
  'gpt-6-sol': { inputPerM: 15.0, cachePerM: 7.5, outputPerM: 60.0 },
  'gpt-5.3-codex': { inputPerM: 10.0, cachePerM: 5.0, outputPerM: 40.0 },
  'gpt-5-codex': { inputPerM: 10.0, cachePerM: 5.0, outputPerM: 40.0 },
  'gpt-5': { inputPerM: 10.0, cachePerM: 5.0, outputPerM: 40.0 },
  'gpt-6.1-terra': { inputPerM: 1.1, cachePerM: 0.55, outputPerM: 4.4 },
  'gpt-6-terra': { inputPerM: 1.1, cachePerM: 0.55, outputPerM: 4.4 },
  'gpt-4o': { inputPerM: 2.5, cachePerM: 1.25, outputPerM: 10.0 },
  'gpt-4o-mini': { inputPerM: 0.15, cachePerM: 0.075, outputPerM: 0.6 },
  'o1': { inputPerM: 15.0, cachePerM: 7.5, outputPerM: 60.0 },
  'o3-mini': { inputPerM: 1.1, cachePerM: 0.55, outputPerM: 4.4 },
  'codex-auto-review': { inputPerM: 0.5, cachePerM: 0.25, outputPerM: 2.0 },

  // --- DeepSeek ---
  'deepseek-chat': { inputPerM: 0.14, cachePerM: 0.014, outputPerM: 0.28 },
  'deepseek-v3': { inputPerM: 0.14, cachePerM: 0.014, outputPerM: 0.28 },
  'deepseek-reasoner': { inputPerM: 0.55, cachePerM: 0.14, outputPerM: 2.19 },
  'deepseek-r1': { inputPerM: 0.55, cachePerM: 0.14, outputPerM: 2.19 },
  'deepseek-v4.1-flash': { inputPerM: 0.1, cachePerM: 0.01, outputPerM: 0.2 },
  'deepseek-flash': { inputPerM: 0.1, cachePerM: 0.01, outputPerM: 0.2 },

  // --- Anthropic Claude ---
  'claude-3-7-sonnet': { inputPerM: 3.0, cachePerM: 0.3, outputPerM: 15.0 },
  'claude-3-5-sonnet': { inputPerM: 3.0, cachePerM: 0.3, outputPerM: 15.0 },
  'claude-3-5-haiku': { inputPerM: 0.8, cachePerM: 0.08, outputPerM: 4.0 },
  'claude-3-opus': { inputPerM: 15.0, cachePerM: 1.5, outputPerM: 75.0 },
  'claude-opus-5.5': { inputPerM: 15.0, cachePerM: 1.5, outputPerM: 75.0 },
  'claude-opus-5': { inputPerM: 15.0, cachePerM: 1.5, outputPerM: 75.0 },

  // --- Google Gemini ---
  'gemini-4-argon': { inputPerM: 1.25, cachePerM: 0.3125, outputPerM: 5.0 },
  'gemini-2.5-pro': { inputPerM: 1.25, cachePerM: 0.3125, outputPerM: 5.0 },
  'gemini-1.5-pro': { inputPerM: 1.25, cachePerM: 0.3125, outputPerM: 5.0 },
  'gemini-3.8-flash': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },
  'gemini-3.8': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },
  'gemini-3-flash': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },
  'gemini-2.5-flash': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },
  'gemini-2.0-flash': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },
  'gemini-1.5-flash': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },

  // --- Moonshot / Kimi ---
  'kimi-k3.1-pro': { inputPerM: 1.65, cachePerM: 0.4, outputPerM: 3.3 },
  'moonshot-v1-auto': { inputPerM: 1.65, cachePerM: 0.4, outputPerM: 3.3 },
  'moonshot-v1-128k': { inputPerM: 1.65, cachePerM: 0.4, outputPerM: 3.3 },

  // --- Tencent Hunyuan ---
  'hy4-free': { inputPerM: 0.0, cachePerM: 0.0, outputPerM: 0.0 }, // Free quota
  'hunyuan-pro': { inputPerM: 0.42, cachePerM: 0.1, outputPerM: 1.4 },
  'hunyuan-t1': { inputPerM: 0.42, cachePerM: 0.1, outputPerM: 1.4 }
}

const DEFAULT_FALLBACK_PRICING: ModelPricing = {
  inputPerM: 1.0,
  cachePerM: 0.25,
  outputPerM: 3.0
}

export function getModelPricing(modelName: string): ModelPricing {
  const norm = (modelName || '').toLowerCase().trim()
  if (!norm) return DEFAULT_FALLBACK_PRICING

  // Direct match
  if (PRICING_CATALOG[norm]) return PRICING_CATALOG[norm]

  // Fuzzy prefix/token matching
  if (norm.includes('sol')) return PRICING_CATALOG['gpt-6.1-sol']
  if (norm.includes('terra')) return PRICING_CATALOG['gpt-6.1-terra']
  if (norm.includes('auto-review') || norm.includes('review')) return PRICING_CATALOG['codex-auto-review']
  if (norm.includes('o1')) return PRICING_CATALOG['o1']
  if (norm.includes('o3')) return PRICING_CATALOG['o3-mini']
  if (norm.includes('gpt-5') || norm.includes('gpt-codex')) return PRICING_CATALOG['gpt-5-codex']
  if (norm.includes('gpt-4o-mini')) return PRICING_CATALOG['gpt-4o-mini']
  if (norm.includes('gpt-4o')) return PRICING_CATALOG['gpt-4o']

  if (norm.includes('r1') || norm.includes('reasoner')) return PRICING_CATALOG['deepseek-reasoner']
  if (norm.includes('flash') && norm.includes('deepseek')) return PRICING_CATALOG['deepseek-v4.1-flash']
  if (norm.includes('deepseek')) return PRICING_CATALOG['deepseek-chat']

  if (norm.includes('sonnet')) return PRICING_CATALOG['claude-3-7-sonnet']
  if (norm.includes('haiku')) return PRICING_CATALOG['claude-3-5-haiku']
  if (norm.includes('opus')) return PRICING_CATALOG['claude-opus-5.5'] || PRICING_CATALOG['claude-3-opus']

  if (norm.includes('argon')) return PRICING_CATALOG['gemini-4-argon']
  if (norm.includes('3.8') || norm.includes('3-flash')) return PRICING_CATALOG['gemini-3.8-flash']
  if (norm.includes('flash') && norm.includes('gemini')) return PRICING_CATALOG['gemini-3.8-flash']
  if (norm.includes('pro') && norm.includes('gemini')) return PRICING_CATALOG['gemini-2.5-pro']
  if (norm.includes('gemini')) return PRICING_CATALOG['gemini-3.8-flash']

  if (norm.includes('kimi') || norm.includes('moonshot')) return PRICING_CATALOG['kimi-k3.1-pro']
  if (norm.includes('free') || norm.includes('hy4')) return PRICING_CATALOG['hy4-free']
  if (norm.includes('hunyuan')) return PRICING_CATALOG['hunyuan-pro']

  return DEFAULT_FALLBACK_PRICING
}

export function calculateCost(
  modelName: string,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  reasoningTokens = 0
): { costUsd: number; savingsUsd: number } {
  const p = getModelPricing(modelName)
  const safeCached = Math.min(inputTokens, Math.max(0, cachedTokens))
  const freshInput = Math.max(0, inputTokens - safeCached)
  const totalGen = Math.max(0, outputTokens + reasoningTokens)

  const rawCost =
    (freshInput / 1_000_000) * p.inputPerM +
    (safeCached / 1_000_000) * p.cachePerM +
    (totalGen / 1_000_000) * p.outputPerM

  const savings = (safeCached / 1_000_000) * Math.max(0, p.inputPerM - p.cachePerM)

  return {
    costUsd: Number(rawCost.toFixed(4)),
    savingsUsd: Number(savings.toFixed(4))
  }
}
