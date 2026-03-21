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
    if (total > 35 * 1024 * 1024) {
      const error = new Error('请求体过大')
      error.statusCode = 413
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

    const prepareResult = await prepareAnalysis({
      sessionToken,
      clientId,
      resumeBase64: body.base64,
      resumeMediaType: body.mediaType,
    })

    if (!prepareResult.ok) {
      return sendJson(res, 400, prepareResult)
    }

    try {
      const analysisResult = await analyzeResume(body.base64, body.mediaType)
      const saved = await saveAnalysisResult({ sessionToken, clientId, analysisResult })
      return sendJson(res, 200, {
        ok: true,
        analysisResult,
        session: saved.session,
      })
    } catch (error) {
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

    try {
      const scriptsResult = await generateScripts(
        beginResult.payload.resumeBase64,
        beginResult.payload.resumeMediaType,
        beginResult.payload.questions,
        body.answers ?? []
      )

      const completed = await completeGeneration({ sessionToken, clientId, scriptsResult })
      return sendJson(res, 200, {
        ok: true,
        scripts: scriptsResult,
        session: completed.session,
      })
    } catch (error) {
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
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
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
      code: error.message === 'INVALID_CLIENT_ID' ? 'INVALID_CLIENT_ID' : 'INTERNAL_ERROR',
      error: error.message || '服务器异常',
    })
  }
})

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`)
})
