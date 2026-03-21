import { SYSTEM_PROMPT_ANALYZE } from '../../src/prompts/analyzePrompt.js'
import { SYSTEM_PROMPT_GENERATE } from '../../src/prompts/generatePrompt.js'
import { getEnv } from './env.mjs'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = getEnv('OPENROUTER_MODEL', 'anthropic/claude-opus-4.6')
const MAX_TOKENS = Number(getEnv('OPENROUTER_MAX_TOKENS', '6000'))

function parseJSON(raw) {
  const cleaned = String(raw || '')
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim()

  return JSON.parse(cleaned)
}

function buildFileContent(base64, mediaType) {
  return {
    type: 'image_url',
    image_url: {
      url: `data:${mediaType};base64,${base64}`,
    },
  }
}

async function callModel(system, userContent) {
  const apiKey = getEnv('OPENROUTER_API_KEY') || getEnv('VITE_OPENROUTER_API_KEY')
  if (!apiKey) {
    const error = new Error('服务器未配置 OpenRouter API Key')
    error.code = 'AI_CONFIG_MISSING'
    throw error
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
  })

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
  ])

  return parseJSON(raw)
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
  ])

  return parseJSON(raw)
}
