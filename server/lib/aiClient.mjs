import { SYSTEM_PROMPT_ANALYZE } from '../../src/prompts/analyzePrompt.js'
import { SYSTEM_PROMPT_GENERATE } from '../../src/prompts/generatePrompt.js'
import { getEnv } from './env.mjs'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = getEnv('OPENROUTER_MODEL', 'anthropic/claude-opus-4.6')
const DEFAULT_MAX_TOKENS = Number(getEnv('OPENROUTER_MAX_TOKENS', '5000'))
const ANALYZE_MAX_TOKENS = Number(getEnv('OPENROUTER_ANALYZE_MAX_TOKENS', '1800'))
const GENERATE_MAX_TOKENS = Number(getEnv('OPENROUTER_GENERATE_MAX_TOKENS', String(DEFAULT_MAX_TOKENS)))
const REQUEST_TIMEOUT_MS = Number(getEnv('OPENROUTER_TIMEOUT_MS', '45000'))

function normalizeJSONText(raw) {
  return String(raw || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
}

function tryParseJSON(raw) {
  const cleaned = normalizeJSONText(raw)
  const candidates = [cleaned]

  const objectStart = cleaned.indexOf('{')
  const objectEnd = cleaned.lastIndexOf('}')
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    candidates.push(cleaned.slice(objectStart, objectEnd + 1))
  }

  const arrayStart = cleaned.indexOf('[')
  const arrayEnd = cleaned.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    candidates.push(cleaned.slice(arrayStart, arrayEnd + 1))
  }

  let lastError = null
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('模型返回不是合法 JSON')
}

async function repairJSON(raw, label) {
  return callModel(
    '你是一个 JSON 修复器。你的唯一任务是把给定内容修复为合法 JSON。不要解释，不要补充说明，不要输出 markdown 代码块，只返回修复后的 JSON。',
    [
      {
        type: 'text',
        text: `下面是 ${label} 接口返回的一段损坏 JSON。请尽量保留原始信息和字段名，只修复格式错误，并返回合法 JSON：\n\n${normalizeJSONText(raw)}`,
      },
    ],
    { maxTokens: DEFAULT_MAX_TOKENS }
  )
}

async function parseJSONWithRecovery(raw, label) {
  try {
    return tryParseJSON(raw)
  } catch (initialError) {
    const repaired = await repairJSON(raw, label)
    try {
      return tryParseJSON(repaired)
    } catch (repairError) {
      const error = new Error(`模型返回格式异常，${label} 自动修复后仍不是合法 JSON`)
      error.code = 'MODEL_JSON_INVALID'
      error.cause = repairError
      throw error
    }
  }
}

function buildFileContent(base64, mediaType) {
  return {
    type: 'image_url',
    image_url: {
      url: `data:${mediaType};base64,${base64}`,
    },
  }
}

async function callModel(system, userContent, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const apiKey = getEnv('OPENROUTER_API_KEY') || getEnv('VITE_OPENROUTER_API_KEY')
  if (!apiKey) {
    const error = new Error('服务器未配置 OpenRouter API Key')
    error.code = 'AI_CONFIG_MISSING'
    throw error
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('AI 分析超时，请换一份更清晰或更小的简历后重试')
      timeoutError.code = 'AI_UPSTREAM_TIMEOUT'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`API 请求失败 (${response.status}): ${details}`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('模型返回为空，请稍后重试')
  }

  return content
}

export async function analyzeResume(base64, mediaType) {
  const raw = await callModel(SYSTEM_PROMPT_ANALYZE, [
    buildFileContent(base64, mediaType),
    { type: 'text', text: '请分析这份简历，并按照要求生成5个追问问题。' },
  ], { maxTokens: ANALYZE_MAX_TOKENS })

  return parseJSONWithRecovery(raw, '简历分析')
}

export async function generateScripts(base64, mediaType, questions, answers) {
  const qaText = questions
    .map((question, index) => `Q${question.id}【${question.dimension}】：${question.question}\n回答：${answers[index]?.answer || '（未回答）'}`)
    .join('\n\n')

  const raw = await callModel(SYSTEM_PROMPT_GENERATE, [
    buildFileContent(base64, mediaType),
    {
      type: 'text',
      text: `以下是候选人对5轮追问的回答：\n\n${qaText}\n\n请基于简历和以上回答，生成自我介绍和项目介绍的逐字稿。`,
    },
  ], { maxTokens: GENERATE_MAX_TOKENS })

  return parseJSONWithRecovery(raw, '逐字稿生成')
}
