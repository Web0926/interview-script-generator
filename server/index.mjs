import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {
  beginGeneration,
  completeGeneration,
  failGeneration,
  getCurrentSession,
  prepareAnalysis,
  redeemOrder,
  saveAnalysisFailure,
  saveAnalysisResult,
} from './lib/workflow.mjs'
import { analyzeResume, generateScripts } from './lib/aiClient.mjs'
import { getEnv, getRootDir } from './lib/env.mjs'
import { parseResumeFile } from './lib/resumeParser.mjs'
import { startPeriodicSync, syncNewOrders, getSyncStatus } from './lib/xhs-sync.mjs'
import { isConfigured as isXHSConfigured, getTokenStatus } from './lib/xhs-client.mjs'
import { wxLogin, getWxUserInfo, createPayOrder, handlePaymentSuccess, startWxSession } from './lib/wx-workflow.mjs'
import { notifyProvideGoods } from './lib/wx-pay.mjs'

const rootDir = getRootDir()
const distDir = path.join(rootDir, 'dist')
const port = Number(getEnv('PORT', '3001'))
const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024
const MAX_MULTIPART_BODY_BYTES = 110 * 1024 * 1024

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readRawBody(req, maxBytes) {
  const chunks = []
  let total = 0

  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      const error = new Error('请求体过大')
      error.statusCode = 413
      error.code = 'REQUEST_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }

  if (!chunks.length) {
    return {}
  }

  return Buffer.concat(chunks)
}

async function readJsonBody(req) {
  const buffer = await readRawBody(req, MAX_JSON_BODY_BYTES)

  if (!buffer.length) {
    return {}
  }

  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.statusCode = 400
    error.code = 'INVALID_JSON'
    throw error
  }
}

async function readFormDataBody(req) {
  const buffer = await readRawBody(req, MAX_MULTIPART_BODY_BYTES)

  const request = new Request('http://localhost/api/resume/analyze', {
    method: req.method,
    headers: req.headers,
    body: buffer,
  })

  return request.formData()
}

function getClientId(req) {
  return req.headers['x-client-id']
}

function getSessionToken(req) {
  const value = req.headers.authorization
  if (!value?.startsWith('Bearer ')) return ''
  return value.slice('Bearer '.length).trim()
}

function summarizeResumeInput(resumeInput) {
  if (!resumeInput || typeof resumeInput !== 'object') {
    return { kind: 'unknown' }
  }

  if (resumeInput.kind === 'text') {
    const text = String(resumeInput.text || '')
    return {
      kind: 'text',
      source: String(resumeInput.source || 'pdf_text'),
      fileName: String(resumeInput.fileName || ''),
      pageCount: Number(resumeInput.pageCount || 0),
      textLength: text.length,
      truncated: Boolean(resumeInput.truncated),
    }
  }

  if (resumeInput.kind === 'images') {
    const pages = Array.isArray(resumeInput.pages) ? resumeInput.pages : []
    const totalBase64Bytes = pages.reduce((sum, page) => sum + String(page?.base64 || '').length, 0)

    return {
      kind: 'images',
      source: String(resumeInput.source || 'image'),
      fileName: String(resumeInput.fileName || ''),
      pageCount: Number(resumeInput.pageCount || pages.length),
      imageCount: pages.length,
      totalBase64Bytes,
    }
  }

  return { kind: 'unknown' }
}

