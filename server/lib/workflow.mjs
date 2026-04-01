import crypto from 'node:crypto'
import { readState, withState } from './store.mjs'

const ACTIVE_SESSION_STATUSES = new Set(['active', 'processing'])
const TERMINAL_ORDER_STATUSES = new Set(['used', 'refunded', 'closed'])
const SESSION_TTL_HOURS = 24
const SUPPORTED_RESUME_INPUT_KINDS = new Set(['text', 'images'])
const MAX_RESUME_TEXT_LENGTH = 24000
const MAX_RESUME_IMAGE_PAGES = 3
const MAX_RESUME_IMAGE_BASE64_LENGTH = 450 * 1024
const MAX_RESUME_PAGE_COUNT = 8

function nowIso() {
  return new Date().toISOString()
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function normalizeOrderNo(value) {
  return String(value || '').trim()
}

function normalizePhoneLast4(value) {
  return String(value || '').replace(/\D/g, '').slice(-4)
}

function isExpired(session) {
  return Boolean(session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now())
}

function updateCurrentStep(session, nextStep) {
  session.currentStep = nextStep
  session.updatedAt = nowIso()
}

function expireSession(session) {
  session.status = 'expired'
  session.updatedAt = nowIso()
}

function serializeSession(order, session) {
  return {
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    currentStep: session.currentStep,
    sessionStatus: session.status,
    analysisResult: session.analysisResult ?? null,
    scriptsResult: session.scriptsResult ?? null,
    lastError: session.lastError ?? null,
    expiresAt: session.expiresAt,
  }
}

function findOrder(ordersStore, orderNo) {
  return ordersStore.orders.find((item) => item.platform === 'xiaohongshu' && item.orderNo === orderNo)
}

function getLiveSessionForOrder(sessionsStore, orderId) {
  return sessionsStore.sessions
    .filter((session) => session.orderId === orderId)
    .sort((a, b) => b.id - a.id)
    .find((session) => {
      if (session.status === 'completed') return true
      return !isExpired(session) && ACTIVE_SESSION_STATUSES.has(session.status)
    }) ?? null
}

function getSessionByToken(sessionsStore, sessionToken) {
  return sessionsStore.sessions.find((item) => item.sessionToken === sessionToken) ?? null
}

function expireIfNeeded(order, session) {
  if (!session || session.status === 'completed' || session.status === 'expired') {
    return false
  }

  if (!isExpired(session)) {
    return false
  }

  expireSession(session)

  if (!TERMINAL_ORDER_STATUSES.has(order.orderStatus)) {
    order.orderStatus = 'paid'
    order.updatedAt = nowIso()
  }

  return true
}

function assertClientId(clientId) {
  if (!clientId || String(clientId).trim().length < 12) {
    throw new Error('INVALID_CLIENT_ID')
  }
}

function createCodeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function normalizeTextPayload(text) {
  const normalized = String(text || '').trim()
  if (!normalized) {
    return null
  }

  if (normalized.length <= MAX_RESUME_TEXT_LENGTH) {
    return {
      text: normalized,
      truncated: false,
      originalTextLength: normalized.length,
    }
  }

  return {
    text: normalized.slice(0, MAX_RESUME_TEXT_LENGTH).trimEnd(),
    truncated: true,
    originalTextLength: normalized.length,
  }
}

function normalizeResumeInput(resumeInput) {
  if (!resumeInput || typeof resumeInput !== 'object') {
    return null
  }

  if (resumeInput.kind === 'text') {
    const normalizedText = normalizeTextPayload(resumeInput.text)
    if (!normalizedText) return null
    const pageCount = Number(resumeInput.pageCount || 0)

    if (pageCount > MAX_RESUME_PAGE_COUNT) {
      throw createCodeError('PDF_PAGE_LIMIT_EXCEEDED')
    }

    return {
      kind: 'text',
      source: String(resumeInput.source || 'pdf_text'),
      text: normalizedText.text,
      truncated: normalizedText.truncated,
      originalTextLength: normalizedText.originalTextLength,
      fileName: String(resumeInput.fileName || ''),
      pageCount,
    }
  }

  if (resumeInput.kind === 'images') {
    const pages = Array.isArray(resumeInput.pages)
      ? resumeInput.pages
          .map((page) => {
            const base64 = String(page?.base64 || '').trim()
            const mediaType = String(page?.mediaType || '').trim()

            if (!base64 || !mediaType) {
              return null
            }

            return { base64, mediaType }
          })
          .filter(Boolean)
      : []

    if (!pages.length) return null
    if (pages.length > MAX_RESUME_IMAGE_PAGES) {
      throw createCodeError('RESUME_IMAGE_PAGE_LIMIT')
    }
    if (pages.some((page) => page.base64.length > MAX_RESUME_IMAGE_BASE64_LENGTH)) {
      throw createCodeError('RESUME_IMAGE_TOO_LARGE')
    }

    const pageCount = Number(resumeInput.pageCount || pages.length)
    if (pageCount > MAX_RESUME_PAGE_COUNT) {
      throw createCodeError('PDF_PAGE_LIMIT_EXCEEDED')
    }

    return {
      kind: 'images',
      source: String(resumeInput.source || 'image'),
      pages,
      fileName: String(resumeInput.fileName || ''),
      pageCount,
    }
  }

  return null
}

function getResumeInputFromSession(session) {
  if (session.resumeInput && SUPPORTED_RESUME_INPUT_KINDS.has(session.resumeInput.kind)) {
    return session.resumeInput
  }

  if (session.resumeBase64 && session.resumeMediaType) {
    return {
      kind: 'images',
      source: 'legacy_image',
      pages: [
        {
          base64: session.resumeBase64,
          mediaType: session.resumeMediaType,
        },
      ],
      fileName: '',
      pageCount: 1,
    }
  }

  return null
}

export async function upsertPaidOrder({ orderNo, phoneLast4, amountCents = null }) {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  const normalizedPhone = normalizePhoneLast4(phoneLast4)

  if (!normalizedOrderNo) {
    throw new Error('订单号不能为空')
  }

  if (normalizedPhone.length !== 4) {
    throw new Error('手机号后四位必须为 4 位数字')
  }

  return withState(({ ordersStore }) => {
    const timestamp = nowIso()
    let order = findOrder(ordersStore, normalizedOrderNo)

    if (!order) {
      order = {
        id: ordersStore.nextId++,
        platform: 'xiaohongshu',
        orderNo: normalizedOrderNo,
        phoneLast4: normalizedPhone,
        amountCents,
        orderStatus: 'paid',
        paidAt: timestamp,
        redeemedAt: null,
        usedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      ordersStore.orders.push(order)
    } else {
      order.phoneLast4 = normalizedPhone
      order.amountCents = amountCents
      order.orderStatus = 'paid'
      order.updatedAt = timestamp
    }

    return order
  })
}

export async function redeemOrder({ orderNo, phoneLast4, clientId }) {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  const normalizedPhone = normalizePhoneLast4(phoneLast4)
  assertClientId(clientId)

  if (!normalizedOrderNo) {
    return { ok: false, code: 'ORDER_NOT_FOUND' }
  }

  if (normalizedPhone.length !== 4) {
    return { ok: false, code: 'PHONE_MISMATCH' }
  }

  return withState(({ ordersStore, sessionsStore }) => {
    const order = findOrder(ordersStore, normalizedOrderNo)
    if (!order) {
      return { ok: false, code: 'ORDER_NOT_FOUND' }
    }

    if (order.phoneLast4 !== normalizedPhone) {
      return { ok: false, code: 'PHONE_MISMATCH' }
    }

    if (order.orderStatus === 'used') {
      return { ok: false, code: 'ORDER_USED' }
    }

    if (order.orderStatus === 'refunded' || order.orderStatus === 'closed') {
      return { ok: false, code: 'ORDER_REFUNDED' }
    }

    const existingSession = getLiveSessionForOrder(sessionsStore, order.id)

    if (existingSession) {
      const expired = expireIfNeeded(order, existingSession)
      if (!expired) {
        if (existingSession.status === 'completed' || order.orderStatus === 'used') {
          return { ok: false, code: 'ORDER_USED' }
        }

        if (existingSession.clientId !== clientId) {
          return { ok: false, code: 'ORDER_ALREADY_CLAIMED' }
        }

        return {
          ok: true,
          sessionToken: existingSession.sessionToken,
          session: serializeSession(order, existingSession),
        }
      }
    }

    const timestamp = nowIso()
    const session = {
      id: sessionsStore.nextId++,
      orderId: order.id,
      clientId,
      sessionToken: crypto.randomUUID(),
      status: 'active',
      currentStep: 'upload',
      resumeInput: null,
      resumeMediaType: null,
      resumeBase64: null,
      analysisResult: null,
      scriptsResult: null,
      lastError: null,
      expiresAt: addHours(SESSION_TTL_HOURS),
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    sessionsStore.sessions.push(session)
    order.orderStatus = 'active'
    order.redeemedAt = order.redeemedAt ?? timestamp
    order.updatedAt = timestamp

    return {
      ok: true,
      sessionToken: session.sessionToken,
      session: serializeSession(order, session),
    }
  })
}

function readSessionWithOrder(state, { sessionToken, clientId }) {
  assertClientId(clientId)

  if (!sessionToken) {
    return { ok: false, code: 'INVALID_SESSION' }
  }

  const session = getSessionByToken(state.sessionsStore, sessionToken)
  if (!session) {
    return { ok: false, code: 'INVALID_SESSION' }
  }

  const order = state.ordersStore.orders.find((item) => item.id === session.orderId)
  if (!order) {
    return { ok: false, code: 'INVALID_SESSION' }
  }

  expireIfNeeded(order, session)

  if (session.status === 'expired') {
    return { ok: false, code: 'SESSION_EXPIRED' }
  }

  if (order.orderStatus === 'refunded' || order.orderStatus === 'closed') {
    return { ok: false, code: 'ORDER_REFUNDED' }
  }

  if (session.clientId !== clientId) {
    return { ok: false, code: 'SESSION_OWNERSHIP_MISMATCH' }
  }

  return { ok: true, order, session }
}

export async function getCurrentSession({ sessionToken, clientId }) {
  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    return {
      ok: true,
      session: serializeSession(result.order, result.session),
    }
  })
}

export async function prepareAnalysis({ sessionToken, clientId, resumeInput }) {
  let normalizedResumeInput = null

  try {
    normalizedResumeInput = normalizeResumeInput(resumeInput)
  } catch (error) {
    return { ok: false, code: error.code || 'RESUME_CONTENT_EMPTY' }
  }

  if (!normalizedResumeInput) {
    return { ok: false, code: 'RESUME_CONTENT_EMPTY' }
  }

  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    const { session } = result
    session.resumeInput = normalizedResumeInput
    session.resumeBase64 = null
    session.resumeMediaType = null
    session.lastError = null
    updateCurrentStep(session, 'upload')

    return { ok: true }
  })
}

