import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getEnv, getRootDir } from './env.mjs'

const XHS_API_BASE = 'https://ark.xiaohongshu.com/ark/open_api/v3'
const XHS_TOKEN_URL = 'https://ark.xiaohongshu.com/ark/open_api/v0/oauth/token'
const TOKENS_FILE = path.join(getRootDir(), 'server/data/xhs-tokens.json')
const REQUEST_TIMEOUT_MS = 15_000

// ─── Token management ───────────────────────────────────────────────

function readTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))
    }
  } catch { /* ignore */ }
  return null
}

function writeTokens(tokens) {
  const dir = path.dirname(TOKENS_FILE)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2))
}

function getCredentials() {
  const appKey = getEnv('XHS_APP_KEY')
  const appSecret = getEnv('XHS_APP_SECRET')
  if (!appKey || !appSecret) {
    return null
  }
  return { appKey, appSecret }
}

function getAccessToken() {
  const tokens = readTokens()
  if (!tokens?.accessToken) return null

  if (tokens.expiresAt && Date.now() >= tokens.expiresAt - 10 * 60 * 1000) {
    return null
  }

  return tokens.accessToken
}

function getRefreshToken() {
  const tokens = readTokens()
  return tokens?.refreshToken || null
}

// ─── Signature ──────────────────────────────────────────────────────

function buildSign(params, appSecret) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')

  return crypto
    .createHmac('sha256', appSecret)
    .update(sorted)
    .digest('hex')
}

// ─── HTTP helpers ───────────────────────────────────────────────────

async function fetchJSON(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    const data = await response.json()

    if (!response.ok) {
      const error = new Error(`XHS API error: ${response.status} ${data?.error_msg || JSON.stringify(data)}`)
      error.code = 'XHS_API_ERROR'
      error.status = response.status
      error.data = data
      throw error
    }

    return data
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('XHS API request timeout')
      timeoutError.code = 'XHS_TIMEOUT'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Token operations ───────────────────────────────────────────────

export async function exchangeCodeForToken(code) {
  const creds = getCredentials()
  if (!creds) throw new Error('XHS_APP_KEY and XHS_APP_SECRET must be configured in .env')

  const data = await fetchJSON(XHS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app_key: creds.appKey,
      app_secret: creds.appSecret,
      code,
      grant_type: 'authorization_code',
    }),
  })

  const tokens = {
    accessToken: data.data?.access_token,
    refreshToken: data.data?.refresh_token,
    expiresAt: Date.now() + (data.data?.expires_in || 604800) * 1000,
    refreshExpiresAt: Date.now() + (data.data?.refresh_token_expires_in || 1209600) * 1000,
    updatedAt: new Date().toISOString(),
  }

  writeTokens(tokens)
  return tokens
}

export async function refreshAccessToken() {
  const creds = getCredentials()
  if (!creds) throw new Error('XHS_APP_KEY and XHS_APP_SECRET must be configured in .env')

  const refreshToken = getRefreshToken()
  if (!refreshToken) throw new Error('No refresh token available. Run npm run xhs-auth first.')

  const data = await fetchJSON(XHS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app_key: creds.appKey,
      app_secret: creds.appSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const tokens = {
    accessToken: data.data?.access_token,
    refreshToken: data.data?.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.data?.expires_in || 604800) * 1000,
    refreshExpiresAt: Date.now() + (data.data?.refresh_token_expires_in || 1209600) * 1000,
    updatedAt: new Date().toISOString(),
  }

  writeTokens(tokens)
  console.log('[xhs.client] access token refreshed')
  return tokens
}

async function ensureAccessToken() {
  let token = getAccessToken()
  if (token) return token

  console.log('[xhs.client] access token expired, refreshing...')
  const refreshed = await refreshAccessToken()
  return refreshed.accessToken
}

// ─── API requests ───────────────────────────────────────────────────

async function apiRequest(method, apiPath, params = {}) {
  const creds = getCredentials()
  if (!creds) throw new Error('XHS_APP_KEY and XHS_APP_SECRET must be configured in .env')

  const accessToken = await ensureAccessToken()
  const timestamp = Math.floor(Date.now() / 1000).toString()

  const signParams = {
    app_key: creds.appKey,
    timestamp,
    access_token: accessToken,
    ...params,
  }

  const sign = buildSign(signParams, creds.appSecret)

  const url = new URL(`${XHS_API_BASE}${apiPath}`)
  const headers = {
    'content-type': 'application/json',
    'app-key': creds.appKey,
    timestamp,
    sign,
    'access-token': accessToken,
  }

  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    return fetchJSON(url.toString(), { method, headers })
  }

  return fetchJSON(url.toString(), {
    method,
    headers,
    body: JSON.stringify(params),
  })
}

// ─── Order APIs ─────────────────────────────────────────────────────

export async function getOrderList({ startTime, endTime, orderStatus, pageNo = 1, pageSize = 50 } = {}) {
  const params = {
    start_time: startTime,
    end_time: endTime,
    page_no: String(pageNo),
    page_size: String(pageSize),
    time_type: 'paidTime',
  }

  if (orderStatus) {
    params.order_status = orderStatus
  }

  const data = await apiRequest('POST', '/orders', params)
  return {
    orders: data.data?.order_list || [],
    total: data.data?.total || 0,
    hasMore: (data.data?.order_list?.length || 0) >= pageSize,
  }
}

export async function getOrderDetail(orderNo) {
  const data = await apiRequest('POST', '/order/detail', {
    order_no: orderNo,
  })
  return data.data || null
}

// ─── Utilities ──────────────────────────────────────────────────────

export function isConfigured() {
  const creds = getCredentials()
  if (!creds) return false

  const tokens = readTokens()
  return Boolean(tokens?.accessToken)
}

export function getAuthUrl() {
  const creds = getCredentials()
  if (!creds) throw new Error('XHS_APP_KEY must be configured in .env')

  return `https://ark.xiaohongshu.com/ark/open_api/v0/oauth/authorize?app_key=${creds.appKey}&response_type=code`
}

export function getTokenStatus() {
  const tokens = readTokens()
  if (!tokens) return { valid: false, reason: 'no tokens' }

  const now = Date.now()
  if (tokens.expiresAt && now >= tokens.expiresAt) {
    if (tokens.refreshExpiresAt && now >= tokens.refreshExpiresAt) {
      return { valid: false, reason: 'refresh token expired, re-auth needed' }
    }
    return { valid: false, reason: 'access token expired, will auto-refresh' }
  }

  return {
    valid: true,
    expiresIn: Math.round((tokens.expiresAt - now) / 1000 / 60),
    updatedAt: tokens.updatedAt,
  }
}