function normalizeIncomingResumePayload(body) {
  const payload = body && typeof body === 'object' ? body : {}

  if (payload.resumeInput && typeof payload.resumeInput === 'object') {
    return {
      resumeInput: payload.resumeInput,
      requestFormat: 'resume_input',
    }
  }

  const base64 = String(payload.base64 || '').trim()
  const mediaType = String(payload.mediaType || '').trim()
  if (base64 && mediaType) {
    return {
      requestFormat: 'legacy_base64',
      resumeInput: {
        kind: 'images',
        source: 'legacy_request',
        fileName: '',
        pageCount: 1,
        pages: [
          {
            base64,
            mediaType,
          },
        ],
      },
    }
  }

  return {
    requestFormat: 'unknown',
    resumeInput: null,
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && url.pathname === '/api/redeem-order') {
    const body = await readJsonBody(req)
    const result = await redeemOrder({
      orderNo: body.orderNo,
      phoneLast4: body.phoneLast4,
      clientId: getClientId(req),
    })

    if (!result.ok) {
      return sendJson(res, 400, result)
    }

    return sendJson(res, 200, result)
  }

  if (req.method === 'GET' && url.pathname === '/api/session/current') {
    const result = await getCurrentSession({
      sessionToken: getSessionToken(req),
      clientId: getClientId(req),
    })

    if (!result.ok) {
      return sendJson(res, 400, result)
    }

    return sendJson(res, 200, result)
  }

  if (req.method === 'POST' && url.pathname === '/api/resume/analyze') {
    const sessionToken = getSessionToken(req)
    const clientId = getClientId(req)
    const contentType = String(req.headers['content-type'] || '')
    let normalizedPayload

    try {
      if (contentType.includes('multipart/form-data')) {
        const formData = await readFormDataBody(req)
        const file = formData.get('file')
        const resumeInput = await parseResumeFile(file)
        normalizedPayload = {
          requestFormat: 'raw_file',
          resumeInput,
        }
      } else {
        const body = await readJsonBody(req)
        normalizedPayload = normalizeIncomingResumePayload(body)
      }
    } catch (error) {
      return sendJson(res, error.statusCode || 400, {
        ok: false,
        code: error.code || 'RESUME_CONTENT_EMPTY',
        error: error.message,
      })
    }

    const resumeSummary = summarizeResumeInput(normalizedPayload.resumeInput)

    console.log('[resume.analyze] start', JSON.stringify({
      sessionTail: sessionToken.slice(-6),
      clientTail: String(clientId || '').slice(-6),
      requestFormat: normalizedPayload.requestFormat,
      ...resumeSummary,
    }))

    const prepareResult = await prepareAnalysis({
      sessionToken,
      clientId,
      resumeInput: normalizedPayload.resumeInput,
    })

    if (!prepareResult.ok) {
      return sendJson(res, 400, prepareResult)
    }

    // Return immediately after upload+prepare succeeds.
    // LLM analysis runs in background; client polls /api/session/current for result.
    // This avoids holding a long-running HTTP connection (30-80s) across WeChat devtools
    // proxy / nginx / PM2 which would otherwise get killed by intermediate timeouts.
    sendJson(res, 200, {
      ok: true,
      queued: true,
      message: '分析已开始，请等待结果',
    })

    // Background analysis (fire-and-forget)
    ;(async () => {
      try {
        const analysisResult = await analyzeResume(normalizedPayload.resumeInput)
        const saved = await saveAnalysisResult({ sessionToken, clientId, analysisResult })
        if (!saved.ok) {
          console.error('[resume.analyze] save failed', JSON.stringify({
            sessionTail: sessionToken.slice(-6),
            code: saved.code,
          }))
          await saveAnalysisFailure({
            sessionToken,
            clientId,
            errorMessage: '保存分析结果失败，请重试。',
          })
          return
        }
        console.log('[resume.analyze] success', JSON.stringify({
          sessionTail: sessionToken.slice(-6),
          requestFormat: normalizedPayload.requestFormat,
          questionCount: Array.isArray(analysisResult?.questions) ? analysisResult.questions.length : 0,
        }))
      } catch (error) {
        console.error('[resume.analyze] failed', JSON.stringify({
          sessionTail: sessionToken.slice(-6),
          code: error.code || 'ANALYZE_FAILED',
          message: error.message,
          requestFormat: normalizedPayload.requestFormat,
          ...resumeSummary,
        }))
        await saveAnalysisFailure({
          sessionToken,
          clientId,
          errorMessage: error.message,
        })
      }
    })()
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/scripts/generate') {
    const body = await readJsonBody(req)
    const sessionToken = getSessionToken(req)
    const clientId = getClientId(req)

    const beginResult = await beginGeneration({ sessionToken, clientId })
    if (!beginResult.ok) {
      return sendJson(res, 400, beginResult)
    }

    console.log('[scripts.generate] start', JSON.stringify({
      sessionTail: sessionToken.slice(-6),
      questionCount: Array.isArray(beginResult.payload.questions) ? beginResult.payload.questions.length : 0,
      answerCount: Array.isArray(body.answers) ? body.answers.length : 0,
      ...summarizeResumeInput(beginResult.payload.resumeInput),
    }))

    // Return immediately; LLM generation runs in background.
    // Client's generating page polls /api/session/current for scriptsResult.
    sendJson(res, 200, {
      ok: true,
      queued: true,
      message: '逐字稿生成中，请等待结果',
    })

    ;(async () => {
      try {
        const scriptsResult = await generateScripts(
          beginResult.payload.resumeInput,
          beginResult.payload.questions,
          body.answers ?? []
        )

        const completed = await completeGeneration({ sessionToken, clientId, scriptsResult })
        if (!completed.ok) {
          console.error('[scripts.generate] complete failed', JSON.stringify({
            sessionTail: sessionToken.slice(-6),
            code: completed.code,
          }))
          await failGeneration({
            sessionToken,
            clientId,
            errorMessage: '保存逐字稿失败，请重试。',
          })
          return
        }
        console.log('[scripts.generate] success', JSON.stringify({
          sessionTail: sessionToken.slice(-6),
          hasIntro: Boolean(scriptsResult?.selfIntro),
          projectCount: Array.isArray(scriptsResult?.projects) ? scriptsResult.projects.length : 0,
        }))
      } catch (error) {
        console.error('[scripts.generate] failed', JSON.stringify({
          sessionTail: sessionToken.slice(-6),
          code: error.code || 'GENERATE_FAILED',
          message: error.message,
        }))
        await failGeneration({
          sessionToken,
          clientId,
          errorMessage: error.message,
        })
      }
    })()
    return
  }

  // ─── WeChat Mini Program routes ────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/wx/login') {
    const body = await readJsonBody(req)
    if (!body.code) {
      return sendJson(res, 400, { ok: false, code: 'MISSING_CODE' })
    }
    const result = await wxLogin(body.code)
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  if (req.method === 'GET' && url.pathname === '/api/wx/user/info') {
    const token = getSessionToken(req)
    const result = await getWxUserInfo(token)
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  if (req.method === 'POST' && url.pathname === '/api/wx/session/start') {
    const token = getSessionToken(req)
    const clientId = getClientId(req)
    const result = await startWxSession(token, clientId)
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  // Virtual payment: generate signed params for wx.requestVirtualPayment
  if (req.method === 'POST' && url.pathname === '/api/wx/pay/create') {
    const token = getSessionToken(req)
    const result = await createPayOrder(token)
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  // WeChat message push: URL verification (GET) + delivery callback (POST)
  if (url.pathname === '/api/wx/pay/notify') {
    const WX_MSG_TOKEN = getEnv('WX_MSG_TOKEN', 'interviewmaster2026')

    // GET: WeChat URL verification
    if (req.method === 'GET') {
      const signature = url.searchParams.get('signature')
      const timestamp = url.searchParams.get('timestamp')
      const nonce = url.searchParams.get('nonce')
      const echostr = url.searchParams.get('echostr')

      const arr = [WX_MSG_TOKEN, timestamp, nonce].sort()
      const hash = (await import('node:crypto')).createHash('sha1').update(arr.join('')).digest('hex')

      if (hash === signature) {
        console.log('[wx-msg] URL verification passed')
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(echostr)
      } else {
        console.error('[wx-msg] URL verification failed', { signature, hash })
        res.writeHead(403)
        res.end('Forbidden')
      }
      return
    }

    // POST: delivery callback (xpay_goods_deliver_notify)
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      console.log('[wx-vpay] delivery callback:', JSON.stringify(body))

      try {
        const outTradeNo = body.OutTradeNo || body.out_trade_no
        if (outTradeNo) {
          await handlePaymentSuccess(outTradeNo)

          // Confirm delivery to WeChat
          try {
            await notifyProvideGoods({ outTradeNo })
          } catch (e) {
            console.error('[wx-vpay] notifyProvideGoods failed:', e.message)
          }
        }
      } catch (e) {
        console.error('[wx-vpay] delivery callback error:', e.message)
      }

      return sendJson(res, 200, { ErrCode: 0, ErrMsg: 'success' })
    }
  }

  // ─── Admin routes (protected by ADMIN_TOKEN) ───────────────────
  if (url.pathname.startsWith('/api/admin/')) {
    const adminToken = getEnv('ADMIN_TOKEN')
    if (!adminToken) {
      return sendJson(res, 403, { ok: false, code: 'ADMIN_NOT_CONFIGURED' })
    }

    const authHeader = req.headers['authorization'] || ''
    const providedToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : url.searchParams.get('token')

    if (providedToken !== adminToken) {
      return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' })
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/sync-status') {
      return sendJson(res, 200, {
        ok: true,
        xhsConfigured: isXHSConfigured(),
        tokenStatus: getTokenStatus(),
        sync: getSyncStatus(),
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/sync-now') {
      const result = await syncNewOrders()
      return sendJson(res, 200, { ok: true, result })
    }

    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' })
  }

  return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' })
}

async function serveStatic(req, res, url) {
  if (!fs.existsSync(distDir)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('前端尚未构建，请先运行 npm run build 或 npm run dev')
    return
  }

  const rawPath = decodeURIComponent(url.pathname)
  const requested = rawPath === '/' ? '/index.html' : rawPath
  const safePath = path.normalize(path.join(distDir, requested))

  if (!safePath.startsWith(distDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }

  let filePath = safePath
  try {
    const stat = await fsp.stat(filePath)
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
  } catch {
    filePath = path.join(distDir, 'index.html')
  }

  try {
    const content = await fsp.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const isHtml = ext === '.html'
    const isAsset = filePath.includes(`${path.sep}assets${path.sep}`)
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': isHtml
        ? 'no-cache'
        : isAsset
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
    })
    res.end(content)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    // CORS for Mini Program
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id, X-Platform')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }

    await serveStatic(req, res, url)
  } catch (error) {
    const statusCode = error.statusCode || 500
    sendJson(res, statusCode, {
      ok: false,
      code: error.code || (error.message === 'INVALID_CLIENT_ID' ? 'INVALID_CLIENT_ID' : 'INTERNAL_ERROR'),
      error: error.message || '服务器异常',
    })
  }
})

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`)

  if (isXHSConfigured()) {
    startPeriodicSync()
  } else if (getEnv('XHS_APP_KEY')) {
    console.log('[xhs.sync] XHS app key found but no token yet. Run: npm run xhs-auth')
  }
})