export async function saveAnalysisResult({ sessionToken, clientId, analysisResult }) {
  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    const { order, session } = result
    session.analysisResult = analysisResult
    session.lastError = null
    session.status = 'active'
    updateCurrentStep(session, 'qa')
    order.orderStatus = 'active'
    order.updatedAt = nowIso()

    return {
      ok: true,
      session: serializeSession(order, session),
    }
  })
}

export async function saveAnalysisFailure({ sessionToken, clientId, errorMessage }) {
  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    const { order, session } = result
    session.lastError = errorMessage
    session.status = 'active'
    updateCurrentStep(session, session.analysisResult ? 'qa' : 'upload')
    order.orderStatus = 'active'
    order.updatedAt = nowIso()

    return { ok: true }
  })
}

export async function beginGeneration({ sessionToken, clientId }) {
  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    const { order, session } = result

    if (!session.analysisResult) {
      return { ok: false, code: 'MISSING_ANALYSIS' }
    }

    if (session.status === 'processing') {
      return { ok: false, code: 'SESSION_BUSY' }
    }

    const resumeInput = getResumeInputFromSession(session)
    if (!resumeInput) {
      return { ok: false, code: 'MISSING_ANALYSIS' }
    }

    session.status = 'processing'
    session.lastError = null
    updateCurrentStep(session, 'generating')
    order.orderStatus = 'processing'
    order.updatedAt = nowIso()

    return {
      ok: true,
      payload: {
        resumeInput,
        questions: session.analysisResult.questions,
      },
    }
  })
}

export async function completeGeneration({ sessionToken, clientId, scriptsResult }) {
  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    const { order, session } = result
    const timestamp = nowIso()

    session.status = 'completed'
    session.scriptsResult = scriptsResult
    session.lastError = null
    updateCurrentStep(session, 'result')
    order.orderStatus = 'used'
    order.usedAt = timestamp
    order.updatedAt = timestamp

    return {
      ok: true,
      session: serializeSession(order, session),
    }
  })
}

export async function failGeneration({ sessionToken, clientId, errorMessage }) {
  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    const { order, session } = result
    session.status = 'active'
    session.lastError = errorMessage
    updateCurrentStep(session, session.analysisResult ? 'qa' : 'upload')
    order.orderStatus = 'active'
    order.updatedAt = nowIso()

    return { ok: true }
  })
}

export async function listOrders() {
  const { ordersStore } = await readState()
  return ordersStore.orders
}
