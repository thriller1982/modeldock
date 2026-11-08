export interface ModelPricing {
  inputPerM: number // USD per 1M tokens (fresh input)
  cachePerM: number // USD per 1M tokens (prompt cache read)
  outputPerM: number // USD per 1M tokens (generation & reasoning)
  writeMultiplier?: number
  longWriteMultiplier?: number
}

/**
 * Standard public API pricing catalog (USD per 1 Million Tokens)
 * Reference rates for standard text usage.
 */
const PRICING_CATALOG: Record<string, ModelPricing> = {
  // --- OpenAI / Codex ---
  'gpt-6.1-sol': { inputPerM: 2.0, cachePerM: 0.1, outputPerM: 10.0, writeMultiplier: 1.25, longWriteMultiplier: 2.5 },
  'gpt-6-sol': { inputPerM: 2.0, cachePerM: 0.1, outputPerM: 10.0 },
  'gpt-5.6-sol': { inputPerM: 2.0, cachePerM: 0.1, outputPerM: 10.0 },
  'gpt-5.3-codex': { inputPerM: 1.75, cachePerM: 0.175, outputPerM: 14.0 },
  'gpt-5-codex': { inputPerM: 1.25, cachePerM: 0.125, outputPerM: 10.0 },
  'gpt-5': { inputPerM: 1.25, cachePerM: 0.125, outputPerM: 10.0 },
  'gpt-5.4': { inputPerM: 2.5, cachePerM: 0.25, outputPerM: 15.0 },
  'gpt-5.5': { inputPerM: 5.0, cachePerM: 0.5, outputPerM: 30.0 },
  'gpt-6.1-terra': { inputPerM: 1.0, cachePerM: 0.05, outputPerM: 5.0, writeMultiplier: 1.25, longWriteMultiplier: 2.5 },
  'gpt-6-terra': { inputPerM: 1.0, cachePerM: 0.05, outputPerM: 5.0 },
  'gpt-5.6-terra': { inputPerM: 1.0, cachePerM: 0.05, outputPerM: 5.0 },
  'gpt-6-luna': { inputPerM: 0.1, cachePerM: 0.01, outputPerM: 0.5, writeMultiplier: 1.25, longWriteMultiplier: 2.5 },
  'gpt-5.6-luna': { inputPerM: 1.0, cachePerM: 0.05, outputPerM: 5.0 },
  'gpt-6-astra': { inputPerM: 10.0, cachePerM: 1.0, outputPerM: 50.0, writeMultiplier: 1.25, longWriteMultiplier: 2.5 },
  'gpt-4o': { inputPerM: 2.5, cachePerM: 1.25, outputPerM: 10.0 },
  'gpt-4o-mini': { inputPerM: 0.15, cachePerM: 0.075, outputPerM: 0.6 },
  'o1': { inputPerM: 15.0, cachePerM: 7.5, outputPerM: 60.0 },
  'o3-mini': { inputPerM: 1.1, cachePerM: 0.55, outputPerM: 4.4 },
  'codex-auto-review': { inputPerM: 0.0, cachePerM: 0.0, outputPerM: 0.0 }, // Free system review model

  // --- DeepSeek ---
  'deepseek-chat': { inputPerM: 0.14, cachePerM: 0.014, outputPerM: 0.28 },
  'deepseek-v3': { inputPerM: 0.14, cachePerM: 0.014, outputPerM: 0.28 },
  'deepseek-reasoner': { inputPerM: 0.55, cachePerM: 0.14, outputPerM: 2.19 },
  'deepseek-r1': { inputPerM: 0.55, cachePerM: 0.14, outputPerM: 2.19 },
  // Standard peak rates for the current DeepSeek reference deployment.
  'deepseek-v4.1-flash': { inputPerM: 0.3, cachePerM: 0.006, outputPerM: 1.2 },
  'deepseek-v4-pro': { inputPerM: 1.32, cachePerM: 0.044, outputPerM: 3.96 },

  // --- Anthropic Claude ---
  'claude-3-7-sonnet': { inputPerM: 3.0, cachePerM: 0.3, outputPerM: 15.0 },
  'claude-3-5-sonnet': { inputPerM: 3.0, cachePerM: 0.3, outputPerM: 15.0 },
  'claude-3-5-haiku': { inputPerM: 0.8, cachePerM: 0.08, outputPerM: 4.0 },
  'claude-3-opus': { inputPerM: 15.0, cachePerM: 1.5, outputPerM: 75.0 },
  'claude-opus-5.5': { inputPerM: 4.0, cachePerM: 0.2, outputPerM: 20.0 },
  'claude-opus-5': { inputPerM: 5.0, cachePerM: 0.5, outputPerM: 25.0 },

  // --- Google Gemini ---
  'gemini-4-argon': { inputPerM: 2.0, cachePerM: 0.1, outputPerM: 10.0 },
  'gemini-2.5-pro': { inputPerM: 1.25, cachePerM: 0.3125, outputPerM: 5.0 },
  'gemini-1.5-pro': { inputPerM: 1.25, cachePerM: 0.3125, outputPerM: 5.0 },
  'gemini-3.8-flash': { inputPerM: 0.75, cachePerM: 0.075, outputPerM: 3.75 },
  'gemini-3-flash-preview': { inputPerM: 0.5, cachePerM: 0.05, outputPerM: 3.0 },
  'gemini-2.5-flash': { inputPerM: 0.3, cachePerM: 0.03, outputPerM: 2.5 },
  'gemini-2.0-flash': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },
  'gemini-1.5-flash': { inputPerM: 0.075, cachePerM: 0.01875, outputPerM: 0.3 },

  // --- Moonshot / Kimi ---
  'kimi-k3.1-pro': { inputPerM: 1.65, cachePerM: 0.4, outputPerM: 3.3 },
  'moonshot-v1-auto': { inputPerM: 1.65, cachePerM: 0.4, outputPerM: 3.3 },
  'moonshot-v1-128k': { inputPerM: 1.65, cachePerM: 0.4, outputPerM: 3.3 },

  // --- Tencent Hunyuan ---
  'hy4-free': { inputPerM: 0.0, cachePerM: 0.0, outputPerM: 0.0 }, // Free quota
  'hunyuan-pro': { inputPerM: 0.42, cachePerM: 0.1, outputPerM: 1.4 },
  'hunyuan-t1': { inputPerM: 0.42, cachePerM: 0.1, outputPerM: 1.4 },

  // --- Qwen / GLM / MiMo / StepFun ---
  'qwen-max': { inputPerM: 0.28, cachePerM: 0.05, outputPerM: 0.84 },
  'qwen-plus': { inputPerM: 0.11, cachePerM: 0.02, outputPerM: 0.28 },
  'qwen-flash': { inputPerM: 0.02, cachePerM: 0.005, outputPerM: 0.06 },
  // Model Studio global list prices, with cache ratios from the model's rate card.
  'qwen3.8-flash': { inputPerM: 0.113, cachePerM: 0.113 * 0.125, outputPerM: 0.382, writeMultiplier: 1.5625 },
  'glm-5': { inputPerM: 0.15, cachePerM: 0.05, outputPerM: 0.5 },
  'mimo-v2.5-pro': { inputPerM: 0.1, cachePerM: 0.02, outputPerM: 0.2 },
  'step-5': { inputPerM: 0.4, cachePerM: 0.1, outputPerM: 1.2 }
}

