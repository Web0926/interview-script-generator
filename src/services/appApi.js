const SESSION_STORAGE_KEY = 'interview-script-session-token'
const CLIENT_ID_STORAGE_KEY = 'interview-script-client-id'

const ERROR_MESSAGES = {
  ORDER_NOT_FOUND: '未找到对应订单，请确认订单号是否填写正确。',
  PHONE_MISMATCH: '手机号后四位与该订单不匹配，请重新检查。',
  ORDER_USED: '这笔订单的使用机会已经消耗完了。',
  ORDER_REFUNDED: '这笔订单已退款或关闭，当前无法兑换。',
  ORDER_ALREADY_CLAIMED: '这笔订单已经在另一台设备上领取，请回到原设备继续。',
  INVALID_SESSION: '当前使用会话已失效，请重新兑换。',
  SESSION_EXPIRED: '当前使用会话已过期，请重新兑换。',
  SESSION_OWNERSHIP_MISMATCH: '请回到首次兑换的设备继续使用。',
  SESSION_BUSY: '逐字稿正在生成，请稍候刷新页面查看。',
  MISSING_ANALYSIS: '请先完成简历分析，再继续生成逐字稿。',
  AI_CONFIG_MISSING: '服务器还没有配置 OpenRouter API Key。',
  ANALYZE_FAILED: '简历分析失败，请稍后重试。',
  GENERATE_FAILED: '逐字稿生成失败，请稍后重试。',
  INVALID_CLIENT_ID: '当前设备标识无效，请刷新页面后重试。',
  INTERNAL_ERROR: '服务器暂时开小差了，请稍后再试。',
}

function getErrorMessage(code, fallback) {
  return ERROR_MESSAGES[code] || fallback || '请求失败，请稍后重试。'
}

async function request(path, { method = 'GET', body, sessionToken, clientId } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      ...(clientId ? { 'x-client-id': clientId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok || payload?.ok === false) {
    throw new Error(getErrorMessage(payload?.code, payload?.error))
  }

  return payload
}

export function getOrCreateClientId() {
  const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY)
  if (existing) {
    return existing
  }

  const nextId = crypto.randomUUID()
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, nextId)
  return nextId
}

export function getStoredSessionToken() {
  return window.localStorage.getItem(SESSION_STORAGE_KEY)
}

export function storeSessionToken(sessionToken) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, sessionToken)
}

export function clearStoredSessionToken() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY)
}

export async function redeemOrder({ orderNo, phoneLast4, clientId }) {
  return request('/api/redeem-order', {
    method: 'POST',
    clientId,
    body: { orderNo, phoneLast4 },
  })
}

export async function restoreSession({ sessionToken, clientId }) {
  return request('/api/session/current', {
    sessionToken,
    clientId,
  })
}

export async function analyzeResume({ sessionToken, clientId, base64, mediaType }) {
  return request('/api/resume/analyze', {
    method: 'POST',
    sessionToken,
    clientId,
    body: { base64, mediaType },
  })
}

export async function generateScripts({ sessionToken, clientId, answers }) {
  return request('/api/scripts/generate', {
    method: 'POST',
    sessionToken,
    clientId,
    body: { answers },
  })
}
