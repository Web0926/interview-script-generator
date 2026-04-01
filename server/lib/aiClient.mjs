import { SYSTEM_PROMPT_ANALYZE } from '../../src/prompts/analyzePrompt.js'
import { SYSTEM_PROMPT_GENERATE } from '../../src/prompts/generatePrompt.js'
import { getEnv } from './env.mjs'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = getEnv('OPENROUTER_MODEL', 'anthropic/claude-opus-4.6')
const DEFAULT_MAX_TOKENS = Number(getEnv('OPENROUTER_MAX_TOKENS', '8000'))
const ANALYZE_MAX_TOKENS = Number(getEnv('OPENROUTER_ANALYZE_MAX_TOKENS', '4000'))
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

function escapeNewlinesInStrings(text) {
  let result = ''
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      result += ch
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      result += ch
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      result += ch
      continue
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      result += ch === '\n' ? '\\n' : '\\r'
      continue
    }
    if (inString && ch === '\t') {
      result += '\\t'
      continue
    }
    result += ch
  }
  return result
}

function tryCompleteTruncatedJSON(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text

  let depth = 0
  let inString = false
  let escape = false
  const stack = []

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }

  if (stack.length === 0) return trimmed

  let completed = trimmed
  if (inString) completed += '"'
  while (stack.length > 0) completed += stack.pop()
  return completed
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

  // Second pass: escape literal newlines inside JSON strings
  const escaped = escapeNewlinesInStrings(cleaned)
  const escapedCandidates = [escaped]
  const eObjStart = escaped.indexOf('{')
  const eObjEnd = escaped.lastIndexOf('}')
  if (eObjStart !== -1 && eObjEnd !== -1 && eObjEnd > eObjStart) {
    escapedCandidates.push(escaped.slice(eObjStart, eObjEnd + 1))
  }
  for (const candidate of escapedCandidates) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }
  }

  // Third pass: try completing truncated JSON
  for (const candidate of escapedCandidates) {
    const completed = tryCompleteTruncatedJSON(candidate)
    if (completed !== candidate) {
      try {
        return JSON.parse(completed)
      } catch (error) {
        lastError = error
      }
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

function normalizeResumeInput(resumeInput) {
  if (!resumeInput || typeof resumeInput !== 'object') {
    return null
  }

  if (resumeInput.kind === 'text' && resumeInput.text) {
    return {
      kind: 'text',
      source: resumeInput.source || 'pdf_text',
      text: String(resumeInput.text),
      truncated: Boolean(resumeInput.truncated),
      originalTextLength: Number(resumeInput.originalTextLength || String(resumeInput.text).length),
      fileName: resumeInput.fileName || '',
      pageCount: Number(resumeInput.pageCount || 0),
    }
  }

  if (resumeInput.kind === 'images' && Array.isArray(resumeInput.pages) && resumeInput.pages.length) {
    return {
      kind: 'images',
      source: resumeInput.source || 'image',
      pages: resumeInput.pages
        .map((page) => ({
          base64: String(page?.base64 || ''),
          mediaType: String(page?.mediaType || ''),
        }))
        .filter((page) => page.base64 && page.mediaType),
      fileName: resumeInput.fileName || '',
      pageCount: Number(resumeInput.pageCount || resumeInput.pages.length),
    }
  }

  return null
}

function buildResumeContent(resumeInput, promptText) {
  const normalizedResumeInput = normalizeResumeInput(resumeInput)
  if (!normalizedResumeInput) {
    const error = new Error('没有从简历里识别到可分析的内容')
    error.code = 'RESUME_CONTENT_EMPTY'
    throw error
  }

  if (normalizedResumeInput.kind === 'text') {
    const fileMeta = [
      normalizedResumeInput.fileName ? `文件名：${normalizedResumeInput.fileName}` : '',
      normalizedResumeInput.pageCount ? `页数：${normalizedResumeInput.pageCount}` : '',
      `来源：${normalizedResumeInput.source}`,
    ].filter(Boolean).join('；')
    const truncateNote = normalizedResumeInput.truncated
      ? `\n注意：提取文本过长，已从 ${normalizedResumeInput.originalTextLength} 字截取前 ${normalizedResumeInput.text.length} 字用于分析。`
      : ''

    return [
      {
        type: 'text',
        text: `${promptText}\n\n以下是从简历中提取出的文本内容（可能有轻微排版丢失）：\n${fileMeta}${truncateNote}\n\n${normalizedResumeInput.text}`,
      },
    ]
  }

  return [
    ...normalizedResumeInput.pages.map((page) => buildFileContent(page.base64, page.mediaType)),
    {
      type: 'text',
      text: `${promptText}\n\n补充信息：文件名：${normalizedResumeInput.fileName || '未命名'}；页数：${normalizedResumeInput.pageCount || normalizedResumeInput.pages.length}；来源：${normalizedResumeInput.source}`,
    },
  ]
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
    const upstreamError = new Error('AI 服务暂时不可达，请稍后重试')
    upstreamError.code = 'AI_UPSTREAM_UNREACHABLE'
    upstreamError.cause = error
    throw upstreamError
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const details = await response.text()
    const upstreamError = new Error(`AI 服务响应异常 (${response.status})`)
    upstreamError.code = 'AI_UPSTREAM_ERROR'
    upstreamError.details = details
    throw upstreamError
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('模型返回为空，请稍后重试')
  }

  return content
}

export async function analyzeResume(resumeInput) {
  const raw = await callModel(
    SYSTEM_PROMPT_ANALYZE,
    buildResumeContent(resumeInput, '请分析这份简历，并按照要求生成5个追问问题。'),
    { maxTokens: ANALYZE_MAX_TOKENS }
  )

  return parseJSONWithRecovery(raw, '简历分析')
}

export async function generateScripts(resumeInput, questions, answers) {
  const qaText = questions
    .map((question, index) => `Q${question.id}【${question.dimension}】：${question.question}\n回答：${answers[index]?.answer || '（未回答）'}`)
    .join('\n\n')

  const userContent = buildResumeContent(
    resumeInput,
    `以下是候选人对${questions.length}轮追问的回答：\n\n${qaText}\n\n请基于简历和以上回答，生成自我介绍和项目介绍的逐字稿。`
  )

  const raw = await callModel(SYSTEM_PROMPT_GENERATE, userContent, { maxTokens: GENERATE_MAX_TOKENS })

  try {
    return parseJSONWithRecovery(raw, '逐字稿生成')
  } catch (firstError) {
    // Retry once with a fresh model call
    const retryRaw = await callModel(SYSTEM_PROMPT_GENERATE, userContent, { maxTokens: GENERATE_MAX_TOKENS })
    return parseJSONWithRecovery(retryRaw, '逐字稿生成')
  }
}
