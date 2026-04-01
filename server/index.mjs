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

const rootDir = getRootDir()
const distDir = path.join(rootDir, 'dist')
const port = Number(getEnv('PORT', '3001'))
const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024

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
  })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0

  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_JSON_BODY_BYTES) {
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

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.statusCode = 400
    error.code = 'INVALID_JSON'
    throw error
  }
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
    const body = await readJsonBody(req)
    const sessionToken = getSessionToken(req)
    const clientId = getClientId(req)
    const normalizedPayload = normalizeIncomingResumePayload(body)
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

    try {
      const analysisResult = await analyzeResume(normalizedPayload.resumeInput)
      const saved = await saveAnalysisResult({ sessionToken, clientId, analysisResult })
      console.log('[resume.analyze] success', JSON.stringify({
        sessionTail: sessionToken.slice(-6),
        requestFormat: normalizedPayload.requestFormat,
        questionCount: Array.isArray(analysisResult?.questions) ? analysisResult.questions.length : 0,
      }))
      return sendJson(res, 200, {
        ok: true,
        analysisResult,
        session: saved.session,
      })
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

      return sendJson(res, 500, {
        ok: false,
        code: error.code || 'ANALYZE_FAILED',
        error: error.message,
      })
    }
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

    try {
      const scriptsResult = await generateScripts(
        beginResult.payload.resumeInput,
        beginResult.payload.questions,
        body.answers ?? []
      )

      const completed = await completeGeneration({ sessionToken, clientId, scriptsResult })
      console.log('[scripts.generate] success', JSON.stringify({
        sessionTail: sessionToken.slice(-6),
        hasIntro: Boolean(scriptsResult?.selfIntro),
        projectCount: Array.isArray(scriptsResult?.projects) ? scriptsResult.projects.length : 0,
      }))
      return sendJson(res, 200, {
        ok: true,
        scripts: scriptsResult,
        session: completed.session,
      })
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

      return sendJson(res, 500, {
        ok: false,
        code: error.code || 'GENERATE_FAILED',
        error: error.message,
      })
    }
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
})
