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
  AI_UPSTREAM_TIMEOUT: 'AI 分析超时，请换一份更清晰或更小的简历后重试。',
  AI_UPSTREAM_UNREACHABLE: 'AI 服务暂时不可达，请稍后重试。',
  AI_UPSTREAM_ERROR: 'AI 服务响应异常，请稍后重试。',
  INVALID_CLIENT_ID: '当前设备标识无效，请刷新页面后重试。',
  RESUME_CONTENT_EMPTY: '没有从简历里识别到可分析的内容，请换一份更清晰的简历后重试。',
  PDF_PAGE_LIMIT_EXCEEDED: '简历页数过多，请上传更精简的简历版本。',
  SCAN_PDF_PAGE_LIMIT: '扫描版 PDF 页数过多，请上传前 3 页或改用文字版 PDF。',
  SCAN_PDF_NEEDS_IMAGE: '当前 PDF 更像扫描件，请先转成图片上传，或导出为可复制文字的 PDF。',
  RESUME_IMAGE_PAGE_LIMIT: '当前最多支持 3 张页面图片，请上传更精简的内容。',
  RESUME_IMAGE_TOO_LARGE: '扫描页图片过大，请换更精简的 PDF 或图片后重试。',
  PDF_TOO_LARGE: 'PDF 文件不能超过 100MB。',
  IMAGE_TOO_LARGE: '图片简历不能超过 30MB，请压缩后重试。',
  PDF_PASSWORD_PROTECTED: '暂不支持带密码的 PDF，请去掉密码后重试。',
  INVALID_PDF: 'PDF 文件无法解析，请重新导出后重试。',
  UNSUPPORTED_FILE_TYPE: '不支持该格式，请上传 PDF、PNG、JPG 或 WebP 文件。',
  REQUEST_TOO_LARGE: '上传内容过大，请换更精简的简历版本后重试。',
  INVALID_JSON: '上传内容格式不正确，请刷新页面后重试。',
  INTERNAL_ERROR: '服务器暂时开小差了，请稍后再试。',
}

function getErrorMessage(code, fallback) {
  return ERROR_MESSAGES[code] || fallback || '请求失败，请稍后重试。'
}

async function request(path, { method = 'GET', body, sessionToken, clientId, timeoutMs } = {}) {
  let response
  const controller = new AbortController()
  const timeoutId = timeoutMs ? window.setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
    response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: {
        ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...(clientId ? { 'x-client-id': clientId } : {}),
        ...(!isFormData && body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: isFormData ? body : JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试。')
    }

    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false
    const fallback = isOffline
      ? '当前网络已断开，请检查网络后重试。'
      : '网络连接失败，可能是简历文件过大或服务器暂时不可达，请稍后重试。'

    throw new Error(error?.message === 'Failed to fetch' ? fallback : (error?.message || fallback))
  } finally {
    if (timeoutId) {
      window.clearTimeout(timeoutId)
    }
  }

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
    timeoutMs: 8_000,
  })
}

export async function analyzeResume({ sessionToken, clientId, resumeInput, file }) {
  if (file instanceof File) {
    const formData = new FormData()
    formData.append('file', file)

    return request('/api/resume/analyze', {
      method: 'POST',
      sessionToken,
      clientId,
      body: formData,
      timeoutMs: 90_000,
    })
  }

  return request('/api/resume/analyze', {
    method: 'POST',
    sessionToken,
    clientId,
    body: { resumeInput },
    timeoutMs: 90_000,
  })
}

export async function generateScripts({ sessionToken, clientId, answers }) {
  return request('/api/scripts/generate', {
    method: 'POST',
    sessionToken,
    clientId,
    body: { answers },
    timeoutMs: 90_000,
  })
}
