import crypto from 'node:crypto'
import { withWxState, readWxState } from './wx-store.mjs'
import { withState, readState } from './store.mjs'
import { code2Session, generateUserToken } from './wx-auth.mjs'
import { buildVirtualPaymentParams, generateOutTradeNo } from './wx-pay.mjs'

const SESSION_TTL_HOURS = 24

function nowIso() {
  return new Date().toISOString()
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

export async function wxLogin(jsCode) {
  const wxResult = await code2Session(jsCode)
  const { openid } = wxResult

  return withWxState(({ usersStore }) => {
    const timestamp = nowIso()
    let user = usersStore.users.find((u) => u.openid === openid)

    if (!user) {
      user = {
        id: usersStore.nextId++,
        openid,
        sessionKey: wxResult.sessionKey,
        token: generateUserToken(),
        remainingSessions: 0,
        totalPurchased: 0,
        totalUsed: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      usersStore.users.push(user)
    } else {
      user.sessionKey = wxResult.sessionKey
      user.token = generateUserToken()
      user.updatedAt = timestamp
    }

    return {
      ok: true,
      token: user.token,
      user: {
        id: user.id,
        remainingSessions: user.remainingSessions,
        totalPurchased: user.totalPurchased,
        totalUsed: user.totalUsed,
      },
    }
  })
}

export async function getWxUser(token) {
  if (!token) return null
  const { usersStore } = await readWxState()
  return usersStore.users.find((u) => u.token === token) || null
}

export async function getWxUserInfo(token) {
  const user = await getWxUser(token)
  if (!user) {
    return { ok: false, code: 'WX_INVALID_TOKEN' }
  }

  return {
    ok: true,
    user: {
      id: user.id,
      remainingSessions: user.remainingSessions,
      totalPurchased: user.totalPurchased,
      totalUsed: user.totalUsed,
    },
  }
}

export async function createPayOrder(token) {
  const user = await getWxUser(token)
  if (!user) {
    return { ok: false, code: 'WX_INVALID_TOKEN' }
  }

  if (!user.sessionKey) {
    return { ok: false, code: 'WX_SESSION_EXPIRED', error: '登录已过期，请重新进入小程序' }
  }

  const outTradeNo = generateOutTradeNo()

  // Save order record
  await withWxState(({ wxOrdersStore }) => {
    const timestamp = nowIso()
    const order = {
      id: wxOrdersStore.nextId++,
      userId: user.id,
      outTradeNo,
      totalFee: Number(process.env.WX_GOODS_PRICE || 4990),
      status: 'pending',
      paidAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    wxOrdersStore.orders.push(order)
  })

  // Build signed virtual payment params
  try {
    const payParams = buildVirtualPaymentParams({
      sessionKey: user.sessionKey,
      userId: user.id,
      outTradeNo,
      env: 1, // 1=sandbox, 0=production
    })

    return {
      ok: true,
      outTradeNo,
      payParams, // { mode, signData, paySig, signature }
    }
  } catch (err) {
    return { ok: false, code: err.code || 'WX_PAY_FAILED', error: err.message }
  }
}

export async function handlePaymentSuccess(outTradeNo) {
  return withWxState(({ usersStore, wxOrdersStore }) => {
    const order = wxOrdersStore.orders.find((o) => o.outTradeNo === outTradeNo)
    if (!order) return { ok: false, code: 'ORDER_NOT_FOUND' }
    if (order.status === 'paid') return { ok: true, alreadyProcessed: true }

    const user = usersStore.users.find((u) => u.id === order.userId)
    if (!user) return { ok: false, code: 'USER_NOT_FOUND' }

    const timestamp = nowIso()
    order.status = 'paid'
    order.paidAt = timestamp
    order.updatedAt = timestamp

    user.remainingSessions += 1
    user.totalPurchased += 1
    user.updatedAt = timestamp

    return { ok: true }
  })
}

async function findActiveWxSession(wxUserId, clientId) {
  // WX mini program: user already authenticated by openid (wxUserId)
  // No clientId check needed — clientId changes when user clears cache
  const { sessionsStore } = await readState()

  const session = sessionsStore.sessions
    .filter((s) => s.wxUserId === wxUserId)
    .sort((a, b) => b.id - a.id)
    .find((s) => {
      if (s.status === 'completed' || s.status === 'expired') return false
      if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) return false
      return s.status === 'active' || s.status === 'processing'
    })

  if (!session) return null

  // Auto-expire stuck processing sessions (over 5 minutes)
  if (session.status === 'processing') {
    const updatedAt = session.updatedAt ? new Date(session.updatedAt).getTime() : 0
    const elapsed = Date.now() - updatedAt
    if (elapsed > 5 * 60 * 1000) {
      console.log('[findActiveWxSession] auto-expiring stuck session', session.id, 'after', Math.round(elapsed / 1000), 'seconds')
      return withState(({ sessionsStore: ss }) => {
        const s = ss.sessions.find((x) => x.id === session.id)
        if (s) {
          s.status = 'expired'
          s.lastError = '会话超时，请重新开始'
          s.updatedAt = nowIso()
        }
        return null // Allow creating new session
      })
    }
  }

  // Sync clientId to current device (clientId may change after cache clear)
  if (session.clientId !== clientId) {
    console.log('[findActiveWxSession] syncing clientId for wx session', session.id)
    await withState(({ sessionsStore: ss }) => {
      const s = ss.sessions.find((x) => x.id === session.id)
      if (s) {
        s.clientId = clientId
        s.updatedAt = nowIso()
      }
    })
  }

  return {
    ok: true,
    sessionToken: session.sessionToken,
    session: {
      currentStep: session.currentStep,
      sessionStatus: session.status,
      analysisResult: session.analysisResult ?? null,
      scriptsResult: session.scriptsResult ?? null,
      lastError: session.lastError ?? null,
      expiresAt: session.expiresAt,
    },
  }
}

export async function startWxSession(token, clientId) {
  const user = await getWxUser(token)
  if (!user) {
    return { ok: false, code: 'WX_INVALID_TOKEN' }
  }

  if (!clientId || String(clientId).trim().length < 12) {
    return { ok: false, code: 'INVALID_CLIENT_ID' }
  }

  // If user has an existing active session, reset it to a fresh state
  // (clicking "start" means user wants to begin a new run from scratch).
  // This avoids burning a new session credit while clearing stale data.
  const existingResult = await findActiveWxSession(user.id, clientId)
  if (existingResult && existingResult.ok && existingResult.sessionToken) {
    return withState(({ sessionsStore }) => {
      const s = sessionsStore.sessions.find((x) => x.sessionToken === existingResult.sessionToken)
      if (s) {
        s.resumeInput = null
        s.resumeBase64 = null
        s.resumeMediaType = null
        s.analysisResult = null
        s.scriptsResult = null
        s.lastError = null
        s.status = 'active'
        s.currentStep = 'upload'
        s.clientId = clientId
        s.updatedAt = nowIso()
      }
      return {
        ok: true,
        sessionToken: existingResult.sessionToken,
        session: {
          currentStep: 'upload',
          sessionStatus: 'active',
          analysisResult: null,
          scriptsResult: null,
          lastError: null,
          expiresAt: s ? s.expiresAt : null,
        },
      }
    })
  }
  if (existingResult && !existingResult.ok) {
    return existingResult
  }

  if (user.remainingSessions <= 0) {
    return { ok: false, code: 'WX_NO_REMAINING_SESSIONS' }
  }

  // Decrement remaining sessions
  await withWxState(({ usersStore }) => {
    const u = usersStore.users.find((u2) => u2.id === user.id)
    if (u) {
      u.remainingSessions -= 1
      u.totalUsed += 1
      u.updatedAt = nowIso()
    }
  })

  // Create session in the existing sessions store
  return withState(({ sessionsStore }) => {
    const timestamp = nowIso()
    const session = {
      id: sessionsStore.nextId++,
      orderId: null,
      wxUserId: user.id,
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

    return {
      ok: true,
      sessionToken: session.sessionToken,
      session: {
        currentStep: session.currentStep,
        sessionStatus: session.status,
        analysisResult: null,
        scriptsResult: null,
        lastError: null,
        expiresAt: session.expiresAt,
      },
    }
  })
}
