import crypto from 'node:crypto'
import { readState, withState } from './store.mjs'

const ACTIVE_SESSION_STATUSES = new Set(['active', 'processing'])
const TERMINAL_ORDER_STATUSES = new Set(['used', 'refunded', 'closed'])
const SESSION_TTL_HOURS = 24

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

export async function prepareAnalysis({ sessionToken, clientId, resumeBase64, resumeMediaType }) {
  if (!resumeBase64 || !resumeMediaType) {
    return { ok: false, code: 'ANALYZE_FAILED' }
  }

  return withState((state) => {
    const result = readSessionWithOrder(state, { sessionToken, clientId })
    if (!result.ok) {
      return result
    }

    const { session } = result
    session.resumeBase64 = resumeBase64
    session.resumeMediaType = resumeMediaType
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

    session.status = 'processing'
    session.lastError = null
    updateCurrentStep(session, 'generating')
    order.orderStatus = 'processing'
    order.updatedAt = nowIso()

    return {
      ok: true,
      payload: {
        resumeBase64: session.resumeBase64,
        resumeMediaType: session.resumeMediaType,
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