const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-5-5': 'claude-opus-5.5',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-v4.1-flash'
}

function modelKey(modelName: string): string {
  const normalized = modelName.toLowerCase().trim().replace(/\s+/g, '-').split(/[/:]/).at(-1) || ''
  const base = normalized.replace(/-\d{4}(?:-\d{2}-\d{2})?$/, '')
  if (Object.hasOwn(PRICING_CATALOG, normalized)) return normalized
  return Object.hasOwn(MODEL_ALIASES, base) ? MODEL_ALIASES[base] : base
}

export function getModelPricing(modelName: string): ModelPricing | undefined {
  const key = modelKey(modelName)
  return Object.hasOwn(PRICING_CATALOG, key) ? PRICING_CATALOG[key] : undefined
}

export function calculateCost(
  modelName: string,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  reasoningTokens = 0,
  cacheWriteTokens = 0,
  longCacheWriteTokens = 0
): { costUsd?: number; savingsUsd?: number } {
  const p = getModelPricing(modelName)
  if (!p) return {}

  const cacheRead = Math.min(inputTokens, cachedTokens)
  const cacheWrite = Math.min(inputTokens - cacheRead, cacheWriteTokens)
  const longWrite = Math.min(cacheWrite, longCacheWriteTokens)
  const freshInput = inputTokens - cacheRead - cacheWrite
  const isClaude = modelKey(modelName).startsWith('claude-')
  const writeRate = p.inputPerM * (p.writeMultiplier ?? (isClaude ? 1.25 : 1))
  const longWriteRate = p.inputPerM * (p.longWriteMultiplier ?? (isClaude ? 2 : p.writeMultiplier ?? 1))
  const inputCost =
    freshInput * p.inputPerM + cacheRead * p.cachePerM +
    (cacheWrite - longWrite) * writeRate + longWrite * longWriteRate
  return {
    costUsd: (inputCost + (outputTokens + reasoningTokens) * p.outputPerM) / 1_000_000,
    savingsUsd: (inputTokens * p.inputPerM - inputCost) / 1_000_000
  }
}
